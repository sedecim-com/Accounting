import bcrypt from 'bcryptjs';
import { query, currentTenant } from '../../database/connection.js';
import type { CheckIdentity, CheckResult } from '../../ai/doctor-service.js';
import type { SectionContext, SectionStatus, SetupSection } from './section.js';

// ============================================================
// S2 · USERS AND ROLES
// The commands that attribute (review, outbox, dudas, memory)
// require a real user: this section defines WHO exists.
// Roles are materialized in users.roles/permissions (JSONB).
// ============================================================

// El catálogo vive en src/auth/roles.ts. Aquí había una SEGUNDA copia, con
// nombres de rol distintos de los del middleware REST: un usuario creado por
// la terminal recibía permisos que la API no reconocía, y los roles `admin`
// y `controller` eran inalcanzables desde el único sitio donde se crean
// usuarios.
import { ROLES, type RoleName } from '../../auth/roles.js';
export { ROLES, type RoleName };

// One rule for both doors: the wizard and `mnemosine user create` (#326).
import { MIN_PASSWORD, BCRYPT_ROUNDS, validatePassword } from '../../services/user/user-service.js';
import { ValidationError } from '../../utils/errors.js';

/** Why the service would refuse this password, or null when it would take it. */
function passwordRefusal(password: string): string | null {
  try {
    validatePassword(password);
    return null;
  } catch (err) {
    if (err instanceof ValidationError) return err.message;
    throw err;
  }
}

/**
 * One check, three verdicts, one identity. What it measures is not "users" —
 * it is whether anybody is there to attribute a review to, and whether one of
 * them owns the install. See `CheckIdentity` in doctor-service.
 */
const USERS: CheckIdentity = { id: 'active-users-and-owner', name: 'Users' };

export class UsuariosSection implements SetupSection {
  readonly id = 'usuarios' as const;
  readonly title = 'Users and roles';
  readonly required = false; // the seed may have created one

  async status(): Promise<SectionStatus> {
    const r = await query<{ n: string; owners: string }>(
      `SELECT count(*)::text n,
              count(*) FILTER (WHERE roles @> '["owner"]')::text owners
       FROM users WHERE is_active = true`
    );
    const n = parseInt(r.rows[0].n, 10);
    if (n === 0) return 'missing';
    return parseInt(r.rows[0].owners, 10) === 0 ? 'partial' : 'ok';
  }

  async verify(): Promise<CheckResult[]> {
    const r = await query<{ n: string; owners: string }>(
      `SELECT count(*)::text n,
              count(*) FILTER (WHERE roles @> '["owner"]')::text owners
       FROM users WHERE is_active = true`
    );
    const n = parseInt(r.rows[0].n, 10);
    const owners = parseInt(r.rows[0].owners, 10);

    if (n === 0) {
      return [{
        ...USERS, level: 'fail',
        detail: 'no active user: review/outbox/questions cannot attribute',
        fix: 'mnemosine init --section users',
      }];
    }
    if (owners === 0) {
      return [{
        ...USERS, level: 'warn',
        detail: `${n} user(s) but none with the owner role`,
        fix: 'mnemosine init --section users',
      }];
    }
    // Multiple active users force --user in the commands that attribute:
    // that is correct, but it is worth saying before it surprises anyone.
    return [{
      ...USERS, level: 'ok',
      detail: `${n} active, ${owners} owner(s)`,
      ...(n > 1 ? { fix: 'with multiple users, review/questions require --user <email>' } : {}),
    }];
  }

  async configure(ctx: SectionContext): Promise<void> {
    const tenantId = await this.tenantForNewUser(ctx);
    if (!tenantId) return;

    // Scoped to that firm: `users` sits outside RLS, so without the filter this
    // listed the logins of every firm of the installation.
    const existing = await query<{ email: string; roles: string[] }>(
      `SELECT email, roles FROM users WHERE is_active = true AND tenant_id = $1 ORDER BY created_at`,
      [tenantId]
    );

    if (existing.rows.length > 0) {
      ctx.print(`  Current users:`);
      for (const u of existing.rows) {
        const roles = Array.isArray(u.roles) ? u.roles.join(', ') : String(u.roles);
        ctx.print(`    · ${u.email} [${roles || 'no role'}]`);
      }
      if (!(await ctx.confirm('  Add another user?', false))) return;
    }

    const email = ctx.flags.user ?? (await ctx.askText('  User email: '));
    if (!email || !email.includes('@')) {
      ctx.print('  Invalid email; section incomplete.');
      return;
    }

    ctx.print('  Available roles:');
    const names = Object.keys(ROLES) as RoleName[];
    names.forEach((r, i) => ctx.print(`    ${i + 1}) ${r} — ${ROLES[r].label}`));
    const pick = await ctx.askText(`  Role [1-${names.length}] (1): `, '1');
    const idx = Math.min(Math.max(parseInt(pick ?? '1', 10) || 1, 1), names.length) - 1;
    const role = names[idx];

    // The password is asked with hidden echo and is NEVER printed or logged.
    const password = await ctx.askSecret(`  Password (minimum ${MIN_PASSWORD} characters): `);
    const refused = passwordRefusal(password ?? '');
    if (password === null || refused !== null) {
      ctx.print(`  ${refused ?? ''} Section incomplete.`);
      ctx.print('  Without a terminal: mnemosine user create --email <address> --role <name> --password-stdin');
      return;
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await query(
      `INSERT INTO users (tenant_id, email, password_hash, first_name, roles, permissions, accessible_entities)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, '[]'::jsonb)
       ON CONFLICT (tenant_id, email) DO UPDATE SET
         roles = EXCLUDED.roles, permissions = EXCLUDED.permissions, updated_at = NOW()`,
      [
        tenantId, email.toLowerCase(), hash, email.split('@')[0],
        JSON.stringify([role]), JSON.stringify(ROLES[role].permissions),
      ]
    );
    ctx.print(`  ✔ User ${email} created with role ${role}`);
  }

  /**
   * The firm the new login belongs to, resolved the way `entity create` does
   * (resolveTenantForCreation): the tenant in effect (--tenant, else
   * MNEMOSINE_TENANT) when it exists; the only one when there is one; and a
   * refusal naming them all when there are several. Guessing here would grant
   * one firm's staff access to another firm's books. Null means "stop".
   */
  private async tenantForNewUser(ctx: SectionContext): Promise<string | null> {
    const named = currentTenant() ?? process.env.MNEMOSINE_TENANT ?? null;
    if (named) {
      const found = await query<{ id: string }>(
        `SELECT id FROM public.tenants WHERE id::text = $1`,
        [named]
      );
      if (found.rows.length === 0) {
        ctx.print(`  Tenant ${named} does not exist; section incomplete (see: mnemosine tenant list).`);
        return null;
      }
      return found.rows[0].id;
    }

    const all = await query<{ id: string; name: string }>(
      `SELECT id, name FROM public.tenants ORDER BY created_at ASC`
    );
    if (all.rows.length === 0) {
      ctx.print('  Configure the identity section first (there is no tenant).');
      return null;
    }
    if (all.rows.length > 1) {
      ctx.print('  This installation has more than one tenant: name the firm with --tenant.');
      ctx.print('  Choosing for you could give this login another firm\'s books:');
      for (const t of all.rows) ctx.print(`    - ${t.name} → ${t.id}`);
      ctx.print('  Section incomplete.');
      return null;
    }
    return all.rows[0].id;
  }
}
