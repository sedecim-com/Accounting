import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, withTransaction, closeDatabase } from '../../src/database/connection.js';
import { receivedVatStillParked } from '../../src/services/accounting/iva-cash-basis.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { seedPolicies, resolvePolicy, reopenPolicy } from '../../src/services/policy/policy-service.js';
import { JournalEntryType } from '../../src/types/index.js';
import {
  recordVendorPayment, applyVendorPayment, unapplyVendorPayment, reverseVendorPayment,
} from '../../src/services/payments/payment-service.js';
import {
  censusDiscountVat, correctDiscountVat, DISCOUNT_VAT_CORRECTION_SOURCE, type DiscountVatFinding,
} from '../../src/services/accounting/discount-vat-correction.js';

// ============================================================
// MNE-001-599 · #831, part 2 of 2 — THE BOOKS CLOSED BEFORE MIGRATION 341.
//
// Before 341 an early-payment discount went whole to 5200 and its share of
// the bill's VAT stayed in 1135. Such a payment is written here as 341 writes
// it and then put back as the old code left it: the row's discount VAT goes
// back to NULL and an entry of the payment returns that share from 5200 to
// 1135. Every figure was worked by hand in the plan. All data is synthetic.
//
// Bill B-1: 1,000.00 + 160.00 = 1,160.00, paid 1,102.00 with a discount of
// 58.00. Release 160 × 1,102 / 1,160 = 152.0000; the discount's VAT 58 × 160
// / 1,160 = 8.0000 stayed in 1135, and 5200 holds 58.00 instead of 50.00.
// ============================================================

let f: Fixture;
const KEY = 'discount_vat_correction_period';
const TODAY = '2026-11-20';

// Paying in dollars with an explicit rate may write `exchange_rates`, which is
// global: it is put back as it was (helpers/catalogos-globales.ts).
apartarCatalogos('exchange_rates');

beforeAll(async () => {
  f = await crearInquilino('MNE-001-599 discount VAT census');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T18:00:00Z`));
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
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
     VALUES ($1,$2,$3,'Proveedor 599','DDD040404DD4','rfc',$4,$5)`,
    [vendorId, f.entityId, `V-${tag}`, fx?.currency ?? 'MXN', f.userId]
  );
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, exchange_rate, bill_date, due_date, status, created_by, terms
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,$9,$10,$11,$11,'draft',$12,'PPD')`,
    [billId, f.entityId, `BILL-${tag}`, vendorId, `CFDI-${tag}`, subtotal, iva, total,
     fx?.currency ?? 'MXN', fx?.rate ?? '1.0', fx ? fechaEnPeriodo() : '2026-03-02', f.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio a credito',1,$4,$4,$5,$6)`,
    [uuidv4(), billId, f.cuentas['6100'], subtotal, iva, total]
  );
  await approveBill(billId, f.userId, { entityId: f.entityId });
  return { billId, vendorId };
}

/** The ledger and the row as a discount posted before 341 left them. */
async function asBefore341(paymentId: string, date: string): Promise<void> {
  const { rows: [row] } = await query<{ v: string }>(
    `SELECT COALESCE(SUM(discount_iva_amount), 0)::text AS v FROM payment_applications WHERE payment_id = $1`, [paymentId]
  );
  if (new Decimal(row.v).greaterThan(0)) {
    await createJournalEntry(
      f.entityId, date, JournalEntryType.STANDARD, 'MNE-001-599 test: the discount as it posted before 341',
      [
        { account_id: f.cuentas['1135'], debit_amount: row.v, credit_amount: null, description: 'Before 341 its VAT stayed' },
        { account_id: f.cuentas['5200'], debit_amount: null, credit_amount: row.v, description: 'Before 341 the whole discount' },
      ],
      f.userId,
      // One of the payment's own sources, so `payment reverse` mirrors it as it would the old entry.
      { autoPost: true, sourceType: 'vendor_application', sourceId: paymentId }
    );
  }
  await query(`UPDATE payment_applications SET discount_iva_amount = NULL WHERE payment_id = $1`, [paymentId]);
}

async function paidBefore341(
  billId: string, vendorId: string, amount: string, discount: string, date = '2026-03-20',
  fx?: { currency: string; rate: string }
): Promise<string> {
  const r = await recordVendorPayment(
    {
      entityId: f.entityId, counterpartyId: vendorId, paymentAmount: amount, paymentDate: date, paymentMethod: 'spei',
      ...(fx ? { currencyCode: fx.currency, exchangeRate: fx.rate } : {}),
      applications: [{ documentId: billId, amountApplied: amount, discountAmount: discount }],
    },
    f.userId
  );
  await asBefore341(r.paymentId, date);
  return r.paymentId;
}

