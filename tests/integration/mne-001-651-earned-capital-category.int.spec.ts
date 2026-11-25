import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { getBalanceSheet } from '../../src/services/reporting/report-service.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// MNE-001-651 (#597) · EARNED CAPITAL IS ITS OWN STATEMENT CATEGORY
//
// NIF B-6 presents contributed and earned capital apart and NIF C-11 defines
// both. The seeded chart put the legal reserve (3150), prior years' results
// (3200), the result of the year (3300) and the income summary (3900) under
// `fs_category = 'equity'`, which the balance sheet labels «Capital
// contribuido».
//
//   T1  a newly seeded entity has the four under `earned_capital`
//   T2  its balance sheet prints them in their own subsection, and foots
//   T3  migration 346, on an installed and hardened firm run by an owner that
//       cannot bypass RLS: it moves the accounts still equal to the seed (code
//       and subtype), leaves and counts the ones a person edited, and does not
//       cross tenants. Bench of migration-340-under-rls.int.spec.ts.
//
// All data is synthetic.
// ============================================================

const EARNED = ['3150', '3200', '3300', '3900'];

describe('a newly seeded entity (T1, T2)', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-651 earned capital');
    enterTenant(f.tenantId);
  });

  afterAll(async () => {
    await drainAttestations(3000);
    await closeDatabase();
  });

  it('T1 · seeds 3150, 3200, 3300 and 3900 as earned capital; 3000 and 3100 stay contributed, 3600 stays ORI', async () => {
    const { rows } = await query<{ code: string; fs_category: string | null }>(
      `SELECT code, fs_category FROM accounts
        WHERE entity_id = $1 AND code = ANY($2::text[])`,
      [f.entityId, ['3000', '3100', '3600', ...EARNED]]
    );
    expect(Object.fromEntries(rows.map((r) => [r.code, r.fs_category]))).toEqual({
      '3000': 'equity',
      '3100': 'equity',
      '3150': 'earned_capital',
      '3200': 'earned_capital',
      '3300': 'earned_capital',
      '3600': 'ori',
      '3900': 'earned_capital',
    });
  });

  it('T2 · the balance sheet holds retained earnings outside «contributed», and still foots', async () => {
    // Bank 1,000.00 = share capital 600.00 + prior years' results 400.00.
    await createJournalEntry(
      f.entityId,
      fechaEnPeriodo(3, 10),
      JournalEntryType.STANDARD,
      'Opening equity (synthetic)',
      [
        { account_id: f.cuentas['1111'], debit_amount: '1000.0000', credit_amount: null, description: 'bank' },
        { account_id: f.cuentas['3100'], debit_amount: null, credit_amount: '600.0000', description: 'capital' },
        { account_id: f.cuentas['3200'], debit_amount: null, credit_amount: '400.0000', description: 'retained' },
      ],
      f.userId,
      { autoPost: true }
    );
    const bs = await getBalanceSheet(f.entityId, { asOfDate: '2026-12-31' });
    const sub = (key: string) => bs.equity.subsections.find((s) => s.key === key);

    expect(sub('equity')?.accounts.map((a) => a.code)).toEqual(['3100']);
    expect(sub('equity')?.total).toBe('600.0000');
    expect(sub('earned_capital')?.accounts.map((a) => [a.code, a.balance])).toEqual([['3200', '400.0000']]);
    expect(sub('earned_capital')?.total).toBe('400.0000');
    expect(bs.equity.total).toBe('1000.0000');
    expect(bs.assets.total).toBe('1000.0000');
    expect(bs.is_balanced).toBe(true);
  });
});

