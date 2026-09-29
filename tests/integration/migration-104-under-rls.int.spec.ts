import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';

/**
 * 104 GIVES EXISTING FISCAL YEARS THEIR PERIOD 13, ON AN INSTALLED, HARDENED
 * FIRM (#304 · MNE-001-046).
 *
 * The bench of tests/integration/migration-102-under-rls.int.spec.ts: the
 * runner is a NOBYPASSRLS role that owns the tables, the policies carry their
 * FORCE, and the session has the `row_security = off` floor of migrate.ts. A
 * bare INSERT ... SELECT over fiscal_years would throw 42501 here; under the
 * superuser the rest of the suite uses it would have "worked" and proved
 * nothing.
 *
 * Two firms, so a loop that only reached one of them is visible, and three
 * kinds of year: one still open (it gets period 13), one whose December is
 * already hard closed, and one that already emitted its closing entries in
 * December. Those two keep what they have: a period 13 added after their
 * close would be an empty month 13, the file that is accepted and does not
 * contain the close.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;

const DATABASE = `mnem_104_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const FILE_104 = '104_every_fiscal_year_gets_its_period_13.sql';
const MIGRATOR = `it_mig104_${randomBytes(4).toString('hex')}`;

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
/** Year id → what 104 must leave it with. */
const YEARS = {
  openA: randomUUID(),
  openB: randomUUID(),
  futureB: randomUUID(),
  hardClosedA: randomUUID(),
  closedInDecemberB: randomUUID(),
};

const urlWithDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

const sqlOf = (file: string): string => fs.readFileSync(path.join(DIR, file), 'utf-8');

let admin: pg.Client;
let db: pg.Client;
/** A superuser on THIS database: the runner cannot read what it is judged on. */
let verifier: pg.Client;
let said: string[] = [];

