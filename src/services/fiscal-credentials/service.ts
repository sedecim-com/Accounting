import { query, withTransaction } from '../../database/connection.js';
import { getVault, zeroize, type SecretContext } from '../vault/index.js';
import {
  parseCertificate,
  verifyKeyPair,
  serializeMaterial,
  deserializeMaterial,
  CertificateParseError,
  type EfirmaMaterial,
} from './certificate.js';

// ============================================================
// FISCAL CREDENTIAL SERVICE
// Single access point to the e.firma material. `withCredential` is
// the ONLY function that decrypts, and it always writes to the
// access log: there is no path to use the credential without a trace.
// ============================================================

export const CONSENT_VERSION = '2026-08-1';

export const CONSENT_TEXT = `
You are about to hand over your SAT e.firma (FIEL): certificate, private key, and password.

WHAT WE WILL DO WITH IT
  · Authenticate with the SAT to download your issued and received CFDIs.
  · Nothing else. We will not sign tax returns or filings on your behalf.

HOW WE STORE IT
  · Encrypted in a dedicated custody service (not in our database).
  · Every use is logged with date, purpose, and origin; you can audit it
    at any time with "mnemosine sat cred audit".
  · You can revoke it whenever you want; deletion is cryptographic and immediate.

WHAT YOU SHOULD KNOW (IMPORTANT)
  · The e.firma has the same legal validity as your handwritten signature, and
    the responsibility before the SAT is yours and cannot be delegated.
  · Whoever holds it could sign tax returns or generate digital seals.
  · The SAT does not offer a narrower-scope credential for this service: bulk
    download requires the e.firma (the CSD is rejected).
  · If you prefer not to hand it over, there is the alternative of running the
    download on your own infrastructure.
`.trim();

export interface StoreCredentialInput {
  tenantId: string;
  entityId: string;
  material: EfirmaMaterial;
  consentBy: string;
  unattendedAccess?: boolean;
  maxDailyAccess?: number;
}

export interface CredentialRow {
  id: string;
  tenant_id: string;
  entity_id: string;
  credential_type: 'efirma' | 'csd';
  rfc: string;
  cert_serial: string;
  valid_from: Date;
  valid_to: Date;
  vault_backend: string;
  vault_ref: string;
  vault_version: string | null;
  status: 'active' | 'expired' | 'revoked' | 'invalid';
  unattended_access: boolean;
  max_daily_access: number;
  last_used_at: Date | null;
}

const CREDENTIAL_COLUMNS = `id, tenant_id, entity_id, credential_type, rfc, cert_serial,
  valid_from, valid_to, vault_backend, vault_ref, vault_version, status,
  unattended_access, max_daily_access, last_used_at`;

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

/** Denial by policy (not a technical failure): recorded in the log. */
export class CredentialAccessDenied extends CredentialError {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'CredentialAccessDenied';
  }
}

function vaultContext(row: Pick<CredentialRow, 'tenant_id' | 'entity_id' | 'credential_type'>): SecretContext {
  return { tenantId: row.tenant_id, entityId: row.entity_id, kind: row.credential_type };
}

// ============================================================
// REGISTRATION
// ============================================================

/**
 * Validates the material locally BEFORE transmitting it, stores it in
 * the vault, and records the metadata. Rejects a CSD upfront: the SAT
 * bulk download service only accepts an e.firma.
 */
