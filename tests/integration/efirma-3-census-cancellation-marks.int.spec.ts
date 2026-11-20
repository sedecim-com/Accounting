import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { runArChecks } from '../../src/services/ar/ar-controls.js';
import { emptyReading, loadCensus, type CensusRow } from '../../src/services/sat-census/census.js';
import { runCensus } from '../../src/cli/ingest-census.js';

// ============================================================
// MNE-001-144 (EFIRMA-3 1/3, #441), against a real database only.
//
// A metadata file in which the SAT reports a CFDI cancelled (Estatus 0) is
// loaded with `runCensus`, the body of `ingest --kind metadata` and of
// `sat package download --import`. Right after the load:
//   - the mirror (xml_documents) of every cancelled CFDI of the file's window
//     says so: sat_validation_status 'cancelled', sat_estado 'Cancelado';
//   - the stamped invoice carrying it goes through the #313 bridge and becomes
//     cfdi_status 'cancelled', so the AR control cancelled-cfdi-open fires;
//   - each posted document still carrying a cancelled CFDI (invoice, credit
//     note or bill) is a finding with its number, UUID and date, and nothing
//     is reversed: status, entry and balance stay;
//   - every bill of the entity carrying a cancelled CFDI of the window gets
//     its mark (MNE-001-431, #643), from the census row, so a bill with no
//     mirror row is reached too.
// Another entity carrying the same UUID is not touched, a mirror row already
// cancelled is not rewritten, and a second load moves nothing.
//
// Every RFC, name and UUID here is synthetic.
// ============================================================

const ME = 'XAXX010101000';
const THEM = 'SIN060101AB1';
const U = (n: number): string => `aaaaaaaa-1440-4000-8000-${String(n).padStart(12, '0')}`;
const HEADER =
  'Uuid~RfcEmisor~NombreEmisor~RfcReceptor~NombreReceptor~RfcPac~FechaEmision~FechaCertificacionSat~Monto~EfectoComprobante~Estatus~FechaCancelacion';

/** One metadata line: issued by the entity unless `received`. */
const line = (n: number, day: string, type: string, status: '0' | '1', received = false): string => {
  const [issuer, receiver] = received ? [THEM, ME] : [ME, THEM];
  const cancelled = status === '0' ? `2026-08-${day} 18:00:00` : '';
  return `${U(n)}~${issuer}~Emisor SA~${receiver}~Receptor SA~SAT970701NN3~2026-08-${day} 10:00:00~` +
    `2026-08-${day} 10:05:00~1160.00~${type}~${status}~${cancelled}`;
};

let f: Fixture;
let g: Fixture;
let work: string;
let metadataFile: string;
let customerId: string;
let vendorId: string;
const numbers: Record<string, string> = {};

async function postedEntry(fx: Fixture, date: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO journal_entries (id, entry_number, entry_type, entity_id, fiscal_period_id,
       entry_date, posted_date, status, total_debits, total_credits, description, created_by, posted_by)
     VALUES ($1, $2, 'standard', $3, $4, $5::date, $5::date, 'posted', 1160, 1160, 'EFIRMA-3 test', $6, $6)`,
    [id, `E144-${id.slice(0, 8)}`, fx.entityId, fx.periodos[8], date, fx.userId]
  );
  // The entry is injected, so its `post` trail is too (doctor's mayor-inviolable).
  await query(
    `INSERT INTO audit_log (user_id, tenant_id, action, entity_type, entity_id, reason)
     VALUES ($1, $2, 'post', 'journal_entries', $3, 'entry injected by the EFIRMA-3 test')`,
    [fx.userId, fx.tenantId, id]
  );
  return id;
}

async function parties(fx: Fixture): Promise<{ c: string; v: string }> {
  const c = uuidv4();
  const v = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Cliente sintético', 'MXN', $4)`,
    [c, fx.entityId, `C-144-${c.slice(0, 8)}`, fx.userId]
  );
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, payment_terms, currency_code, created_by)
     VALUES ($1, $2, $3, 'Proveedor sintético', 'XEXX010101000', 'rfc', 'Net 30', 'MXN', $4)`,
    [v, fx.entityId, `V-144-${v.slice(0, 8)}`, fx.userId]
  );
  return { c, v };
}

/** A stamped, posted, unpaid invoice carrying `uuid`. */
async function invoice(fx: Fixture, customer: string, uuid: string, date: string): Promise<string> {
  const id = uuidv4();
  const number = `INV-144-${id.slice(0, 6)}`;
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
       amount_due, currency_code, invoice_date, due_date, status, cfdi_uuid, cfdi_status, journal_entry_id, created_by)
     VALUES ($1,$2,$3,$4,1000,160,1160,1160,'MXN',$5,$5,'sent',$6,'stamped',$7,$8)`,
    [id, fx.entityId, number, customer, date, uuid, await postedEntry(fx, date), fx.userId]
  );
  if (fx === f) numbers[uuid] = number;
  return id;
}

