import fs from 'node:fs';
import path from 'node:path';
import { query } from '../database/connection.js';
import { config } from '../config/index.js';
import { isLocalHost, defaultSslMode } from '../database/ssl.js';
import { DB_PROVIDERS } from '../database/providers.js';
import { listProfiles } from './providers/config.js';

// ============================================================
// DOCTOR — health diagnostics
// Answers "why isn't it working?" without reading code. Each
// check says what is wrong AND the command that fixes it; never
// just the symptom.
// ============================================================

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  level: CheckLevel;
  detail: string;
  /** Concrete command or action when something is wrong. */
  fix?: string;
}

export interface DoctorReport {
  checks: CheckResult[];
  /** fail = the system cannot operate; warn = operates degraded. */
  worst: CheckLevel;
}

export interface DoctorDeps {
  migrationsDir?: string;
  cwd?: string;
  /** Injectable to test without touching disk or network. */
  now?: Date;
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const checks: CheckResult[] = [];

  checks.push(await checkDatabase());
  // Without a database the remaining checks mean nothing.
  if (checks[0].level !== 'fail') {
    checks.push(await checkMigrations(deps));
    checks.push(await checkEntities());
    checks.push(await checkAccountRoles());
    checks.push(checkConnectionTransport());
    checks.push(await checkTenantIsolation());
    checks.push(await checkPendingWork());
    checks.push(await checkCredentials(deps.now ?? new Date()));
  }
  checks.push(checkModelProvider(deps.cwd));
  checks.push(checkEncryptionKey());

  const worst: CheckLevel = checks.some((c) => c.level === 'fail')
    ? 'fail'
    : checks.some((c) => c.level === 'warn')
      ? 'warn'
      : 'ok';
  return { checks, worst };
}

export async function checkDatabase(): Promise<CheckResult> {
  try {
    const r = await query<{ v: string }>('SELECT version() AS v');
    const version = r.rows[0].v.split(' ').slice(0, 2).join(' ');
    return { name: 'Database', level: 'ok', detail: version };
  } catch (err) {
    return {
      name: 'Database',
      level: 'fail',
      detail: `no connection: ${(err as Error).message}`,
      fix: 'Check DATABASE_URL in .env and that PostgreSQL is running (docker compose up -d postgres)',
    };
  }
}

export async function checkMigrations(deps: DoctorDeps): Promise<CheckResult> {
  // Anchored to this module, not to process.cwd(): running the CLI from
  // another directory used to report "missing migrations" that were applied.
  // __dirname is src/ai in dev and dist/ai in a build; both resolve correctly.
  const dir = deps.migrationsDir ?? path.join(__dirname, '../database/migrations');
  let onDisk: string[] = [];
  try {
    onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  } catch {
    return { name: 'Migrations', level: 'warn', detail: `could not read ${dir}` };
  }

  const applied = await query<{ filename: string }>('SELECT filename FROM public.migrations');
  const appliedSet = new Set(applied.rows.map((r) => r.filename));
  const missing = onDisk.filter((f) => !appliedSet.has(f));

  if (missing.length > 0) {
    return {
      name: 'Migrations',
      level: 'fail',
      detail: `${missing.length} unapplied: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`,
      fix: 'npm run migrate',
    };
  }
  return { name: 'Migrations', level: 'ok', detail: `${appliedSet.size} applied` };
}

export async function checkEntities(): Promise<CheckResult> {
  const r = await query<{ n: string }>(
    `SELECT count(*)::text n FROM legal_entities WHERE is_active = true`
  );
  const n = parseInt(r.rows[0].n, 10);
  if (n === 0) {
    return {
      name: 'Legal entities',
      level: 'fail',
      detail: 'no active entities',
      fix: 'mnemosine init  (or npm run seed for demo data)',
    };
  }
  return { name: 'Legal entities', level: 'ok', detail: `${n} active` };
}


/**
 * Los account_roles traducen semántica contable («cxc», «iva_acreditable») a
 * un código de cuenta. Sin ellos, la primera factura de una entidad falla con
 * MISSING_ROLE_ACCOUNT y no hay forma de saberlo hasta que ocurre. Este
 * chequeo lo dice antes.
 */