export async function storeCredential(input: StoreCredentialInput): Promise<CredentialRow> {
  const info = parseCertificate(input.material.cer);

  if (info.type === 'csd') {
    throw new CredentialError(
      `The certificate is a CSD (digital seal), not an e.firma. The SAT bulk download ` +
        `service only accepts an e.firma (FIEL) — a CSD would be rejected.`
    );
  }
  if (!verifyKeyPair(input.material.cer, input.material.key, input.material.password)) {
    throw new CredentialError(
      'The private key does not match the certificate, or the password is incorrect.'
    );
  }
  const now = new Date();
  if (info.validTo <= now) {
    throw new CredentialError(
      `The certificate expired on ${info.validTo.toISOString().split('T')[0]}. Renew it with the SAT.`
    );
  }
  if (info.validFrom > now) {
    throw new CredentialError(
      `The certificate is not yet valid (it starts on ${info.validFrom.toISOString().split('T')[0]}).`
    );
  }

  // The certificate's RFC must be the entity's: prevents uploading the
  // wrong e.firma to the wrong entity.
  const entity = await query<{ tax_id: string; name: string }>(
    'SELECT tax_id, name FROM legal_entities WHERE id = $1 AND tenant_id = $2',
    [input.entityId, input.tenantId]
  );
  if (entity.rows.length === 0) {
    throw new CredentialError('The entity does not exist in this tenant');
  }
  if (entity.rows[0].tax_id.toUpperCase() !== info.rfc.toUpperCase()) {
    throw new CredentialError(
      `The certificate's RFC (${info.rfc}) does not match the entity's ` +
        `"${entity.rows[0].name}" (${entity.rows[0].tax_id}).`
    );
  }

  const vault = getVault();
  const ctx: SecretContext = {
    tenantId: input.tenantId,
    entityId: input.entityId,
    kind: 'efirma',
  };

  const blob = serializeMaterial(input.material);
  let ref;
  try {
    ref = await vault.put(ctx, blob);
  } finally {
    zeroize(blob);
  }

  return withTransaction(async (client) => {
    // Revoke the previous one: the partial index allows a single active credential.
    await client.query(
      `UPDATE fiscal_credentials SET status = 'revoked', updated_at = NOW()
       WHERE entity_id = $1 AND credential_type = 'efirma' AND status = 'active'`,
      [input.entityId]
    );
    const inserted = await client.query<CredentialRow>(
      `INSERT INTO fiscal_credentials (
         tenant_id, entity_id, credential_type, rfc, cert_serial, cert_subject,
         valid_from, valid_to, vault_backend, vault_ref, vault_version,
         consent_at, consent_by, consent_version, unattended_access, max_daily_access
       ) VALUES ($1,$2,'efirma',$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11,$12,$13,$14)
       ON CONFLICT (entity_id, credential_type, cert_serial) DO UPDATE SET
         status = 'active', vault_ref = EXCLUDED.vault_ref,
         vault_version = EXCLUDED.vault_version, updated_at = NOW()
       RETURNING ${CREDENTIAL_COLUMNS}`,
      [
        input.tenantId, input.entityId, info.rfc, info.serial, info.subject,
        info.validFrom, info.validTo, ref.backend, ref.ref, ref.version ?? null,
        input.consentBy, CONSENT_VERSION,
        input.unattendedAccess ?? true, input.maxDailyAccess ?? 24,
      ]
    );
    return inserted.rows[0];
  });
}

// ============================================================
// USE — the only decryption path
// ============================================================

export interface AccessOptions {
  purpose: 'sat_auth' | 'validation' | 'healthcheck' | 'export';
  actor: string;
  /** true = no human present (scheduler). Subject to policy. */
  unattended: boolean;
  requestId?: string;
}

/**
 * Decrypts the material, runs `fn`, and zeroizes. ALWAYS writes to the
 * access log: success, denial, or error. There is no way to use the
 * credential without leaving a trace.
 */
