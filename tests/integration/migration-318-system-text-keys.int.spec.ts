import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';

/**
 * Migration 318 (MNE-001-170) adds the key columns that let system texts be
 * translated by key. It is run, not read: it is applied on top of every
 * earlier migration, as the runner applies it, and the resulting catalog is
 * asked what the columns are.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;

const BASE = `mnem_318_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const FILE_318 = fs.readdirSync(DIR).find((f) => f.startsWith('318_')) as string;

const NEW_COLUMNS: Array<[string, string, string]> = [
  ['journal_entries', 'description_key', 'character varying'],
  ['journal_entries', 'description_params', 'jsonb'],
  ['journal_entry_lines', 'description_key', 'character varying'],
  ['journal_entry_lines', 'description_params', 'jsonb'],
  ['audit_log', 'reason_key', 'character varying'],
  ['ai_drafts', 'review_kind', 'character varying'],
  ['fiscal_periods', 'period_key', 'character varying'],
  ['paycheck_taxes', 'notes_key', 'character varying'],
  ['paycheck_taxes', 'notes_params', 'jsonb'],
];

function urlWithDb(url: string, base: string): string {
  const u = new URL(url);
  u.pathname = `/${base}`;
  return u.toString();
}

let admin: pg.Client;
let db: pg.Client;

beforeAll(async () => {
  if (!ADMIN) throw new Error('TEST_ADMIN_DATABASE_URL / MIGRATION_DATABASE_URL / DATABASE_URL is missing');
  admin = new pg.Client({ connectionString: urlWithDb(ADMIN, 'postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${BASE}`);
  db = new pg.Client({ connectionString: urlWithDb(ADMIN, BASE) });
  await db.connect();
  await db.query('SET row_security = off');
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (f === FILE_318) continue; // applied explicitly below
    await db.query(fs.readFileSync(path.join(DIR, f), 'utf-8'));
  }
}, 600_000);

afterAll(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${BASE}`);
  await admin?.end();
});

async function column(table: string, name: string) {
  const r = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, name]
  );
  return r.rows[0];
}

describe('migration 318: key columns beside the system prose', () => {
  it('the columns do not exist before it runs', async () => {
    for (const [t, c] of NEW_COLUMNS) expect(await column(t, c), `${t}.${c}`).toBeUndefined();
  });

  it('adds every column nullable, with no default, and is idempotent', async () => {
    const sql = fs.readFileSync(path.join(DIR, FILE_318), 'utf-8');
    await db.query(sql);
    await db.query(sql);
    for (const [t, c, type] of NEW_COLUMNS) {
      const col = await column(t, c);
      expect(col, `${t}.${c}`).toBeDefined();
      expect(col.data_type).toBe(type);
      expect(col.is_nullable, `${t}.${c} nullable`).toBe('YES');
      expect(col.column_default, `${t}.${c} no default`).toBeNull();
    }
  });

  it('keeps period_name as the NOT NULL display name', async () => {
    expect((await column('fiscal_periods', 'period_name')).is_nullable).toBe('NO');
  });

  it('does not backfill: the file contains no data statement', () => {
    const sql = fs.readFileSync(path.join(DIR, FILE_318), 'utf-8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
  });
});