async function creditNote(uuid: string, date: string): Promise<void> {
  const id = uuidv4();
  const number = `NC-144-${id.slice(0, 6)}`;
  await query(
    `INSERT INTO credit_notes (id, tenant_id, entity_id, credit_note_number, customer_id, type, credit_date,
       subtotal, tax_amount, total_amount, currency_code, status, journal_entry_id, cfdi_uuid, created_by)
     VALUES ($1,$2,$3,$4,$5,'descuento',$6,1000,160,1160,'MXN','issued',$7,$8,$9)`,
    [id, f.tenantId, f.entityId, number, customerId, date, await postedEntry(f, date), uuid, f.userId]
  );
  numbers[uuid] = number;
}

async function bill(uuid: string, date: string): Promise<void> {
  const id = uuidv4();
  const number = `BILL-144-${id.slice(0, 6)}`;
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount, total_amount, amount_due,
       currency_code, bill_date, due_date, status, cfdi_uuid, journal_entry_id, created_by)
     VALUES ($1,$2,$3,$4,1000,160,1160,1160,'MXN',$5,$5,'posted',$6,$7,$8)`,
    [id, f.entityId, number, vendorId, date, uuid, await postedEntry(f, date), f.userId]
  );
  numbers[uuid] = number;
}

/** An approved bill with no entry and no mirror row, as an opening bill is (MNE-001-431). */
async function unpostedBill(fx: Fixture, vendor: string, uuid: string, date: string): Promise<void> {
  const id = uuidv4();
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount, total_amount, amount_due,
       currency_code, bill_date, due_date, status, cfdi_uuid, created_by)
     VALUES ($1,$2,$3,$4,1000,160,1160,1160,'MXN',$5,$5,'approved',$6,$7)`,
    [id, fx.entityId, `BILL-431-${id.slice(0, 6)}`, vendor, date, uuid.toUpperCase(), fx.userId]
  );
}

async function billOf(entityId: string, uuid: string): Promise<Record<string, unknown>> {
  const r = await query<Record<string, unknown>>(
    `SELECT status, amount_due::text AS amount_due, cfdi_cancellation_noted_at IS NOT NULL AS marked
       FROM bills WHERE entity_id = $1 AND lower(cfdi_uuid) = $2`,
    [entityId, uuid]
  );
  return r.rows[0];
}

/** The mirror row of a CFDI, stored upper-case as a parsed XML carries it. */
async function mirror(entityId: string, uuid: string, received = false, status: string | null = null): Promise<void> {
  await query(
    `INSERT INTO xml_documents (entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha, emisor_rfc,
       receptor_rfc, subtotal, total, moneda, xml_content, xml_hash, import_source, processing_status,
       sat_validation_status, sat_estado, updated_at)
     VALUES ($1,'cfdi_ingreso',$2,'4.0','2026-08-10',$3,$4,1000,1160,'MXN','<x/>',$5,'manual_upload','completed',
       $6, $7, '2026-08-01T00:00:00Z')`,
    [entityId, uuid.toUpperCase(), received ? THEM : ME, received ? ME : THEM, uuid,
      status, status === 'cancelled' ? 'Cancelado' : null]
  );
}

