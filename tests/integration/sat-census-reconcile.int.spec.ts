import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies, resolvePolicy, reopenPolicy } from '../../src/services/policy/policy-service.js';
import { getPeriodCloseStatus } from '../../src/services/accounting/period-close.js';
import { explainCloseCheck } from '../../src/services/accounting/close-explain.js';
import {
  emptyReading, loadCensus, type CensusRow,
} from '../../src/services/sat-census/census.js';
import { reconcileCensus } from '../../src/services/sat-census/reconcile.js';

// MNE-001-119 (#312): the SAT census of August read against what was posted.
// One entity, one month, every state the reconcile names: matched, to fetch,
// to post, cancelled-but-posted, cancelled-and-never-posted (not a gap),
// surplus, a type the panel leaves out, a direction nobody loaded, and the
// weight at close that differs by direction.

let f: Fixture;
let other: Fixture;
const ctx = () => ({ tenantId: f.tenantId, entityId: f.entityId });
const scope = () => entityScope(f.tenantId, f.entityId);
const U = (n: number): string => `aaaaaaaa-1190-4000-8000-${String(n).padStart(12, '0')}`;
const ME = 'XAXX010101000';
const THEM = 'SIN060101AB1';

const row = (n: number, over: Partial<CensusRow>): CensusRow => ({
  uuid: U(n), direction: 'issued', cfdiType: 'I', issuerRfc: ME, receiverRfc: THEM,
  issuedAt: '2026-08-10 10:00:00', amount: '1160.00', satStatus: 'current', cancelledAt: null,
  source: 'metadata', ...over,
});
const received = (n: number, over: Partial<CensusRow> = {}): CensusRow =>
  row(n, { direction: 'received', issuerRfc: THEM, receiverRfc: ME, ...over });

let customerId: string;
let vendorId: string;

async function postedEntry(fx: Fixture): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO journal_entries (id, entry_number, entry_type, entity_id, fiscal_period_id,
       entry_date, posted_date, status, total_debits, total_credits, description, created_by, posted_by)
     VALUES ($1, $2, 'standard', $3, $4, '2026-08-10', '2026-08-10', 'posted', 1160, 1160, 'census test', $5, $5)`,
    [id, `C119-${id.slice(0, 8)}`, fx.entityId, fx.periodos[8], fx.userId]
  );
  // The entry is injected, so its `post` trail is too: the suite shares one database,
  // and `doctor` (mayor-inviolable) would otherwise report posted entries with no author.
  await query(
    `INSERT INTO audit_log (user_id, tenant_id, action, entity_type, entity_id, reason)
     VALUES ($1, $2, 'post', 'journal_entries', $3, 'entry injected by the census test')`,
    [fx.userId, fx.tenantId, id]
  );
  return id;
}

async function invoice(uuid: string, date = '2026-08-10'): Promise<void> {
  const je = await postedEntry(f);
  const id = uuidv4();
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
       amount_due, currency_code, invoice_date, due_date, status, cfdi_uuid, cfdi_status, journal_entry_id, created_by)
     VALUES ($1,$2,$3,$4,1000,160,1160,1160,'MXN',$5,$5,'sent',$6,'stamped',$7,$8)`,
    [id, f.entityId, `INV-119-${id.slice(0, 6)}`, customerId, date, uuid, je, f.userId]
  );
}

