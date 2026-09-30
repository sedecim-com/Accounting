import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

// ============================================================
// MNE-001-385 · THE CREDITABLE IVA OF MIXED ACTIVITIES, BY HAND
//
// LIVA art. 5 fr. V: the IVA paid is credited in the proportion the taxed
// acts bear to all the acts. The panel's `iva_creditable_proration` picks the
// month's (inc. d, default) or the prior calendar year's (art. 5-B).
//
//   2026-05  sale PUE 3 000 at 16 % (480) · sale PUE 1 500 exempt
//            purchase PUE 1 000 at 16 % (160), paid
//   2026-11  sale PUE 1 500 exempt
//   2027-01  sale PUE 1 000 at 16 % (160) · purchase PUE 500 at 16 % (80), paid
//
// Monthly (default):
//   May:  3 000 / 4 500 → 160 × 3 000 / 4 500 = 106.6667 creditable
//         cents 480 − 106.67 = 373.33 · whole 480 − 107 = 373
//   Jan:  no exempt act collected: nothing to prorate, 80 whole → 160 − 80 = 80
// Annual (prior year):
//   Jan 2027 over 2026: 3 000 / (3 000 + 1 500 + 1 500) = 0.5 → 80 × 0.5 = 40
//         160 − 40 = 120
//   May 2026 over 2025: no act collected in 2025, so no proportion: blocked.
// ============================================================

let f: Fixture;
let customerId: string;
let vendorId: string;
let mayMonthly: IvaWorkpaper;
let janMonthly: IvaWorkpaper;
let janAnnual: IvaWorkpaper;
let mayAnnual: IvaWorkpaper;

async function sale(date: string, price: string, rate: string | null): Promise<void> {
  const draft = await createInvoice({
    entity_id: f.entityId,
    customer_id: customerId,
    invoice_date: date,
    due_date: date,
    currency_code: 'MXN',
    terms: 'PUE',
    lines: [{
      revenue_account_id: f.cuentas['4100'], description: 'Servicio', quantity: '1', unit_price: price,
      tax_rate: rate, tax_code: rate === null ? 'exento' : null,
    }],
    created_by: f.userId,
  });
  await issueInvoice(draft.id, f.userId, { entityId: f.entityId });
}

async function paidPurchase(date: string, amount: string, iva: string): Promise<void> {
  const id = uuidv4();
  const total = (Number(amount) + Number(iva)).toFixed(4);
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
       total_amount, amount_due, amount_paid, currency_code, bill_date, due_date, status, created_by, terms)
     VALUES ($1,$2,$3,$4,$3,$5,$6,$7,$7,0,'MXN',$8,$8,'draft',$9,'PUE')`,
    [id, f.entityId, `BILL-${id.slice(0, 8)}`, vendorId, amount, iva, total, date, f.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price,
       line_amount, tax_amount, total_amount, tax_rate, tipo_factor)
     VALUES ($1,$2,1,$3,'Insumo',1,$4,$4,$5,$6,'16.00','tasa')`,
    [uuidv4(), id, f.cuentas['6100'], amount, iva, total]
  );
  await approveBill(id, f.userId, { entityId: f.entityId });
  await recordVendorPayment(
    {
      entityId: f.entityId, counterpartyId: vendorId, paymentAmount: total, paymentDate: date,
      paymentMethod: 'spei', applications: [{ documentId: id, amountApplied: total }],
    },
    f.userId
  );
}

/** The fixture opens 2026 only; January 2027 needs its year and period. */
async function openJanuary2027(): Promise<void> {
  const year = uuidv4();
  await query(
    `INSERT INTO fiscal_years (id, entity_id, year_number, start_date, end_date, is_calendar_year, status)
     VALUES ($1, $2, 2027, '2027-01-01', '2027-12-31', true, 'open')`,
    [year, f.entityId]
  );
  await query(
    `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name, start_date, end_date, status)
     VALUES ($1, $2, $3, 1, 'Periodo 1/2027', '2027-01-01', '2027-01-31', 'open')`,
    [uuidv4(), year, f.entityId]
  );
}

const build = (year: number, month: number): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year, month });

