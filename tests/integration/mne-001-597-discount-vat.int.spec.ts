import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, withTransaction, closeDatabase } from '../../src/database/connection.js';
import { receivedVatStillParked } from '../../src/services/accounting/iva-cash-basis.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { hechosDelMes } from '../../src/services/sat/diot/hechos.js';
import {
  recordVendorPayment,
  applyVendorPayment,
  unapplyVendorPayment,
  reverseVendorPayment,
} from '../../src/services/payments/payment-service.js';

/**
 * MNE-001-597 (#831): the VAT of an early-payment discount leaves 1135.
 *
 * On cash-basis books a received bill parks its VAT in 1135 and each payment
 * moves the share of the cash it pays to 1130 (LIVA art. 5 fr. III). A
 * discount lowers the price and so the VAT (art. 7): its share was never
 * paid, so it is never creditable. Until this task the whole discount went to
 * 5200 and that share stayed in 1135 on a paid bill, forever.
 *
 * Hand figures, bill B-1: 1,000.00 + 160.00 = 1,160.00, paid 1,102.00 with a
 * discount of 58.00. Release 160 × 1,102 / 1,160 = 152.0000; the discount's
 * VAT 58 × 160 / 1,160 = 8.0000, so 5200 takes 50.0000 and 1135 ends at 0.
 */

let f: Fixture;
const PAID_ON = '2026-08-15';

// Paying in dollars with an explicit rate may write `exchange_rates`, which is
// global: it is put back as it was (helpers/catalogos-globales.ts).
apartarCatalogos('exchange_rates');

beforeAll(async () => {
  f = await crearInquilino('MNE-001-597 discount VAT');
  await seedPolicies({ tenantId: f.tenantId });
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function approvedBill(
  subtotal: string, iva: string, fx?: { currency: string; rate: string }
): Promise<{ billId: string; vendorId: string }> {
  const total = new Decimal(subtotal).plus(iva).toFixed(2);
  const billId = uuidv4();
  const vendorId = uuidv4();
  const tag = uuidv4().slice(0, 8);
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor 597','CCC030303CC3','rfc',$4,$5)`,
    [vendorId, f.entityId, `V-${tag}`, fx?.currency ?? 'MXN', f.userId]
  );
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, exchange_rate, bill_date, due_date, status, created_by, terms
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,$9,$10,$11,$11,'draft',$12,'PPD')`,
    [billId, f.entityId, `BILL-${tag}`, vendorId, `CFDI-${tag}`, subtotal, iva, total,
     fx?.currency ?? 'MXN', fx?.rate ?? '1.0', fx ? fechaEnPeriodo() : PAID_ON, f.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio a credito',1,$4,$4,$5,$6)`,
    [uuidv4(), billId, f.cuentas['6100'], subtotal, iva, total]
  );
  await approveBill(billId, f.userId, { entityId: f.entityId });
  return { billId, vendorId };
}

async function paid(
  billId: string, vendorId: string, amount: string, discount: string
): Promise<{ paymentId: string; entryId: string }> {
  const r = await recordVendorPayment(
    {
      entityId: f.entityId, counterpartyId: vendorId, paymentAmount: amount, paymentDate: PAID_ON,
      paymentMethod: 'spei', applications: [{ documentId: billId, amountApplied: amount, discountAmount: discount }],
    },
    f.userId
  );
  return { paymentId: r.paymentId, entryId: r.journalEntry!.id };
}

async function onAccount(vendorId: string, amount: string): Promise<string> {
  const r = await recordVendorPayment(
    { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: amount, paymentDate: PAID_ON,
      paymentMethod: 'spei', applications: [], onAccount: true },
    f.userId
  );
  return r.paymentId;
}