async function bill(uuid: string): Promise<void> {
  const je = await postedEntry(f);
  const id = uuidv4();
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount, total_amount, amount_due,
       currency_code, bill_date, due_date, status, cfdi_uuid, journal_entry_id, created_by)
     VALUES ($1,$2,$3,$4,1000,160,1160,1160,'MXN','2026-08-10','2026-08-10','posted',$5,$6,$7)`,
    [id, f.entityId, `BILL-119-${id.slice(0, 6)}`, vendorId, uuid, je, f.userId]
  );
}

async function fetched(uuid: string): Promise<void> {
  await query(
    `INSERT INTO xml_documents (entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha, emisor_rfc,
       receptor_rfc, subtotal, total, moneda, xml_content, xml_hash, import_source, processing_status)
     VALUES ($1,'cfdi_ingreso',$2,'4.0','2026-08-10',$3,$4,1000,1160,'MXN','<x/>',$5,'manual_upload','completed')`,
    [f.entityId, uuid, THEM, ME, uuid]
  );
}

async function load(rows: CensusRow[], file: string): Promise<void> {
  await loadCensus(scope(), { source: 'metadata', fileName: file, sha256: file.padEnd(64, '0'), loadedBy: null },
    { ...emptyReading(), rows });
}

async function answer(value: string): Promise<void> {
  const r = await query<{ status: string }>(
    `SELECT status FROM policy_decisions WHERE tenant_id = $1 AND entity_id = $2 AND key = 'census_missing_at_close'`,
    [f.tenantId, f.entityId]
  );
  if (r.rows[0]?.status !== 'pending') await reopenPolicy(ctx(), 'census_missing_at_close');
  await resolvePolicy(ctx(), 'census_missing_at_close', value, f.userId);
}

async function party(fx: Fixture): Promise<{ c: string; v: string }> {
  const c = uuidv4();
  const v = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, payment_terms, currency_code, created_by)
     VALUES ($1,$2,$3,'Cliente 119','XEXX010101000','rfc','Net 30','MXN',$4)`,
    [c, fx.entityId, `C-119-${c.slice(0, 8)}`, fx.userId]
  );
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, payment_terms, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor 119','XEXX010101000','rfc','Net 30','MXN',$4)`,
    [v, fx.entityId, `V-119-${v.slice(0, 8)}`, fx.userId]
  );
  return { c, v };
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-119 census against the books');
  other = await crearInquilino('MNE-001-119 another tenant');
  await seedPolicies(ctx());
  enterTenant(f.tenantId);
  ({ c: customerId, v: vendorId } = await party(f));

  // Issued: 1 matched, 2 to fetch, 3 cancelled but posted, 4 cancelled and never posted.
  await invoice(U(1));
  await invoice(U(3));
  // Received: 11 matched, 12 fetched and not posted, 13 payroll (left out by default).
  await bill(U(11));
  await fetched(U(12));
  // Posted, and the SAT census does not list them: surplus.
  await invoice(U(21));
  await bill(U(22));
  // A posted invoice of another month is not this month's surplus.
  await invoice(U(23), '2026-07-10');

  await load([
    row(1, {}), row(2, {}),
    row(3, { satStatus: 'cancelled', cancelledAt: '2026-08-20 09:00:00' }),
    row(4, { satStatus: 'cancelled', cancelledAt: '2026-08-21 09:00:00' }),
    received(11, {}), received(12, {}),
    received(13, { cfdiType: 'N' }),
  ], 'agosto.txt');
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('reconcileCensus', () => {
  it('names what is to fetch, to post, cancelled but posted and surplus, and leaves the rest out', async () => {
    const r = await reconcileCensus(scope(), '2026-08-01', '2026-08-31');
    expect(r.toFetch.map((i) => i.uuid)).toEqual([U(2)]);
    expect(r.toPost.map((i) => i.uuid)).toEqual([U(12)]);
    expect(r.cancelledBooked.map((i) => i.uuid)).toEqual([U(3)]);
    expect(r.matched).toBe(2);
    // Cancelled and never posted is counted, never a gap.
    expect(r.cancelledUnbooked).toBe(1);
    // U(23) is July's; the payroll CFDI is a type the panel leaves out.
    expect(r.surplus.map((s) => s.uuid).sort()).toEqual([U(21), U(22)]);
    expect(r.covered).toEqual({ issued: true, received: true });
  });

  it('counts payroll once the panel says so', async () => {
    const r = await reconcileCensus(scope(), '2026-08-01', '2026-08-31', ['I', 'E', 'P', 'N']);
    expect(r.toFetch.map((i) => i.uuid).sort()).toEqual([U(2), U(13)]);
  });

  it('does not call a direction nobody loaded empty, nor compute its surplus', async () => {
    const r = await reconcileCensus(scope(), '2026-09-01', '2026-09-30');
    expect(r.covered).toEqual({ issued: false, received: false });
    expect(r.toFetch).toEqual([]);
    expect(r.surplus).toEqual([]);
  });

  it('reads nothing of another entity: its census and its books are invisible', async () => {
    const r = await reconcileCensus(entityScope(other.tenantId, other.entityId), '2026-08-01', '2026-08-31');
    expect(r.hasLoads).toBe(false);
    expect(r.matched + r.toFetch.length + r.toPost.length + r.surplus.length).toBe(0);
  });

  it('refuses an entity that is not the tenant\'s', async () => {
    await expect(reconcileCensus(entityScope(other.tenantId, f.entityId), '2026-08-01', '2026-08-31'))
      .rejects.toThrow();
  });
});