/** Net debit of one account over the documents' own entries and their mirrors (a mirror carries no source). */
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

const stillParked = (billId: string) => withTransaction((client) => receivedVatStillParked(client, f.entityId, billId));

const findingOf = async (billId: string): Promise<DiscountVatFinding | undefined> =>
  (await censusDiscountVat(f.tenantId)).find((x) => x.billId === billId);

async function correct(billId: string, opts: { reopen?: boolean } = {}) {
  const x = await findingOf(billId);
  return correctDiscountVat(x ? [x] : [], f.userId, opts);
}

const correctionsOf = async (paymentId: string) =>
  (await query<{ entry_date: string; reference: string; dr5200: string; cr1135: string }>(
    `SELECT je.entry_date::text AS entry_date, je.reference,
            SUM(l.debit_amount) FILTER (WHERE a.code = '5200')::numeric(19,4)::text AS dr5200,
            SUM(l.credit_amount) FILTER (WHERE a.code = '1135')::numeric(19,4)::text AS cr1135
       FROM journal_entries je
       JOIN journal_entry_lines l ON l.journal_entry_id = je.id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.entity_id = $1 AND je.source_type = $2 AND je.source_id = $3 AND je.status = 'posted'
      GROUP BY je.id, je.entry_date, je.reference ORDER BY je.entry_date`,
    [f.entityId, DISCOUNT_VAT_CORRECTION_SOURCE, paymentId]
  )).rows;

const rowOf = async (paymentId: string) =>
  (await query<{ v: string | null }>(`SELECT discount_iva_amount::text AS v FROM payment_applications WHERE payment_id = $1`, [paymentId])).rows.map((r) => r.v);

const written = async (): Promise<string> =>
  (await query<{ n: string }>(
    `SELECT ((SELECT count(*) FROM journal_entries WHERE entity_id = $2)
           + (SELECT count(*) FROM audit_log WHERE tenant_id = $1)
           + (SELECT count(*) FROM payment_applications pa JOIN bills b ON b.id = pa.bill_id
               WHERE b.entity_id = $2 AND pa.discount_iva_amount IS NOT NULL))::text AS n`,
    [f.tenantId, f.entityId]
  )).rows[0].n;

async function answer(value: string): Promise<void> {
  const ctx = { tenantId: f.tenantId, entityId: f.entityId };
  await reopenPolicy(ctx, KEY).catch(() => undefined);
  await resolvePolicy(ctx, KEY, value, f.userId, 'MNE-001-599 test');
}

const periodStatus = (month: number, status: string) =>
  query(`UPDATE fiscal_periods SET status = $3 WHERE id = $1 AND entity_id = $2`, [f.periodos[month], f.entityId, status]);