export async function checkAccountRoles(): Promise<CheckResult> {
  const r = await query<{ entidad: string; nombre: string; mapeados: string; total: string }>(
    `SELECT e.id AS entidad, e.name AS nombre,
            count(ar.role)::text AS mapeados,
            (SELECT count(*)::text FROM account_roles WHERE entity_id = e.id AND qualifier IS NULL) AS total
     FROM legal_entities e
     LEFT JOIN account_roles ar ON ar.entity_id = e.id AND ar.qualifier IS NULL
     WHERE e.is_active = true
     GROUP BY e.id, e.name`
  );
  if (r.rows.length === 0) {
    return { name: 'Account roles', level: 'ok', detail: 'no active entities to check' };
  }
  const sinSembrar = r.rows.filter((x) => parseInt(x.mapeados, 10) === 0);
  if (sinSembrar.length > 0) {
    return {
      name: 'Account roles',
      level: 'fail',
      detail: `${sinSembrar.length} entity(ies) without account roles: ${sinSembrar
        .map((x) => x.nombre)
        .slice(0, 3)
        .join(', ')} — invoices and bills cannot post`,
      fix: 'mnemosine init --section identity',
    };
  }
  const total = r.rows.reduce((n, x) => n + parseInt(x.mapeados, 10), 0);
  return {
    name: 'Account roles',
    level: 'ok',
    detail: `${total} role(s) mapped across ${r.rows.length} entity(ies)`,
  };
}

/**
 * The connection's transport: TLS mode and, if configured, the SSH tunnel.
 * `require` is the trap here — it encrypts and verifies nothing, so it reads
 * as protected while leaving a man-in-the-middle wide open.
 */
export function checkConnectionTransport(): CheckResult {
  const url = config.database.url;
  const local = isLocalHost(url);
  const tunneled = Boolean(config.database.tunnel);
  const mode = (config.database.sslMode || defaultSslMode(url)) as string;

  const parts: string[] = [];
  if (config.database.provider) {
    parts.push(`provider ${config.database.provider}`);
  }
  parts.push(tunneled ? 'via SSH tunnel' : local ? 'local' : 'direct');
  parts.push(`sslmode=${mode}`);
  const detail = parts.join(' · ');

  if (!local && mode === 'disable') {
    return {
      name: 'Connection transport',
      level: 'fail',
      detail: `${detail} — credentials and data travel in the clear`,
      fix: 'Set DATABASE_SSL_MODE=verify-full',
    };
  }
  if (!local && mode === 'require') {
    return {
      name: 'Connection transport',
      level: 'warn',
      detail: `${detail} — encrypts but does NOT verify the certificate`,
      fix: 'Set DATABASE_SSL_MODE=verify-full (or verify-ca behind a tunnel)',
    };
  }

  // Provider caveats are the point of the preset: they surface the traps that
  // silently break isolation, like Neon's default role bypassing RLS.
  const preset = config.database.provider ? DB_PROVIDERS[config.database.provider] : undefined;
  return {
    name: 'Connection transport',
    level: 'ok',
    detail,
    ...(preset?.caveats.length ? { fix: preset.caveats[0] } : {}),
  };
}

/**
 * RLS can be enabled yet inert: a SUPERUSER role or one with BYPASSRLS
 * ignores it. Distinguishing that is the difference between believing there
 * is isolation and actually having it.
 */
export async function checkTenantIsolation(): Promise<CheckResult> {
  const r = await query<{ current_user: string; is_super: boolean; bypass: boolean; rls_tables: string }>(
    `SELECT current_user,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
            (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
            (SELECT count(*)::text FROM pg_tables t
              WHERE t.schemaname = 'public' AND t.rowsecurity) AS rls_tables`
  );
  const row = r.rows[0];
  const tables = parseInt(row.rls_tables, 10);

  if (tables === 0) {
    return {
      name: 'Tenant isolation',
      level: 'warn',
      detail: 'RLS is not enabled on any table',
      fix: 'npm run migrate (re-applies src/database/rls-policies.sql)',
    };
  }
  if (row.is_super || row.bypass) {
    return {
      name: 'Tenant isolation',
      level: 'warn',
      detail: `RLS enabled on ${tables} tables, but role "${row.current_user}" bypasses it (${row.is_super ? 'SUPERUSER' : 'BYPASSRLS'})`,
      fix: 'Connect as mnemosine_app: see scripts/provision-roles.sql',
    };
  }
  return {
    name: 'Tenant isolation',
    level: 'ok',
    detail: `RLS enabled on ${tables} tables, role "${row.current_user}" subject to policies`,
  };
}