beforeAll(async () => {
  f = await crearInquilino('MNE-001-385 prorrateo');
  await seedPolicies({ tenantId: f.tenantId });
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-385', 'Cliente Sintético SA', 'MXN', $3)`,
    [customerId, f.entityId, f.userId]
  );
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'V-385', 'Proveedor Sintético SA', 'PSI010101AA1', 'rfc', 'MXN', $3)`,
    [vendorId, f.entityId, f.userId]
  );
  await openJanuary2027();

  await sale('2026-05-05', '3000', '16');
  await sale('2026-05-06', '1500', null);
  await paidPurchase('2026-05-08', '1000.0000', '160.0000');
  await sale('2026-11-10', '1500', null);
  await sale('2027-01-05', '1000', '16');
  await paidPurchase('2027-01-08', '500.0000', '80.0000');

  mayMonthly = await build(2026, 5);
  janMonthly = await build(2027, 1);
  await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'iva_creditable_proration', 'annual', f.userId);
  janAnnual = await build(2027, 1);
  mayAnnual = await build(2026, 5);
}, 240_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

const line = (wp: IvaWorkpaper, key: string) => wp.settlement?.lines.find((l) => l.key === key);

describe('the month proportion (inc. d) by default', () => {
  it('May: 3 000 taxed of 4 500 collected, 160 paid, 106.6667 credited', () => {
    expect(mayMonthly.figures.charged.exento).toEqual({ base: '1500.0000', iva: '0.0000' });
    expect(mayMonthly.figures.proration).toEqual({
      method: 'monthly',
      reference: { desde: '2026-05-01', hasta: '2026-05-31' },
      taxedActs: '3000.0000',
      totalActs: '4500.0000',
      factor: '0.666667',
      paid: '160.0000',
      creditable: '106.6667',
    });
  });

  it('only the credited share subtracts: 373.33 in cents, 480 − 107 = 373 whole', () => {
    expect(line(mayMonthly, 'creditable.tasa16.iva')).toMatchObject({ cents: '160.00', sign: 0 });
    expect(line(mayMonthly, 'creditable.prorated')).toMatchObject({ cents: '106.67', whole: '107', sign: -1 });
    expect(mayMonthly.settlement?.resultCents).toBe('373.33');
    expect(mayMonthly.settlement?.resultWhole).toBe('373');
  });

  it('the old "not applied" warning is gone, and the proration names its limits', () => {
    const codes = mayMonthly.findings.map((h) => h.codigo);
    expect(codes).not.toContain('IVA-WP-PRORATION-NOT-APPLIED');
    expect(mayMonthly.findings.find((h) => h.codigo === 'IVA-WP-PRORATION-OVER-ALL-PAID')?.mensaje)
      .toMatch(/^El IVA pagado del mes \(160\.0000\) se acredita en la proporción 0\.666667/);
    // The ledger still holds all the IVA paid: the proration is the workpaper's.
    expect(mayMonthly.ledger.iva_acreditable).toBe('160.0000');
    expect(codes).not.toContain('IVA-WP-CREDITABLE-VS-LEDGER');
  });

  it('January 2027 collected no exempt act: nothing to prorate, 80 credited whole', () => {
    expect(janMonthly.figures.proration).toBeNull();
    expect(line(janMonthly, 'creditable.tasa16.iva')).toMatchObject({ cents: '80.00', sign: -1 });
    expect(line(janMonthly, 'creditable.prorated')).toBeUndefined();
    expect(janMonthly.settlement?.resultWhole).toBe('80');
  });
});

describe('the prior year proportion (art. 5-B) when the panel chooses it', () => {
  it('January 2027 reads 2026: 3 000 of 6 000, 80 × 0.5 = 40 credited, 120 payable', () => {
    expect(janAnnual.figures.proration).toEqual({
      method: 'annual',
      reference: { desde: '2026-01-01', hasta: '2026-12-31' },
      taxedActs: '3000.0000',
      totalActs: '6000.0000',
      factor: '0.500000',
      paid: '80.0000',
      creditable: '40.0000',
    });
    expect(janAnnual.settlement?.resultCents).toBe('120.00');
    expect(janAnnual.settlement?.resultWhole).toBe('120');
  });

  it('a prior year with no act collected has no proportion: the settlement is withheld', () => {
    expect(mayAnnual.blockedBy).toEqual(['IVA-WP-PRORATION-NO-REFERENCE']);
    expect(mayAnnual.settlement).toBeNull();
    expect(mayAnnual.findings.find((h) => h.codigo === 'IVA-WP-PRORATION-NO-REFERENCE')?.mensaje).toMatch(/año 2025/);
  });
});