/** Applies 104 as migrate.ts does: in one transaction, with the floor on. */
async function apply104(): Promise<void> {
  await db.query('SET row_security = off');
  await db.query('BEGIN');
  try {
    await db.query(sqlOf(FILE_104));
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

/** One entity with one calendar year and its twelve months, December in `december`. */
async function seedYear(entity: string, yearId: string, year: number, december: string) {
  await db.query(
    `INSERT INTO fiscal_years (id, entity_id, year_number, start_date, end_date, is_calendar_year, status)
     VALUES ($1, $2, $3, $4, $5, true, 'open')`,
    [yearId, entity, year, `${year}-01-01`, `${year}-12-31`]
  );
  for (let m = 1; m <= 12; m++) {
    const end = new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
    await db.query(
      `INSERT INTO fiscal_periods (fiscal_year_id, entity_id, period_number, period_name, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [yearId, entity, m, `M${m} ${year}`, `${year}-${String(m).padStart(2, '0')}-01`, end,
       m === 12 ? december : 'open']
    );
  }
}

async function period13Of(yearId: string): Promise<Array<Record<string, string>>> {
  const { rows } = await verifier.query<Record<string, string>>(
    `SELECT period_type, period_name, start_date::text AS start_date, end_date::text AS end_date, status
       FROM fiscal_periods WHERE fiscal_year_id = $1 AND period_number = 13`,
    [yearId]
  );
  return rows;
}

beforeAll(async () => {
  if (!ADMIN) throw new Error('missing TEST_ADMIN_DATABASE_URL / MIGRATION_DATABASE_URL / DATABASE_URL');
  admin = new pg.Client({ connectionString: urlWithDatabase(ADMIN, 'postgres') });
  await admin.connect();
  await admin.query(`CREATE ROLE ${MIGRATOR} NOLOGIN NOBYPASSRLS`);
  await admin.query(`GRANT ${MIGRATOR} TO CURRENT_USER`);
  await admin.query(`CREATE DATABASE ${DATABASE} OWNER ${MIGRATOR}`);

  db = new pg.Client({ connectionString: urlWithDatabase(ADMIN, DATABASE) });
  await db.connect();
  (db as unknown as { on(e: 'notice', cb: (n: { severity?: string; message?: string }) => void): void })
    .on('notice', (n) => said.push(`${n.severity}: ${n.message}`));
  verifier = new pg.Client({ connectionString: urlWithDatabase(ADMIN, DATABASE) });
  await verifier.connect();

  await db.query(`SET ROLE ${MIGRATOR}`);
  await db.query(
    'CREATE TABLE public.migrations (id SERIAL PRIMARY KEY, filename VARCHAR(255) UNIQUE NOT NULL, executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
  );
  await db.query('SET row_security = off');
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) < 104).sort()) {
    await db.query('BEGIN');
    await db.query(sqlOf(file));
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }

  const entities: Record<string, string> = {};
  for (const [tenant, name] of [[TENANT_A, 'a'], [TENANT_B, 'b']]) {
    await db.query(`INSERT INTO tenants (id, name, subdomain, schema_name) VALUES ($1, $2, $3, $4)`, [
      tenant, `Firm ${name}`, `firm-${name}-${DATABASE}`, `s_${name}_${DATABASE}`,
    ]);
    const org = randomUUID();
    await db.query(
      `INSERT INTO organizations (id, tenant_id, name, type) VALUES ($1, $2, $3, 'operating')`,
      [org, tenant, `Org ${name}`]
    );
    entities[name] = randomUUID();
    await db.query(
      `INSERT INTO legal_entities (id, organization_id, tenant_id, name, entity_type, tax_id, tax_id_type,
         incorporation_country)
       VALUES ($1, $2, $3, $4, 'corporation', $5, 'rfc', 'MX')`,
      [entities[name], org, tenant, `Entity ${name}`, `XAXX01010${name === 'a' ? '1' : '2'}000`]
    );
  }
  await seedYear(entities.a, YEARS.openA, 2026, 'open');
  await seedYear(entities.a, YEARS.hardClosedA, 2025, 'hard_close');
  await seedYear(entities.b, YEARS.openB, 2026, 'open');
  await seedYear(entities.b, YEARS.futureB, 2027, 'future');
  await seedYear(entities.b, YEARS.closedInDecemberB, 2025, 'open');
  const december = await db.query<{ id: string }>(
    `SELECT id FROM fiscal_periods WHERE fiscal_year_id = $1 AND period_number = 12`,
    [YEARS.closedInDecemberB]
  );
  // A reopened December that already carries its year's closing entry.
  await db.query(
    `INSERT INTO journal_entries (entry_number, entry_type, entity_id, fiscal_period_id, entry_date, created_by)
     VALUES ('JE-CLOSE-2025', 'closing', $1, $2, '2025-12-31', $3)`,
    [entities.b, december.rows[0].id, randomUUID()]
  );

  // THE HARDENING, which makes this an upgrade and not a fresh install.
  await db.query(fs.readFileSync(path.join(DIR, '..', 'rls-policies.sql'), 'utf-8'));
  await db.query(`SET ROLE ${MIGRATOR}`);
}, 900_000);

afterAll(async () => {
  await verifier?.end();
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
  await admin?.query(`DROP ROLE IF EXISTS ${MIGRATOR}`);
  await admin?.end();
});

describe('the bench is the one where a data migration goes silent, and it is checked first', () => {
  it('the runner owns fiscal_periods under FORCE RLS, cannot bypass it, and a bare read throws 42501', async () => {
    const { rows } = await db.query<{ sup: boolean; bypass: boolean }>(
      `SELECT rolsuper AS sup, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    );
    expect(rows[0]).toEqual({ sup: false, bypass: false });
    const t = await verifier.query(
      `SELECT relforcerowsecurity AS forced, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'fiscal_periods'`
    );
    expect(t.rows[0]).toEqual({ forced: true, owner: MIGRATOR });
    await db.query('SET row_security = off');
    await expect(db.query('SELECT count(*) FROM fiscal_periods')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('104 adds period 13 to every open year of every tenant, once', () => {
  it('applies under RLS and says how many years it reached', async () => {
    said = [];
    await apply104();
    expect(said).toContain('NOTICE: migration 104: added period 13 to 3 fiscal year(s) in 2 tenant(s)');
  });

  it('each open year has its adjustment period on December 31, born with December’s state', async () => {
    for (const year of [YEARS.openA, YEARS.openB]) {
      expect(await period13Of(year)).toEqual([{
        period_type: 'adjustment', period_name: 'Year-end adjustments 2026',
        start_date: '2026-12-31', end_date: '2026-12-31', status: 'open',
      }]);
    }
    expect((await period13Of(YEARS.futureB))[0]).toMatchObject({ status: 'future' });
  });

  it('a year already closed in December keeps its twelve periods', async () => {
    expect(await period13Of(YEARS.hardClosedA)).toEqual([]);
    expect(await period13Of(YEARS.closedInDecemberB)).toEqual([]);
  });

  it('run again, it adds nothing: exactly one period 13 per year', async () => {
    said = [];
    await apply104();
    expect(said).toContain('NOTICE: migration 104: added period 13 to 0 fiscal year(s) in 0 tenant(s)');
    const { rows } = await verifier.query(
      `SELECT fiscal_year_id, count(*)::int AS n FROM fiscal_periods WHERE period_number = 13 GROUP BY fiscal_year_id`
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r: { n: number }) => r.n === 1)).toBe(true);
  });
});
