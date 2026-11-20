import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';

/**
 * 340 MARKS THE BILLS WHOSE CFDI IS ALREADY RECORDED CANCELLED, ON AN
 * INSTALLED, HARDENED FIRM (#643 · MNE-001-431).
 *
 * The bench of tests/integration/migration-328-under-rls.int.spec.ts, for the
 * reason measured there: this suite runs as a superuser, a superuser ignores
 * RLS, and a data migration that forgets RLS then changes nothing in
 * production. Here the runner is a NOBYPASSRLS role that owns the tables, the
 * policies carry their FORCE, and the session has the `row_security = off`
 * floor of migrate.ts. A superuser on the same database seeds the rows and
 * judges what 340 left. All data is synthetic.
 *
 *   T1 · E1   b1 mirror cancelled → marked; b2 census cancelled, no mirror →
 *             marked; b3 mirror valid and census current → not; b4 no UUID → not
 *   T1 · E1b  b5 carries b1's UUID with no rows of its own → not
 *   T2 · E2   b6 lower-case UUID, its upper-case mirror cancelled → marked
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL || process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const DATABASE = `mnem_340_${randomBytes(4).toString('hex')}`;
const MIGRATOR = `it_mig340_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const FILE = '340_a_bill_notes_its_cancelled_cfdi.sql';
const U = (n: number): string => `bbbbbbbb-4310-4000-8000-${String(n).padStart(12, '0')}`;
const sqlOf = (file: string): string => fs.readFileSync(path.join(DIR, file), 'utf-8');
const urlWithDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

type Entity = { tenant: string; entity: string; user: string; vendor: string };
let admin: pg.Client;
let db: pg.Client;
/** A superuser on THIS database: the runner cannot read what it is judged on. */
let verifier: pg.Client;
const bills: Record<string, string> = {};
const MARKED = ['b1', 'b2', 'b6'];
const UNMARKED = ['b3', 'b4', 'b5'];

async function entity(tenant: string, user: string, org: string): Promise<Entity> {
  const e: Entity = { tenant, entity: randomUUID(), user, vendor: randomUUID() };
  await verifier.query(
    `INSERT INTO legal_entities (id, tenant_id, organization_id, name, entity_type, tax_id, tax_id_type, incorporation_country)
     VALUES ($1, $2, $3, 'Entity', 'corporation', 'XAXX010101000', 'rfc', 'MX')`,
    [e.entity, tenant, org]
  );
  await verifier.query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, created_by) VALUES ($1, $2, 'V-1', 'Proveedor sintético', $3)`,
    [e.vendor, e.entity, user]
  );
  return e;
}

async function firm(name: string): Promise<{ tenant: string; user: string; org: string }> {
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

/** A posted bill of 1,000.00 + 160.00 VAT = 1,160.00, carrying `uuid` (or none). */
async function bill(name: string, e: Entity, uuid: string | null): Promise<void> {
  const id = (bills[name] = randomUUID());
  await verifier.query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount, total_amount, amount_due,
                        currency_code, bill_date, due_date, status, cfdi_uuid, created_by, updated_at)
     VALUES ($1, $2, $3, $4, 1000, 160, 1160, 1160, 'MXN', '2026-08-10', '2026-09-09', 'posted', $5, $6, '2026-08-10T12:00:00Z')`,
    [id, e.entity, name, e.vendor, uuid, e.user]
  );
}

async function mirror(e: Entity, uuid: string, status: 'cancelled' | 'valid'): Promise<void> {
  await verifier.query(
    `INSERT INTO xml_documents (entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha, emisor_rfc, receptor_rfc,
                                subtotal, total, xml_content, xml_hash, import_source, sat_validation_status)
     VALUES ($1, 'cfdi_ingreso', $2, '4.0', '2026-08-10', 'SIN060101AB1', 'XAXX010101000', 1000, 1160, '<cfdi/>', $3, 'api', $4)`,
    [e.entity, uuid, randomBytes(32).toString('hex'), status]
  );
}

async function census(e: Entity, uuid: string, status: 'cancelled' | 'current'): Promise<void> {
  const load = randomUUID();
  await verifier.query(
    `INSERT INTO sat_census_loads (id, entity_id, source, file_name, file_sha256, issued_count, received_count,
                                   foreign_count, invalid_count)
     VALUES ($1, $2, 'metadata', 'synthetic.txt', $3, 0, 1, 0, 0)`,
    [load, e.entity, randomBytes(32).toString('hex')]
  );
  await verifier.query(
    `INSERT INTO sat_cfdi_census (entity_id, cfdi_uuid, direction, cfdi_type, issuer_rfc, receiver_rfc, issued_at,
                                  amount, sat_status, source, last_load_id)
     VALUES ($1, $2, 'received', 'I', 'SIN060101AB1', 'XAXX010101000', '2026-08-10 10:00:00', 1160, $3, 'metadata', $4)`,
    [e.entity, uuid, status, load]
  );
}

