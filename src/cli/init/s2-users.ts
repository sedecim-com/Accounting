import bcrypt from 'bcryptjs';
import { query } from '../../database/connection.js';
import type { CheckResult } from '../../ai/doctor-service.js';
import type { SectionContext, SectionStatus, SetupSection } from './section.js';

// ============================================================
// S2 · USERS AND ROLES
// The commands that attribute (review, outbox, dudas, memory)
// require a real user: this section defines WHO exists.
// Roles are materialized in users.roles/permissions (JSONB).
// ============================================================

/** Permissions per role. The API already consumes them via requirePermission(). */
export const ROLES = {
  owner: {
    label: 'Owner — everything, including fiscal credentials',
    permissions: ['*'],
  },
  contador: {
    label: 'Accountant — operates and approves, without touching SAT credentials',
    permissions: [
      'accounts:read', 'accounts:create', 'accounts:update',
      'journal_entries:read', 'journal_entries:create', 'journal_entries:post',
      'invoices:read', 'invoices:create', 'bills:read', 'bills:create', 'bills:approve',
      'reports:read', 'periods:close', 'settings:read',
    ],
  },
  revisor: {
    label: 'Reviewer — approves drafts and answers questions, does not configure',
    permissions: [
      'accounts:read', 'journal_entries:read', 'journal_entries:post',
      'invoices:read', 'bills:read', 'bills:approve', 'reports:read',
    ],
  },
  auditor: {
    label: 'Auditor — read-only, including the audit trail',
    permissions: [
      'accounts:read', 'journal_entries:read', 'invoices:read',
      'bills:read', 'reports:read', 'audit:read',
    ],
  },
} as const;

export type RoleName = keyof typeof ROLES;

const MIN_PASSWORD = 12;
const BCRYPT_ROUNDS = 12;

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
        name: 'Users', level: 'fail',
        detail: 'no active user: review/outbox/questions cannot attribute',
        fix: 'mnemosine init --section users',
      }];
    }
    if (owners === 0) {
      return [{
        name: 'Users', level: 'warn',
        detail: `${n} user(s) but none with the owner role`,
        fix: 'mnemosine init --section users',
      }];
    }
    // Multiple active users force --user in the commands that attribute:
    // that is correct, but it is worth saying before it surprises anyone.
    return [{
      name: 'Users', level: 'ok',
      detail: `${n} active, ${owners} owner(s)`,
      ...(n > 1 ? { fix: 'with multiple users, review/questions require --user <email>' } : {}),
    }];
  }

  async configure(ctx: SectionContext): Promise<void> {
    const existing = await query<{ email: string; roles: string[] }>(
      `SELECT email, roles FROM users WHERE is_active = true ORDER BY created_at`
    );

    if (existing.rows.length > 0) {
      ctx.print(`  Current users:`);
      for (const u of existing.rows) {
        const roles = Array.isArray(u.roles) ? u.roles.join(', ') : String(u.roles);
        ctx.print(`    · ${u.email} [${roles || 'no role'}]`);
      }
      if (!(await ctx.confirm('  Add another user?', false))) return;
    }

    const tenant = await query<{ id: string }>(
      `SELECT id FROM public.tenants ORDER BY created_at ASC LIMIT 1`
    );
    if (tenant.rows.length === 0) {
      ctx.print('  Configure the identity section first (there is no tenant).');
      return;
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
    if (!password || password.length < MIN_PASSWORD) {
      ctx.print(`  Password too short (minimum ${MIN_PASSWORD}); section incomplete.`);
      return;
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await query(
      `INSERT INTO users (tenant_id, email, password_hash, first_name, roles, permissions, accessible_entities)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, '[]'::jsonb)
       ON CONFLICT (tenant_id, email) DO UPDATE SET
         roles = EXCLUDED.roles, permissions = EXCLUDED.permissions, updated_at = NOW()`,
      [
        tenant.rows[0].id, email.toLowerCase(), hash, email.split('@')[0],
        JSON.stringify([role]), JSON.stringify(ROLES[role].permissions),
      ]
    );
    ctx.print(`  ✔ User ${email} created with role ${role}`);
  }
}