describe('the census writes nothing and names the discount VAT left in 1135', () => {
  it('B-1 paid before 341 with 1,102 + 58: it names 8.0000, of the payment\'s month, and writes nothing', async () => {
    const { billId, vendorId } = await approvedBill('1000.00', '160.00');
    const paymentId = await paidBefore341(billId, vendorId, '1102.00', '58.00');
    expect(await heldBy('1135', [billId, paymentId]), 'the 8 left behind').toBe('8.0000');
    expect(await heldBy('5200', [billId, paymentId])).toBe('-58.0000');

    const before = await written();
    const x = await findingOf(billId);
    expect(await written()).toBe(before);
    expect([x?.parked, x?.share, x?.correctable, x?.reasons]).toEqual(['8.0000', '8.0000', true, []]);
    expect(x?.rows.map((r) => [r.paymentId, r.date, r.discount, r.share])).toEqual([[paymentId, '2026-03-20', '58.0000', '8.0000']]);
    expect(x?.byMonth).toEqual([{ month: '2026-03', share: '8.0000' }]);
  }, 120_000);

  it('980 + 20 before 341, then 160 after: 2.7586 is left, the 20\'s share', async () => {
    const { billId, vendorId } = await approvedBill('1000.00', '160.00');
    await paidBefore341(billId, vendorId, '980.00', '20.00');
    await recordVendorPayment(
      { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '160.00', paymentDate: '2026-04-20',
        paymentMethod: 'spei', applications: [{ documentId: billId, amountApplied: '160.00' }] },
      f.userId
    );
    // 160 − 135.1724 − 22.0690.
    expect((await findingOf(billId))?.share).toBe('2.7586');
  }, 120_000);

  it('an advance applied later with the discount: the month is the application\'s, not the payment\'s', async () => {
    const { billId, vendorId } = await approvedBill('1000.00', '160.00');
    const r = await recordVendorPayment(
      { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '1102.00', paymentDate: '2026-03-20',
        paymentMethod: 'spei', applications: [], onAccount: true },
      f.userId
    );
    await applyVendorPayment(f.entityId, r.paymentId, [{ documentId: billId, amountApplied: '1102.00', discountAmount: '58.00' }], f.userId);
    await asBefore341(r.paymentId, TODAY);
    expect((await findingOf(billId))?.rows.map((x) => [x.date, x.share])).toEqual([[TODAY, '8.0000']]);
  }, 120_000);

  it('a discount posted from 341 on is never listed', async () => {
    const { billId, vendorId } = await approvedBill('1000.00', '160.00');
    await recordVendorPayment(
      { entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '1102.00', paymentDate: '2026-03-20',
        paymentMethod: 'spei', applications: [{ documentId: billId, amountApplied: '1102.00', discountAmount: '58.00' }] },
      f.userId
    );
    expect(await findingOf(billId)).toBeUndefined();
  }, 120_000);

  it('names and leaves out a bill in dollars, one closed short and one whose header was edited', async () => {
    const usd = await approvedBill('100.00', '16.00', { currency: 'USD', rate: '20.00' });
    await paidBefore341(usd.billId, usd.vendorId, '110.20', '5.80', toDay(fechaEnPeriodo()), { currency: 'USD', rate: '19.50' });

    const short = await approvedBill('1000.00', '160.00');
    const advance = await recordVendorPayment(
      { entityId: f.entityId, counterpartyId: short.vendorId, paymentAmount: '1000.00', paymentDate: '2026-03-20',
        paymentMethod: 'spei', applications: [], onAccount: true },
      f.userId
    );
    await applyVendorPayment(
      f.entityId, advance.paymentId, [{ documentId: short.billId, amountApplied: '1000.00', discountAmount: '58.00' }], f.userId,
      { modo: 'residual', shortPayReason: 'El proveedor acepta cerrar con lo pagado' }
    );
    await asBefore341(advance.paymentId, TODAY);

    const edited = await approvedBill('1000.00', '160.00');
    await paidBefore341(edited.billId, edited.vendorId, '980.00', '20.00');
    await query(`UPDATE bills SET tax_amount = 150.00 WHERE id = $1`, [edited.billId]);

    const codes = async (billId: string) => {
      const x = await findingOf(billId);
      return [x?.correctable, x?.reasons.map((r) => r.code)];
    };
    expect(await codes(usd.billId)).toEqual([false, ['foreign_currency']]);
    expect(await codes(short.billId)).toEqual([false, ['closed_short']]);
    expect(await codes(edited.billId)).toEqual([false, ['header_edited']]);

    await answer('current_period');
    try {
      for (const billId of [usd.billId, short.billId, edited.billId]) {
        const r = await correct(billId);
        expect([r.corrected, r.skipped.map((s) => s.billId)]).toEqual([[], [billId]]);
      }
    } finally {
      await answer('ask');
    }
  }, 240_000);
});