async function mirrorOf(entityId: string, uuid: string): Promise<Record<string, unknown>> {
  const r = await query<Record<string, unknown>>(
    `SELECT sat_validation_status, sat_estado, updated_at::text AS updated_at
       FROM xml_documents WHERE entity_id = $1 AND lower(cfdi_uuid) = $2`,
    [entityId, uuid]
  );
  return r.rows[0];
}

async function invoiceOf(entityId: string, uuid: string): Promise<Record<string, unknown>> {
  const r = await query<Record<string, unknown>>(
    `SELECT i.cfdi_status, i.status, i.amount_due::text AS amount_due, je.status AS entry_status
       FROM invoices i JOIN journal_entries je ON je.id = i.journal_entry_id
      WHERE i.entity_id = $1 AND lower(i.cfdi_uuid) = $2`,
    [entityId, uuid]
  );
  return r.rows[0];
}

/** `runCensus` over the August file, with what it printed. */
async function load(dryRun = false): Promise<Awaited<ReturnType<typeof runCensus>> & { printed: string }> {
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const run = await runCensus({
      kind: 'metadata', files: [metadataFile], scope: entityScope(f.tenantId, f.entityId), entityRfc: ME,
      dryRun, loadedBy: null,
    });
    return { ...run, printed: out.mock.calls.map((c) => String(c[0])).join('\n') };
  } finally {
    out.mockRestore();
  }
}

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'mne-144-'));
  f = await crearInquilino('MNE-001-144 census cancellation marks');
  g = await crearInquilino('MNE-001-144 another entity, same UUID');
  ({ c: customerId, v: vendorId } = await parties(f));
  const other = await parties(g);

  // 1 issued, invoiced, posted and mirrored: the SAT cancels it.
  await invoice(f, customerId, U(1), '2026-08-10');
  await mirror(f.entityId, U(1));
  // 2 issued credit note, posted: the SAT cancels it.
  await creditNote(U(2), '2026-08-11');
  // 3 received, billed, posted and mirrored: the SAT cancels it.
  await bill(U(3), '2026-08-12');
  await mirror(f.entityId, U(3), true);
  // 4 issued, invoiced, posted, mirrored and current: nothing happens to it.
  await invoice(f, customerId, U(4), '2026-08-13');
  await mirror(f.entityId, U(4));
  // 5 cancelled, mirrored and never posted: the mirror learns it, no finding.
  await mirror(f.entityId, U(5), true);
  // 6 cancelled and already marked in the mirror: not rewritten.
  await mirror(f.entityId, U(6), true, 'cancelled');
  // 7 cancelled in a census loaded earlier whose marks never ran: this load of the window marks it.
  await mirror(f.entityId, U(7), true);
  const earlier: CensusRow = {
    uuid: U(7), direction: 'received', cfdiType: 'I', issuerRfc: THEM, receiverRfc: ME,
    issuedAt: '2026-08-12 09:00:00', amount: '1160.00', satStatus: 'cancelled', cancelledAt: '2026-08-12 18:00:00',
    source: 'metadata',
  };
  await loadCensus(entityScope(f.tenantId, f.entityId),
    { source: 'metadata', fileName: 'earlier.txt', sha256: 'e'.repeat(64), loadedBy: null },
    { ...emptyReading(), rows: [earlier] });

  // 8 received, cancelled, on an approved bill with no entry and no mirror row: only the census reaches it.
  await unpostedBill(f, vendorId, U(8), '2026-08-16');

  // Another entity carries U(1) in its mirror and on a stamped invoice of its own, and U(3) on a bill.
  await invoice(g, other.c, U(1), '2026-08-10');
  await mirror(g.entityId, U(1));
  await unpostedBill(g, other.v, U(3), '2026-08-12');

  metadataFile = path.join(work, 'agosto.txt');
  fs.writeFileSync(metadataFile, [
    HEADER,
    line(1, '10', 'I', '0'),
    line(2, '11', 'E', '0'),
    line(3, '12', 'I', '0', true),
    line(4, '13', 'I', '1'),
    line(5, '14', 'I', '0', true),
    line(6, '15', 'I', '0', true),
    line(8, '16', 'I', '0', true),
  ].join('\r\n') + '\r\n');
});

