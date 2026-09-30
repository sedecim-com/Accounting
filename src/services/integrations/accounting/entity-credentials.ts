import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../../database/connection.js';
import { AppError } from '../../../utils/errors.js';
import { getVault, zeroize, type SecretContext, type StoredSecretRef } from '../../vault/index.js';

// ============================================================
// EXTERNAL SYSTEM CREDENTIALS, ONE PER ENTITY (#357, ADR-0004)
// The key of an external accounting system belongs to ONE entity and
// names the RFC of the company it writes to. The key lives in the
// vault; external_system_credentials keeps only the reference, the RFC
// and the status. Nothing here logs, returns or stores the key.
//
// What the RFC proves: it is ATTESTED by the person who registers the
// key (it must equal the entity's RFC at that moment) and re-checked
// against the entity's current RFC at every use. Nothing reads back
// from Contalink which company the key actually opens.
// NOTE: the Contalink adapter has no call that returns the company's
// RFC, so registration cannot verify the key against it; the ADR-0004
// guard is the registrant's attestation until such a call exists.
// ============================================================

/**
 * Missing, mismatched or unusable credential: refused before any call goes
 * out. 423 (the CLI's BLOCKED exit): configuration is missing and a human
 * must act; retrying unchanged will not help, and nothing reached the
 * external system.
 */
export class ExternalCredentialError extends AppError {
  constructor(message: string) {
    super(423, 'EXTERNAL_CREDENTIAL_UNUSABLE', message);
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

/**
 * One secret per REGISTRATION, not per entity: the credential row's id is
 * part of the name, so a replacement never overwrites the secret an older
 * (or a concurrently failing) row still points at.
 */
function vaultContext(ref: EntityRef, provider: string, credentialId: string): SecretContext {
  return { tenantId: ref.tenantId, entityId: ref.entityId, kind: `${provider}-${credentialId}` };
}

function storedRef(row: { vault_backend: string; vault_ref: string; vault_version: string | null }): StoredSecretRef {
  return { ref: row.vault_ref, backend: row.vault_backend, version: row.vault_version ?? undefined };
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
 * RFC is the registrant's attestation of the company the key opens, and
 * it must be the entity's: a key declared for another company is refused
 * before it reaches the vault. The previous active key is revoked in the
 * same transaction, so the entity never has two writers.
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

  const id = uuidv4();
  const vault = getVault();
  const secret = vaultContext(input, input.provider, id);
  const ref = await vault.put(secret, input.apiKey);
  let revoked: CredentialRow[];
  let inserted: { id: string; rfc: string };
  try {
    [revoked, inserted] = await withTransaction(async (client) => {
      const old = await client.query<CredentialRow>(
        `UPDATE external_system_credentials SET status = 'revoked', updated_at = NOW()
         WHERE entity_id = $1 AND tenant_id = $2 AND provider = $3 AND status = 'active'
         RETURNING id, rfc, vault_backend, vault_ref, vault_version`,
        [input.entityId, input.tenantId, input.provider]
      );
      const row = await client.query<{ id: string; rfc: string }>(
        `INSERT INTO external_system_credentials
           (id, tenant_id, entity_id, provider, rfc, vault_backend, vault_ref, vault_version, registered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, rfc`,
        [
          id, input.tenantId, input.entityId, input.provider, declared,
          ref.backend, ref.ref, ref.version ?? null, input.registeredBy,
        ]
      );
      return [old.rows, row.rows[0]] as const;
    });
  } catch (err) {
    // No row points at the secret just written: remove it rather than leave
    // an unregistered key in the vault. The original error is what matters.
    await vault.destroy(secret, ref).catch(() => undefined);
    throw err;
  }
  // The revoked rows stay as history (who, when, which RFC); their key
  // material does not. Best effort: a failed destroy leaves an unreachable
  // secret, never a usable one, since no active row points at it.
  for (const old of revoked) {
    await vault
      .destroy(vaultContext(input, input.provider, old.id), storedRef(old))
      .catch(() => undefined);
  }
  return inserted;
}

/**
 * Metadata-only check (never reads the vault): the entity has an active key
 * for `provider` AND that key's RFC is the entity's current RFC. Returns the
 * row so the caller that does need the key can read it; refuses otherwise.
 */
export async function assertExternalCredentialUsable(
  ref: EntityRef,
  provider: string
): Promise<CredentialRow> {
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
  return row;
}

/** Metadata-only (never reads the vault): does the entity have a USABLE key? */
export async function hasExternalCredential(ref: EntityRef, provider: string): Promise<boolean> {
  try {
    await assertExternalCredentialUsable(ref, provider);
    return true;
  } catch (err) {
    if (err instanceof ExternalCredentialError) return false;
    throw err;
  }
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
  const row = await assertExternalCredentialUsable(ref, provider);
  const blob = await getVault().get(vaultContext(ref, provider, row.id), storedRef(row));
  try {
    return use(blob.toString('utf8'));
  } finally {
    zeroize(blob);
  }
}
