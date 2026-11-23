import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, withTransaction } from '../../src/database/connection.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { PreRegistrationService, registrarFacturaDeBorradorAprobado } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { writeOpeningBills, type OpeningBillDraft } from '../../src/services/ap/opening-bills.js';
import { markBillCfdiCancelled } from '../../src/services/ap/bill-cfdi-cancellation.js';

// ============================================================
// MNE-001-601 (#643), against a real database. MNE-001-431 marks a bill when
// the SAT's «Cancelado» arrives after it; here the cancellation is already in
// the mirror or the census of the same entity when the bill is born, and the
// bill carries the mark from that same step:
//
//   U1 · bill inbox run, cancelled in A's census (the SAT says Vigente) · marked
//   U2 · bill inbox run, cancelled only in the sister entity's census   · not
//   U3 · an AI draft approved after the background check said Cancelado · marked
//   O1 · a new opening bill, cancelled in A's census, no mirror row     · marked
//   O2 · a new opening bill, cancelled only in the sister's census      · not
//   O3 · a takeover to a new UUID: the old UUID's mark goes             · NULL
//   O4 · a takeover to a UUID A's census reports cancelled              · marked
//   O5 · a takeover to the same UUID in lower case keeps its first mark
//
// Every bill is 1,000.00 + 160.00 VAT = 1,160.00. All data is synthetic.
// ============================================================

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-limpieza-1001.xml'), 'utf8');
const CONCEPT_VAT = '<cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>';

let a: Fixture;
let b: Fixture;
let openingEntry: string;
const svc = new PreRegistrationService();
const answers = new Map<string, string>();
const uuid = (n: number) => `BBBBBBBB-6010-4000-8000-${String(n).padStart(12, '0')}`;

/** The SAT's answer for the UUID in the envelope: `answers`, else Vigente. */
async function sat(_url: unknown, init?: { body?: unknown }): Promise<Response> {
  const body = typeof init?.body === 'string' ? init.body : '';
  const state = [...answers].find(([u]) => body.toUpperCase().includes(u))?.[1] ?? 'Vigente';
  return new Response(
    '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
      '<ConsultaResponse xmlns="http://tempuri.org/"><ConsultaResult xmlns:a="http://schemas.datacontract.org/2004/07/Sat.Cfdi">' +
      `<a:CodigoEstatus>S - Comprobante obtenido satisfactoriamente.</a:CodigoEstatus><a:Estado>${state}</a:Estado>` +
      '<a:EsCancelable>Cancelable sin aceptación</a:EsCancelable><a:EstatusCancelacion></a:EstatusCancelacion>' +
      '</ConsultaResult></ConsultaResponse></s:Body></s:Envelope>',
    { status: 200 }
  );
}

async function census(fx: Fixture, u: string): Promise<void> {
  const load = uuidv4();
  await query(
    `INSERT INTO sat_census_loads (id, entity_id, source, file_name, file_sha256, issued_count, received_count,
                                   foreign_count, invalid_count)
     VALUES ($1, $2, 'metadata', 'synthetic.txt', $3, 0, 1, 0, 0)`,
    [load, fx.entityId, (uuidv4() + uuidv4()).replace(/-/g, '')]
  );
  await query(
    `INSERT INTO sat_cfdi_census (entity_id, cfdi_uuid, direction, cfdi_type, issuer_rfc, receiver_rfc, issued_at,
                                  amount, sat_status, source, last_load_id)
     VALUES ($1, $2, 'received', 'I', 'SIN060101AB1', 'XAXX010101000', '2026-08-15 10:00:00', 1160, 'cancelled', 'metadata', $3)`,
    [fx.entityId, u, load]
  );
}

