import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  SecretContextMismatchError,
  SecretVaultError,
  zeroize,
  type SecretContext,
  type SecretVault,
  type StoredSecretRef,
} from './types.js';

// ============================================================
// LOCAL DEV VAULT — DEVELOPMENT ONLY
// Lets the full flow be exercised (credential registration, use,
// revocation, audit) without an AWS account. Encrypts with
// AES-256-GCM using a key file with 600 permissions, and REFUSES
// to start in production.
// ============================================================

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;

export interface LocalDevVaultOptions {
  /** Vault directory. Default: .mnemosine-vault (gitignored). */
  dir?: string;
  /** Escape hatch for tests only; never in a real deployment. */
  allowInProduction?: boolean;
}

export class LocalDevVault implements SecretVault {
  readonly backend = 'local-dev';
  private readonly dir: string;

  constructor(opts: LocalDevVaultOptions = {}) {
    if (process.env.NODE_ENV === 'production' && !opts.allowInProduction) {
      throw new SecretVaultError(
        'LocalDevVault must NOT be used in production: the key lives on disk next to the data. ' +
          'Configure VAULT_BACKEND=aws-secrets-manager.'
      );
    }
    this.dir = opts.dir ?? path.join(process.cwd(), '.mnemosine-vault');
  }

  private keyPath(): string {
    return path.join(this.dir, 'vault.key');
  }

  /** Vault key: generated on first use with 600 permissions. */
  private loadKey(): Buffer {
    const file = this.keyPath();
    if (!fs.existsSync(file)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const key = crypto.randomBytes(KEY_BYTES);
      fs.writeFileSync(file, key, { mode: 0o600 });
      return key;
    }
    const stat = fs.statSync(file);
    // 0o077 = group/other permissions. Warn if anyone else can read it.
    if ((stat.mode & 0o077) !== 0) {
      console.warn(
        `[vault] WARNING: ${file} is readable by other users ` +
          `(mode ${(stat.mode & 0o777).toString(8)}). Fix with: chmod 600 ${file}`
      );
    }
    const key = fs.readFileSync(file);
    if (key.byteLength !== KEY_BYTES) {
      throw new SecretVaultError(`The vault key has an invalid size: ${key.byteLength} bytes`);
    }
    return key;
  }

  /** Deterministic path: anchors the secret to tenant + entity + kind. */
  secretName(ctx: SecretContext): string {
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${safe(ctx.tenantId)}__${safe(ctx.entityId)}__${safe(ctx.kind)}.enc`;
  }

  async put(ctx: SecretContext, material: Buffer): Promise<StoredSecretRef> {
    if (material.byteLength === 0) throw new SecretVaultError('The secret material is empty');
    const key = this.loadKey();
    try {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ALGO, key, iv);
      // AAD: binds the ciphertext to the context. If the file is renamed
      // to pass as another tenant's, decryption fails.
      cipher.setAAD(Buffer.from(this.aad(ctx), 'utf-8'));
      const enc = Buffer.concat([cipher.update(material), cipher.final()]);
      const tag = cipher.getAuthTag();

      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const file = path.join(this.dir, this.secretName(ctx));
      fs.writeFileSync(file, Buffer.concat([iv, tag, enc]), { mode: 0o600 });
      return { ref: file, backend: this.backend };
    } finally {
      zeroize(key);
    }
  }

  async get(ctx: SecretContext, ref: StoredSecretRef): Promise<Buffer> {
    this.assertRefMatchesContext(ctx, ref);
    if (!fs.existsSync(ref.ref)) {
      throw new SecretVaultError(`The secret does not exist in the local vault: ${ref.ref}`);
    }
    const key = this.loadKey();
    try {
      const blob = fs.readFileSync(ref.ref);
      const iv = blob.subarray(0, 12);
      const tag = blob.subarray(12, 28);
      const enc = blob.subarray(28);
      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAAD(Buffer.from(this.aad(ctx), 'utf-8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]);
    } catch (err) {
      throw new SecretVaultError(`Could not decrypt the local secret: ${(err as Error).message}`, err);
    } finally {
      zeroize(key);
    }
  }

  async destroy(ctx: SecretContext, ref: StoredSecretRef): Promise<void> {
    this.assertRefMatchesContext(ctx, ref);
    if (fs.existsSync(ref.ref)) fs.rmSync(ref.ref);
  }

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      zeroize(this.loadKey());
      return { healthy: true, detail: `local vault at ${this.dir} (DEVELOPMENT ONLY)` };
    } catch (err) {
      return { healthy: false, detail: (err as Error).message };
    }
  }

  private aad(ctx: SecretContext): string {
    return `${ctx.tenantId}|${ctx.entityId}|${ctx.kind}`;
  }

  private assertRefMatchesContext(ctx: SecretContext, ref: StoredSecretRef): void {
    if (ref.backend !== this.backend) {
      throw new SecretContextMismatchError(this.backend, ref.backend);
    }
    const expected = this.secretName(ctx);
    if (path.basename(ref.ref) !== expected) {
      throw new SecretContextMismatchError(expected, path.basename(ref.ref));
    }
  }
}