/** Applies 340 as migrate.ts does: the floor, then the file in one transaction. */
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

/** Every bill as text, by its number. Before 340 runs, the row has no mark column. */
const rows = async (): Promise<Record<string, string>> => Object.fromEntries((await verifier.query<{ bill_number: string; row: string }>(
  `SELECT bill_number, b::text AS row FROM bills b`
)).rows.map((r) => [r.bill_number, r.row]));
const marks = async (): Promise<Record<string, string | null>> => Object.fromEntries((await verifier.query<{ bill_number: string; m: string | null }>(
  `SELECT bill_number, cfdi_cancellation_noted_at::text AS m FROM bills`
)).rows.map((r) => [r.bill_number, r.m]));
const money = async (name: string) => (await verifier.query<Record<string, unknown>>(
  `SELECT status, amount_due::text AS amount_due, journal_entry_id, updated_at::text AS updated_at FROM bills WHERE id = $1`, [bills[name]]
)).rows[0];

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
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) < 340).sort()) {
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

  const t1 = await firm('one');
  const t2 = await firm('two');
  const e1 = await entity(t1.tenant, t1.user, t1.org);
  const e1b = await entity(t1.tenant, t1.user, t1.org);
  const e2 = await entity(t2.tenant, t2.user, t2.org);

  await bill('b1', e1, U(1).toUpperCase());
  await mirror(e1, U(1).toUpperCase(), 'cancelled');
  await bill('b2', e1, U(2).toUpperCase());
  await census(e1, U(2), 'cancelled');
  await bill('b3', e1, U(3).toUpperCase());
  await mirror(e1, U(3).toUpperCase(), 'valid');
  await census(e1, U(3), 'current');
  await bill('b4', e1, null);
  await bill('b5', e1b, U(1).toUpperCase());
  await bill('b6', e2, U(6));
  await mirror(e2, U(6).toUpperCase(), 'cancelled');
}, 900_000);

afterAll(async () => {
  await verifier?.end();
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
  await admin?.query(`DROP ROLE IF EXISTS ${MIGRATOR}`);
  await admin?.end();
});

describe('340 under FORCE RLS, run by an owner that cannot bypass it', () => {
  let before: Record<string, string>;

  it('the bench bites: a bare UPDATE of bills throws 42501 instead of changing zero rows', async () => {
    const { rows: who } = await db.query<{ sup: boolean; bypass: boolean }>(
      'SELECT rolsuper AS sup, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user'
    );
    expect(who[0]).toEqual({ sup: false, bypass: false });
    await db.query('SET row_security = off');
    await expect(db.query('UPDATE bills SET memo = memo')).rejects.toMatchObject({ code: '42501' });
  });

  it('marks exactly the bills whose CFDI the mirror or the census of their own entity records cancelled', async () => {
    before = await rows();
    await apply();
    const m = await marks();
    for (const name of MARKED) expect(m[name], name).not.toBeNull();
    for (const name of UNMARKED) expect(m[name], name).toBeNull();
  });

  it('changes nothing else: an unmarked bill keeps every byte, a marked one its status, balance, entry and updated_at', async () => {
    const after = await rows();
    // The text of an unmarked row gains only the new column, empty, at its end.
    for (const name of UNMARKED) expect(after[name], name).toBe(before[name].replace(/\)$/, ',)'));
    for (const name of MARKED) {
      expect(await money(name), name).toEqual({
        status: 'posted', amount_due: '1160.0000', journal_entry_id: null, updated_at: '2026-08-10 12:00:00+00',
      });
    }
  });

  it('a second run moves nothing: the marks keep their timestamps', async () => {
    const first = await marks();
    await apply();
    expect(await marks()).toEqual(first);
  });

  it('run by a superuser, as every CI job migrates, RLS filters nothing and it still marks the same bills and no other', async () => {
    await verifier.query('UPDATE bills SET cfdi_cancellation_noted_at = NULL');
    await apply(verifier);
    const m = await marks();
    for (const name of MARKED) expect(m[name], name).not.toBeNull();
    for (const name of UNMARKED) expect(m[name], name).toBeNull();
  });
});
