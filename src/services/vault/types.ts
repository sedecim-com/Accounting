// ============================================================
// SECRET VAULT
// Custody of extremely high-value secrets (the SAT e.firma).
// The abstraction lets the backend change without touching the rest:
//   aws-secrets-manager → the material lives in AWS; the DB stores
//     only the reference. A Postgres dump contains nothing.
//   kms-envelope (future) → ciphertext in the DB, DEK wrapped by
//     KMS. Cheaper at scale ($1/month total vs $0.40/secret/month).
//   local-dev → development ONLY; never in production.
// ============================================================

/**
 * Context binding a secret to its owner. The backend uses it to build
 * a deterministic name and to REJECT reads whose reference does not
 * match the context — so copying a DB row from one tenant to another
 * grants no access to the neighbor's secret.
 */
export interface SecretContext {
  tenantId: string;
  entityId: string;
  /** Discriminator within the entity, e.g. 'efirma' | 'csd'. */
  kind: string;
}

export interface StoredSecretRef {
  /** Opaque backend identifier (ARN in AWS, path locally). */
  ref: string;
  /** Name of the backend that stored it, to route the read. */
  backend: string;
  /** Version, when the backend exposes it (rotation). */
  version?: string;
}

export interface SecretVault {
  readonly backend: string;

  /**
   * Stores (or replaces) the material. Takes a Buffer, not a string:
   * JS strings are immutable and cannot be wiped from memory.
   */
  put(ctx: SecretContext, material: Buffer): Promise<StoredSecretRef>;

  /**
   * Reads the material. MUST validate that `ref` matches `ctx` and throw
   * if it does not. The caller is responsible for zeroizing.
   */
  get(ctx: SecretContext, ref: StoredSecretRef): Promise<Buffer>;

  /** Cryptographic/permanent deletion. Idempotent. */
  destroy(ctx: SecretContext, ref: StoredSecretRef): Promise<void>;

  /** Verifies connectivity and permissions without reading sensitive material. */
  healthCheck(): Promise<{ healthy: boolean; detail?: string }>;
}

export class SecretVaultError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SecretVaultError';
  }
}

/** Reference that does not match the context: possible DB tampering. */
export class SecretContextMismatchError extends SecretVaultError {
  constructor(expected: string, got: string) {
    super(
      `The secret reference does not match its context ` +
        `(expected "${expected}", found "${got}"). Possible data tampering.`
    );
    this.name = 'SecretContextMismatchError';
  }
}

/** Wipes a Buffer in place. Call in `finally` after using sensitive material. */
export function zeroize(...buffers: Array<Buffer | undefined | null>): void {
  for (const b of buffers) {
    if (b && Buffer.isBuffer(b)) b.fill(0);
  }
}