/** Uploads the fixture CFDI with `u` to A and waits for the background SAT check that ingest starts. */
async function upload(u: string): Promise<Record<string, unknown>> {
  const xml = FIXTURE.replace('D5A8C9E1-4B2F-4A6D-9E3C-1F2A3B4C5D6E', u).replace('Folio="1001"', `Folio="${u.slice(-6)}"`)
    .replace('ObjetoImp="02"/>', `ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>${CONCEPT_VAT}</cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`);
  const { preRegistration } = await svc.processXMLUpload(a.entityId, xml, 'manual_upload', a.userId);
  for (let i = 0; i < 100; i++) {
    const r = await query<{ at: Date | null }>(`SELECT sat_validated_at AS at FROM xml_documents WHERE id = $1`,
      [preRegistration.xml_document_id]);
    if (r.rows[0]?.at) return preRegistration;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the background SAT check of ${u} never answered`);
}

async function billRow(id: string): Promise<Record<string, unknown>> {
  const r = await query<Record<string, unknown>>(
    `SELECT b.status, b.amount_due::text AS amount_due, b.journal_entry_id, je.status AS entry_status,
            b.cfdi_uuid, b.cfdi_cancellation_noted_at::text AS mark
       FROM bills b LEFT JOIN journal_entries je ON je.id = b.journal_entry_id
      WHERE b.id = $1`,
    [id]
  );
  return r.rows[0];
}

const billOf = async (fx: Fixture, u: string): Promise<string> =>
  (await query<{ id: string }>(`SELECT id FROM bills WHERE entity_id = $1 AND lower(cfdi_uuid) = lower($2)`, [fx.entityId, u])).rows[0].id;

/** An opening draft of 1,160.00; `replacesId` takes over that bill. */
const draft = (u: string | null, replacesId: string | null = null): OpeningBillDraft => ({
  accountCode: '2110', accountId: a.cuentas['2110'], vendorInvoiceNumber: `F-601-${uuidv4().slice(0, 6)}`,
  vendorName: 'Servicios Integrales SA', vendorRfc: 'SIN060101AB1', date: '2026-01-01', dueDate: '2026-01-31',
  amount: '1160.00', subtotal: '1000.00', tax: '160.00', taxRatePct: '16.00', factorType: 'tasa', currency: 'MXN',
  cfdiUuid: u, replacesId,
});
const writeOpening = (drafts: OpeningBillDraft[]) =>
  withTransaction((client) => writeOpeningBills(client, a.entityId, a.userId, openingEntry, { drafts, voids: [] }));

/** An untouched approved bill of A carrying `u`, as a reversed opening leaves it. */
async function untouched(u: string): Promise<string> {
  const id = uuidv4();
  const vendor = await query<{ id: string }>(`SELECT id FROM vendors WHERE entity_id = $1 AND tax_id = 'SIN060101AB1'`, [a.entityId]);
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount, total_amount,
       amount_due, currency_code, bill_date, due_date, status, cfdi_uuid, journal_entry_id, created_by)
     VALUES ($1,$2,$3,$4,$3,1000,160,1160,1160,'MXN','2026-01-01','2026-01-31','approved',$5,$6,$7)`,
    [id, a.entityId, `BILL-601-${id.slice(0, 6)}`, vendor.rows[0].id, u, openingEntry, a.userId]
  );
  return id;
}