describe('the census box at close', () => {
  const census = async () => {
    const st = await getPeriodCloseStatus(f.periodos[8], f.entityId);
    return { st, box: st.checklist.find((i) => i.codigo === 'sat-census-missing') };
  };

  it('weighs an issued gap heavier than a received one by default: issued blocks the close', async () => {
    const { st, box } = await census();
    expect(box).toMatchObject({ is_complete: false, severity: 'blocking' });
    expect(st.blocking_issues.some((m) => m.includes('CFDI the SAT lists'))).toBe(true);
  });

  it('warns for both directions when the firm says so, and blocks both when it says so', async () => {
    await answer('both_warn');
    const { st, box } = await census();
    expect(box).toMatchObject({ is_complete: false, severity: 'warning' });
    expect(st.blocking_issues.some((m) => m.includes('CFDI the SAT lists'))).toBe(false);
    expect(st.warnings.some((m) => m.includes('CFDI the SAT lists'))).toBe(true);

    await answer('both_block');
    expect((await census()).box?.severity).toBe('blocking');
  });

  it('a received gap alone only warns by default', async () => {
    await answer('issued_blocks');
    // Fix the issued side: fetch U(2) and post it, and reverse the cancelled U(3).
    await query(`UPDATE invoices SET status = 'void' WHERE entity_id = $1 AND cfdi_uuid = $2`, [f.entityId, U(3)]);
    await invoice(U(2));
    const { box } = await census();
    expect(box).toMatchObject({ is_complete: false, severity: 'warning' });
  });

  it('`closing explain` lists the same CFDI the box counts', async () => {
    const e = await explainCloseCheck(f.entityId, f.periodos[8], 'sat-census-missing');
    expect(e.renglones.map((x) => (x as { uuid: string }).uuid)).toContain(U(12));
    expect(e.total).toBe(e.renglones.length);
  });

  it('is absent for an entity that never loaded a census', async () => {
    const st = await getPeriodCloseStatus(other.periodos[8], other.entityId);
    expect(st.checklist.some((i) => i.codigo === 'sat-census-missing')).toBe(false);
  });
});

describe('mnemosine sat download reconcile', () => {
  const cli = (args: string[]): { status: number | null; out: string; err: string } => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', MNEMOSINE_LOCALE: 'en-US', MNEMOSINE_TENANT: f.tenantId };
    const r = spawnSync('npx', ['tsx', path.resolve(__dirname, '..', '..', 'src', 'cli', 'mnemosine.ts'), 'sat', 'download',
      'reconcile', ...args, '-e', f.entityId, '--json'], { encoding: 'utf-8', timeout: 240_000, env });
    return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };

  it('lists the findings as data and exits 4 while the month is not complete', () => {
    const r = cli(['--period', '2026-08']);
    expect(r.status).toBe(4);
    // One JSON document on stdout; each finding is tagged with its status. By now
    // the earlier tests fixed the issued side: what is left is the received CFDI to post.
    const rows = (JSON.parse(r.out) as { rows: { status: string; uuid: string }[] }).rows;
    expect(rows.filter((x) => x.status === 'to_post').map((x) => x.uuid)).toEqual([U(12)]);
    expect(r.err).toContain('1 to post');
  });

  it('says a month nobody loaded is not loaded, and a malformed month is a usage error', () => {
    const empty = cli(['--period', '2026-09']);
    expect(empty.status).toBe(4);
    expect(empty.err).toContain('is not loaded');
    expect(cli(['--period', 'agosto']).status).toBe(2);
  });
});
