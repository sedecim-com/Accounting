import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { recordCustomerPayment, recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { NotFoundError, ValidationError } from '../../src/utils/errors.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

// ============================================================
// MNE-001-058 · THE DEFINITIVE IVA OF A SYNTHETIC MONTH, BY RATE, BY HAND
//
// May 2026, every figure worked out below and every document posted by the
// real services, so the workpaper is measured against what the ledger moved:
//
//   sale PUE     1 000 at 16 % (160) + 500 at 0 %                 → 160 charged
//   sale PPD     2 000 at 16 % (320) + 1 000 at 8 % (80), total 3 400,
//                half collected (1 700)                          → 160 + 40 charged
//   purchase PUE   800 at 16 % (128), paid                        → 128 creditable
//   purchase PPD 1 500 at 16 % (240), total 1 740, half paid (870) → 120 creditable
//   a prior balance in favor of 10.50 is applied                 → 10.50, 10 in whole
//
//   charged 16 %  base 2 000  IVA 320      charged 8 %  base 500  IVA 40
//   charged 0 %   base   500  IVA 0        creditable 16 %  base 1 550  IVA 248
//   cents: 320 + 40 − 248 − 10.50 = 101.50
//   whole, cada_renglon (default): 320 + 40 − 248 − 10 = 102
//
// Two manual entries no document explains, which the tie-outs must name:
// 10.50 debited to iva_retenido_a_favor and 12.34 credited to iva_trasladado.
// A manual retention is NOT the customer's withholding on a document: only
// the document's own entry says that (the CFDI case is in
// mne-001-058-iva-workpaper-cfdi.int.spec.ts).
//
// June holds one PUE sale whose lines lost their tax, as an ingested CFDI
// without its pre-registration looks: the settlement must be withheld.
// ============================================================

const MONTH = 5;
const day = (d: number): string => `2026-05-${String(d).padStart(2, '0')}`;

let f: Fixture;
let customerId: string;
let vendorId: string;
let wp: IvaWorkpaper;
let june: IvaWorkpaper;

async function sale(terms: 'PUE' | 'PPD', lines: Array<[string, string]>, date = day(5)): Promise<string> {
  const draft = await createInvoice({
    entity_id: f.entityId,
    customer_id: customerId,
    invoice_date: date,
    due_date: date,
    currency_code: 'MXN',
    terms,
    lines: lines.map(([price, rate]) => ({
      revenue_account_id: f.cuentas['4100'], description: 'Servicio', quantity: '1', unit_price: price, tax_rate: rate,
    })),
    created_by: f.userId,
  });
  return (await issueInvoice(draft.id, f.userId, { entityId: f.entityId })).invoice.id;
}

async function purchase(terms: 'PUE' | 'PPD', amount: string, iva: string): Promise<{ id: string; total: string }> {
  const id = uuidv4();
  const total = (Number(amount) + Number(iva)).toFixed(4);
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
       total_amount, amount_due, amount_paid, currency_code, bill_date, due_date, status, created_by, terms)
     VALUES ($1,$2,$3,$4,$3,$5,$6,$7,$7,0,'MXN',$8,$8,'draft',$9,$10)`,
    [id, f.entityId, `BILL-${id.slice(0, 8)}`, vendorId, amount, iva, total, day(8), f.userId, terms]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price,
       line_amount, tax_amount, total_amount, tax_rate, tipo_factor)
     VALUES ($1,$2,1,$3,'Insumo',1,$4,$4,$5,$6,'16.00','tasa')`,
    [uuidv4(), id, f.cuentas['6100'], amount, iva, total]
  );
  await approveBill(id, f.userId, { entityId: f.entityId });
  return { id, total };
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-058 IVA definitivo');
  await seedPolicies({ tenantId: f.tenantId });
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-058', 'Cliente Sintético SA', 'MXN', $3)`,
    [customerId, f.entityId, f.userId]
  );
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'V-058', 'Proveedor Sintético SA', 'PSI010101AA1', 'rfc', 'MXN', $3)`,
    [vendorId, f.entityId, f.userId]
  );

  await sale('PUE', [['1000', '16'], ['500', '0']]);
  const ppdSale = await sale('PPD', [['2000', '16'], ['1000', '8']]);
  await recordCustomerPayment(
    {
      entityId: f.entityId, counterpartyId: customerId, paymentAmount: '1700', paymentDate: day(20),
      paymentMethod: 'spei', applications: [{ documentId: ppdSale, amountApplied: '1700' }],
    },
    f.userId
  );

  for (const [terms, amount, iva, paid] of [
    ['PUE', '800.0000', '128.0000', null],
    ['PPD', '1500.0000', '240.0000', '870.0000'],
  ] as const) {
    const bill = await purchase(terms, amount, iva);
    await recordVendorPayment(
      {
        entityId: f.entityId, counterpartyId: vendorId, paymentAmount: paid ?? bill.total, paymentDate: day(22),
        paymentMethod: 'spei', applications: [{ documentId: bill.id, amountApplied: paid ?? bill.total }],
      },
      f.userId
    );
  }

  await createJournalEntry(
    f.entityId, new Date(Date.UTC(2026, MONTH - 1, 25)), JournalEntryType.STANDARD, 'IVA retenido por el cliente',
    [
      { account_id: f.roles['iva_retenido_a_favor'], debit_amount: '10.50', credit_amount: null, description: 'IVA retenido' },
      { account_id: f.roles['cxc'], debit_amount: null, credit_amount: '10.50', description: 'Cliente' },
    ],
    f.userId,
    { autoPost: true }
  );

  await createJournalEntry(
    f.entityId, new Date(Date.UTC(2026, MONTH - 1, 26)), JournalEntryType.STANDARD, 'IVA trasladado sin documento',
    [
      { account_id: f.roles['cxc'], debit_amount: '12.34', credit_amount: null, description: 'Cliente' },
      { account_id: f.roles['iva_trasladado'], debit_amount: null, credit_amount: '12.34', description: 'IVA' },
    ],
    f.userId,
    { autoPost: true }
  );

  wp = await buildIvaWorkpaper({
    tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: MONTH, priorBalanceInFavor: '10.50',
  });

  const bare = await sale('PUE', [['1000', '16']], '2026-06-05');
  await query(`UPDATE invoice_lines SET tax_amount = 0, tax_rate = NULL WHERE invoice_id = $1`, [bare]);
  june = await buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 6 });
}, 240_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('the definitive IVA of the month equals the hand calculation', () => {
  it('charged by rate: PUE whole, PPD in the share collected', () => {
    const c = wp.figures.charged;
    expect(c.tasa16).toEqual({ base: '2000.0000', iva: '320.0000' });
    expect(c.tasa8).toEqual({ base: '500.0000', iva: '40.0000' });
    expect(c.tasa0).toEqual({ base: '500.0000', iva: '0.0000' });
  });

  it('creditable by rate: PUE whole, PPD in the share paid', () => {
    expect(wp.figures.creditable.tasa16).toEqual({ base: '1550.0000', iva: '248.0000' });
  });

  it('the creditable side ties to the ledger', () => {
    expect(wp.ledger.iva_acreditable).toBe('248.0000');
    expect(wp.findings.map((h) => h.codigo)).not.toContain('IVA-WP-CREDITABLE-VS-LEDGER');
  });

  it('a manual IVA entry no document explains is named by the charged tie-out', () => {
    expect(wp.ledger.iva_trasladado).toBe('-372.3400');
    const found = wp.findings.find((h) => h.codigo === 'IVA-WP-CHARGED-VS-LEDGER');
    expect(found?.mensaje).toMatch(/360\.0000.*372\.3400/);
  });

  it('a manual retention is not a customer withholding: it is left out and named', () => {
    expect(wp.figures.withheldByCustomers).toBe('0.0000');
    expect(wp.ledger.iva_retenido_a_favor).toBe('10.5000');
    const found = wp.findings.find((h) => h.codigo === 'IVA-WP-WITHHELD-VS-LEDGER');
    expect(found?.mensaje).toMatch(/0\.0000.*10\.5000/);
  });

  it('a manual 0 % line cannot say it is not exempt: the finding says so', () => {
    expect(wp.findings.find((h) => h.codigo === 'IVA-WP-ZERO-RATE-UNVERIFIED')?.mensaje).toMatch(/^500\.0000/);
  });

  it('every line adjusted to whole by CFF art. 20 by default: 102 payable', () => {
    expect(wp.rounding).toMatchObject({ key: 'declaracion_redondeo_a_pesos', value: 'cada_renglon' });
    expect(wp.blockedBy).toEqual([]);
    const line = (k: string) => wp.settlement?.lines.find((l) => l.key === k);
    expect(line('prior_balance_in_favor')).toMatchObject({ cents: '10.50', whole: '10' });
    expect(wp.settlement?.resultCents).toBe('101.50');
    expect(wp.settlement?.resultWhole).toBe('102');
  });

  it('a blocking finding withholds the settlement: no figure is presented as declarable', () => {
    expect(june.blockedBy).toEqual(['DIOT-IVA-CABECERA']);
    expect(june.settlement).toBeNull();
    const found = june.findings.find((h) => h.codigo === 'DIOT-IVA-CABECERA');
    expect(found?.mensaje).toMatch(/^La factura de venta /);
  });

  it('a prior balance in favor that is not an amount of zero or more is refused', async () => {
    await expect(
      buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: MONTH, priorBalanceInFavor: '-1' })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('another tenant does not see the entity', async () => {
    await expect(
      buildIvaWorkpaper({ tenantId: uuidv4(), entityId: f.entityId, year: 2026, month: MONTH })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
