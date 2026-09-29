import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pg from 'pg';
import { applyMigrations, MIGRATION_LOCK_NAME } from '../../src/database/migrate';

/**
 * TWO `npm run migrate` AT ONCE APPLY EACH MIGRATION ONCE (#373 · MNE-001-108).
 *
 * The platform deploys with `kubectl apply`, and the migration runs as a
 * pre-step or a Job: two replicas, or two overlapping deploys, can start the
 * runner against the same database at the same moment. Each run reads
 * public.migrations, sees the same pending file, and both execute it. The
 * per-file transaction keeps the bookkeeping row unique, but the loser dies
 * on the duplicate (and a deploy goes red), and whatever the file did outside
 * transactional state (a sequence, a notification) happened twice.
 *
 * The bench is a scratch database and a scratch migrations directory, so the
 * runner's real loop runs without touching the suite's shared database. Every
 * scratch migration draws from a sequence: nextval is NOT rolled back, so its
 * last value counts executions, not commits.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;

const DATABASE = `mnem_lock_${randomBytes(4).toString('hex')}`;

const urlWithDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

let admin: pg.Client;
const clients: pg.Client[] = [];
let tmpRoot: string;

async function connect(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlWithDatabase(ADMIN as string, DATABASE) });
  await c.connect();
  clients.push(c);
  return c;
}

function migrationsDir(name: string, files: Record<string, string>): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir);
  for (const [file, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), sql);
  return dir;
}

async function executions(c: pg.Client, sequence: string): Promise<number> {
  const { rows } = await c.query<{ n: string; called: boolean }>(
    `SELECT last_value AS n, is_called AS called FROM ${sequence}`
  );
  return rows[0].called ? Number(rows[0].n) : 0;
}

beforeAll(async () => {
  if (!ADMIN) throw new Error('missing TEST_ADMIN_DATABASE_URL / MIGRATION_DATABASE_URL / DATABASE_URL');
  admin = new pg.Client({ connectionString: urlWithDatabase(ADMIN, 'postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DATABASE}`);
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mnem-migrate-lock-'));
});

afterAll(async () => {
  for (const c of clients) await c.end().catch(() => undefined);
  if (admin) {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DATABASE]
    );
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
    await admin.end();
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('npm run migrate under an advisory lock', () => {
  it('two concurrent runs both succeed, and each migration executes exactly once', async () => {
    const setup = await connect();
    await setup.query('CREATE SEQUENCE concurrent_runs');
    const dir = migrationsDir('concurrent', {
      // The sleep holds the first run inside 001 long enough for the second
      // one to reach the same file if nothing stops it.
      '001_slow.sql': "SELECT nextval('concurrent_runs'); SELECT pg_sleep(0.5); CREATE TABLE lock_once (id int);",
      '002_count.sql': "SELECT nextval('concurrent_runs'); INSERT INTO lock_once VALUES (2);",
    });

    const [a, b] = await Promise.all([connect(), connect()]);
    const results = await Promise.all([
      applyMigrations(a, { migrationsDir: dir, hardeningPath: null }),
      applyMigrations(b, { migrationsDir: dir, hardeningPath: null }),
    ]);

    expect(results).toEqual([true, true]);
    expect(await executions(setup, 'concurrent_runs')).toBe(2);
    const { rows } = await setup.query<{ filename: string }>(
      'SELECT filename FROM public.migrations ORDER BY filename'
    );
    expect(rows.map((r) => r.filename)).toEqual(['001_slow.sql', '002_count.sql']);
  });

  it('a run waits while another holds the lock, then proceeds', async () => {
    const holder = await connect();
    await holder.query('CREATE SEQUENCE waiting_runs');
    const dir = migrationsDir('waiting', {
      '001_count.sql': "SELECT nextval('waiting_runs');",
    });
    await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [MIGRATION_LOCK_NAME]);

    const runner = await connect();
    let settled = false;
    const run = applyMigrations(runner, { migrationsDir: dir, hardeningPath: null }).finally(() => {
      settled = true;
    });
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false);
      expect(await executions(holder, 'waiting_runs')).toBe(0);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATION_LOCK_NAME]);
    }
    expect(await run).toBe(true);
    expect(await executions(holder, 'waiting_runs')).toBe(1);
  });

  it('a failing migration still releases the lock', async () => {
    const dir = migrationsDir('failing', {
      '001_boom.sql': 'SELECT 1 / 0;',
    });
    const runner = await connect();
    expect(await applyMigrations(runner, { migrationsDir: dir, hardeningPath: null })).toBe(false);

    // The runner's session is still open, as it is in a Job that keeps its
    // connection until the process exits: the lock must be free NOW, from
    // any other session, not merely when the connection closes.
    const other = await connect();
    const { rows } = await other.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok',
      [MIGRATION_LOCK_NAME]
    );
    expect(rows[0].ok).toBe(true);
    await other.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATION_LOCK_NAME]);
  });

  it('a run whose session no longer holds the lock at the end is red', async () => {
    // Through a transaction-mode pooler the lock is taken on one backend and
    // the unlock runs on another, where pg_advisory_unlock returns false and
    // only warns. The migration below drops the lock itself, which is the same
    // state seen from the runner: the unlock finds nothing to release.
    const dir = migrationsDir('not-held', {
      '001_drop_lock.sql': `SELECT pg_advisory_unlock(hashtextextended('${MIGRATION_LOCK_NAME}', 0));`,
    });
    const runner = await connect();
    expect(await applyMigrations(runner, { migrationsDir: dir, hardeningPath: null })).toBe(false);
  });
});
