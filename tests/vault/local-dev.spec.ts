import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalDevVault } from '../../src/services/vault/local-dev.js';
import { SecretContextMismatchError, SecretVaultError, zeroize } from '../../src/services/vault/types.js';

let dir: string;
let vault: LocalDevVault;

const CTX_A = { tenantId: 'tenant-a', entityId: 'entity-1', kind: 'efirma' };
const CTX_B = { tenantId: 'tenant-b', entityId: 'entity-2', kind: 'efirma' };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  vault = new LocalDevVault({ dir });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('LocalDevVault', () => {
  it('round-trips the material', async () => {
    const material = Buffer.from('secret-private-key');
    const ref = await vault.put(CTX_A, material);
    const got = await vault.get(CTX_A, ref);
    expect(got.toString()).toBe('secret-private-key');
  });

  it('writes the key and the secret with 600 permissions', async () => {
    const ref = await vault.put(CTX_A, Buffer.from('x'));
    expect(fs.statSync(ref.ref).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, 'vault.key')).mode & 0o777).toBe(0o600);
  });

  it('the material on disk does NOT contain the plaintext', async () => {
    const ref = await vault.put(CTX_A, Buffer.from('RFC-SECRETO-12345'));
    const onDisk = fs.readFileSync(ref.ref);
    expect(onDisk.includes(Buffer.from('RFC-SECRETO-12345'))).toBe(false);
  });

  it('REJECTS reading with a reference from another tenant (DB tampering)', async () => {
    const refA = await vault.put(CTX_A, Buffer.from('secreto-de-A'));
    // Simulates someone copying A's row to entity B
    await expect(vault.get(CTX_B, refA)).rejects.toBeInstanceOf(SecretContextMismatchError);
  });

  it('REJECTS a secret renamed to pass as another (the AAD fails)', async () => {
    const refA = await vault.put(CTX_A, Buffer.from('secreto-de-A'));
    await vault.put(CTX_B, Buffer.from('secreto-de-B'));
    // Renaming A's file to B's name passes the name validation,
    // but the encryption AAD does not match → decryption fails.
    const nameB = vault.secretName(CTX_B);
    fs.copyFileSync(refA.ref, path.join(dir, nameB));
    await expect(
      vault.get(CTX_B, { ref: path.join(dir, nameB), backend: 'local-dev' })
    ).rejects.toBeInstanceOf(SecretVaultError);
  });

  it('rejects a reference from another backend', async () => {
    await expect(
      vault.get(CTX_A, { ref: 'arn:aws:secretsmanager:...', backend: 'aws-secrets-manager' })
    ).rejects.toBeInstanceOf(SecretContextMismatchError);
  });

  it('destroy is idempotent', async () => {
    const ref = await vault.put(CTX_A, Buffer.from('x'));
    await vault.destroy(CTX_A, ref);
    await expect(vault.destroy(CTX_A, ref)).resolves.toBeUndefined();
    await expect(vault.get(CTX_A, ref)).rejects.toThrow(/does not exist/);
  });

  it('rejects empty material', async () => {
    await expect(vault.put(CTX_A, Buffer.alloc(0))).rejects.toThrow(/is empty/);
  });

  it('REFUSES to be constructed in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new LocalDevVault({ dir })).toThrow(/production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('healthCheck reports development mode', async () => {
    const h = await vault.healthCheck();
    expect(h.healthy).toBe(true);
    expect(h.detail).toMatch(/DEVELOPMENT ONLY/);
  });
});

describe('zeroize', () => {
  it('wipes the buffer contents in place', () => {
    const b = Buffer.from('secret');
    zeroize(b);
    expect(b.every((byte) => byte === 0)).toBe(true);
  });

  it('tolerates undefined and null', () => {
    expect(() => zeroize(undefined, null)).not.toThrow();
  });
});