afterAll(async () => {
  fs.rmSync(work, { recursive: true, force: true });
  await drainAttestations(3000);
  await closeDatabase();
});

describe('a cancellation the census loads reaches the mirror and the invoice', () => {
  it('marks the mirror and, through the #313 bridge, the invoice, and names each posted document', async () => {
    const run = await load();

    // Mirror: 1, 3, 5 and 7 (loaded earlier, same window). 6 was already cancelled; 4 is current.
    for (const n of [1, 3, 5, 7]) {
      expect(await mirrorOf(f.entityId, U(n))).toMatchObject({ sat_validation_status: 'cancelled', sat_estado: 'Cancelado' });
    }
    expect(await mirrorOf(f.entityId, U(6))).toMatchObject({
      sat_validation_status: 'cancelled', updated_at: '2026-08-01 00:00:00+00',
    });
    expect(await mirrorOf(f.entityId, U(4))).toMatchObject({ sat_validation_status: null, sat_estado: null });

    // The invoice is marked and nothing else moves: status, entry and balance stay.
    expect(await invoiceOf(f.entityId, U(1))).toEqual({
      cfdi_status: 'cancelled', status: 'sent', amount_due: '1160.0000', entry_status: 'posted',
    });
    expect(await invoiceOf(f.entityId, U(4))).toMatchObject({ cfdi_status: 'stamped' });
    // Bills: 3 and 8. The bill keeps its status and balance; only its mark moves.
    expect(run.marks).toEqual({ mirror: 4, invoices: 1, bills: 2 });
    expect(await billOf(f.entityId, U(3))).toEqual({ status: 'posted', amount_due: '1160.0000', marked: true });
    expect(await billOf(f.entityId, U(8))).toEqual({ status: 'approved', amount_due: '1160.0000', marked: true });
    const control = await runArChecks(f.entityId, { checks: ['cancelled-cfdi-open'] });
    expect(control.results[0].count).toBe(1);

    // Findings: every posted document still carrying a cancelled CFDI, by its number.
    expect(run.findings).toEqual([
      { source: 'invoice', number: numbers[U(1)], uuid: U(1), date: '2026-08-10' },
      { source: 'credit_note', number: numbers[U(2)], uuid: U(2), date: '2026-08-11' },
      { source: 'bill', number: numbers[U(3)], uuid: U(3), date: '2026-08-12' },
    ]);
    for (const n of [1, 2, 3]) expect(run.printed).toContain(numbers[U(n)]);
  });

  it('leaves another entity carrying the same UUID untouched', async () => {
    expect(await mirrorOf(g.entityId, U(1))).toMatchObject({ sat_validation_status: null, sat_estado: null });
    expect(await invoiceOf(g.entityId, U(1))).toMatchObject({ cfdi_status: 'stamped' });
    expect(await billOf(g.entityId, U(3))).toMatchObject({ marked: false });
  });

  it('moves nothing the second time and still names the findings, computed on every run', async () => {
    const before = await mirrorOf(f.entityId, U(1));
    const run = await load();
    expect(await mirrorOf(f.entityId, U(1))).toEqual(before);
    expect(run.marks).toEqual({ mirror: 0, invoices: 0, bills: 0 });
    expect(run.findings.map((x) => x.uuid)).toEqual([U(1), U(2), U(3)]);
  });

  it('marks nothing and finds nothing on a dry run', async () => {
    const run = await load(true);
    expect(run.marks).toEqual({ mirror: 0, invoices: 0, bills: 0 });
    expect(run.findings).toEqual([]);
  });
});
