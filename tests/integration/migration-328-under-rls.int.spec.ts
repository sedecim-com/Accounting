import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';
import { SYSTEM_USER_EMAIL } from '../../src/services/entity/entity-service.js';

/**
 * 328 CORRECTS THE STORED CFDI BILL HEADERS ON AN INSTALLED, HARDENED FIRM
 * (#691 · MNE-001-554).
 *
 * The bench of tests/integration/migration-325-under-rls.int.spec.ts, for the
 * reason measured there: this suite runs as a superuser, a superuser ignores
 * RLS, and that is how 040 shipped a data migration that changed nothing.
 * Here the runner is a NOBYPASSRLS role that owns the tables, the policies
 * carry their FORCE, and the session has the `row_security = off` floor of
 * migrate.ts. A superuser on the same database seeds the rows and judges what
 * 328 left. Two firms, one with its system user and one without. All data is
 * synthetic.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL || process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const DATABASE = `mnem_328_${randomBytes(4).toString('hex')}`;
const MIGRATOR = `it_mig328_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const FILE = '328_a_cfdi_bill_header_holds_vat_alone.sql';
const sqlOf = (file: string): string => fs.readFileSync(path.join(DIR, file), 'utf-8');
const urlWithDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

const ieps = { base: 1000, impuesto: 3, tipoFactor: 'Tasa', tasaOCuota: 0.08, importe: 80 };
// The parser stores the SAT key as a number ("002" -> 2); a string key must read the same.
const vat = (key: unknown) => ({ base: 1080, impuesto: key, tipoFactor: 'Tasa', tasaOCuota: 0.16, importe: 172.8 });
const summary = (...transfers: unknown[]) => ({ totalImpuestosTrasladados: 252.8, traslados: transfers, retenciones: [] });

let admin: pg.Client;
let db: pg.Client;
/** A superuser on THIS database: the runner cannot read what it is judged on. */
let verifier: pg.Client;
const firms: Array<{ tenant: string; entity: string; user: string; vendor: string }> = [];
const bills: Record<string, string> = {};

