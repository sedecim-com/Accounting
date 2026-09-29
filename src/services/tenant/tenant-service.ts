import { withTransaction, query } from '../../database/connection.js';
import { ValidationError, ConflictError } from '../../utils/errors.js';
import { registrarAuditoria } from '../audit/audit-log.js';
import { ensureSystemUser } from '../entity/entity-service.js';

// ============================================================
// TENANTS — the firm, as a row an operator can create and list
//
// Until #326 a tenant came into existence only as a side effect of the first
// `entity create`, and only while the installation had none. A second firm on
// the same installation needed hand-written SQL, with an invented schema name
// to get past a UNIQUE that migration 145 drops.
//
// `public.tenants` is outside RLS on purpose (rls-policies.sql: it is the root
// of the hierarchy), so these reads and writes see every firm of the
// installation. That is why neither CLI leaf is the agent's: an agent works
// inside ONE tenant and has no business learning which other firms exist.
// ============================================================

/**
 * The plan every tenant is created with: the one the implicit first tenant of
 * `entity create` has always received, so both doors agree. Nothing in src/
 * reads tenants.plan yet, so it is not an option until something does.
 */
export const TENANT_PLAN = 'professional';

/** A DNS label: at most 63 characters (RFC 1035), inner hyphens only. */
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** tenants.name is VARCHAR(255), which counts characters, not UTF-16 units. */
const NAME_MAX = 255;

export interface TenantRow {
  id: string;
  name: string;
  subdomain: string;
  plan: string;
  is_active: boolean;
  created_at: string;
}

export interface CreateTenantInput {
  name: string;
  /** Unique handle of the firm; derived from the name when omitted. */
  subdomain?: string;
}

export interface CreateTenantResult {
  tenantId: string;
  name: string;
  subdomain: string;
  plan: string;
  /** The tenant's system account, which the creation is attributed to. */
  createdBy: string;
}

/**
 * A subdomain-safe handle from a firm's name. Accents are folded instead of
 * becoming hyphens, so "Ruiz Núñez" is `ruiz-nunez`, not `ruiz-n-ez`.
 */
export function tenantSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** Validates the input and fills its defaults, before any connection is taken. */
export function normalizeTenantInput(input: CreateTenantInput): { name: string; subdomain: string } {
  const name = input.name.trim();
  if (!name) throw new ValidationError('The firm needs a name.');
  if ([...name].length > NAME_MAX) {
    throw new ValidationError(`The firm's name has ${[...name].length} characters; the most it can hold is ${NAME_MAX}.`);
  }

  const subdomain = input.subdomain !== undefined ? input.subdomain.trim().toLowerCase() : tenantSlug(name);
  if (!SUBDOMAIN_PATTERN.test(subdomain)) {
    throw new ValidationError(
      input.subdomain !== undefined
        ? `"${input.subdomain}" is not a valid subdomain: lowercase letters, digits and inner hyphens, up to 63.`
        : `"${name}" yields no usable subdomain; name one with --subdomain.`
    );
  }
  return { name, subdomain };
}

/**
 * Creates a tenant with its system account, and records the creation in the
 * NEW tenant's audit log — the firm's own history starts with its birth.
 *
 * A retry of the same command derives the same subdomain and is refused with
 * the existing tenant's id, so a lost response never produces a second firm.
 */
export async function createTenant(input: CreateTenantInput): Promise<CreateTenantResult> {
  const { name, subdomain } = normalizeTenantInput(input);
  const plan = TENANT_PLAN;

  return withTransaction(async (client) => {
    // The UNIQUE on subdomain decides, not a SELECT before the INSERT: two
    // concurrent creates of the same firm would both pass the SELECT, and the
    // loser would surface a raw 23505 instead of this conflict.
    const created = await client.query<{ id: string }>(
      `INSERT INTO public.tenants (name, subdomain, schema_name, plan)
       VALUES ($1, $2, 'public', $3)
       ON CONFLICT (subdomain) DO NOTHING
       RETURNING id`,
      [name, subdomain, plan]
    );
    if (created.rows.length === 0) {
      const taken = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM public.tenants WHERE subdomain = $1',
        [subdomain]
      );
      const owner = taken.rows[0];
      throw new ConflictError(
        `Subdomain "${subdomain}" already belongs to ` +
          (owner ? `"${owner.name}" (${owner.id}). ` : 'another tenant. ') +
          'If that is this firm, it already exists; otherwise name another with --subdomain.'
      );
    }
    const tenantId = created.rows[0].id;

    // The audit row belongs to the new tenant, so under a NOBYPASSRLS role the
    // insert has to run in its context; `true` keeps it local to this transaction.
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
    const createdBy = await ensureSystemUser(client, tenantId);
    await registrarAuditoria(client, {
      tenantId,
      userId: createdBy,
      action: 'create',
      entityType: 'tenants',
      entityId: tenantId,
      newValues: { name, subdomain, plan },
    });

    return { tenantId, name, subdomain, plan, createdBy };
  });
}

/** Every tenant of the installation, oldest first, archived ones included. */
export async function listTenants(): Promise<TenantRow[]> {
  const result = await query<TenantRow>(
    `SELECT id, name, subdomain, plan, is_active, created_at
       FROM public.tenants
      ORDER BY created_at ASC, id ASC`
  );
  return result.rows;
}
