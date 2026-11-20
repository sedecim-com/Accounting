import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedBill } from './helpers/seeded-bill.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { revalidateEntityCfdis, type FetchImpl } from '../../src/services/sat/cfdi-status.js';
import { SATValidationService } from '../../src/services/xml-ingestion/sat-validation.js';

// ============================================================
// MNE-001-431 (#643), against a real database: when the SAT's «Cancelado»
// for a received CFDI reaches the mirror through the status query, the bill
// of the entity that carries its UUID gets its mark in the same step.
//
//   - the sweep behind `cfdi status sync` (revalidateEntityCfdis);
//   - validateAndUpdate, behind the ingest check and `cfdi status show --refresh`.
//
// The census marks are in efirma-3-census-cancellation-marks.int.spec.ts,
// and the backfill of migration 340 in migration-340-under-rls.int.spec.ts.
// Each bill is 1,000.00 + 160.00 VAT = 1,160.00. All data is synthetic.
// ============================================================

let a: Fixture;
let b: Fixture;
let vendorA: string;
const answers = new Map<string, string>();

/** The SAT's answer for the UUID in the envelope: `answers`, else Vigente. */
const sat: FetchImpl = async (_url, init) => {
  const body = typeof init?.body === 'string' ? init.body : '';
  const state = [...answers].find(([uuid]) => body.includes(uuid))?.[1] ?? 'Vigente';
  return new Response(
    '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
      '<ConsultaResponse xmlns="http://tempuri.org/"><ConsultaResult xmlns:a="http://schemas.datacontract.org/2004/07/Sat.Cfdi">' +
      `<a:CodigoEstatus>S - Comprobante obtenido satisfactoriamente.</a:CodigoEstatus><a:Estado>${state}</a:Estado>` +
      '<a:EsCancelable>Cancelable sin aceptación</a:EsCancelable><a:EstatusCancelacion></a:EstatusCancelacion>' +
      '</ConsultaResult></ConsultaResponse></s:Body></s:Envelope>',
    { status: 200 }
  );
};

async function vendor(fx: Fixture): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, payment_terms, currency_code, created_by)
     VALUES ($1, $2, $3, 'Proveedor sintético', 'SIN060101AB1', 'rfc', 'Net 30', 'MXN', $4)`,
    [id, fx.entityId, `V-431-${id.slice(0, 8)}`, fx.userId]
  );
  return id;
}

/** A bill of `fx` carrying `uuid` (or none), with no entry, and its mirror row when asked. */
async function plainBill(fx: Fixture, vendorId: string, uuid: string | null, mirrored = false): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount, total_amount, amount_due,
       currency_code, bill_date, due_date, status, cfdi_uuid, created_by)
     VALUES ($1,$2,$3,$4,1000,160,1160,1160,'MXN','2026-08-15','2026-08-15','approved',$5,$6)`,
    [id, fx.entityId, `BILL-431-${id.slice(0, 6)}`, vendorId, uuid, fx.userId]
  );
  if (mirrored && uuid) {
    await query(
      `INSERT INTO xml_documents (entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha, emisor_rfc, receptor_rfc,
         subtotal, total, xml_content, xml_hash, import_source, processing_status)
       VALUES ($1,'cfdi_ingreso',$2,'4.0','2026-08-15','SIN060101AB1','XAXX010101000',1000,1160,'<x/>',$3,'manual_upload','completed')`,
      [fx.entityId, uuid.toUpperCase(), uuidv4().replace(/-/g, '')]
    );
  }
  return id;
}

async function billRow(id: string): Promise<Record<string, unknown>> {
  const r = await query<Record<string, unknown>>(
    `SELECT b.status, b.amount_due::text AS amount_due, b.journal_entry_id, je.status AS entry_status,
            b.cfdi_cancellation_noted_at::text AS mark
       FROM bills b LEFT JOIN journal_entries je ON je.id = b.journal_entry_id
      WHERE b.id = $1`,
    [id]
  );
  return r.rows[0];
}

const bills: Record<string, string> = {};
let u1Entry: string;

beforeAll(async () => {
  a = await crearInquilino('MNE-001-431 the bill gets the mark');
  b = await crearEntidadHermana(a, 'MNE-001-431 sister entity, same UUID');
  vendorA = await vendor(a);
  const vendorB = await vendor(b);

  // U1: a posted bill of A with its mirror row; the SAT cancels it.
  const u1 = await seedBill(a, { vendorId: vendorA, method: 'PUE', vatCode: '1130', date: '2026-08-15' });
  [bills.u1, u1Entry] = [u1.id, u1.entryId];
  answers.set(u1.uuid, 'Cancelado');
  // The same UUID on a bill of B, in lower case, with B's own mirror row.
  bills.sister = await plainBill(b, vendorB, u1.uuid.toLowerCase(), true);
  // U2: a bill of A with its mirror row; the SAT says it is current.
  bills.u2 = (await seedBill(a, { vendorId: vendorA, method: 'PUE', vatCode: '1130', date: '2026-08-15' })).id;
  // A bill of A captured by hand, with no UUID.
  bills.manual = await plainBill(a, vendorA, null);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await drainAttestations(3000);
  await closeDatabase();
});

describe('the SAT cancellation of a received CFDI reaches its bill', () => {
  it('the sweep marks the bill of the entity, and nothing else moves', async () => {
    const summary = await revalidateEntityCfdis({ entityId: a.entityId }, { fetchImpl: sat });
    expect(summary).toMatchObject({ consultados: 2, cancelados: 1, vigentes: 1, bills_marked: 1, invoices_cancelled: 0 });

    expect(await billRow(bills.u1)).toMatchObject({
      status: 'posted', amount_due: '1160.0000', journal_entry_id: u1Entry, entry_status: 'posted',
    });
    expect((await billRow(bills.u1)).mark).not.toBeNull();
    for (const name of ['sister', 'u2', 'manual']) expect((await billRow(bills[name])).mark, name).toBeNull();
  }, 60_000);

  it('the same cancellation again moves zero rows and keeps the first mark', async () => {
    const first = (await billRow(bills.u1)).mark;
    const summary = await revalidateEntityCfdis({ entityId: a.entityId }, { fetchImpl: sat, staleHours: 0 });
    expect(summary).toMatchObject({ cancelados: 1, bills_marked: 0 });
    expect((await billRow(bills.u1)).mark).toBe(first);
    expect((await billRow(bills.sister)).mark).toBeNull();
  }, 60_000);

  it('validateAndUpdate marks the bill and returns the count; a second query returns 0', async () => {
    const u3 = await seedBill(a, { vendorId: vendorA, method: 'PUE', vatCode: '1130', date: '2026-08-15' });
    answers.set(u3.uuid, 'Cancelado');
    vi.stubGlobal('fetch', sat);
    const doc = await query<{ id: string }>(
      `SELECT id FROM xml_documents WHERE entity_id = $1 AND cfdi_uuid = $2`, [a.entityId, u3.uuid]
    );
    const service = new SATValidationService();

    const first = await service.validateAndUpdate(doc.rows[0].id);
    expect(first).toMatchObject({ status: 'cancelled', billsMarked: 1 });
    expect(await billRow(u3.id)).toMatchObject({ status: 'posted', amount_due: '1160.0000', entry_status: 'posted' });
    expect((await billRow(u3.id)).mark).not.toBeNull();

    const again = await service.validateAndUpdate(doc.rows[0].id);
    expect(again).toMatchObject({ status: 'cancelled', billsMarked: 0 });
  }, 60_000);
});
