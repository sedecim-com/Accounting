import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { checkDatabase, checkMigrations, checkEncryptionKey } from '../../ai/doctor-service.js';
import type { CheckResult } from '../../ai/doctor-service.js';
import { query, enterTenant } from '../../database/connection.js';
import type { SectionContext, SectionStatus, SetupSection } from './section.js';

// ============================================================
// S0 · INFRASTRUCTURE
// .env, database connection, migrations and encryption key.
// Without this nothing else makes sense, so it goes first and
// cannot be skipped.
// ============================================================

/** Writes/updates a variable in .env without touching the rest of the file. */
export function upsertEnvVar(envPath: string, key: string, value: string): void {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    if (content && !content.endsWith('\n')) content += '\n';
    content += line + '\n';
  }
  // 600: the .env carries secrets and must not be readable by other users.
  fs.writeFileSync(envPath, content, { mode: 0o600 });
}

export function readEnvVar(envPath: string, key: string): string | null {
  if (!fs.existsSync(envPath)) return null;
  const m = fs.readFileSync(envPath, 'utf-8').match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}

export interface InfraDeps {
  cwd?: string;
  /** Injectable in tests so real migrations do not run. */
  runMigrations?: () => void;
  randomKey?: () => string;
}

export class InfraSection implements SetupSection {
  readonly id = 'infra' as const;
  readonly title = 'Infrastructure (database, migrations, encryption)';
  readonly required = true;

  constructor(private readonly deps: InfraDeps = {}) {}

  private get cwd(): string {
    return this.deps.cwd ?? process.cwd();
  }
  private get envPath(): string {
    return path.join(this.cwd, '.env');
  }

  async status(): Promise<SectionStatus> {
    const checks = await this.verify();
    if (checks.some((c) => c.level === 'fail')) return 'missing';
    if (checks.some((c) => c.level === 'warn')) return 'partial';
    return 'ok';
  }

  async verify(): Promise<CheckResult[]> {
    const db = await checkDatabase();
    // Without a database the migrations table cannot be queried.
    if (db.level === 'fail') return [db, checkEncryptionKey()];
    return [
      db,
      await checkMigrations({ migrationsDir: path.join(this.cwd, 'src/database/migrations') }),
      await this.checkRlsContext(),
      checkEncryptionKey(),
    ];
  }

  /**
   * RLS smoke test: enters the pinned tenant and runs a scoped SELECT so the
   * whole chain (env var → set_config inside the transaction → policy) is
   * exercised for real, not assumed. Without a pinned tenant there is nothing
   * to verify yet — the identity section pins it — so the check passes with a
   * note instead of alarming on a half-finished install.
   */
  private async checkRlsContext(): Promise<CheckResult> {
    const tenant = process.env.MNEMOSINE_TENANT ?? readEnvVar(this.envPath, 'MNEMOSINE_TENANT');
    if (!tenant) {
      return {
        name: 'RLS context',
        level: 'ok',
        detail: 'no tenant pinned yet (the identity section pins it)',
      };
    }
    try {
      enterTenant(tenant);
      const r = await query<{ tenant: string | null; entities: string }>(
        `SELECT current_setting('app.current_tenant', true) AS tenant,
                (SELECT count(*)::text FROM legal_entities) AS entities`
      );
      const applied = r.rows[0]?.tenant ?? null;
      if (applied !== tenant) {
        return {
          name: 'RLS context',
          level: 'fail',
          detail: `app.current_tenant is "${applied ?? ''}" instead of "${tenant}": queries would run unscoped`,
          fix: 'Check MNEMOSINE_TENANT in .env; the connection module must apply the tenant on every query',
        };
      }
      return {
        name: 'RLS context',
        level: 'ok',
        detail: `tenant ${tenant} scoped · ${r.rows[0].entities} entities visible`,
      };
    } catch (err) {
      return {
        name: 'RLS context',
        level: 'fail',
        detail: `scoped SELECT failed: ${(err as Error).message}`,
        fix: 'npm run migrate (the legal_entities table or its RLS policies may be missing)',
      };
    }
  }

  async configure(ctx: SectionContext): Promise<void> {
    // 1. .env from the example if it does not exist
    if (!fs.existsSync(this.envPath)) {
      const example = path.join(this.cwd, '.env.example');
      if (fs.existsSync(example)) {
        fs.copyFileSync(example, this.envPath);
        fs.chmodSync(this.envPath, 0o600);
        ctx.print('  Created .env from .env.example');
      } else {
        fs.writeFileSync(this.envPath, '', { mode: 0o600 });
        ctx.print('  Created an empty .env');
      }
    }

    // 2. Encryption key: the example default is nominal encryption.
    const current = process.env.ENCRYPTION_KEY ?? readEnvVar(this.envPath, 'ENCRYPTION_KEY');
    if (!current || /^0+$/.test(current) || current.length !== 64) {
      const key = (this.deps.randomKey ?? defaultRandomKey)();
      upsertEnvVar(this.envPath, 'ENCRYPTION_KEY', key);
      process.env.ENCRYPTION_KEY = key;
      ctx.print('  Generated a dedicated 256-bit ENCRYPTION_KEY (the previous one was the example key)');
    }

    // 3. Connection
    const db = await checkDatabase();
    if (db.level === 'fail') {
      ctx.print(`  ✘ ${db.detail}`);
      const url = await ctx.askText(
        '  DATABASE_URL (Enter to keep the current one): ',
        readEnvVar(this.envPath, 'DATABASE_URL') ?? undefined
      );
      if (url) {
        upsertEnvVar(this.envPath, 'DATABASE_URL', url);
        process.env.DATABASE_URL = url;
        ctx.print('  Saved DATABASE_URL. Restart the command to reconnect.');
      } else {
        ctx.print('  Start PostgreSQL and run again: docker compose up -d postgres');
      }
      return; // without a database we cannot continue
    }
    ctx.print(`  ✔ ${db.detail}`);

    // 4. Migrations
    const mig = await checkMigrations({
      migrationsDir: path.join(this.cwd, 'src/database/migrations'),
    });
    if (mig.level === 'fail') {
      ctx.print(`  ${mig.detail}`);
      if (await ctx.confirm('  Apply the migrations now?', true)) {
        try {
          (this.deps.runMigrations ?? defaultRunMigrations)();
          ctx.print('  ✔ Migrations applied');
        } catch (err) {
          ctx.print(`  ✘ Failed: ${(err as Error).message}`);
          ctx.print('  Run manually: npm run migrate');
        }
      }
    } else {
      ctx.print(`  ✔ ${mig.detail}`);
    }

    // 5. RLS context: VERIFY only, never reconfigure — the tenant belongs to
    // the identity section, and re-running infra must not reset its state.
    const rls = await this.checkRlsContext();
    ctx.print(`  ${rls.level === 'ok' ? '✔' : '✘'} RLS: ${rls.detail}`);
    if (rls.level === 'fail' && rls.fix) ctx.print(`     Fix: ${rls.fix}`);
  }
}

function defaultRandomKey(): string {
  // randomBytes, NOT Math.random: this key protects fiscal credentials and
  // a non-cryptographic PRNG would make it predictable. 32 bytes = 64 hex (AES-256).
  return crypto.randomBytes(32).toString('hex');
}

function defaultRunMigrations(): void {
  execFileSync('npm', ['run', 'migrate'], { stdio: 'pipe' });
}