// ── T3 · the migration on an installed firm ────────────────────────────

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL || process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const DATABASE = `mnem_346_${randomBytes(4).toString('hex')}`;
const MIGRATOR = `it_mig346_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const NUMBER = 346;
const fileOf346 = (): string | undefined =>
  fs.readdirSync(DIR).find((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) === NUMBER);
const sqlOf = (file: string): string => fs.readFileSync(path.join(DIR, file), 'utf-8');
const urlWithDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

type Firm = { tenant: string; user: string; org: string };
type Account = { code: string; name: string; type?: string; sub: string | null; fs: string; parent?: string };

/** The equity of the seed as it was before 346, written out. */
const SEEDED_BEFORE_346: Account[] = [
  { code: '3000', name: 'Capital Contable', sub: null, fs: 'equity' },
  { code: '3100', name: 'Capital Social', sub: 'common_stock', fs: 'equity', parent: '3000' },
  { code: '3150', name: 'Reserva Legal', sub: null, fs: 'equity', parent: '3000' },
  { code: '3200', name: 'Resultado de Ejercicios Anteriores', sub: 'retained_earnings', fs: 'equity', parent: '3000' },
  { code: '3300', name: 'Resultado del Ejercicio', sub: 'retained_earnings', fs: 'equity', parent: '3000' },
  { code: '3600', name: 'Otros Resultados Integrales', sub: null, fs: 'ori', parent: '3000' },
  { code: '3900', name: 'Resumen de Ingresos y Gastos', sub: null, fs: 'equity', parent: '3000' },
];

/**
 * A chart a person edited: 3300's subtype changed, the legal reserve
 * renumbered to 3155, a sub-account under 3200. 3200 and 3900 are as seeded.
 */
const EDITED: Account[] = [
  { code: '3000', name: 'Capital Contable', sub: null, fs: 'equity' },
  { code: '3100', name: 'Capital Social', sub: 'common_stock', fs: 'equity', parent: '3000' },
  { code: '3155', name: 'Reserva Legal', sub: null, fs: 'equity', parent: '3000' },
  { code: '3200', name: 'Resultado de Ejercicios Anteriores', sub: 'retained_earnings', fs: 'equity', parent: '3000' },
  { code: '3201', name: 'Utilidades por Aplicar', sub: null, fs: 'equity', parent: '3200' },
  { code: '3300', name: 'Resultado del Ejercicio', sub: 'year_result', fs: 'equity', parent: '3000' },
  { code: '3900', name: 'Resumen de Ingresos y Gastos', sub: null, fs: 'equity', parent: '3000' },
];

describe('migration 346 under FORCE RLS, run by an owner that cannot bypass it (T3)', () => {
  let admin: pg.Client;
  let db: pg.Client;
  /** A superuser on THIS database: the runner cannot read what it is judged on. */
  let verifier: pg.Client;
  const entities: Record<'e1' | 'e2' | 'e3', string> = { e1: '', e2: '', e3: '' };
  let notices: string[] = [];

  async function firm(name: string): Promise<Firm> {
    const [tenant, user, org] = [randomUUID(), randomUUID(), randomUUID()];
    await verifier.query('INSERT INTO tenants (id, name, subdomain, schema_name) VALUES ($1, $2, $3, $4)', [
      tenant, `Firm ${name}`, `firm-${name}-${DATABASE}`, `s_${name}_${DATABASE}`,
    ]);
    await verifier.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name) VALUES ($1, $2, $3, 'x', 'Test', 'User')`,
      [user, tenant, `clerk-${name}@example.test`]
    );
    await verifier.query(`INSERT INTO organizations (id, tenant_id, name, type) VALUES ($1, $2, 'Org', 'holding')`, [org, tenant]);
    return { tenant, user, org };
  }

  async function entityWith(f: Firm, chart: Account[]): Promise<string> {
    const entity = randomUUID();
    await verifier.query(
      `INSERT INTO legal_entities (id, tenant_id, organization_id, name, entity_type, tax_id, tax_id_type, incorporation_country)
       VALUES ($1, $2, $3, 'Entity', 'corporation', 'XAXX010101000', 'rfc', 'MX')`,
      [entity, f.tenant, f.org]
    );
    const ids: Record<string, string> = {};
    for (const a of chart) {
      ids[a.code] = randomUUID();
      await verifier.query(
        `INSERT INTO accounts (id, code, name, account_type, account_subtype, fs_category, normal_balance,
                               parent_id, entity_id, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'credit', $7, $8, $9, '2026-01-02T12:00:00Z')`,
        [ids[a.code], a.code, a.name, a.type ?? 'equity', a.sub, a.fs, a.parent ? ids[a.parent] : null, entity, f.user]
      );
    }
    return entity;
  }

  /** Applies 346 as migrate.ts does: the floor, then the file in one transaction. */
  async function apply(client: pg.Client = db): Promise<void> {
    const file = fileOf346();
    expect(file, `migration ${NUMBER} is not in src/database/migrations`).toBeDefined();
    notices = [];
    await client.query('SET row_security = off');
    await client.query('BEGIN');
    try {
      await client.query(sqlOf(file!));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  /** code → fs_category of one entity, and every row as text for the byte comparison. */
  const categories = async (entity: string): Promise<Record<string, string | null>> =>
    Object.fromEntries((await verifier.query<{ code: string; fs_category: string | null }>(
      'SELECT code, fs_category FROM accounts WHERE entity_id = $1', [entity]
    )).rows.map((r) => [r.code, r.fs_category]));
  const rowsAsText = async (): Promise<Record<string, string>> =>
    Object.fromEntries((await verifier.query<{ id: string; row: string }>(
      'SELECT id, a::text AS row FROM accounts a'
    )).rows.map((r) => [r.id, r.row]));

  beforeAll(async () => {
    if (!ADMIN) throw new Error('missing TEST_ADMIN_DATABASE_URL / MIGRATION_DATABASE_URL / DATABASE_URL');
    admin = new pg.Client({ connectionString: urlWithDatabase(ADMIN, 'postgres') });
    await admin.connect();
    await admin.query(`CREATE ROLE ${MIGRATOR} NOLOGIN NOBYPASSRLS`);
    await admin.query(`GRANT ${MIGRATOR} TO CURRENT_USER`);
    await admin.query(`CREATE DATABASE ${DATABASE} OWNER ${MIGRATOR}`);
    db = new pg.Client({ connectionString: urlWithDatabase(ADMIN, DATABASE) });
    await db.connect();
    verifier = new pg.Client({ connectionString: urlWithDatabase(ADMIN, DATABASE) });
    await verifier.connect();
    for (const c of [db, verifier]) c.on('notice', (n) => notices.push(n.message ?? ''));

    await db.query('SET row_security = off');
    for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) < NUMBER).sort()) {
      // 071 ends with RESET ROLE: in production that returns to mnemosine_owner, here to the superuser.
      await db.query(`SET ROLE ${MIGRATOR}`);
      await db.query('BEGIN');
      await db.query(sqlOf(file));
      await db.query('COMMIT');
    }
    // THE HARDENING, as the runner, which makes this an upgrade and not a fresh install.
    await db.query(`SET ROLE ${MIGRATOR}`);
    await db.query(fs.readFileSync(path.join(DIR, '..', 'rls-policies.sql'), 'utf-8'));
    await db.query(`SET ROLE ${MIGRATOR}`);

    const one = await firm('one');
    const two = await firm('two');
    entities.e1 = await entityWith(one, SEEDED_BEFORE_346);
    entities.e2 = await entityWith(one, EDITED);
    entities.e3 = await entityWith(two, SEEDED_BEFORE_346);
  }, 900_000);

  afterAll(async () => {
    await verifier?.end();
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
    await admin?.query(`DROP ROLE IF EXISTS ${MIGRATOR}`);
    await admin?.end();
  });

  it('before 346, the seed put 3150, 3200, 3300 and 3900 under equity, and the CHECK refuses earned_capital', async () => {
    expect(await categories(entities.e1)).toMatchObject({ '3150': 'equity', '3200': 'equity', '3300': 'equity', '3900': 'equity' });
    await expect(
      verifier.query(`UPDATE accounts SET fs_category = 'earned_capital' WHERE entity_id = $1 AND code = '3200'`, [entities.e1])
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the bench bites: a bare UPDATE of accounts throws 42501 instead of changing zero rows', async () => {
    const { rows: who } = await db.query<{ sup: boolean; bypass: boolean }>(
      'SELECT rolsuper AS sup, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user'
    );
    expect(who[0]).toEqual({ sup: false, bypass: false });
    await db.query('SET row_security = off');
    await expect(db.query('UPDATE accounts SET name = name')).rejects.toMatchObject({ code: '42501' });
  });

  let before: Record<string, string>;

  it('moves the accounts still equal to the seed, in both tenants, and leaves the edited ones', async () => {
    before = await rowsAsText();
    await apply();
    for (const e of [entities.e1, entities.e3]) {
      expect(await categories(e)).toEqual({
        '3000': 'equity', '3100': 'equity', '3150': 'earned_capital', '3200': 'earned_capital',
        '3300': 'earned_capital', '3600': 'ori', '3900': 'earned_capital',
      });
    }
    expect(await categories(entities.e2)).toEqual({
      '3000': 'equity', '3100': 'equity', '3155': 'equity', '3200': 'earned_capital',
      '3201': 'equity', '3300': 'equity', '3900': 'earned_capital',
    });
  });

  it('says how many it moved and how many it left to a person', () => {
    // Moved: four in e1, four in e3, 3200 and 3900 in e2. Left: e2's 3300
    // (subtype), 3155 (the seed's name under another code) and 3201 (a child of 3200).
    expect(notices.filter((n) => n.startsWith('migration 346'))).toEqual([
      'migration 346: moved 10 account(s) to earned_capital; left 3 for a person to classify',
    ]);
  });

  it('changes nothing but the category: no other column, no other row, updated_at kept', async () => {
    const after = await rowsAsText();
    const changed = Object.keys(after).filter((id) => after[id] !== before[id]);
    expect(changed).toHaveLength(10);
    for (const id of changed) {
      expect(after[id].replace(',earned_capital,', ',equity,'), id).toBe(before[id]);
    }
  });

  it('a second run moves nothing and still counts what it left', async () => {
    const first = await rowsAsText();
    await apply();
    expect(await rowsAsText()).toEqual(first);
    expect(notices.filter((n) => n.startsWith('migration 346'))).toEqual([
      'migration 346: moved 0 account(s) to earned_capital; left 3 for a person to classify',
    ]);
  });

  it('run by a superuser, as every CI job migrates, RLS filters nothing and it moves the same accounts and no other', async () => {
    await verifier.query(`UPDATE accounts SET fs_category = 'equity' WHERE fs_category = 'earned_capital'`);
    await apply(verifier);
    expect(Object.values(await rowsAsText()).filter((r) => r.includes(',earned_capital,'))).toHaveLength(10);
    expect(notices.filter((n) => n.startsWith('migration 346'))).toEqual([
      'migration 346: moved 10 account(s) to earned_capital; left 3 for a person to classify',
    ]);
  });
});