export async function withCredential<T>(
  entityId: string,
  tenantId: string,
  opts: AccessOptions,
  fn: (material: EfirmaMaterial, row: CredentialRow) => Promise<T>
): Promise<T> {
  const found = await query<CredentialRow>(
    `SELECT ${CREDENTIAL_COLUMNS} FROM fiscal_credentials
     WHERE entity_id = $1 AND tenant_id = $2 AND credential_type = 'efirma' AND status = 'active'`,
    [entityId, tenantId]
  );
  const row = found.rows[0];
  if (!row) {
    throw new CredentialError(
      'There is no active e.firma for this entity. Upload it with: mnemosine sat cred add'
    );
  }

  const deny = async (reason: string, message: string): Promise<never> => {
    await logAccess(row, opts, 'denied', { deniedReason: reason });
    throw new CredentialAccessDenied(message, reason);
  };

  if (new Date(row.valid_to) <= new Date()) {
    await query(`UPDATE fiscal_credentials SET status = 'expired', updated_at = NOW() WHERE id = $1`, [row.id]);
    return deny('expired', `The e.firma expired on ${new Date(row.valid_to).toISOString().split('T')[0]}.`);
  }
  if (opts.unattended && !row.unattended_access) {
    return deny(
      'unattended_disabled',
      'This credential does not allow unattended use; an operator must be present.'
    );
  }

  // Daily rate limit: an anomalous access pattern is the primary
  // compromise signal when encryption at rest is done right.
  const used = await query<{ n: string }>(
    `SELECT count(*)::text n FROM fiscal_credential_access_log
     WHERE credential_id = $1 AND outcome = 'success' AND accessed_at > NOW() - INTERVAL '24 hours'`,
    [row.id]
  );
  if (parseInt(used.rows[0].n, 10) >= row.max_daily_access) {
    return deny(
      'rate_limit',
      `The limit of ${row.max_daily_access} accesses in 24 h was reached for this credential.`
    );
  }

  const vault = getVault();
  let blob: Buffer | undefined;
  let material: EfirmaMaterial | undefined;
  try {
    blob = await vault.get(vaultContext(row), {
      ref: row.vault_ref,
      backend: row.vault_backend,
      version: row.vault_version ?? undefined,
    });
    material = deserializeMaterial(blob);
    const result = await fn(material, row);
    await logAccess(row, opts, 'success');
    await query(`UPDATE fiscal_credentials SET last_used_at = NOW() WHERE id = $1`, [row.id]);
    return result;
  } catch (err) {
    if (!(err instanceof CredentialAccessDenied)) {
      await logAccess(row, opts, 'error', { error: err instanceof Error ? err.message : String(err) });
    }
    throw err;
  } finally {
    // The material leaves memory as soon as it is no longer in use.
    zeroize(blob, material?.cer, material?.key);
    if (material) material.password = '';
  }
}

async function logAccess(
  row: CredentialRow,
  opts: AccessOptions,
  outcome: 'success' | 'denied' | 'error',
  extra: { deniedReason?: string; error?: string } = {}
): Promise<void> {
  await query(
    `INSERT INTO fiscal_credential_access_log (
       credential_id, tenant_id, entity_id, purpose, actor, unattended,
       request_id, source_host, outcome, denied_reason, error
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      row.id, row.tenant_id, row.entity_id, opts.purpose, opts.actor, opts.unattended,
      opts.requestId ?? null, process.env.HOSTNAME ?? null,
      outcome, extra.deniedReason ?? null, extra.error ?? null,
    ]
  );
}

// ============================================================
// QUERY AND REVOCATION
// ============================================================

export async function getCredentialStatus(entityId: string, tenantId: string) {
  const r = await query<CredentialRow & { cert_subject: string }>(
    `SELECT ${CREDENTIAL_COLUMNS}, cert_subject FROM fiscal_credentials
     WHERE entity_id = $1 AND tenant_id = $2
     ORDER BY status = 'active' DESC, created_at DESC`,
    [entityId, tenantId]
  );
  return r.rows.map((row) => ({
    ...row,
    days_to_expiry: Math.floor((new Date(row.valid_to).getTime() - Date.now()) / 86_400_000),
  }));
}

/** Cryptographic deletion: without the material in the vault, the row is inert. */
export async function revokeCredential(
  entityId: string,
  tenantId: string,
  revokedBy: string
): Promise<void> {
  const found = await query<CredentialRow>(
    `SELECT ${CREDENTIAL_COLUMNS} FROM fiscal_credentials
     WHERE entity_id = $1 AND tenant_id = $2 AND status = 'active'`,
    [entityId, tenantId]
  );
  const row = found.rows[0];
  if (!row) throw new CredentialError('There is no active credential to revoke');

  await getVault().destroy(vaultContext(row), {
    ref: row.vault_ref,
    backend: row.vault_backend,
  });
  await query(
    `UPDATE fiscal_credentials SET status = 'revoked', updated_at = NOW() WHERE id = $1`,
    [row.id]
  );
  await logAccess(row, { purpose: 'export', actor: revokedBy, unattended: false }, 'success');
}

export async function getAccessLog(entityId: string, tenantId: string, limit = 50) {
  const r = await query(
    `SELECT purpose, actor, unattended, outcome, denied_reason, error, accessed_at
     FROM fiscal_credential_access_log
     WHERE entity_id = $1 AND tenant_id = $2
     ORDER BY accessed_at DESC LIMIT ${Math.min(500, Math.max(1, limit))}`,
    [entityId, tenantId]
  );
  return r.rows;
}

export { CertificateParseError };
