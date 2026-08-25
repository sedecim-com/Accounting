import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  GetSecretValueCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  ListSecretsCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  SecretContextMismatchError,
  SecretVaultError,
  type SecretContext,
  type SecretVault,
  type StoredSecretRef,
} from './types.js';

// ============================================================
// AWS SECRETS MANAGER VAULT
// The material lives in AWS; the DB stores only the ARN. Benefits:
//   - A Postgres dump contains neither the secret nor its ciphertext.
//   - CloudTrail records every GetSecretValue OUTSIDE your server:
//     an attacker with RCE in the app cannot erase the trail.
// Cost: $0.40/secret/month — linear in the number of entities. At
// scale it pays to migrate to kms-envelope (one key for all).
// Size limit: 65,536 bytes; an e.firma (~4 KB) fits comfortably.
// ============================================================

const MAX_SECRET_BYTES = 65_536;

export interface AwsSecretsManagerOptions {
  region: string;
  /** Namespace prefix, e.g. 'mnemosine/prod'. */
  prefix: string;
  /** KMS key ARN/alias to encrypt the secret (customer-managed). */
  kmsKeyId?: string;
  client?: SecretsManagerClient;
}

export class AwsSecretsManagerVault implements SecretVault {
  readonly backend = 'aws-secrets-manager';
  private readonly client: SecretsManagerClient;

  constructor(private readonly opts: AwsSecretsManagerOptions) {
    this.client = opts.client ?? new SecretsManagerClient({ region: opts.region });
  }

  /**
   * Deterministic, namespaced name. It is the piece that anchors the
   * secret to its owner: `get` rebuilds this name from the context and
   * requires it inside the stored ARN.
   */
  secretName(ctx: SecretContext): string {
    return `${this.opts.prefix}/fiscal/${ctx.tenantId}/${ctx.entityId}/${ctx.kind}`;
  }

  async put(ctx: SecretContext, material: Buffer): Promise<StoredSecretRef> {
    if (material.byteLength === 0) {
      throw new SecretVaultError('The secret material is empty');
    }
    if (material.byteLength > MAX_SECRET_BYTES) {
      throw new SecretVaultError(
        `The secret exceeds the Secrets Manager limit ` +
          `(${material.byteLength} > ${MAX_SECRET_BYTES} bytes)`
      );
    }
    const name = this.secretName(ctx);

    // Create if it does not exist, version if it already does. No generic
    // catch: only ResourceExistsException justifies the second path.
    try {
      const created = await this.client.send(
        new CreateSecretCommand({
          Name: name,
          SecretBinary: material,
          KmsKeyId: this.opts.kmsKeyId,
          Description: `mnemosine fiscal credential (${ctx.kind})`,
          Tags: [
            { Key: 'tenant_id', Value: ctx.tenantId },
            { Key: 'entity_id', Value: ctx.entityId },
            { Key: 'managed_by', Value: 'mnemosine' },
          ],
        })
      );
      return { ref: created.ARN!, backend: this.backend, version: created.VersionId };
    } catch (err) {
      if ((err as { name?: string }).name !== 'ResourceExistsException') {
        throw new SecretVaultError(`Could not create the secret in AWS: ${describe(err)}`, err);
      }
    }

    const updated = await this.client
      .send(new PutSecretValueCommand({ SecretId: name, SecretBinary: material }))
      .catch((err) => {
        throw new SecretVaultError(`Could not update the secret in AWS: ${describe(err)}`, err);
      });
    return { ref: updated.ARN!, backend: this.backend, version: updated.VersionId };
  }

  async get(ctx: SecretContext, ref: StoredSecretRef): Promise<Buffer> {
    this.assertRefMatchesContext(ctx, ref);
    const res = await this.client
      .send(new GetSecretValueCommand({ SecretId: ref.ref, VersionId: ref.version }))
      .catch((err) => {
        throw new SecretVaultError(`Could not read the secret from AWS: ${describe(err)}`, err);
      });

    if (res.SecretBinary) return Buffer.from(res.SecretBinary);
    // Compatibility: in case someone stored it as a string (they shouldn't).
    if (res.SecretString) return Buffer.from(res.SecretString, 'utf-8');
    throw new SecretVaultError('The AWS secret contains no material');
  }

  async destroy(ctx: SecretContext, ref: StoredSecretRef): Promise<void> {
    this.assertRefMatchesContext(ctx, ref);
    try {
      // ForceDeleteWithoutRecovery: deletion must be real and immediate.
      // With a recovery window the secret keeps existing for days.
      await this.client.send(
        new DeleteSecretCommand({ SecretId: ref.ref, ForceDeleteWithoutRecovery: true })
      );
    } catch (err) {
      if ((err as { name?: string }).name === 'ResourceNotFoundException') return; // idempotent
      throw new SecretVaultError(`Could not delete the secret in AWS: ${describe(err)}`, err);
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      // ListSecrets with MaxResults=1 tests credentials and permissions
      // without reading sensitive material (and without GetSecretValue cost).
      await this.client.send(new ListSecretsCommand({ MaxResults: 1 }));
      return { healthy: true, detail: `region ${this.opts.region}, prefix ${this.opts.prefix}` };
    } catch (err) {
      return { healthy: false, detail: describe(err) };
    }
  }

  /** Metadata without reading the material: rotation validity, versions. */
  async describeSecret(ctx: SecretContext, ref: StoredSecretRef) {
    this.assertRefMatchesContext(ctx, ref);
    return this.client.send(new DescribeSecretCommand({ SecretId: ref.ref }));
  }

  /**
   * The Secrets Manager ARN ends in `<name>-<suffix>`, and the name
   * includes tenant and entity. If the stored reference does not contain
   * the name for this context, the row was tampered with.
   */
  private assertRefMatchesContext(ctx: SecretContext, ref: StoredSecretRef): void {
    if (ref.backend !== this.backend) {
      throw new SecretContextMismatchError(this.backend, ref.backend);
    }
    const expected = this.secretName(ctx);
    if (!ref.ref.includes(expected)) {
      throw new SecretContextMismatchError(expected, ref.ref);
    }
  }
}

function describe(err: unknown): string {
  const e = err as { name?: string; message?: string };
  return e?.name ? `${e.name}: ${e.message ?? ''}`.trim() : String(err);
}
