import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { query, getClient, closeDatabase, enterTenant, withTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import {
  recordVendorPayment, applyVendorPayment, unapplyVendorPayment, reverseVendorPayment,
} from '../../src/services/payments/payment-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { censusVatOvercredit, type OvercreditFinding } from '../../src/services/accounting/vat-overcredit.js';

// ============================================================
// MNE-001-562 · #725 — THE VAT RELEASED ABOVE THE CFDI'S, BEFORE THE HEADER
// HELD VAT ALONE: A CENSUS THAT WRITES NOTHING (part 1 of 2).
//
// Until MNE-001-488 a received CFDI's bill kept VAT plus IEPS in its header,
// and each payment moved its pro rata of that sum from 1135 to 1130. The CFDI
// is the issue's: SubTotal 1,000.00, IEPS 80.00, VAT 172.80, Total 1,252.80.
// The old header (252.80) is put back by SQL, as the old writer left it, and
// "the header corrected" is migration 328 run again, as 488's T8 does. Every
// figure was worked by hand in the plan. All data is synthetic.
// ============================================================

const OWN_RFC = 'XAXX010101000';
const VENDOR_RFC = 'IEP010101AA1';

interface Ctx { f: Fixture; vendorId: string; bank: string }
let a: Ctx;
const svc = new PreRegistrationService();

/** A received one-concept PPD CFDI: IEPS (by rate, or by quota) ahead of the VAT at 16 %, or the VAT alone. */
function cfdi(month: number, o: { ieps?: string | null; vat?: string; quota?: boolean } = {}): string {
  const subtotal = '1000.00';
  const vat = o.vat ?? '172.80';
  const ieps = o.ieps === undefined ? '80.00' : o.ieps;
  const vatBase = (Number(subtotal) + Number(ieps ?? 0)).toFixed(2);
  const iepsFactor = o.quota
    ? `TipoFactor="Cuota" TasaOCuota="1.600000"`
    : `TipoFactor="Tasa" TasaOCuota="0.080000"`;
  const transfers =
    (ieps ? `<cfdi:Traslado Base="${o.quota ? '50.00' : subtotal}" Impuesto="003" ${iepsFactor} Importe="${ieps}"/>` : '') +
    `<cfdi:Traslado Base="${vatBase}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${vat}"/>`;
  const taxes = (Number(ieps ?? 0) + Number(vat)).toFixed(2);
  const total = (Number(subtotal) + Number(taxes)).toFixed(2);
  const date = `2026-${String(month).padStart(2, '0')}-10T10:00:00`;
  const uuid = uuidv4().toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="I" Folio="${uuid.slice(0, 6)}" Fecha="${date}" FormaPago="99" MetodoPago="PPD" TipoDeComprobante="I" Moneda="MXN" SubTotal="${subtotal}" Total="${total}" LugarExpedicion="06600">
  <cfdi:Emisor Rfc="${VENDOR_RFC}" Nombre="Bottled Drinks SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${OWN_RFC}" Nombre="Demo Corp MX" UsoCFDI="G03" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos><cfdi:Concepto ClaveProdServ="50202300" ClaveUnidad="H87" Descripcion="Soft drinks" Cantidad="1" ValorUnitario="${subtotal}" Importe="${subtotal}" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>${transfers}</cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="${taxes}"><cfdi:Traslados>${transfers}</cfdi:Traslados></cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="${date}" RfcProvCertif="SAT970701NN3" SelloCFD="s" NoCertificadoSAT="30001000000500000001" SelloSAT="s"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

async function setup(name: string): Promise<Ctx> {
  const f = await crearInquilino(name);
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  const vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code,
       created_by, tipo_tercero, tipo_operacion, default_expense_account_id)
     VALUES ($1, $2, 'V-IEP', 'Bottled Drinks SA', $3, 'rfc', 'MXN', $4, '04', '85',
       (SELECT id FROM accounts WHERE entity_id = $2 AND code = '6100'))`,
    [vendorId, f.entityId, VENDOR_RFC, f.userId]
  );
  const bank = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1, $2, 'Cheques', 'Banco', $3, 'MXN', 'checking')`,
    [bank, f.entityId, f.roles.banco]
  );
  return { f, vendorId, bank };
}

/** `bill inbox run`, then the header put back to VAT plus IEPS, as the old writer left it. */
async function oldBill(c: Ctx, xml: string, oldHeader: string | null = '252.80'): Promise<string> {
  const up = await svc.processXMLUpload(c.f.entityId, xml, 'manual_upload', c.f.userId);
  const r = await svc.processToAccounting(up.preRegistration, c.f.userId);
  const billId = (r.bill as { id: string }).id;
  if (oldHeader) {
    await query(`UPDATE bills SET tax_amount = $3 WHERE id = $1 AND entity_id = $2`, [billId, c.f.entityId, oldHeader]);
  }
  return billId;
}