beforeAll(async () => {
  a = await crearInquilino('MNE-001-601 a bill born from a cancelled CFDI');
  b = await crearEntidadHermana(a, 'MNE-001-601 sister entity, same UUID');
  await seedPolicies({ tenantId: a.tenantId, entityId: a.entityId });
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by, default_expense_account_id)
     VALUES ($1, $2, 'V-601', 'Servicios Integrales SA', 'SIN060101AB1', 'rfc', 'MXN', $3, $4)`,
    [uuidv4(), a.entityId, a.userId, a.cuentas['6100']]
  );
  openingEntry = (await createJournalEntry(
    a.entityId, '2026-01-01', JournalEntryType.STANDARD, 'Synthetic opening',
    [
      { account_id: a.cuentas['6100'], debit_amount: '1160.00', credit_amount: null, description: 'Opening' },
      { account_id: a.cuentas['2110'], debit_amount: null, credit_amount: '1160.00', description: 'Vendors' },
    ],
    a.userId,
    { autoPost: true }
  )).id;
  vi.stubGlobal('fetch', sat);
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await drainAttestations(3000);
  await closeDatabase();
});

describe('a bill born from a CFDI its entity already knows cancelled carries the mark', () => {
  it('U1 · bill inbox run, cancelled in the census: marked at birth, and nothing else moves', async () => {
    await census(a, uuid(1));
    const pre = await upload(uuid(1));
    const bill = (await svc.processToAccounting(pre, a.userId)).bill as { id: string };
    const row = await billRow(bill.id);
    expect(row).toMatchObject({ status: 'posted', amount_due: '1160.0000', entry_status: 'posted' });
    expect(row.journal_entry_id).not.toBeNull();
    expect(row.mark).not.toBeNull();
  }, 60_000);

  it('U2 · bill inbox run, cancelled only in the sister entity\'s census: not marked', async () => {
    await census(b, uuid(2));
    const bill = (await svc.processToAccounting(await upload(uuid(2)), a.userId)).bill as { id: string };
    expect(await billRow(bill.id)).toMatchObject({ status: 'posted', mark: null });
  }, 60_000);

  it('U3 · an AI draft approved after the background check said Cancelado: marked at birth', async () => {
    answers.set(uuid(3), 'Cancelado');
    const pre = await upload(uuid(3));
    const mirror = await query<{ s: string }>(`SELECT sat_validation_status AS s FROM xml_documents WHERE id = $1`, [pre.xml_document_id]);
    expect(mirror.rows[0].s).toBe('cancelled');
    await withTransaction((client) => registrarFacturaDeBorradorAprobado(client, {
      tenantId: a.tenantId, entityId: a.entityId, preRegistrationId: String(pre.id),
      approvedLines: [{ account_code: '6100', debit: 1000 }, { account_code: '1135', debit: 160 }, { account_code: '2110', credit: 1160 }],
      approvedDescription: 'Approved draft', userId: a.userId, accountIdByCode: new Map(Object.entries(a.cuentas)),
    }));
    const row = await billRow(await billOf(a, uuid(3)));
    expect(row).toMatchObject({ amount_due: '1160.0000' });
    expect(row.mark).not.toBeNull();
  }, 60_000);
});

describe('an opening bill is measured against the UUID it carries', () => {
  it('O1 · a new opening bill cancelled in the census is marked; the sister\'s bill with that UUID is not', async () => {
    await census(a, uuid(11));
    const sister = uuidv4();
    await query(
      `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount, total_amount, amount_due,
         currency_code, bill_date, due_date, status, cfdi_uuid, created_by)
       VALUES ($1, $2, 'BILL-601-B', $3, 1000, 160, 1160, 1160, 'MXN', '2026-01-01', '2026-01-31', 'approved', $4, $5)`,
      [sister, b.entityId, await vendorOf(b), uuid(11).toLowerCase(), b.userId]
    );
    await writeOpening([draft(uuid(11))]);
    const row = await billRow(await billOf(a, uuid(11)));
    expect(row).toMatchObject({ status: 'approved', amount_due: '1160.0000', journal_entry_id: openingEntry });
    expect(row.mark).not.toBeNull();
    expect((await billRow(sister)).mark).toBeNull();
  }, 60_000);

  it('O2 · a new opening bill cancelled only in the sister\'s census is not marked', async () => {
    await census(b, uuid(12));
    await writeOpening([draft(uuid(12))]);
    expect((await billRow(await billOf(a, uuid(12)))).mark).toBeNull();
  }, 60_000);

  it('O3 · taken over with a new UUID, the bill drops the mark of the UUID it no longer carries', async () => {
    const id = await untouched(uuid(13));
    expect(await markBillCfdiCancelled(a.entityId, uuid(13))).toBe(1);
    await writeOpening([draft(uuid(14), id)]);
    expect(await billRow(id)).toMatchObject({ status: 'approved', cfdi_uuid: uuid(14), amount_due: '1160.0000', mark: null });
  }, 60_000);

  it('O4 · taken over with a UUID the census reports cancelled, the bill gets the mark', async () => {
    const id = await untouched(uuid(15));
    await census(a, uuid(16));
    await writeOpening([draft(uuid(16), id)]);
    const row = await billRow(id);
    expect(row).toMatchObject({ status: 'approved', cfdi_uuid: uuid(16) });
    expect(row.mark).not.toBeNull();
  }, 60_000);

  it('O5 · taken over with the same UUID in lower case, the bill keeps its first mark', async () => {
    const id = await untouched(uuid(17));
    await markBillCfdiCancelled(a.entityId, uuid(17));
    const first = (await billRow(id)).mark;
    await writeOpening([draft(uuid(17).toLowerCase(), id)]);
    expect((await billRow(id)).mark).toBe(first);
  }, 60_000);
});

async function vendorOf(fx: Fixture): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, $3, 'Proveedor sintético', 'SIN060101AB1', 'rfc', 'MXN', $4)`,
    [id, fx.entityId, `V-601-${id.slice(0, 6)}`, fx.userId]
  );
  return id;
}
