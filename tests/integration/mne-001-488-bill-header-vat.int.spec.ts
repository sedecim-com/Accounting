import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { query, getClient, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { repXml } from './helpers/rep-xml.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment, applyVendorPayment } from '../../src/services/payments/payment-service.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import {
  PreRegistrationService,
  registrarFacturaDeBorradorAprobado,
} from '../../src/services/xml-ingestion/pre-registration-service.js';
import { construirDiot } from '../../src/services/sat/diot/index.js';

// ============================================================
// MNE-001-488 · #691 — A CFDI BILL'S HEADER HOLDS ITS VAT ALONE.
//
// Both doors copied the XML's total of transferred taxes (VAT plus IEPS) to
// `bills.tax_amount`, and every reader takes that column as VAT: the payment's
// release, the short payment, the REP's cross-check and the DIOT. The CFDI
// here is the issue's: SubTotal 1,000.00, IEPS 80.00, VAT 172.80, Total
// 1,252.80. All data is synthetic.
// ============================================================

const OWN_RFC = 'XAXX010101000';
const VENDOR_RFC = 'IEP010101AA1';

let f: Fixture;
let vendorId: string;
const svc = new PreRegistrationService();

interface Cfdi { xml: string; uuid: string }

/** A received one-concept CFDI: IEPS at 8 % ahead of the VAT at 16 %, or the VAT alone. */
function cfdi(month: number, o: { method?: 'PPD' | 'PUE'; subtotal?: string; ieps?: string | null; vat?: string } = {}): Cfdi {
  const { method = 'PPD', subtotal = '1000.00', vat = '172.80' } = o;
  const ieps = o.ieps === undefined ? '80.00' : o.ieps;
  const vatBase = (Number(subtotal) + Number(ieps ?? 0)).toFixed(2);
  const transfers =
    (ieps ? `<cfdi:Traslado Base="${subtotal}" Impuesto="003" TipoFactor="Tasa" TasaOCuota="0.080000" Importe="${ieps}"/>` : '') +
    `<cfdi:Traslado Base="${vatBase}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${vat}"/>`;
  const taxes = (Number(ieps ?? 0) + Number(vat)).toFixed(2);
  const total = (Number(subtotal) + Number(taxes)).toFixed(2);
  const date = `2026-${String(month).padStart(2, '0')}-10T10:00:00`;
  const uuid = uuidv4().toUpperCase();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="I" Folio="${uuid.slice(0, 6)}" Fecha="${date}" FormaPago="${method === 'PUE' ? '03' : '99'}" MetodoPago="${method}" TipoDeComprobante="I" Moneda="MXN" SubTotal="${subtotal}" Total="${total}" LugarExpedicion="06600">
  <cfdi:Emisor Rfc="${VENDOR_RFC}" Nombre="Bottled Drinks SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${OWN_RFC}" Nombre="Demo Corp MX" UsoCFDI="G03" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos><cfdi:Concepto ClaveProdServ="50202300" ClaveUnidad="H87" Descripcion="Soft drinks" Cantidad="1" ValorUnitario="${subtotal}" Importe="${subtotal}" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>${transfers}</cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="${taxes}"><cfdi:Traslados>${transfers}</cfdi:Traslados></cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="${date}" RfcProvCertif="SAT970701NN3" SelloCFD="s" NoCertificadoSAT="30001000000500000001" SelloSAT="s"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
  return { xml, uuid };
}

/** `bill inbox run`: upload, then the same processToAccounting the command calls. */
async function inbox(xml: string): Promise<{ billId: string; paymentId?: string }> {
  const up = await svc.processXMLUpload(f.entityId, xml, 'manual_upload', f.userId);
  const r = await svc.processToAccounting(up.preRegistration, f.userId);
  return { billId: (r.bill as { id: string } | undefined)?.id as string, paymentId: r.paymentId as string | undefined };
}

const one = async (sql: string, params: unknown[]): Promise<string> =>
  Object.values((await query<Record<string, string>>(sql, params)).rows[0])[0];
const headerOf = (billId: string) => one(`SELECT tax_amount::text FROM bills WHERE id = $1`, [billId]);
const statusOf = (billId: string) => one(`SELECT status FROM bills WHERE id = $1`, [billId]);
const releasedBy = (paymentId: string) =>
  one(`SELECT iva_reclass_amount::text FROM payment_applications WHERE payment_id = $1`, [paymentId]);

/** Net debit of one account over the bill's entry and the entries of its payments. */
const moved = (code: string, billId: string, only?: string) =>
  one(
    `SELECT COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0)::numeric(19,4)::text
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND a.code = $2
        AND je.source_id IN (SELECT $3::uuid UNION SELECT payment_id FROM payment_applications WHERE bill_id = $3)
        AND ($4::uuid IS NULL OR je.source_id = $4)`,
    [f.entityId, code, billId, only ?? null]
  );

async function pay(billId: string, amount: string, month: number, day = 20): Promise<string> {
  const r = await recordVendorPayment(
    {
      entityId: f.entityId,
      counterpartyId: vendorId,
      paymentAmount: amount,
      paymentDate: new Date(Date.UTC(2026, month - 1, day)),
      paymentMethod: 'spei',
      applications: billId ? [{ documentId: billId, amountApplied: amount }] : [],
      ...(billId ? {} : { onAccount: true }),
    },
    f.userId
  );
  return r.paymentId;
}

const rep = (c: Cfdi, total: string, iva: number, month: number) =>
  inbox(repXml({ cfdiUuid: c.uuid, total, iva }, uuidv4().toUpperCase(), {
    issuerRfc: VENDOR_RFC, issuerName: 'Bottled Drinks SA', date: new Date(Date.UTC(2026, month - 1, 25)),
  }));

async function diotOf(month: number) {
  const diot = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: month });
  return {
    header: diot.hallazgos.filter((h) => h.codigo === 'DIOT-IVA-CABECERA'),
    rate16: diot.renglones.find((r) => r.tercero.rfc === VENDOR_RFC)?.desglose.tasa16.iva,
  };
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-488 bill header VAT');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code,
       created_by, tipo_tercero, tipo_operacion, default_expense_account_id)
     VALUES ($1, $2, 'V-IEP', 'Bottled Drinks SA', $3, 'rfc', 'MXN', $4, '04', '85',
       (SELECT id FROM accounts WHERE entity_id = $2 AND code = '6100'))`,
    [vendorId, f.entityId, VENDOR_RFC, f.userId]
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('the inbox door', () => {
  it('T1 · the header is the VAT (002) alone; the lines, the entry and the pre-registration stay', async () => {
    const c = cfdi(2);
    const { billId } = await inbox(c.xml);
    expect(await headerOf(billId)).toBe('172.8000');
    expect(await one(`SELECT tax_amount::text FROM bill_lines WHERE bill_id = $1`, [billId])).toBe('172.8000');
    expect(await moved('1135', billId)).toBe('172.8000');
    expect(await moved('1165', billId)).toBe('80.0000');
    expect(await one(`SELECT tax_amount::text FROM pre_registrations WHERE bill_id = $1`, [billId])).toBe('252.8000');
  }, 90_000);

  it('T2 · two payments of half the bill release half its VAT each, and 1135 ends at zero', async () => {
    const { billId } = await inbox(cfdi(3).xml);
    for (const day of [18, 20]) {
      const paymentId = await pay(billId, '626.40', 3, day);
      expect(await releasedBy(paymentId)).toBe('86.4000');
      expect(await moved('1130', billId, paymentId)).toBe('86.4000');
    }
    expect(await moved('1135', billId)).toBe('0.0000');
    expect(await statusOf(billId)).toBe('paid');
  }, 90_000);

  it('T3 · a short payment splits the VAT between what was paid and what was forgiven', async () => {
    const { billId } = await inbox(cfdi(4).xml);
    const paymentId = await pay('', '1152.80', 4);
    const r = await applyVendorPayment(
      f.entityId, paymentId, [{ documentId: billId, amountApplied: '1152.80' }], f.userId,
      { modo: 'residual', shortPayReason: 'Breakage accepted by the vendor' }
    );
    expect(r.ivaNoAcreditable).toBe('13.79');
    expect(await moved('1130', billId, paymentId)).toBe('159.0069');
    // 172.8000 parked, 159.0069 credited and 13.7931 written off with the forgiven balance.
    expect(await moved('1135', billId, paymentId)).toBe('-172.8000');
    expect(await moved('1135', billId)).toBe('0.0000');
  }, 90_000);

  it('T4 · the REP that declares the CFDI\'s VAT links, in full and by installment', async () => {
    const full = cfdi(5);
    const { billId } = await inbox(full.xml);
    const { paymentId } = await rep(full, '1252.80', 172.8, 5);
    expect(paymentId).toBeTruthy();
    expect(await moved('1130', billId, paymentId)).toBe('172.8000');
    expect(await statusOf(billId)).toBe('paid');

    const half = cfdi(5);
    const second = await inbox(half.xml);
    const installment = await rep(half, '626.40', 86.4, 5);
    expect(installment.paymentId).toBeTruthy();
    expect(await releasedBy(installment.paymentId as string)).toBe('86.4000');
    expect(await statusOf(second.billId)).toBe('partially_paid');
  }, 120_000);

  it('T5 · the DIOT declares 172.80 at 16 % for a paid PPD and a paid PUE, with no header finding', async () => {
    const ppd = await inbox(cfdi(6).xml);
    await pay(ppd.billId, '1252.80', 6);
    expect(await diotOf(6)).toEqual({ header: [], rate16: '172.8000' });

    const pue = await inbox(cfdi(7, { method: 'PUE' }).xml);
    expect(await headerOf(pue.billId)).toBe('172.8000');
    await pay(pue.billId, '1252.80', 7);
    expect(await diotOf(7)).toEqual({ header: [], rate16: '172.8000' });
  }, 120_000);

  it('T7 · a VAT-only CFDI and a `bill create` bill keep the header they had', async () => {
    const { billId } = await inbox(cfdi(8, { ieps: null, vat: '160.00' }).xml);
    expect(await headerOf(billId)).toBe('160.0000');
    const manual = await createBill({
      entity_id: f.entityId, vendor_id: vendorId, created_by: f.userId,
      bill_date: '2027-01-10', due_date: '2027-02-09', currency_code: 'MXN', // its own year: the inbox numbers bills by COUNT(*)
      lines: [{
        account_id: await one(`SELECT id FROM accounts WHERE entity_id = $1 AND code = '6100'`, [f.entityId]),
        unit_price: '1000', tax_amount: '252.80',
      }],
    });
    expect(await headerOf(manual.id)).toBe('252.8000');
  }, 90_000);
});

// MNE-001-554: the bills the old writer stored are corrected by migration 328.
describe('a bill stored before the fix', () => {
  it('T8 · after the migration a payment releases the right VAT, and the earlier excess stays written', async () => {
    const { billId } = await inbox(cfdi(10).xml);
    await query(`UPDATE bills SET tax_amount = 252.80 WHERE id = $1 AND entity_id = $2`, [billId, f.entityId]);
    expect(await releasedBy(await pay(billId, '626.40', 10, 18))).toBe('126.4000');

    const file = path.join(__dirname, '..', '..', 'src', 'database', 'migrations', '328_a_cfdi_bill_header_holds_vat_alone.sql');
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(file, 'utf-8'));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    expect(await headerOf(billId)).toBe('172.8000');
    // Run by a superuser, whom RLS does not filter: the row is still this firm's.
    expect(await one(`SELECT tenant_id::text FROM audit_log WHERE entity_type = 'bills' AND entity_id = $1`, [billId])).toBe(f.tenantId);

    expect(await releasedBy(await pay(billId, '626.40', 10, 20))).toBe('86.4000');
    // 172.80 parked, 126.40 + 86.40 released: the 40.00 over-credited before the
    // correction stays in sight, and nothing was posted to hide it.
    expect(await moved('1135', billId)).toBe('-40.0000');
    expect(await one(
      `SELECT count(*)::text FROM journal_entries WHERE entity_id = $1 AND status = 'posted'
          AND source_id IN (SELECT $2::uuid UNION SELECT payment_id FROM payment_applications WHERE bill_id = $2)`,
      [f.entityId, billId]
    )).toBe('3');
  }, 120_000);
});

describe('the draft door', () => {
  it('T6 · approving a draft over an IEPS CFDI leaves the VAT alone in the header', async () => {
    const ctx = { tenantId: f.tenantId, entityId: f.entityId };
    await resolvePolicy(ctx, 'cfdi_tolerancia_cuadre', '1.00', f.userId, 'test');
    const up = await svc.processXMLUpload(
      f.entityId, cfdi(9, { subtotal: '10.00', ieps: '0.80', vat: '1.73' }).xml, 'manual_upload', f.userId
    );
    const codes = (await query<{ code: string; id: string }>(
      `SELECT code, id FROM accounts WHERE entity_id = $1`, [f.entityId]
    )).rows;
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const bill = await registrarFacturaDeBorradorAprobado(client, {
        ...ctx,
        preRegistrationId: String(up.preRegistration.id),
        approvedLines: [
          { account_code: '6100', debit: 10 },
          { account_code: '1165', debit: 0.8 },
          { account_code: '1135', debit: 1.73 },
          { account_code: '2110', credit: 12.53 },
        ],
        approvedDescription: 'Approved draft',
        accountIdByCode: new Map(codes.map((c) => [c.code, c.id])),
        userId: f.userId,
      });
      const header = await client.query<{ tax_amount: string }>(
        `SELECT tax_amount::text FROM bills WHERE id = $1`, [bill.billId]
      );
      expect(header.rows[0].tax_amount).toBe('1.7300');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }, 90_000);
});
