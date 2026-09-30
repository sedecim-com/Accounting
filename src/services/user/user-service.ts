import bcrypt from 'bcryptjs';
import type pg from 'pg';
import { withTransaction, query } from '../../database/connection.js';
import { ValidationError, ConflictError, NotFoundError } from '../../utils/errors.js';
import { registrarAuditoria } from '../audit/audit-log.js';
import { ensureSystemUser } from '../entity/entity-service.js';
import { ROLES, type RoleName } from '../../auth/roles.js';

// ============================================================
// USERS — the logins of one firm, managed without a terminal (#326)
//
// Until MNE-001-086 the only door that created a human login was the
// interactive wizard (`init --section users`), which reads the password with
// hidden echo and therefore cannot run in a script. These functions are the
// reusable service behind `mnemosine user create|list|archive`.
//
// SECURITY: `public.users` sits outside RLS, so every statement here carries
// `tenant_id` in its WHERE; the caller resolves the tenant once. The password
// arrives as a value and leaves only as a bcrypt hash: it is never returned,
// logged, or written to the audit trail.
// ============================================================

/** Shared with the wizard, so both doors enforce the same floor. */
export const MIN_PASSWORD = 12;
/** bcrypt ignores every byte past the 72nd; a longer secret would be silently truncated. */
export const MAX_PASSWORD_BYTES = 72;
export const BCRYPT_ROUNDS = 12;

/** The role the tenant's system account carries: never a login, never listed. */
const SYSTEM_ROLE = 'system';

export interface UserRow {
  id: string;
  email: string;
  roles: string[];
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

export interface CreateUserInput {
  tenantId: string;
  email: string;
  /** A role name of src/auth/roles.ts, or its Spanish alias. */
  role: string;
  password: string;
}

/** A role name or its alias (`dueño` → `owner`), or a validation error listing them. */
export function resolveRole(input: string): RoleName {
  const wanted = input.trim().toLowerCase();
  for (const [name, spec] of Object.entries(ROLES) as Array<[RoleName, (typeof ROLES)[RoleName]]>) {
    if (name === wanted || spec.alias === wanted) return name;
  }
  throw new ValidationError(
    `Unknown role "${input}". Roles: ${Object.keys(ROLES).join(', ')}.`
  );
}

/** Validates what can be checked before a connection is taken. */
export function normalizeUserInput(input: CreateUserInput): { email: string; role: RoleName } {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 255) {
    throw new ValidationError(`"${input.email}" is not a usable email address.`);
  }
  const role = resolveRole(input.role);
  // The message names the rule, never the value.
  if ([...input.password].length < MIN_PASSWORD) {
    throw new ValidationError(`The password is too short: at least ${MIN_PASSWORD} characters.`);
  }
  if (Buffer.byteLength(input.password, 'utf-8') > MAX_PASSWORD_BYTES) {
    throw new ValidationError(
      `The password is too long: bcrypt keeps only the first ${MAX_PASSWORD_BYTES} bytes.`
    );
  }
  return { email, role };
}

/**
 * The firm a user command acts on: the one named (--tenant or
 * MNEMOSINE_TENANT) when it exists, the only one when there is one, and a
 * refusal naming them all when there are several. Guessing would put one
 * firm's staff into another firm's books.
 */
export async function resolveUserTenant(named: string | null | undefined): Promise<string> {
  if (named) {
    const found = await query<{ id: string }>('SELECT id FROM public.tenants WHERE id::text = $1', [named]);
    if (found.rows.length === 0) throw new NotFoundError(`Tenant ${named}`);
    return found.rows[0].id;
  }
  const all = await query<{ id: string; name: string }>(
    'SELECT id, name FROM public.tenants ORDER BY created_at ASC, id ASC'
  );
  if (all.rows.length === 1) return all.rows[0].id;
  if (all.rows.length === 0) {
    throw new ValidationError('This installation has no tenant yet: mnemosine tenant create <name>.');
  }
  throw new ValidationError(
    'This installation has more than one tenant: name the firm with --tenant.\n' +
      all.rows.map((t) => `  - ${t.name} → ${t.id}`).join('\n')
  );
}