export async function checkPendingWork(): Promise<CheckResult> {
  const r = await query<{ drafts: string; questions: string; ops: string }>(
    `SELECT
       (SELECT count(*)::text FROM ai_drafts WHERE status = 'pending_review') AS drafts,
       (SELECT count(*)::text FROM ai_questions WHERE status = 'pending') AS questions,
       (SELECT count(*)::text FROM ai_external_ops WHERE status = 'pending') AS ops`
  );
  const n = {
    drafts: parseInt(r.rows[0].drafts, 10),
    questions: parseInt(r.rows[0].questions, 10),
    ops: parseInt(r.rows[0].ops, 10),
  };
  const total = n.drafts + n.questions + n.ops;
  if (total === 0) return { name: 'Pending work', level: 'ok', detail: 'nothing queued' };
  const parts = [
    n.drafts && `${n.drafts} ${n.drafts === 1 ? 'draft' : 'drafts'}`,
    n.questions && `${n.questions} ${n.questions === 1 ? 'question' : 'questions'}`,
    n.ops && `${n.ops} ${n.ops === 1 ? 'write' : 'writes'}`,
  ].filter(Boolean);
  return {
    name: 'Pending work',
    level: 'ok', // having work is not a health problem
    detail: parts.join(', '),
    fix: 'mnemosine pending',
  };
}

export async function checkCredentials(now: Date): Promise<CheckResult> {
  const r = await query<{ n: string; soonest: string | null }>(
    `SELECT count(*)::text n, MIN(valid_to)::text AS soonest
     FROM fiscal_credentials WHERE status = 'active'`
  );
  const n = parseInt(r.rows[0].n, 10);
  if (n === 0) {
    return {
      name: 'Fiscal credentials',
      level: 'ok',
      detail: 'none loaded (not required to operate)',
      fix: 'mnemosine sat cred add  (only if you will download from the SAT)',
    };
  }
  const soonest = r.rows[0].soonest ? new Date(r.rows[0].soonest) : null;
  const days = soonest ? Math.floor((soonest.getTime() - now.getTime()) / 86_400_000) : null;
  if (days !== null && days <= 0) {
    return {
      name: 'Fiscal credentials',
      level: 'fail',
      detail: `${n} loaded, the next one has ALREADY EXPIRED`,
      fix: 'Renew the e.firma at the SAT and reload it: mnemosine sat cred add',
    };
  }
  if (days !== null && days <= 30) {
    return {
      name: 'Fiscal credentials',
      level: 'warn',
      detail: `${n} loaded, expires in ${days} days`,
      fix: 'Renew the e.firma at the SAT before that date',
    };
  }
  return { name: 'Fiscal credentials', level: 'ok', detail: `${n} valid` };
}

export function checkModelProvider(cwd?: string): CheckResult {
  let profiles: ReturnType<typeof listProfiles>;
  try {
    profiles = listProfiles(cwd);
  } catch (err) {
    return {
      name: 'Model provider',
      level: 'fail',
      detail: (err as Error).message,
      fix: 'Fix mnemosine.config.json',
    };
  }

  const { profiles: all, defaultName } = profiles;
  const active = all[defaultName];
  if (!active) {
    return {
      name: 'Model provider',
      level: 'fail',
      detail: `the default "${defaultName}" does not exist`,
      fix: 'mnemosine providers  (pick a valid one)',
    };
  }
  // No api_key_env = local without a credential (ollama): ready to use.
  if (!active.api_key_env) {
    return {
      name: 'Model provider',
      level: 'ok',
      detail: `${defaultName} · ${active.model} (local, no credential)`,
    };
  }
  if (!process.env[active.api_key_env]) {
    const withKey = Object.entries(all).filter(
      ([, p]) => !p.api_key_env || process.env[p.api_key_env]
    );
    return {
      name: 'Model provider',
      level: 'fail',
      detail: `${defaultName} requires ${active.api_key_env} and it is not set`,
      fix: withKey.length
        ? `Set ${active.api_key_env} in .env, or use --provider ${withKey[0][0]}`
        : `Set ${active.api_key_env} in .env`,
    };
  }
  return {
    name: 'Model provider',
    level: 'ok',
    detail: `${defaultName} · ${active.model}`,
  };
}

/** The example default (64 zeros) is nominal encryption: it must be shouted. */
export function checkEncryptionKey(): CheckResult {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    return {
      name: 'Encryption key',
      level: 'warn',
      detail: 'ENCRYPTION_KEY not set (the code default is used)',
      fix: 'openssl rand -hex 32  → ENCRYPTION_KEY in .env',
    };
  }
  if (/^0+$/.test(key)) {
    return {
      name: 'Encryption key',
      level: 'fail',
      detail: 'ENCRYPTION_KEY is the EXAMPLE key (zeros): "encrypted" data is not protected',
      fix: 'openssl rand -hex 32  → replace ENCRYPTION_KEY in .env',
    };
  }
  if (key.length !== 64) {
    return {
      name: 'Encryption key',
      level: 'fail',
      detail: `ENCRYPTION_KEY is ${key.length} characters long; 64 hex expected`,
      fix: 'openssl rand -hex 32',
    };
  }
  return { name: 'Encryption key', level: 'ok', detail: 'own 256-bit key' };
}
