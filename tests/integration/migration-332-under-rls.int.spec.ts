import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';
import { SYSTEM_USER_EMAIL } from '../../src/services/entity/entity-service.js';

/**
 * 332 RE-TYPES THE OPEN PRE-REGISTRATIONS OF ISSUED CFDI THAT STILL SAY 'bill',
 * ON AN INSTALLED, HARDENED FIRM (#670 · MNE-001-522).
 *
 * The bench of tests/integration/migration-328-under-rls.int.spec.ts, for the
 * reason measured there: this suite runs as a superuser, a superuser ignores
 * RLS, and a data migration that forgets RLS then changes nothing in
 * production. Here the runner is a NOBYPASSRLS role that owns the tables, the
 * policies carry their FORCE, and the session has the `row_security = off`
 * floor of migrate.ts. A superuser on the same database seeds the rows and
 * judges what 332 left. Three firms: A with its system user, B without one,
 * and C with nothing to re-type. All data is synthetic.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL || process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const DATABASE = `mnem_332_${randomBytes(4).toString('hex')}`;
const MIGRATOR = `it_mig332_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const FILE = '332_an_issued_cfdi_born_bill_is_an_invoice.sql';
const OWN_RFC = 'XAXX010101000';
const OTHER_RFC = 'AAA010101AAA';
const sqlOf = (file: string): string => fs.readFileSync(path.join(DIR, file), 'utf-8');
const urlWithDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

type Firm = { tenant: string; entity: string; user: string; vendor: string; expense: string; revenue: string };
let admin: pg.Client;
let db: pg.Client;
/** A superuser on THIS database: the runner cannot read what it is judged on. */
let verifier: pg.Client;
const firms: Firm[] = [];
const rows: Record<string, string> = {};

/** The match the old pipeline left: the entity itself, found as its own vendor. */
const selfVendor = (firm: Firm) => ({
  vendor_id: firm.vendor, vendor_match_confidence: '1.00', vendor_match_method: 'rfc_exact',
  is_new_vendor: false, suggested_vendor_data: null as unknown,
});

