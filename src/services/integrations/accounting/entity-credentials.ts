import { query, withTransaction } from '../../../database/connection.js';
import { getVault, zeroize, type SecretContext } from '../../vault/index.js';

// ============================================================
// EXTERNAL SYSTEM CREDENTIALS, ONE PER ENTITY (#357, ADR-0004)
// The key of an external accounting system belongs to ONE entity and
// names the RFC of the company it writes to. The key lives in the
// vault; external_system_credentials keeps only the reference, the RFC
// and the status. Nothing here logs, returns or stores the key.
// ============================================================

/** Missing, mismatched or unusable credential: refused before any call goes out. */
export class ExternalCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalCredentialError';
  }
}

export interface EntityRef {
  tenantId: string;
  entityId: string;
}

interface CredentialRow {
  id: string;
  rfc: string;
  vault_backend: string;
  vault_ref: string;
  vault_version: string | null;
}

const normalizeRfc = (rfc: string) => rfc.trim().toUpperCase();

function vaultContext(ref: EntityRef, provider: string): SecretContext {
  return { tenantId: ref.tenantId, entityId: ref.entityId, kind: provider };
}

/** The entity's own RFC, scoped to its tenant. Refuses an entity with no RFC. */
async function entityRfc(ref: EntityRef): Promise<string> {
  const entity = await query<{ tax_id: string; tax_id_type: string }>(
    'SELECT tax_id, tax_id_type FROM legal_entities WHERE id = $1 AND tenant_id = $2',
    [ref.entityId, ref.tenantId]
  );
  const row = entity.rows[0];
  if (!row) throw new ExternalCredentialError('The entity does not exist in this tenant');
  if (row.tax_id_type !== 'rfc' || !row.tax_id?.trim()) {
    throw new ExternalCredentialError(
      'The entity has no RFC, so no external accounting company can be bound to it'
    );
  }
  return normalizeRfc(row.tax_id);
}

/**
 * Registers (or replaces) the entity's key for `provider`. The declared
 * RFC must be the entity's: a key for another company is refused before
 * it reaches the vault. The previous active key is revoked in the same
 * transaction, so the entity never has two writers.
 */
export async function storeExternalCredential(input: EntityRef & {
  provider: string;
  rfc: string;
  apiKey: Buffer;
  registeredBy: string;
}): Promise<{ id: string; rfc: string }> {
  const declared = normalizeRfc(input.rfc);
  const own = await entityRfc(input);
  if (declared !== own) {
    throw new ExternalCredentialError(
      `The ${input.provider} key is declared for RFC ${declared}, but the entity's RFC is ${own}`
    );
  }
  if (input.apiKey.byteLength === 0) throw new ExternalCredentialError('The key is empty');

  const ref = await getVault().put(vaultContext(input, input.provider), input.apiKey);
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE external_system_credentials SET status = 'revoked', updated_at = NOW()
       WHERE entity_id = $1 AND tenant_id = $2 AND provider = $3 AND status = 'active'`,
      [input.entityId, input.tenantId, input.provider]
    );
    const inserted = await client.query<{ id: string; rfc: string }>(
      `INSERT INTO external_system_credentials
         (tenant_id, entity_id, provider, rfc, vault_backend, vault_ref, vault_version, registered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, rfc`,
      [
        input.tenantId, input.entityId, input.provider, declared,
        ref.backend, ref.ref, ref.version ?? null, input.registeredBy,
      ]
    );
    return inserted.rows[0];
  });
}

/** Metadata-only check (never reads the vault): does the entity have an active key? */
export async function hasExternalCredential(ref: EntityRef, provider: string): Promise<boolean> {
  const found = await query(
    `SELECT 1 FROM external_system_credentials
     WHERE entity_id = $1 AND tenant_id = $2 AND provider = $3 AND status = 'active'`,
    [ref.entityId, ref.tenantId, provider]
  );
  return found.rows.length > 0;
}

/**
 * Reads the entity's key for `provider` and hands it to `use`. Refuses,
 * BEFORE reading the vault, when the entity has no active key or when
 * the key's RFC is not the entity's current RFC. The key is checked at
 * use time, so a key revoked after an operation was approved no longer
 * executes it.
 */
export async function withExternalCredential<T>(
  ref: EntityRef,
  provider: string,
  use: (apiKey: string) => T
): Promise<T> {
  const found = await query<CredentialRow>(
    `SELECT id, rfc, vault_backend, vault_ref, vault_version FROM external_system_credentials
     WHERE entity_id = $1 AND tenant_id = $2 AND provider = $3 AND status = 'active'`,
    [ref.entityId, ref.tenantId, provider]
  );
  const row = found.rows[0];
  if (!row) {
    throw new ExternalCredentialError(
      `This entity has no ${provider} key registered; each entity writes only with its own key (ADR-0004)`
    );
  }
  const own = await entityRfc(ref);
  if (normalizeRfc(row.rfc) !== own) {
    throw new ExternalCredentialError(
      `The ${provider} key is registered for RFC ${row.rfc}, but the entity's RFC is ${own}; ` +
        'register the key of the entity\'s own company'
    );
  }

  const blob = await getVault().get(vaultContext(ref, provider), {
    ref: row.vault_ref,
    backend: row.vault_backend,
    version: row.vault_version ?? undefined,
  });
  try {
    return use(blob.toString('utf8'));
  } finally {
    zeroize(blob);
  }
}