/** The entry's lines by account code, two decimals. */
async function linesOf(entryId: string): Promise<Map<string, { debit: string; credit: string }>> {
  const r = await query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, COALESCE(SUM(l.debit_amount),0)::text AS debit, COALESCE(SUM(l.credit_amount),0)::text AS credit
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.journal_entry_id = $1 GROUP BY a.code`,
    [entryId]
  );
  return new Map(r.rows.map((x) => [x.code, { debit: new Decimal(x.debit).toFixed(2), credit: new Decimal(x.credit).toFixed(2) }]));
}

/**
 * What an account holds for these documents in the ledger: the entries whose
 * source is the bill or one of its payments, and their mirrors (a mirror
 * carries no source of its own).
 */
async function heldBy(code: string, sources: string[]): Promise<string> {
  const r = await query<{ net: string }>(
    `SELECT (COALESCE(SUM(l.debit_amount),0) - COALESCE(SUM(l.credit_amount),0))::text AS net
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND a.code = $3
        AND (je.source_id = ANY($2::uuid[])
             OR je.id IN (SELECT reversed_by_entry_id FROM journal_entries
                           WHERE entity_id = $1 AND source_id = ANY($2::uuid[]) AND reversed_by_entry_id IS NOT NULL))`,
    [f.entityId, sources, code]
  );
  return new Decimal(r.rows[0].net).toFixed(4);
}

async function rowsOf(paymentId: string) {
  const r = await query<{ iva: string | null; discount_iva: string | null }>(
    `SELECT iva_reclass_amount::text AS iva, discount_iva_amount::text AS discount_iva
       FROM payment_applications WHERE payment_id = $1`,
    [paymentId]
  );
  return r.rows;
}

const stillParked = (billId: string) =>
  withTransaction((client) => receivedVatStillParked(client, f.entityId, billId));

describe('a vendor bill closed with an early-payment discount leaves nothing in 1135', () => {
  it('A · paid 1,102 + 58 with the payment: 5200 takes 50, 1135 is emptied, the row stores 152 and 8', async () => {
    const { billId, vendorId } = await approvedBill('1000.00', '160.00');
    const { paymentId, entryId } = await paid(billId, vendorId, '1102.00', '58.00');

    const lines = await linesOf(entryId);
    expect(lines.get('2110')?.debit).toBe('1160.00');
    expect(lines.get('5200')).toEqual({ debit: '0.00', credit: '50.00' });
    expect(lines.get('1130')?.debit).toBe('152.00');
    expect(lines.get('1135')?.credit, '8 for the discount, 152 for the cash').toBe('160.00');
    expect(await heldBy('1135', [billId, paymentId])).toBe('0.0000');
    expect(await stillParked(billId)).toBe('0.0000');
    expect(await rowsOf(paymentId)).toEqual([{ iva: '152.0000', discount_iva: '8.0000' }]);
  }, 120_000);

  it('B · an advance applied later with the discount: the same figures', async () => {
    const { billId, vendorId } = await approvedBill('1000.00', '160.00');
    const paymentId = await onAccount(vendorId, '1102.00');
    const r = await applyVendorPayment(
      f.entityId, paymentId, [{ documentId: billId, amountApplied: '1102.00', discountAmount: '58.00' }], f.userId
    );

    const lines = await linesOf(r.journalEntry!.id);
    expect(lines.get('5200')?.credit).toBe('50.00');
    expect(lines.get('1135')?.credit).toBe('160.00');
    expect(lines.get('1130')?.debit).toBe('152.00');
    expect(await heldBy('1135', [billId, paymentId])).toBe('0.0000');
    expect(await rowsOf(paymentId)).toEqual([{ iva: '152.0000', discount_iva: '8.0000' }]);
  }, 120_000);

  it('C · unapplying it gives 5200 back only its 50 and puts all 160 back in 1135', async () => {
    const { billId, vendorId } = await approvedBill('1000.00', '160.00');
    const paymentId = await onAccount(vendorId, '1102.00');
    await applyVendorPayment(
      f.entityId, paymentId, [{ documentId: billId, amountApplied: '1102.00', discountAmount: '58.00' }], f.userId
    );
    const r = await unapplyVendorPayment(f.entityId, paymentId, { billId, reason: 'Descuento no pactado' }, f.userId);

    const lines = await linesOf(r.journalEntry!.id);
    expect(lines.get('1150')?.debit).toBe('1102.00');
    expect(lines.get('5200')?.debit).toBe('50.00');
    expect(lines.get('1135')?.debit).toBe('160.00');
    expect(lines.get('1130')?.credit).toBe('152.00');
    expect(lines.get('2110')?.credit).toBe('1160.00');
    expect(await heldBy('1135', [billId, paymentId])).toBe('160.0000');
    expect(await heldBy('5200', [billId, paymentId])).toBe('0.0000');
    expect(await stillParked(billId)).toBe('160.0000');
  }, 120_000);

  it('D · reversing the payment mirrors it: 1135 and 5200 are back where the bill left them', async () => {
    const { billId, vendorId } = await approvedBill('1000.00', '160.00');
    const { paymentId } = await paid(billId, vendorId, '1102.00', '58.00');
    await reverseVendorPayment(f.entityId, paymentId, { reason: 'Transferencia devuelta', date: '2026-08-20' }, f.userId);

    expect(await heldBy('1135', [billId, paymentId])).toBe('160.0000');
    expect(await heldBy('5200', [billId, paymentId])).toBe('0.0000');
    expect(await stillParked(billId)).toBe('160.0000');
  }, 120_000);

  it('E · a partial 980 + 20, then 160 of cash: 2.7586, 135.1724 and 22.0690 empty 1135', async () => {
    const { billId, vendorId } = await approvedBill('1000.00', '160.00');
    const first = await paid(billId, vendorId, '980.00', '20.00');
    expect((await linesOf(first.entryId)).get('5200')?.credit).toBe('17.24');
    expect(await stillParked(billId), '160 − 135.1724 − 2.7586').toBe('22.0690');

    const second = await recordVendorPayment(
      { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '160.00', paymentDate: PAID_ON,
        paymentMethod: 'spei', applications: [{ documentId: billId, amountApplied: '160.00' }] },
      f.userId
    );
    expect(await heldBy('1135', [billId, first.paymentId, second.paymentId])).toBe('0.0000');
    expect(await rowsOf(second.paymentId)).toEqual([{ iva: '22.0690', discount_iva: '0.0000' }]);
  }, 120_000);

  it('F · after 500 + 20 the bill reads 88.2759 still parked, the base a later credit note takes from', async () => {
    const { billId, vendorId } = await approvedBill('1000.00', '160.00');
    await paid(billId, vendorId, '500.00', '20.00');
    // 160 − 68.9655 − 2.7586; before this task it read 91.0345.
    expect(await stillParked(billId)).toBe('88.2759');
  }, 120_000);

  it('G · in dollars the discount\'s VAT leaves at the bill\'s rate, beside the FX discount line', async () => {
    // USD 100 + 16 at 20.00 parks 320.0000; paid USD 110.20 + 5.80 at 19.50.
    // The release takes 15.20 × 20 = 304.0000; the discount's USD 0.80 × 20
    // = 16.0000 is what is left.
    const { billId, vendorId } = await approvedBill('100.00', '16.00', { currency: 'USD', rate: '20.00' });
    const r = await recordVendorPayment(
      { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '110.20', paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei', exchangeRate: '19.50', currencyCode: 'USD',
        applications: [{ documentId: billId, amountApplied: '110.20', discountAmount: '5.80' }] },
      f.userId
    );

    const lines = await linesOf(r.journalEntry!.id);
    expect(lines.get('5200'), '116.00 at the bill\'s rate, less 16.00 of VAT').toEqual({ debit: '16.00', credit: '116.00' });
    expect(lines.get('1135')?.credit).toBe('320.00');
    expect(await heldBy('1135', [billId, r.paymentId])).toBe('0.0000');
    expect(await rowsOf(r.paymentId)).toEqual([{ iva: '304.0000', discount_iva: '16.0000' }]);
  }, 120_000);

  it('H · the DIOT of the month declares the 152.00 paid, as it did before', async () => {
    const { billId, vendorId } = await approvedBill('1000.00', '160.00');
    await paid(billId, vendorId, '1102.00', '58.00');

    const { hechos: facts } = await withTransaction((client) => hechosDelMes(client, f.entityId, 2026, 8));
    const fact = facts.find((h) => h.billId === billId);
    expect(new Decimal(fact!.ivaPagado).toFixed(2)).toBe('152.00');
  }, 120_000);

  it('I · a row written before 341 (NULL) unapplies as before: 5200 gets its 58 back and 1135 only the release', async () => {
    const { billId, vendorId } = await approvedBill('1000.00', '160.00');
    const paymentId = await onAccount(vendorId, '1102.00');
    await applyVendorPayment(
      f.entityId, paymentId, [{ documentId: billId, amountApplied: '1102.00', discountAmount: '58.00' }], f.userId
    );
    await query(`UPDATE payment_applications SET discount_iva_amount = NULL WHERE payment_id = $1`, [paymentId]);
    const r = await unapplyVendorPayment(f.entityId, paymentId, { billId, reason: 'Fila anterior a 341' }, f.userId);

    const lines = await linesOf(r.journalEntry!.id);
    expect(lines.get('5200')?.debit).toBe('58.00');
    expect(lines.get('1135')?.debit).toBe('152.00');
  }, 120_000);

  it('the column refuses a negative discount VAT: giving it back is the unapply\'s entry', async () => {
    const { billId, vendorId } = await approvedBill('100.00', '16.00');
    const { paymentId } = await paid(billId, vendorId, '110.20', '5.80');
    expect(await rowsOf(paymentId)).toEqual([{ iva: '15.2000', discount_iva: '0.8000' }]);
    await expect(
      query(`UPDATE payment_applications SET discount_iva_amount = -1 WHERE payment_id = $1`, [paymentId])
    ).rejects.toThrow(/payment_applications_discount_iva_not_negative/);
  }, 120_000);
});
