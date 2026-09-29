import type pg from 'pg';
import * as crypto from 'node:crypto';
import { withTransaction, query } from '../../database/connection.js';
import { ensureEntityAccounting, type ResultadoContabilidad } from '../accounting/entity-accounting.js';
import { ValidationError, ConflictError, NotFoundError } from '../../utils/errors.js';
import { SAT_CATALOGS } from '../xml-ingestion/sat-catalogs.js';
import { registrarAuditoria } from '../audit/audit-log.js';

// ============================================================
// ENTITY CREATION — the root of the dependency graph
//
// Creating a company used to be a PRIVATE METHOD of the setup wizard
// (src/cli/init/s1-identity.ts). Nothing else in the system could make one:
// no command, no REST route, no importer. Every other capability in the
// product is downstream of an entity existing, so a private constructor put
// the whole catalog behind an interactive prompt.
//
// Two defects travelled with it and are fixed here:
//
//   TENANT SELECTION. The wizard took `ORDER BY created_at ASC LIMIT 1` —
//   the oldest tenant in the installation. In a firm running two practices,
//   every new company silently joined the first one, which is the worst
//   possible outcome for a system whose entire isolation story is RLS. This
//   service takes the tenant EXPLICITLY, and auto-selects only when there is
//   exactly one. With several, it refuses and names them.
//
//   ATTRIBUTION. `created_by` is NOT NULL with no foreign key to users, so
//   the wizard passed the entity's own id — which does not error, and quietly
//   poisons the column every audit and approval feature will read. Creation
//   now attributes to a real user, and when there is none (bootstrap, before
//   any human exists) it attributes to an explicit per-tenant system account
//   instead of to something that is not a user at all.
// ============================================================

export type Country = 'MX' | 'USA';

interface CountryProfile {
  currency: string;
  standard: string;
  taxIdType: string;
  entityType: string;
  taxIdLabel: string;
  /** Shape only. Neither authority publishes a checksum we can verify offline. */
  taxIdPattern: RegExp;
  /**
   * Lo que se GUARDA en legal_entities.incorporation_country, que es CHAR(2).
   *
   * La clave de este catálogo es 'USA' y se insertaba tal cual, así que crear
   * una entidad estadounidense moría con «value too long for type
   * character(2)». Nadie lo había visto porque ninguna prueba, ninguna semilla
   * y ningún dato de ejemplo crea una: el carril de EE. UU. entero —incluido
   * su catálogo de nómina— nunca se había ejecutado.
   *
   * Se guarda el alfa-2 de ISO 3166, que es lo que una columna CHAR(2) pide.
   */
  iso2: string;
}

export const COUNTRY_PROFILES: Record<Country, CountryProfile> = {
  MX: {
    currency: 'MXN',
    standard: 'mx_nif',
    taxIdType: 'rfc',
    entityType: 'sa',
    taxIdLabel: 'RFC',
    // 12 for a moral person, 13 for a physical one. Ñ and & are legal.
    taxIdPattern: /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/,
    iso2: 'MX',
  },
  USA: {
    currency: 'USD',
    standard: 'us_gaap',
    taxIdType: 'ein',
    entityType: 'corporation',
    taxIdLabel: 'EIN',
    taxIdPattern: /^\d{2}-?\d{7}$/,
    iso2: 'US',
  },
};

/** The email the bootstrap system account uses, per tenant. */
export const SYSTEM_USER_EMAIL = 'system@mnemosine.local';

export interface CreateEntityInput {
  name: string;
  taxId: string;
  country: Country;
  /** Defaults to the country's functional currency. */
  currency?: string;
  /** Explicit tenant. Omitted only when the installation has exactly one. */
  tenantId?: string;
  /** The user this creation is attributed to. Omitted only during bootstrap. */
  createdBy?: string;
  /** Passed through to the chart/roles/payroll seeding. */
  estrategia?: 'auto' | 'siempre' | 'nunca';
  /** c_RegimenFiscal code. Optional: a Mexican entity without it only warns. */
  taxRegime?: string;
  /** Postal code of the fiscal address (5 digits). */
  taxPostalCode?: string;
}

