import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// MNE-001-385 · THE CREDITABLE IVA OF MIXED ACTIVITIES, BY HAND
//
// LIVA art. 5 fr. V: the IVA paid is credited in the proportion the taxed
// acts bear to all the acts. The panel's `iva_creditable_proration` picks the
// month's (inc. c, default) or the prior calendar year's (art. 5-B).
//
//   2026-01  capital contribution: the ledger holds 2026 from January
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
//
// A sister entity whose ledger starts in November 2026 (a migration):
//   2026-11  sale PUE 1 000 at 16 %
//   2027-01  purchase PUE 500 at 16 % (80), paid
//   Annual, January 2027: November is not 2026's proportion, so it blocks
//   even though no exempt act was read (the proration is null and the 80
//   would be credited whole).
//   Then 2026-12: a sale of 1 000 whose line says exempt and carries 160 of
//   IVA. That document blocks January under a code of its own.
// ============================================================

interface Parties {
  on: Fixture;
  customerId: string;
  vendorId: string;
}

let f: Parties;
let g: Parties;
let mayMonthly: IvaWorkpaper;
let janMonthly: IvaWorkpaper;
let janAnnual: IvaWorkpaper;
let mayAnnual: IvaWorkpaper;
let janPartial: IvaWorkpaper;
let janBroken: IvaWorkpaper;