async function pay(c: Ctx, billId: string, amount: string, month: number, method = 'spei'): Promise<string> {
  const r = await recordVendorPayment(
    {
      entityId: c.f.entityId,
      counterpartyId: c.vendorId,
      paymentAmount: amount,
      paymentDate: new Date(Date.UTC(2026, month - 1, 20)),
      paymentMethod: method,
      bankAccountId: c.bank,
      ...(method === 'check' ? { checkNumber: uuidv4().slice(0, 6) } : {}),
      ...(billId ? { applications: [{ documentId: billId, amountApplied: amount }] } : { applications: [], onAccount: true }),
    },
    c.f.userId
  );
  return r.paymentId;
}

/** Migration 328, run again: the header gets the CFDI's VAT (002) alone. */
async function correctHeaders(): Promise<void> {
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
}

const findingOf = async (c: Ctx, billId: string): Promise<OvercreditFinding | undefined> =>
  (await censusVatOvercredit(c.f.tenantId)).find((x) => x.billId === billId);

const paymentsOf = (x: OvercreditFinding | undefined) =>
  (x?.payments ?? []).map((p) => [p.paymentId, p.creditDate, p.stored, p.should, p.excess]);

const countWritten = async (tenantId: string): Promise<string> =>
  (await query<{ n: string }>(
    `SELECT ((SELECT count(*) FROM journal_entries je JOIN legal_entities le ON le.id = je.entity_id WHERE le.tenant_id = $1)
           + (SELECT count(*) FROM audit_log WHERE tenant_id = $1))::text AS n`,
    [tenantId]
  )).rows[0].n;