/** Runs `fn` with the tenant set for this transaction, so audit rows pass RLS. */
async function inTenant<T>(tenantId: string, fn: (client: pg.PoolClient, systemUser: string) => Promise<T>): Promise<T> {
  return withTransaction(async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
    return fn(client, await ensureSystemUser(client, tenantId));
  });
}

/**
 * Creates a login with one role of the catalog. A second create of the same
 * address is a conflict, never an update: silently changing an existing
 * user's role is what the wizard's upsert did, and a retried script must not
 * be able to do it.
 */
export async function createUser(input: CreateUserInput): Promise<{ id: string; email: string; role: RoleName }> {
  const { email, role } = normalizeUserInput(input);
  const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  return inTenant(input.tenantId, async (client, systemUser) => {
    const created = await client.query<{ id: string }>(
      `INSERT INTO public.users (tenant_id, email, password_hash, first_name, roles, permissions, accessible_entities)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, '[]'::jsonb)
       ON CONFLICT (tenant_id, email) DO NOTHING
       RETURNING id`,
      [input.tenantId, email, hash, email.split('@')[0], JSON.stringify([role]), JSON.stringify(ROLES[role].permissions)]
    );
    if (created.rows.length === 0) {
      throw new ConflictError(`User ${email} already exists in this firm; nothing was changed.`);
    }
    const id = created.rows[0].id;
    await registrarAuditoria(client, {
      tenantId: input.tenantId,
      userId: systemUser,
      action: 'create',
      entityType: 'users',
      entityId: id,
      newValues: { email, roles: [role] },
    });
    return { id, email, role };
  });
}

/** The logins of one firm, oldest first; the system account is not a login. */
export async function listUsers(tenantId: string): Promise<UserRow[]> {
  const r = await query<UserRow>(
    `SELECT id, email, roles, is_active, last_login_at, created_at
       FROM public.users
      WHERE tenant_id = $1 AND NOT roles @> $2::jsonb
      ORDER BY created_at ASC, id ASC`,
    [tenantId, JSON.stringify([SYSTEM_ROLE])]
  );
  return r.rows;
}

/**
 * Archives a login (is_active = false): it can no longer sign in, and nothing
 * it did is erased. The last active owner of a firm cannot be archived, since
 * nobody would be left who can manage the firm.
 */
export async function archiveUser(input: { tenantId: string; email: string; reason: string }): Promise<{ id: string; email: string }> {
  const email = input.email.trim().toLowerCase();
  return inTenant(input.tenantId, async (client, systemUser) => {
    // Locking the active owners serialises two concurrent archives of the
    // last two owners, which would otherwise each see the other one left.
    const owners = await client.query<{ email: string }>(
      `SELECT email FROM public.users
        WHERE tenant_id = $1 AND is_active = true AND roles @> '["owner"]'::jsonb
        FOR UPDATE`,
      [input.tenantId]
    );
    if (owners.rows.length === 1 && owners.rows[0].email === email) {
      throw new ValidationError(`${email} is the last active owner of this firm; create another owner first.`);
    }

    const updated = await client.query<{ id: string }>(
      `UPDATE public.users SET is_active = false, updated_at = NOW()
        WHERE tenant_id = $1 AND email = $2 AND is_active = true AND NOT roles @> $3::jsonb
        RETURNING id`,
      [input.tenantId, email, JSON.stringify([SYSTEM_ROLE])]
    );
    if (updated.rowCount !== 1) {
      const seen = await client.query<{ is_active: boolean }>(
        `SELECT is_active FROM public.users WHERE tenant_id = $1 AND email = $2 AND NOT roles @> $3::jsonb`,
        [input.tenantId, email, JSON.stringify([SYSTEM_ROLE])]
      );
      if (seen.rows.length === 0) throw new NotFoundError(`User ${email} in this firm`);
      throw new ConflictError(`User ${email} is already archived.`);
    }
    const id = updated.rows[0].id;
    await registrarAuditoria(client, {
      tenantId: input.tenantId,
      userId: systemUser,
      action: 'update',
      entityType: 'users',
      entityId: id,
      oldValues: { is_active: true },
      newValues: { is_active: false },
      reason: input.reason,
    });
    return { id, email };
  });
}