async function parties(on: Fixture, suffix: string): Promise<Parties> {
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Cliente Sintético SA', 'MXN', $4)`,
    [customerId, on.entityId, `C-385${suffix}`, on.userId]
  );
  const vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, $3, 'Proveedor Sintético SA', 'PSI010101AA1', 'rfc', 'MXN', $4)`,
    [vendorId, on.entityId, `V-385${suffix}`, on.userId]
  );
  return { on, customerId, vendorId };
}

async function sale(p: Parties, date: string, price: string, rate: string | null): Promise<string> {
  const draft = await createInvoice({
    entity_id: p.on.entityId,
    customer_id: p.customerId,
    invoice_date: date,
    due_date: date,
    currency_code: 'MXN',
    terms: 'PUE',
    lines: [{
      revenue_account_id: p.on.cuentas['4100'], description: 'Servicio', quantity: '1', unit_price: price,
      tax_rate: rate, tax_code: rate === null ? 'exento' : null,
    }],
    created_by: p.on.userId,
  });
  await issueInvoice(draft.id, p.on.userId, { entityId: p.on.entityId });
  return draft.id;
}

async function paidPurchase(p: Parties, date: string, amount: string, iva: string): Promise<void> {
  const id = uuidv4();
  const total = (Number(amount) + Number(iva)).toFixed(4);
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
       total_amount, amount_due, amount_paid, currency_code, bill_date, due_date, status, created_by, terms)
     VALUES ($1,$2,$3,$4,$3,$5,$6,$7,$7,0,'MXN',$8,$8,'draft',$9,'PUE')`,
    [id, p.on.entityId, `BILL-${id.slice(0, 8)}`, p.vendorId, amount, iva, total, date, p.on.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price,
       line_amount, tax_amount, total_amount, tax_rate, tipo_factor)
     VALUES ($1,$2,1,$3,'Insumo',1,$4,$4,$5,$6,'16.00','tasa')`,
    [uuidv4(), id, p.on.cuentas['6100'], amount, iva, total]
  );
  await approveBill(id, p.on.userId, { entityId: p.on.entityId });
  await recordVendorPayment(
    {
      entityId: p.on.entityId, counterpartyId: p.vendorId, paymentAmount: total, paymentDate: date,
      paymentMethod: 'spei', applications: [{ documentId: id, amountApplied: total }],
    },
    p.on.userId
  );
}

/** The fixture opens 2026 only; January 2027 needs its year and period. */
async function openJanuary2027(on: Fixture): Promise<void> {
  const year = uuidv4();
  await query(
    `INSERT INTO fiscal_years (id, entity_id, year_number, start_date, end_date, is_calendar_year, status)
     VALUES ($1, $2, 2027, '2027-01-01', '2027-12-31', true, 'open')`,
    [year, on.entityId]
  );
  await query(
    `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name, start_date, end_date, status)
     VALUES ($1, $2, $3, 1, 'Periodo 1/2027', '2027-01-01', '2027-01-31', 'open')`,
    [uuidv4(), year, on.entityId]
  );
}

const build = (on: Fixture, year: number, month: number): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: on.tenantId, entityId: on.entityId, year, month });

beforeAll(async () => {
  const main = await crearInquilino('MNE-001-385 prorrateo');
  const late = await crearEntidadHermana(main, 'MNE-001-385 migrada en noviembre');
  await seedPolicies({ tenantId: main.tenantId });
  f = await parties(main, '');
  g = await parties(late, '-G');
  await openJanuary2027(main);
  await openJanuary2027(late);

  await createJournalEntry(
    main.entityId, '2026-01-02', JournalEntryType.STANDARD, 'Aportación de capital',
    [
      { account_id: main.cuentas['1110'], debit_amount: '10000.0000', credit_amount: null, description: 'banco' },
      { account_id: main.cuentas['3100'], debit_amount: null, credit_amount: '10000.0000', description: 'capital' },
    ],
    main.userId, { autoPost: true }
  );
  await sale(f, '2026-05-05', '3000', '16');
  await sale(f, '2026-05-06', '1500', null);
  await paidPurchase(f, '2026-05-08', '1000.0000', '160.0000');
  await sale(f, '2026-11-10', '1500', null);
  await sale(f, '2027-01-05', '1000', '16');
  await paidPurchase(f, '2027-01-08', '500.0000', '80.0000');

  mayMonthly = await build(main, 2026, 5);
  janMonthly = await build(main, 2027, 1);
  await resolvePolicy({ tenantId: main.tenantId, entityId: main.entityId }, 'iva_creditable_proration', 'annual', main.userId);
  janAnnual = await build(main, 2027, 1);
  mayAnnual = await build(main, 2026, 5);

  await sale(g, '2026-11-10', '1000', '16');
  await paidPurchase(g, '2027-01-08', '500.0000', '80.0000');
  await resolvePolicy({ tenantId: late.tenantId, entityId: late.entityId }, 'iva_creditable_proration', 'annual', late.userId);
  janPartial = await build(late, 2027, 1);
  const broken = await sale(g, '2026-12-03', '1000', '16');
  // The line now says exempt and still carries its 160 of IVA.
  await query(`UPDATE invoice_lines SET tax_code = 'exento' WHERE invoice_id = $1`, [broken]);
  janBroken = await build(late, 2027, 1);
}, 300_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

const line = (wp: IvaWorkpaper, key: string) => wp.settlement?.lines.find((l) => l.key === key);

describe('the month proportion (inc. c) by default', () => {
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
    const warning = mayMonthly.findings.find((h) => h.codigo === 'IVA-WP-PRORATION-OVER-ALL-PAID')?.mensaje;
    expect(warning).toMatch(/^El IVA pagado del mes \(160\.0000\) se acredita en la proporción 0\.666667/);
    // It errs both ways, and says which.
    expect(warning).toMatch(/sobrestimado por un gasto sólo de actos exentos y subestimado por uno sólo de gravados/);
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

  it('the workpaper says which method applied even when nothing was prorated, and that the panel was not answered', () => {
    expect(janMonthly.proration).toEqual({ key: 'iva_creditable_proration', value: 'monthly', defined: false });
  });
});

describe('the prior year proportion (art. 5-B) when the panel chooses it', () => {
  it('January 2027 reads 2026: 3 000 of 6 000, 80 × 0.5 = 40 credited, 120 payable', () => {
    expect(janAnnual.proration).toEqual({ key: 'iva_creditable_proration', value: 'annual', defined: true });
    expect(janAnnual.blockedBy).toEqual([]);
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

  it('a ledger that holds only November and December of the prior year blocks instead of crediting the 80 whole', () => {
    expect(janPartial.figures.proration).toBeNull();
    expect(janPartial.settlement).toBeNull();
    expect(janPartial.blockedBy).toContain('IVA-WP-PRORATION-PARTIAL-REFERENCE');
    expect(janPartial.findings.find((h) => h.codigo === 'IVA-WP-PRORATION-PARTIAL-REFERENCE')?.mensaje)
      .toMatch(/del 2026-11-10 al 2026-12-31/);
  });

  it('a blocking document of the prior year blocks the month under a code of its own', () => {
    expect(janBroken.settlement).toBeNull();
    expect(janBroken.blockedBy).toContain('DIOT-EXENTO-CON-IVA@REFERENCE');
    expect(janBroken.blockedBy).not.toContain('DIOT-EXENTO-CON-IVA');
    expect(janBroken.findings.find((h) => h.codigo === 'DIOT-EXENTO-CON-IVA@REFERENCE')?.mensaje)
      .toMatch(/^Proporción del año 2026: /);
  });
});