/** A CFDI and its xml_cfdi pre-registration; `fields` override the open legacy row of an issued one. */
async function preRegistration(name: string, firm: Firm, fields: Record<string, unknown> = {}, issuer = OWN_RFC): Promise<void> {
  const xml = randomUUID();
  await verifier.query(
    `INSERT INTO xml_documents (id, entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha, emisor_rfc, receptor_rfc,
                                subtotal, total, xml_content, xml_hash, import_source)
     VALUES ($1, $2, 'cfdi_ingreso', $3, '4.0', '2026-08-10', $4, $5, 8000, 9280, '<cfdi/>', $6, 'api')`,
    [xml, firm.entity, randomUUID(), issuer, issuer === OWN_RFC ? OTHER_RFC : OWN_RFC, randomBytes(32).toString('hex')]
  );
  const row: Record<string, unknown> = {
    id: (rows[name] = randomUUID()), entity_id: firm.entity, xml_document_id: xml, source_type: 'xml_cfdi',
    document_type: 'bill', external_reference: name, document_date: '2026-08-10', currency_code: 'MXN',
    subtotal: 8000, tax_amount: 1280, total_amount: 9280, lines: '[]', status: 'draft', ...selfVendor(firm), ...fields,
  };
  const columns = Object.keys(row);
  await verifier.query(
    `INSERT INTO pre_registrations (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    columns.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]))
  );
}

/** Applies 332 as migrate.ts does: the floor, then the file in one transaction. */
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

const textOf = async (table: 'pre_registrations' | 'xml_documents'): Promise<Record<string, string>> =>
  Object.fromEntries((await verifier.query<{ id: string; row: string }>(`SELECT id, t::text AS row FROM ${table} t`)).rows.map((r) => [r.id, r.row]));
const rowOf = async (name: string) =>
  (await verifier.query<Record<string, unknown>>(
    `SELECT document_type, vendor_id, vendor_match_confidence, vendor_match_method, is_new_vendor, suggested_vendor_data,
            default_account_id, account_mapping_method, account_mapping_confidence, lines, status, error_message, processing_mode
       FROM pre_registrations WHERE id = $1`, [rows[name]]
  )).rows[0];
const trail = async () => (await verifier.query<{
  tenant_id: string; user_id: string; entity_id: string; legal_entity_id: string;
  old_values: Record<string, unknown>; new_values: Record<string, unknown>; reason: string;
}>(
  `SELECT tenant_id, user_id, entity_id, legal_entity_id, old_values, new_values, reason
     FROM audit_log WHERE action = 'update' AND entity_type = 'pre_registrations' ORDER BY timestamp, id`
)).rows;
const systemUsers = async () =>
  (await verifier.query<{ tenant_id: string; id: string; is_active: boolean }>(
    'SELECT tenant_id, id, is_active FROM users WHERE email = $1', [SYSTEM_USER_EMAIL]
  )).rows;
const AS_BORN = {
  document_type: 'invoice', vendor_id: null, vendor_match_confidence: '0.00', vendor_match_method: 'issued_by_entity',
  is_new_vendor: false, suggested_vendor_data: null,
};
const UNTOUCHED = ['completed-with-bill', 'received', 'payment', 'open-with-entry', 'rejected', 'manual-source', 'born-invoice'];

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
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) < 332).sort()) {
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

  for (const name of ['a', 'b', 'c']) {
    const firm: Firm = {
      tenant: randomUUID(), entity: randomUUID(), user: randomUUID(), vendor: randomUUID(), expense: randomUUID(), revenue: randomUUID(),
    };
    firms.push(firm);
    const org = randomUUID();
    await verifier.query('INSERT INTO tenants (id, name, subdomain, schema_name) VALUES ($1, $2, $3, $4)', [
      firm.tenant, `Firm ${name}`, `firm-${name}-${DATABASE}`, `s_${name}_${DATABASE}`,
    ]);
    // Firm A's creator is the system user ensureSystemUser makes; firms B and C have none yet.
    await verifier.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name) VALUES ($1, $2, $3, 'x', 'Test', 'User')`,
      [firm.user, firm.tenant, name === 'a' ? SYSTEM_USER_EMAIL : `clerk-${name}@example.test`]
    );
    await verifier.query(`INSERT INTO organizations (id, tenant_id, name, type) VALUES ($1, $2, 'Org', 'holding')`, [org, firm.tenant]);
    // The guard compares under UPPER(TRIM()): firm A's RFC differs from the XML's in case and spaces.
    await verifier.query(
      `INSERT INTO legal_entities (id, tenant_id, organization_id, name, entity_type, tax_id, tax_id_type, incorporation_country)
       VALUES ($1, $2, $3, 'Entity', 'corporation', $4, 'rfc', 'MX')`,
      [firm.entity, firm.tenant, org, name === 'a' ? ` ${OWN_RFC.toLowerCase()} ` : OWN_RFC]
    );
    await verifier.query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, created_by) VALUES ($1, $2, 'V-SELF', 'Entity', $3)`,
      [firm.vendor, firm.entity, firm.user]
    );
    await verifier.query(
      `INSERT INTO accounts (id, entity_id, code, name, account_type, normal_balance, created_by)
       VALUES ($1, $3, '6100', 'Expenses', 'expense', 'debit', $4), ($2, $3, '4100', 'Sales', 'revenue', 'credit', $4)`,
      [firm.expense, firm.revenue, firm.entity, firm.user]
    );
  }
  const [a, b, c] = firms;
  await preRegistration('open-a', a, {
    default_account_id: a.expense, account_mapping_method: 'rule', account_mapping_confidence: '1.00',
    lines: [
      { line_number: 1, description: 'Consulting', account_id: a.expense, suggested_account_id: a.expense },
      { line_number: 2, description: 'Licence', account_id: a.revenue },
      { line_number: 3, description: 'Nothing coded' },
    ],
  });
  await preRegistration('open-b', b, {
    status: 'error', error_message: 'CFDI_ISSUED_BY_ENTITY', processing_mode: 'batch',
    vendor_id: null, vendor_match_confidence: '0.00', vendor_match_method: 'none', is_new_vendor: true,
    suggested_vendor_data: { tax_id: OWN_RFC }, default_account_id: b.revenue, account_mapping_method: 'rule',
    lines: [{ line_number: 1, description: 'Consulting' }],
  });
  // References no bill or entry exists for: the migration only asks whether the row has one.
  await verifier.query(`SET session_replication_role = replica`);
  await preRegistration('completed-with-bill', a, { status: 'completed', bill_id: randomUUID(), result_type: 'bill', result_id: randomUUID() });
  await preRegistration('open-with-entry', a, { status: 'ready', journal_entry_id: randomUUID() });
  await verifier.query(`SET session_replication_role = origin`);
  await preRegistration('received', a, {}, OTHER_RFC);
  await preRegistration('payment', a, { document_type: 'payment' });
  await preRegistration('manual-source', a, { source_type: 'manual' });
  await preRegistration('born-invoice', a, { ...AS_BORN, default_account_id: a.expense });
  await preRegistration('rejected', c, { status: 'rejected' });
}, 900_000);

afterAll(async () => {
  await verifier?.end();
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
  await admin?.query(`DROP ROLE IF EXISTS ${MIGRATOR}`);
  await admin?.end();
});

describe('332 under FORCE RLS, run by an owner that cannot bypass it', () => {
  let before: Record<string, string>;
  let xmlBefore: Record<string, string>;

  it('the bench bites: a bare UPDATE of pre_registrations throws 42501 instead of changing zero rows', async () => {
    const { rows: role } = await db.query<{ sup: boolean; bypass: boolean }>(
      'SELECT rolsuper AS sup, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user'
    );
    expect(role[0]).toEqual({ sup: false, bypass: false });
    await db.query('SET row_security = off');
    await expect(db.query('UPDATE pre_registrations SET status = status')).rejects.toMatchObject({ code: '42501' });
  });

  it('T1 · the open legacy row of each firm says invoice and carries no vendor, as one born today; the XML keeps every byte', async () => {
    [before, xmlBefore] = [await textOf('pre_registrations'), await textOf('xml_documents')];
    await apply();
    expect(await rowOf('open-a')).toMatchObject({ ...AS_BORN, status: 'draft' });
    // Decision 5: the status, the error text and the processing mode stay.
    expect(await rowOf('open-b')).toMatchObject({ ...AS_BORN, status: 'error', error_message: 'CFDI_ISSUED_BY_ENTITY', processing_mode: 'batch' });
    expect(await textOf('xml_documents')).toEqual(xmlBefore);
  });

  it('T2 · each re-typed row has one audit row in its own firm with what it said before, written by the firm\'s system user', async () => {
    const users = await systemUsers();
    const systemUserOf = (firm: Firm) => users.find((u) => u.tenant_id === firm.tenant);
    expect(systemUserOf(firms[0])?.id).toBe(firms[0].user);
    expect(systemUserOf(firms[1]), 'firm B had none: 332 created it').toMatchObject({ is_active: false });
    expect(systemUserOf(firms[2]), 'firm C had none and no row changed there').toBeUndefined();
    const records = await trail();
    expect(records).toHaveLength(2);
    const olds = [
      ['open-a', firms[0], { document_type: 'bill', ...selfVendor(firms[0]), vendor_match_confidence: 1 }],
      ['open-b', firms[1], {
        document_type: 'bill', vendor_id: null, vendor_match_confidence: 0, vendor_match_method: 'none',
        is_new_vendor: true, suggested_vendor_data: { tax_id: OWN_RFC },
      }],
    ] as const;
    for (const [name, firm, old] of olds) {
      const record = records.find((r) => r.entity_id === rows[name]);
      expect(record, name).toMatchObject({
        tenant_id: firm.tenant, user_id: systemUserOf(firm)?.id, legal_entity_id: firm.entity, reason: FILE,
        old_values: old, new_values: { ...AS_BORN, vendor_match_confidence: 0 },
      });
    }
  });

  it('T3 · a consumed row, a rejected one, a received bill, a REP, a row with an entry, a hand-made row and a born invoice keep every byte', async () => {
    const after = await textOf('pre_registrations');
    for (const name of UNTOUCHED) expect(after[rows[name]], name).toBe(before[rows[name]]);
    expect(Object.keys(after).filter((id) => after[id] !== before[id]).sort()).toEqual([rows['open-a'], rows['open-b']].sort());
  });

  // DECISION 4 of the plan (#670), which the owner may overturn: these two cases go with its block of the SQL.
  it('D4 · an expense account leaves the line and the default; a revenue account and the suggestion stay', async () => {
    const [a, b] = firms;
    expect(await rowOf('open-a')).toMatchObject({
      default_account_id: null, account_mapping_method: null, account_mapping_confidence: null,
      lines: [
        { line_number: 1, description: 'Consulting', suggested_account_id: a.expense },
        { line_number: 2, description: 'Licence', account_id: a.revenue },
        { line_number: 3, description: 'Nothing coded' },
      ],
    });
    expect((await rowOf('open-a')).lines).not.toHaveProperty([0, 'account_id']);
    expect(await rowOf('open-b')).toMatchObject({
      default_account_id: b.revenue, account_mapping_method: 'rule', lines: [{ line_number: 1, description: 'Consulting' }],
    });
  });

  it('D4 · the audit row holds each cleared account, and none where nothing was cleared', async () => {
    const records = await trail();
    const of = (name: string) => records.find((r) => r.entity_id === rows[name])!;
    expect(of('open-a').old_values).toMatchObject({
      default_account_id: firms[0].expense, account_mapping_method: 'rule', account_mapping_confidence: 1,
      cleared_lines: [{ line_number: 1, account_id: firms[0].expense }],
    });
    expect(of('open-a').new_values).toMatchObject({ default_account_id: null, account_mapping_method: null, account_mapping_confidence: null });
    for (const values of [of('open-b').old_values, of('open-b').new_values]) {
      expect(Object.keys(values).filter((k) => /account|lines/.test(k))).toEqual([]);
    }
  });

  it('T4 · a second run changes no row and writes no audit row', async () => {
    const [rows1, trail1, users1] = [await textOf('pre_registrations'), await trail(), await systemUsers()];
    await apply();
    expect(await textOf('pre_registrations')).toEqual(rows1);
    expect(await trail()).toEqual(trail1);
    expect(await systemUsers()).toEqual(users1);
  });

  it('run by a superuser, as every CI job migrates, each firm still re-types and records only its own row', async () => {
    const earlier = (await trail()).length;
    await verifier.query(`UPDATE pre_registrations SET document_type = 'bill' WHERE external_reference LIKE 'open-_'`);
    // RLS filters nothing for a superuser: only the tenant predicate keeps the
    // first tenant of the loop from taking, and signing for, every row.
    await apply(verifier);
    expect(await rowOf('open-a')).toMatchObject(AS_BORN);
    const records = await trail();
    expect(records).toHaveLength(earlier + 2);
    for (const [name, firm] of [['open-a', firms[0]], ['open-b', firms[1]]] as const) {
      expect(records.filter((r) => r.entity_id === rows[name]).map((r) => r.tenant_id)).toEqual([firm.tenant, firm.tenant]);
    }
    expect(await textOf('xml_documents')).toEqual(xmlBefore);
  });
});
