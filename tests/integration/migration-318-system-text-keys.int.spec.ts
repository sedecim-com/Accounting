import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
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

const PRE_EXISTING_ROW = randomUUID();

const NEW_COLUMNS: Array<[string, string, string, number | null]> = [
  ['journal_entries', 'description_key', 'character varying', 80],
  ['journal_entries', 'description_params', 'jsonb', null],
  ['journal_entry_lines', 'description_key', 'character varying', 80],
  ['journal_entry_lines', 'description_params', 'jsonb', null],
  ['audit_log', 'reason_key', 'character varying', 80],
  ['audit_log', 'reason_params', 'jsonb', null],
  ['ai_drafts', 'review_kind', 'character varying', 50],
  ['fiscal_periods', 'period_key', 'character varying', 20],
  ['paycheck_taxes', 'notes_key', 'character varying', 80],
  ['paycheck_taxes', 'notes_params', 'jsonb', null],
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
  await db.query(
    `INSERT INTO audit_log (id, user_id, tenant_id, action, entity_type, entity_id, reason)
     VALUES ($1, $2, $3, 'update', 'fixture', $4, 'Reversal of JE-1')`,
    [PRE_EXISTING_ROW, randomUUID(), randomUUID(), randomUUID()]
  );
}, 600_000);

afterAll(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${BASE}`);
  await admin?.end();
});

async function column(table: string, name: string) {
  const r = await db.query<{
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    character_maximum_length: number | null;
  }>(
    `SELECT data_type, is_nullable, column_default, character_maximum_length FROM information_schema.columns
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
    for (const [t, c, type, len] of NEW_COLUMNS) {
      const col = await column(t, c);
      expect(col, `${t}.${c}`).toBeDefined();
      expect(col.data_type).toBe(type);
      expect(col.character_maximum_length, `${t}.${c} length`).toBe(len);
      expect(col.is_nullable, `${t}.${c} nullable`).toBe('YES');
      expect(col.column_default, `${t}.${c} no default`).toBeNull();
    }
  });

  it('leaves a row persisted before it with its prose and NULL keys', async () => {
    const r = await db.query(
      'SELECT reason, reason_key, reason_params FROM audit_log WHERE id = $1',
      [PRE_EXISTING_ROW]
    );
    expect(r.rows).toEqual([{ reason: 'Reversal of JE-1', reason_key: null, reason_params: null }]);
  });

  it('keeps period_name as the NOT NULL display name', async () => {
    expect((await column('fiscal_periods', 'period_name')).is_nullable).toBe('NO');
  });

  it('does not backfill: the file contains no data statement', () => {
    const sql = fs.readFileSync(path.join(DIR, FILE_318), 'utf-8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
  });
});