beforeAll(async () => {
  a = await setup('MNE-001-562 VAT over-credit census');
}, 180_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('the census of the VAT released above the CFDI', () => {
  it('C1 · two payments on the old header: one bill, 80.0000 over the CFDI, 40.0000 in each month, nothing written', async () => {
    const billId = await oldBill(a, cfdi(3));
    const p1 = await pay(a, billId, '626.40', 3);
    const p2 = await pay(a, billId, '626.40', 4);
    await drainAttestations(3000);
    const before = await countWritten(a.f.tenantId);

    const all = (await censusVatOvercredit(a.f.tenantId)).filter((x) => x.billId === billId);
    expect(all).toHaveLength(1);
    const x = all[0];
    expect([x.vatTransferred, x.released, x.excess, x.corrected, x.open]).toEqual(
      ['172.8000', '252.8000', '80.0000', '0.0000', '80.0000']
    );
    expect(paymentsOf(x)).toEqual([
      [p1, '2026-03-20', '126.4000', '86.4000', '40.0000'],
      [p2, '2026-04-20', '126.4000', '86.4000', '40.0000'],
    ]);
    expect(x.byMonth).toEqual([{ month: '2026-03', excess: '40.0000' }, { month: '2026-04', excess: '40.0000' }]);
    expect([x.correctable, x.reasons]).toEqual([true, []]);
    expect(await countWritten(a.f.tenantId)).toBe(before);
  }, 120_000);

  it('C2 · paid once before the header is corrected and once after: 40.0000 under the first payment only', async () => {
    const billId = await oldBill(a, cfdi(3));
    const p1 = await pay(a, billId, '626.40', 3);
    await correctHeaders();
    const p2 = await pay(a, billId, '626.40', 4);

    const x = await findingOf(a, billId);
    expect(x?.excess).toBe('40.0000');
    expect(paymentsOf(x)).toEqual([
      [p1, '2026-03-20', '126.4000', '86.4000', '40.0000'],
      [p2, '2026-04-20', '86.4000', '86.4000', '0.0000'],
    ]);
    expect(x?.correctable).toBe(true);
  }, 120_000);

  it('C3 · three unequal payments on an IEPS by quota split the same 80.0000 by cumulative targets', async () => {
    const billId = await oldBill(a, cfdi(3, { quota: true }));
    for (const [amount, month] of [['300.00', 3], ['400.00', 4], ['552.80', 5]] as const) await pay(a, billId, amount, month);

    const x = await findingOf(a, billId);
    expect(x?.payments.map((p) => [p.stored, p.should, p.excess])).toEqual([
      ['60.5364', '41.3793', '19.1571'],
      ['80.7152', '55.1724', '25.5428'],
      ['111.5484', '76.2483', '35.3001'],
    ]);
    expect(x?.excess).toBe('80.0000');
  }, 120_000);

  it('C4 · a first payment the parked cap trimmed: its excess is the ledger\'s and the row says it was capped', async () => {
    const billId = await oldBill(a, cfdi(3));
    for (const [amount, month] of [['1000.00', 3], ['200.00', 4], ['52.80', 5]] as const) await pay(a, billId, amount, month);

    const x = await findingOf(a, billId);
    expect(x?.payments.map((p) => [p.stored, p.should, p.excess, p.capped])).toEqual([
      ['172.8000', '137.9310', '34.8690', true],
      ['40.3576', '27.5862', '12.7714', false],
      ['10.6544', '7.2828', '3.3716', false],
    ]);
    expect(x?.excess).toBe('51.0120');
  }, 120_000);

  it('C5 · guards: what is never listed, and what is listed but not corrected automatically, with the reason', async () => {
    // (a) A CFDI with VAT alone, half paid.
    const vatOnly = await oldBill(a, cfdi(3, { ieps: null, vat: '160.00' }), null);
    await pay(a, vatOnly, '580.00', 3);
    // (b) A bill with no CFDI behind it, header 252.80, paid.
    const manual = uuidv4();
    await query(
      `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
         total_amount, amount_due, amount_paid, currency_code, bill_date, due_date, status, created_by, terms)
       VALUES ($1,$2,$3,$4,'MANUAL-562',1000,252.80,1252.80,1252.80,0,'MXN','2026-03-05','2026-03-05','draft',$5,'PPD')`,
      [manual, a.f.entityId, `BILL-${manual.slice(0, 8)}`, a.vendorId, a.f.userId]
    );
    await query(
      `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
       VALUES ($1,$2,1,$3,'Servicio',1,1000,1000,252.80,1252.80)`,
      [uuidv4(), manual, a.f.cuentas['6100']]
    );
    await approveBill(manual, a.f.userId, { entityId: a.f.entityId });
    await pay(a, manual, '1252.80', 3);
    // (c) Closed short: 1,152.80 on account applied as the residual of the bill.
    const short = await oldBill(a, cfdi(3));
    const onAccount = await pay(a, '', '1152.80', 3);
    await applyVendorPayment(
      a.f.entityId, onAccount, [{ documentId: short, amountApplied: '1152.80' }], a.f.userId,
      { modo: 'residual', shortPayReason: 'Breakage accepted by the vendor' }
    );
    // (d) A live application that stored no release, as before migration 105. Each
    // bill below is paid in full, so the reason under test is its only one.
    const unstored = await oldBill(a, cfdi(3));
    const p = await pay(a, unstored, '1252.80', 3);
    await query(`UPDATE payment_applications SET iva_reclass_amount = NULL WHERE payment_id = $1 AND bill_id = $2`, [p, unstored]);
    // (e) A cheque not cashed yet: it holds its VAT in 1135.
    const heldCheck = await oldBill(a, cfdi(3));
    await pay(a, heldCheck, '626.40', 3, 'check');
    // (f) A bill in another currency than the entity's.
    const foreign = await oldBill(a, cfdi(3));
    await pay(a, foreign, '626.40', 3);
    await pay(a, foreign, '626.40', 4);
    await query(`UPDATE bills SET currency_code = 'USD' WHERE id = $1 AND entity_id = $2`, [foreign, a.f.entityId]);

    const census = await censusVatOvercredit(a.f.tenantId);
    const of = (id: string) => census.find((x) => x.billId === id);
    expect([of(vatOnly), of(manual), of(heldCheck)]).toEqual([undefined, undefined, undefined]);

    expect(of(short)?.excess).toBe('13.7931');
    expect(of(short)?.reasons.map((r) => r.code)).toEqual(['closed_short']);
    expect(of(short)?.reasons[0].detail).toContain('100.00');
    expect(of(unstored)?.reasons.map((r) => r.code)).toEqual(['release_not_stored']);
    expect(of(foreign)?.reasons.map((r) => r.code)).toEqual(['foreign_currency']);
    expect([of(short), of(unstored), of(foreign)].map((x) => x?.correctable)).toEqual([false, false, false]);
  }, 240_000);

  it('C6 · an undone payment gave its release back: only the live one is listed, and none once both are undone', async () => {
    const billId = await oldBill(a, cfdi(3));
    const p1 = await pay(a, billId, '626.40', 3);
    const p2 = await pay(a, billId, '626.40', 4);
    await unapplyVendorPayment(a.f.entityId, p2, { billId, reason: 'Applied to the wrong bill' }, a.f.userId);

    const x = await findingOf(a, billId);
    expect(paymentsOf(x)).toEqual([[p1, '2026-03-20', '126.4000', '86.4000', '40.0000']]);
    expect(x?.excess).toBe('40.0000');

    await reverseVendorPayment(a.f.entityId, p1, { reason: 'Transfer returned by the bank' }, a.f.userId);
    expect(await findingOf(a, billId)).toBeUndefined();
  }, 120_000);

  it('C7 · each tenant sees only its own bills, and an entity off Mexican books has none', async () => {
    const b = await setup('MNE-001-562 second tenant');
    try {
      const theirs = await withTenant(b.f.tenantId, async () => {
        const id = await oldBill(b, cfdi(3));
        await pay(b, id, '626.40', 3);
        await pay(b, id, '626.40', 4);
        return id;
      });
      enterTenant(a.f.tenantId);
      expect(await findingOf(a, theirs)).toBeUndefined();
      expect(await withTenant(b.f.tenantId, async () => (await findingOf(b, theirs))?.excess)).toBe('80.0000');

      await query(
        `UPDATE legal_entities SET incorporation_country = 'US', accounting_standard = 'us_gaap'
          WHERE id = $1 AND tenant_id = $2`,
        [b.f.entityId, b.f.tenantId]
      );
      expect(await withTenant(b.f.tenantId, () => censusVatOvercredit(b.f.tenantId))).toEqual([]);
    } finally {
      enterTenant(a.f.tenantId);
    }
  }, 240_000);
});