export interface CreateEntityResult {
  entityId: string;
  tenantId: string;
  organizationId: string;
  name: string;
  taxId: string;
  country: Country;
  currency: string;
  accountingStandard: string;
  createdBy: string;
  /** True when attribution fell back to the tenant's system account. */
  attributedToSystem: boolean;
  accounting: ResultadoContabilidad;
  taxRegime: string | null;
  taxPostalCode: string | null;
  /** What the entity was created without and will be asked for later. */
  warnings: string[];
}

// ============================================================
// THE ENTITY'S FISCAL PROFILE (#321 · MNE-001-017)
//
// Regime and fiscal postal code, with the shape migration 049 gave customers
// and the same validation `customer tax set` applies: the catalog in
// sat-catalogs.ts, checked here before writing, never by a CHECK in the table.
// ============================================================

export interface EntityTaxProfilePatch {
  taxRegime?: string;
  taxPostalCode?: string;
}

export interface EntityTaxProfile {
  tax_regime: string | null;
  tax_regime_name: string | null;
  tax_postal_code: string | null;
}

const REGIMES = SAT_CATALOGS.REGIMEN_FISCAL as Record<string, string>;

/** The columns to write, validated. An omitted field is left out, not cleared. */
export function validateEntityTaxProfile(
  patch: EntityTaxProfilePatch
): { tax_regime?: string; tax_postal_code?: string } {
  const out: { tax_regime?: string; tax_postal_code?: string } = {};
  if (patch.taxRegime !== undefined) {
    const regime = patch.taxRegime.trim();
    if (!REGIMES[regime]) {
      throw new ValidationError(
        `The tax regime '${patch.taxRegime}' is not in c_RegimenFiscal: use a catalog code (601, 612, 626…).`
      );
    }
    out.tax_regime = regime;
  }
  if (patch.taxPostalCode !== undefined) {
    const cp = patch.taxPostalCode.trim();
    if (!/^\d{5}$/.test(cp)) {
      throw new ValidationError(`The postal code '${patch.taxPostalCode}' is not 5 digits.`);
    }
    out.tax_postal_code = cp;
  }
  return out;
}

function profileOf(row: { tax_regime: string | null; tax_postal_code: string | null }): EntityTaxProfile {
  return {
    tax_regime: row.tax_regime,
    tax_regime_name: row.tax_regime ? (REGIMES[row.tax_regime] ?? null) : null,
    tax_postal_code: row.tax_postal_code,
  };
}

/** Reads the fiscal profile, scoped to the tenant: outside it is a 404. */
export async function getEntityTaxProfile(entityId: string, tenantId: string): Promise<EntityTaxProfile> {
  const r = await query<{ tax_regime: string | null; tax_postal_code: string | null }>(
    'SELECT tax_regime, tax_postal_code FROM legal_entities WHERE id = $1 AND tenant_id = $2',
    [entityId, tenantId]
  );
  if (r.rows.length === 0) throw new NotFoundError('Legal entity', entityId);
  return profileOf(r.rows[0]);
}

/**
 * Sets regime and/or postal code of an active entity, validated before the
 * transaction opens, with the tenant in the UPDATE and the change audited.
 */