describe('the correction, as the panel key dates it', () => {
  it('by default ("ask") nothing posts, and the bill is named with both options', async () => {
    const { billId, vendorId } = await approvedBill('1000.00', '160.00');
    const paymentId = await paidBefore341(billId, vendorId, '1102.00', '58.00');
    const before = await written();
    const r = await correct(billId, { reopen: true });
    expect([r.corrected, r.failures]).toEqual([[], []]);
    expect(r.skipped[0].why).toContain('current_period');
    expect(r.skipped[0].why).toContain('payment_month');
    expect(await written()).toBe(before);
    expect(await rowOf(paymentId)).toEqual([null]);
  }, 120_000);

  it('current_period: one audited entry today leaves 1135 at 0.00 and the discount at 50.00, and a second run does nothing', async () => {
    await answer('current_period');
    try {
      const { billId, vendorId } = await approvedBill('1000.00', '160.00');
      const paymentId = await paidBefore341(billId, vendorId, '1102.00', '58.00');

      const r = await correct(billId);
      expect([r.corrected.length, r.skipped, r.failures, r.amount]).toEqual([1, [], [], '8.0000']);
      expect((await correctionsOf(paymentId)).map((e) => [e.entry_date, e.dr5200, e.cr1135]))
        .toEqual([[TODAY, '8.0000', '8.0000']]);
      expect(await heldBy('1135', [billId, paymentId])).toBe('0.0000');
      expect(await heldBy('5200', [billId, paymentId])).toBe('-50.0000');
      expect(await rowOf(paymentId)).toEqual(['8.0000']);
      expect(await stillParked(billId)).toBe('0.0000');

      const audit = await query<{ new_values: Record<string, unknown> }>(
        `SELECT new_values FROM audit_log WHERE tenant_id = $1 AND entity_type = 'bills' AND entity_id = $2 AND action = 'post'`,
        [f.tenantId, billId]
      );
      expect(audit.rows.map((a) => [a.new_values.discount_vat, a.new_values.period_option])).toEqual([['8.0000', 'current_period']]);

      expect(await findingOf(billId)).toBeUndefined();
      const before = await written();
      const again = (await censusDiscountVat(f.tenantId)).filter((y) => y.billId === billId);
      expect((await correctDiscountVat(again, f.userId)).corrected).toEqual([]);
      expect(await written()).toBe(before);
    } finally {
      await answer('ask');
    }
  }, 180_000);

  it('payment_month: a closed month needs --reopen and is put back; a locked one never opens', async () => {
    const { billId, vendorId } = await approvedBill('1000.00', '160.00');
    const paymentId = await paidBefore341(billId, vendorId, '1102.00', '58.00');
    const locked = await approvedBill('1000.00', '160.00');
    const lockedPayment = await paidBefore341(locked.billId, locked.vendorId, '1102.00', '58.00', '2026-05-20');
    await periodStatus(3, 'hard_close');
    await periodStatus(5, 'locked');
    await answer('payment_month');
    try {
      const shut = await correct(billId);
      expect(shut.corrected).toEqual([]);
      expect(shut.skipped[0].why).toContain('--reopen');
      expect(await correctionsOf(paymentId)).toEqual([]);

      expect((await correct(billId, { reopen: true })).amount).toBe('8.0000');
      expect((await correctionsOf(paymentId)).map((e) => [e.entry_date, e.dr5200])).toEqual([['2026-03-20', '8.0000']]);
      expect((await query<{ s: string }>(`SELECT status AS s FROM fiscal_periods WHERE id = $1`, [f.periodos[3]])).rows[0].s).toBe('hard_close');

      const never = await correct(locked.billId, { reopen: true });
      expect(never.corrected).toEqual([]);
      expect(never.skipped[0].why).toContain('locked');
      expect(await correctionsOf(lockedPayment)).toEqual([]);
    } finally {
      await periodStatus(3, 'open');
      await periodStatus(5, 'open');
      await answer('ask');
    }
  }, 240_000);

  it('a corrected payment unapplied later: 5200 gets back its 50 and 1135 all 160', async () => {
    await answer('current_period');
    try {
      const { billId, vendorId } = await approvedBill('1000.00', '160.00');
      const paymentId = await paidBefore341(billId, vendorId, '1102.00', '58.00');
      await correct(billId);
      await unapplyVendorPayment(f.entityId, paymentId, { billId, reason: 'Descuento no pactado' }, f.userId);
      expect(await heldBy('1135', [billId, paymentId])).toBe('160.0000');
      expect(await heldBy('5200', [billId, paymentId])).toBe('0.0000');
      expect(await stillParked(billId)).toBe('160.0000');
    } finally {
      await answer('ask');
    }
  }, 180_000);

  it('a corrected payment reversed later: its correction is mirrored with it, and the bill is back at 160 parked', async () => {
    await answer('current_period');
    try {
      const { billId, vendorId } = await approvedBill('1000.00', '160.00');
      const paymentId = await paidBefore341(billId, vendorId, '1102.00', '58.00');
      await correct(billId);
      await expect(
        reverseVendorPayment(f.entityId, paymentId, { reason: 'Transferencia devuelta', date: '2026-11-19' }, f.userId)
      ).rejects.toThrow(/last posted on 2026-11-20/);
      await reverseVendorPayment(f.entityId, paymentId, { reason: 'Transferencia devuelta', date: TODAY }, f.userId);
      expect(await heldBy('1135', [billId, paymentId])).toBe('160.0000');
      expect(await heldBy('5200', [billId, paymentId])).toBe('0.0000');
      expect(await stillParked(billId)).toBe('160.0000');
    } finally {
      await answer('ask');
    }
  }, 180_000);
});

function toDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
