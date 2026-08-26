import type pg from 'pg';
import * as crypto from 'node:crypto';
import { withTransaction, query } from '../../database/connection.js';
import { ensureEntityAccounting, type ResultadoContabilidad } from '../accounting/entity-accounting.js';
import { ValidationError, ConflictError, NotFoundError } from '../../utils/errors.js';

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
  },
  USA: {
    currency: 'USD',
    standard: 'us_gaap',
    taxIdType: 'ein',
    entityType: 'corporation',
    taxIdLabel: 'EIN',
    taxIdPattern: /^\d{2}-?\d{7}$/,
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
         incorporation_country, functional_currency, accounting_standard
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        org.rows[0].id, tenantId, name, profile.entityType, taxId,
        profile.taxIdType, input.country, currency, profile.standard,
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