export async function updateEntityTaxProfile(
  entityId: string,
  tenantId: string,
  patch: EntityTaxProfilePatch,
  audit: { userId: string; tenantId: string; reason?: string }
): Promise<EntityTaxProfile> {
  const changes = validateEntityTaxProfile(patch);
  const columns = Object.keys(changes) as Array<keyof typeof changes>;
  if (columns.length === 0) {
    throw new ValidationError('Nothing to set: pass --tax-regime or --tax-postal-code.');
  }

  return withTransaction(async (client) => {
    const before = await client.query<{ tax_regime: string | null; tax_postal_code: string | null }>(
      `SELECT tax_regime, tax_postal_code FROM legal_entities
        WHERE id = $1 AND tenant_id = $2 AND is_active = true FOR UPDATE`,
      [entityId, tenantId]
    );
    if (before.rows.length === 0) throw new NotFoundError('Active legal entity', entityId);

    const sets = columns.map((c, i) => `${c} = $${i + 3}`).join(', ');
    const updated = await client.query(
      `UPDATE legal_entities SET ${sets}, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
      [entityId, tenantId, ...columns.map((c) => changes[c])]
    );
    if (updated.rowCount !== 1) {
      throw new ConflictError(`Legal entity ${entityId} changed while its fiscal profile was being set.`);
    }

    await registrarAuditoria(client, {
      tenantId: audit.tenantId,
      userId: audit.userId,
      action: 'update',
      entityType: 'legal_entities',
      entityId,
      oldValues: { ...before.rows[0] },
      newValues: changes,
      reason: audit.reason,
    });

    return profileOf({ ...before.rows[0], ...changes });
  });
}

export function normalizeTaxId(taxId: string, country: Country): string {
  const profile = COUNTRY_PROFILES[country];
  const normalized = taxId.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!profile.taxIdPattern.test(normalized)) {
    throw new ValidationError(
      `"${taxId}" is not a valid ${profile.taxIdLabel} for ${country}. ` +
        (country === 'MX'
          ? 'An RFC is 3 letters (moral) or 4 (physical), 6 digits of date, and 3 of homoclave.'
          : 'An EIN is nine digits, optionally written as NN-NNNNNNN.')
    );
  }
  return normalized;
}

/**
 * Resolves which tenant the entity belongs to. Explicit wins; with exactly one
 * tenant in the installation that one is used; with several it refuses rather
 * than guessing, because guessing here merges two firms' books under one RLS
 * scope and nothing downstream can detect that it happened.
 */
export async function resolveTenantForCreation(
  client: pg.PoolClient,
  tenantId: string | undefined,
  entityName: string
): Promise<{ tenantId: string; created: boolean }> {
  if (tenantId) {
    const found = await client.query<{ id: string }>(
      'SELECT id FROM public.tenants WHERE id = $1',
      [tenantId]
    );
    if (found.rows.length === 0) throw new NotFoundError('Tenant', tenantId);
    return { tenantId, created: false };
  }

  const all = await client.query<{ id: string; name: string }>(
    'SELECT id, name FROM public.tenants ORDER BY created_at ASC'
  );
  if (all.rows.length === 1) return { tenantId: all.rows[0].id, created: false };
  if (all.rows.length > 1) {
    throw new ValidationError(
      'This installation has more than one tenant, so the firm must be named explicitly ' +
        'with --tenant. Choosing for you would put this company in another firm\'s books:\n' +
        all.rows.map((t) => `  - ${t.name} → ${t.id}`).join('\n')
    );
  }

  const slug = entityName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'principal';
  const created = await client.query<{ id: string }>(
    `INSERT INTO public.tenants (name, subdomain, schema_name, plan)
     VALUES ($1, $2, 'public', 'professional') RETURNING id`,
    [entityName, slug]
  );
  return { tenantId: created.rows[0].id, created: true };
}

/**
 * The account bootstrap writes are attributed to when no human exists yet.
 * Explicit and inspectable: a row created by setup says so, instead of
 * pointing at an id that is not a user.
 */
export async function ensureSystemUser(
  client: pg.PoolClient,
  tenantId: string
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM public.users WHERE tenant_id = $1 AND email = $2',
    [tenantId, SYSTEM_USER_EMAIL]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  // Not a login: the hash is random and no flow accepts this address. It
  // exists to give attribution a real referent.
  const created = await client.query<{ id: string }>(
    `INSERT INTO public.users (tenant_id, email, password_hash, first_name, last_name, is_active, roles)
     VALUES ($1, $2, $3, 'Mnemosine', 'Setup', false, '["system"]'::jsonb)
     RETURNING id`,
    [tenantId, SYSTEM_USER_EMAIL, crypto.randomBytes(32).toString('hex')]
  );
  return created.rows[0].id;
}

/**
 * Creates a legal entity and everything it needs to post its first document:
 * tenant, organization, the entity itself, then the chart of accounts, the
 * account roles and the payroll GL mapping — all in ONE transaction, so an
 * entity is never left half-configured.
 */
export async function createEntity(
  input: CreateEntityInput,
  options: { client?: pg.PoolClient } = {}
): Promise<CreateEntityResult> {
  const name = input.name.trim();
  if (!name) throw new ValidationError('The legal entity needs a name.');

  const profile = COUNTRY_PROFILES[input.country];
  if (!profile) {
    throw new ValidationError(
      `Unsupported country "${input.country}". Supported: ${Object.keys(COUNTRY_PROFILES).join(', ')}.`
    );
  }
  const taxId = normalizeTaxId(input.taxId, input.country);
  const currency = input.currency ?? profile.currency;
  const fiscal = validateEntityTaxProfile(input);
  const taxRegime = fiscal.tax_regime ?? null;
  const taxPostalCode = fiscal.tax_postal_code ?? null;

  // NOTE: a Mexican entity without a regime is created anyway. Every entity
  // that exists today lacks it, and refusing the new ones would not fix those.
  const warnings: string[] = [];
  if (input.country === 'MX' && (!taxRegime || !taxPostalCode)) {
    const missing = [!taxRegime && 'tax regime', !taxPostalCode && 'fiscal postal code'].filter(Boolean);
    warnings.push(
      `Created without ${missing.join(' and ')}: withholdings, provisional ISR and the payroll CFDI ` +
        `read them. Set them with: mnemosine entity edit ${taxId} --tax-regime <code> --tax-postal-code <cp>`
    );
  }

  const run = async (client: pg.PoolClient): Promise<CreateEntityResult> => {
    const { tenantId } = await resolveTenantForCreation(client, input.tenantId, name);

    const duplicate = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM legal_entities WHERE tenant_id = $1 AND tax_id = $2',
      [tenantId, taxId]
    );
    if (duplicate.rows.length > 0) {
      throw new ConflictError(
        `${profile.taxIdLabel} ${taxId} already belongs to "${duplicate.rows[0].name}" in this tenant.`
      );
    }

    const attributedToSystem = !input.createdBy;
    const createdBy = input.createdBy ?? (await ensureSystemUser(client, tenantId));

    const org = await client.query<{ id: string }>(
      `INSERT INTO organizations (tenant_id, name, type)
       VALUES ($1, $2, 'operating') RETURNING id`,
      [tenantId, name]
    );

    const entity = await client.query<{ id: string }>(
      `INSERT INTO legal_entities (
         organization_id, tenant_id, name, entity_type, tax_id, tax_id_type,
         incorporation_country, functional_currency, accounting_standard,
         tax_regime, tax_postal_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        org.rows[0].id, tenantId, name, profile.entityType, taxId,
        profile.taxIdType, profile.iso2, currency, profile.standard,
        taxRegime, taxPostalCode,
      ]
    );
    const entityId = entity.rows[0].id;

    const accounting = await ensureEntityAccounting(entityId, tenantId, createdBy, {
      client,
      estrategia: input.estrategia ?? 'auto',
    });

    return {
      entityId,
      tenantId,
      organizationId: org.rows[0].id,
      name,
      taxId,
      country: input.country,
      currency,
      accountingStandard: profile.standard,
      createdBy,
      attributedToSystem,
      accounting,
      taxRegime,
      taxPostalCode,
      warnings,
    };
  };

  return options.client ? run(options.client) : withTransaction(run);
}

/** Archives an entity. Nothing is ever deleted: its ledger has to survive. */
export async function archiveEntity(entityId: string): Promise<{ name: string }> {
  const result = await query<{ name: string }>(
    `UPDATE legal_entities SET is_active = false, updated_at = NOW()
     WHERE id = $1 AND is_active = true RETURNING name`,
    [entityId]
  );
  if (result.rows.length === 0) throw new NotFoundError('Active legal entity', entityId);
  return result.rows[0];
}