/** A bill and, unless `breakdown` is undefined, the CFDI pre-registration that wrote it, with `stored` as its total of taxes. */
async function bill(name: string, firm: number, header: string, breakdown?: unknown, stored = '252.80'): Promise<void> {
  const { entity, user, vendor } = firms[firm];
  const id = (bills[name] = randomUUID());
  await verifier.query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount, total_amount, amount_due,
                        currency_code, bill_date, due_date, status, created_by)
     VALUES ($1, $2, $3, $4, 1000, $5, 1252.80, 1252.80, 'MXN', '2026-08-10', '2026-09-09', 'posted', $6)`,
    [id, entity, name, vendor, header, user]
  );
  if (breakdown === undefined) return;
  await verifier.query(
    `INSERT INTO pre_registrations (entity_id, source_type, document_type, document_date, currency_code,
                                    subtotal, tax_amount, total_amount, tax_breakdown, lines, status, bill_id)
     VALUES ($1, 'xml_cfdi', 'bill', '2026-08-10', 'MXN', 1000, $4, 1252.80, $2::jsonb, '[]'::jsonb, 'completed', $3)`,
    [entity, breakdown === null ? null : JSON.stringify(breakdown), id, stored]
  );
}

/** Applies 328 as migrate.ts does: the floor, then the file in one transaction. */
async function apply(client: pg.Client = db): Promise<void> {
  await client.query('SET row_security = off');
  await client.query('BEGIN');
  try {
    await client.query(sqlOf(FILE));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

const headers = async (): Promise<Record<string, string>> => Object.fromEntries((await verifier.query<{ bill_number: string; row: string }>(
  `SELECT bill_number, b::text AS row FROM bills b`
)).rows.map((r) => [r.bill_number, r.row]));
const headerOf = async (name: string): Promise<string> =>
  (await verifier.query<{ t: string }>(`SELECT tax_amount::text AS t FROM bills WHERE id = $1`, [bills[name]])).rows[0].t;
const trail = async () => (await verifier.query<{
  tenant_id: string; user_id: string; entity_id: string; legal_entity_id: string;
  old_values: unknown; new_values: unknown; reason: string;
}>(
  `SELECT tenant_id, user_id, entity_id, legal_entity_id, old_values, new_values, reason
     FROM audit_log WHERE action = 'update' AND entity_type = 'bill' ORDER BY tenant_id`
)).rows;

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

  await db.query('SET row_security = off');
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) < 328).sort()) {
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

  for (const name of ['a', 'b']) {
    const firm = { tenant: randomUUID(), entity: randomUUID(), user: randomUUID(), vendor: randomUUID() };
    firms.push(firm);
    const org = randomUUID();
    await verifier.query('INSERT INTO tenants (id, name, subdomain, schema_name) VALUES ($1, $2, $3, $4)', [
      firm.tenant, `Firm ${name}`, `firm-${name}-${DATABASE}`, `s_${name}_${DATABASE}`,
    ]);
    // Firm A's creator is the system user ensureSystemUser makes; firm B has none yet.
    await verifier.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name) VALUES ($1, $2, $3, 'x', 'Test', 'User')`,
      [firm.user, firm.tenant, name === 'a' ? SYSTEM_USER_EMAIL : `clerk-${name}@example.test`]
    );
    await verifier.query(`INSERT INTO organizations (id, tenant_id, name, type) VALUES ($1, $2, 'Org', 'holding')`, [org, firm.tenant]);
    await verifier.query(
      `INSERT INTO legal_entities (id, tenant_id, organization_id, name, entity_type, tax_id, tax_id_type, incorporation_country)
       VALUES ($1, $2, $3, 'Entity', 'corporation', 'XAXX010101000', 'rfc', 'MX')`,
      [firm.entity, firm.tenant, org]
    );
    await verifier.query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, created_by) VALUES ($1, $2, 'V-1', 'Bottled Drinks SA', $3)`,
      [firm.vendor, firm.entity, firm.user]
    );
  }
  await bill('ieps-a', 0, '252.80', summary(ieps, vat(2)));
  await bill('ieps-b', 1, '252.80', summary(ieps, vat('002')));
  await bill('vat-only', 0, '172.80', summary(vat(2)), '172.80');
  await bill('no-pre-registration', 0, '252.80');
  await bill('edited', 0, '200.00', summary(ieps, vat(2)));
  await bill('no-breakdown', 1, '252.80', null);
}, 900_000);

afterAll(async () => {
  await verifier?.end();
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
  await admin?.query(`DROP ROLE IF EXISTS ${MIGRATOR}`);
  await admin?.end();
});

describe('328 under FORCE RLS, run by an owner that cannot bypass it', () => {
  let before: Record<string, string>;

  it('M1 · the bench bites: a bare UPDATE of bills throws 42501 instead of changing zero rows', async () => {
    const { rows } = await db.query<{ sup: boolean; bypass: boolean }>(
      'SELECT rolsuper AS sup, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user'
    );
    expect(rows[0]).toEqual({ sup: false, bypass: false });
    await db.query('SET row_security = off');
    await expect(db.query('UPDATE bills SET tax_amount = tax_amount')).rejects.toMatchObject({ code: '42501' });
  });

  it('M1 · the IEPS bill of each firm gets the sum of its 002 transfers', async () => {
    before = await headers();
    await apply();
    expect(await headerOf('ieps-a')).toBe('172.8000');
    expect(await headerOf('ieps-b')).toBe('172.8000');
  });

  it('M2 · a VAT-only CFDI, a bill with no pre-registration, an edited header and a null breakdown keep every byte', async () => {
    const after = await headers();
    for (const name of ['vat-only', 'no-pre-registration', 'edited', 'no-breakdown']) expect(after[name], name).toBe(before[name]);
  });

  it('M3 · each changed bill has one audit row in its own firm, with both figures and the firm\'s system user', async () => {
    const systemUsers = (await verifier.query<{ tenant_id: string; id: string; is_active: boolean }>(
      'SELECT tenant_id, id, is_active FROM users WHERE email = $1', [SYSTEM_USER_EMAIL]
    )).rows;
    const systemUserOf = (firm: number) => systemUsers.find((u) => u.tenant_id === firms[firm].tenant);
    expect(systemUserOf(0)?.id).toBe(firms[0].user);
    expect(systemUserOf(1), 'firm B had none: 328 created it').toMatchObject({ is_active: false });
    const expected = [['ieps-a', 0], ['ieps-b', 1]] as const;
    expect((await trail()).map((r) => JSON.stringify(r)).sort()).toEqual(expected.map(([name, firm]) => JSON.stringify({
      tenant_id: firms[firm].tenant, user_id: systemUserOf(firm)?.id, entity_id: bills[name], legal_entity_id: firms[firm].entity,
      old_values: { tax_amount: '252.8000' }, new_values: { tax_amount: '172.8000' }, reason: FILE,
    })).sort());
    const comment = await verifier.query<{ c: string }>(
      `SELECT col_description('bills'::regclass, attnum) AS c FROM pg_attribute WHERE attrelid = 'bills'::regclass AND attname = 'tax_amount'`
    );
    expect(comment.rows[0].c).toMatch(/^CONTRACT: .*VAT \(Impuesto 002\) alone/);
  });

  it('M4 · a second run changes no bill and writes no audit row', async () => {
    const [bills1, trail1] = [await headers(), await trail()];
    await apply();
    expect(await headers()).toEqual(bills1);
    expect(await trail()).toEqual(trail1);
  });

  it('run by a superuser, as every CI job migrates, each firm still corrects and records only its own bill', async () => {
    const earlier = (await trail()).length;
    await verifier.query(`UPDATE bills SET tax_amount = 252.80 WHERE bill_number LIKE 'ieps-%'`);
    // RLS filters nothing for a superuser: only the tenant predicate keeps the
    // first tenant of the loop from taking, and signing for, every bill.
    await apply(verifier);
    expect(await headerOf('ieps-a')).toBe('172.8000');
    const rows = await trail();
    expect(rows).toHaveLength(earlier + 2);
    for (const [name, firm] of [['ieps-a', 0], ['ieps-b', 1]] as const) {
      expect(rows.filter((r) => r.entity_id === bills[name]).map((r) => r.tenant_id)).toEqual([firms[firm].tenant, firms[firm].tenant]);
    }
  });
});
