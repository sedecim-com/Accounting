import { describe, it, expect, afterAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment, reverseCustomerPayment, stateReversalCause,
} from '../../src/services/payments/payment-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

// ============================================================
// MNE-001-510 (#701, part 2/3) · THE IVA WORKPAPER APPLIES THE CAUSE A
// REVERSED RECEIPT STATES, NOT ITS METHOD
//
// On #666's rules (comment 6948200519), every figure by hand:
//
//   - not_collected: the money never became the firm's, so it caused no IVA
//     (LIVA art. 1-B). Read as a returned cheque under rule 2: it counts in no
//     month, and each month it would have counted in names it with the
//     amended return (CFF art. 32).
//   - taken_back: the money arrived, so its IVA was caused, and it leaves only
//     by an art. 7 restitution (its second paragraph's document; RLIVA
//     art. 24): an issued credit note, which the paper subtracts in its own
//     month (MNE-001-565). None is issued here, so the collection month keeps it.
//   - no cause on a receipt that is not a cheque: rule 3, the IVA stays where
//     it was collected until a cause is stated with `receipt cause record`
//     (MNE-001-511); both findings name that command.
//
// One entity per story, a PPD invoice of 1,160.00 (1,000.00 + 160.00) issued
// 2026-05-10, collected by `ach` on 2026-05-20 and reversed on 2026-06-10.
// ============================================================

const day = (month: number, d: number, year = 2026): string =>
  `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

interface Book {
  f: Fixture;
  customerId: string;
}

async function book(name: string): Promise<Book> {
  const f = await crearInquilino(`MNE-001-510 ${name}`);
  await seedPolicies({ tenantId: f.tenantId });
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Reversal Cause SA', 'MXN', $4)`,
    [customerId, f.entityId, `C-510-${customerId.slice(0, 6)}`, f.userId]
  );
  return { f, customerId };
}

async function ppd(b: Book, date = day(5, 10)): Promise<string> {
  const draft = await createInvoice({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_date: date, due_date: date,
    currency_code: 'MXN', terms: 'PPD',
    lines: [{ revenue_account_id: b.f.cuentas['4100'], description: 'Synthetic sale', quantity: '1', unit_price: '1000.00', tax_rate: '16' }],
    created_by: b.f.userId,
  });
  return (await issueInvoice(draft.id, b.f.userId, { entityId: b.f.entityId })).invoice.id;
}

const collect = (b: Book, invoiceId: string, date = day(5, 20), method = 'ach') =>
  recordCustomerPayment(
    {
      entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: '1160.00', paymentDate: date,
      paymentMethod: method, applications: [{ documentId: invoiceId, amountApplied: '1160.00' }],
    },
    b.f.userId
  );

const advance = (b: Book, method = 'ach') =>
  recordCustomerPayment(
    {
      entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: '1160.00', paymentDate: day(5, 10),
      paymentMethod: method, applications: [], onAccount: true, advanceTreatment: '16',
    },
    b.f.userId
  );

/** `receipt reverse` has no --date: its mirrors take the clock's day. */
async function reverseOn(b: Book, paymentId: string, date: string, cause?: string) {
  vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date(`${date}T12:00:00`));
  try {
    return await reverseCustomerPayment(
      b.f.entityId, paymentId, { reason: 'returned', ...(cause ? { cause } : {}) }, b.f.userId
    );
  } finally {
    vi.useRealTimers();
  }
}

const paper = (b: Book, month: number, year = 2026): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year, month });

const reversalOf = (wp: IvaWorkpaper, paymentId: string) =>
  wp.findings.find((h) => h.codigo === 'IVA-WP-RECEIPT-REVERSED' && h.documentId === paymentId);

const at16 = (wp: IvaWorkpaper) => ({
  base: Number(wp.figures.charged.tasa16.base).toFixed(2),
  iva: Number(wp.figures.charged.tasa16.iva).toFixed(2),
});

/** Collected in May, reversed on 2026-06-10 with `cause`; the mirror of its own entry. */
async function collectedAndReversed(b: Book, cause?: string, method = 'ach') {
  const inv = await ppd(b);
  const receipt = await collect(b, inv, day(5, 20), method);
  const reversed = await reverseOn(b, receipt.paymentId, day(6, 10), cause);
  const mirror = reversed.reversals.find((r) => r.of === receipt.journalEntry!.entry_number)!.entryNumber;
  return { inv, receipt, reversed, mirror };
}

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('not_collected · read as a returned cheque (rule 2)', () => {
  it('an ach receipt: May counts nothing and names the reversal and the amended return; June counts nothing and names its mirror', async () => {
    const b = await book('ach not collected');
    const { receipt, mirror } = await collectedAndReversed(b, 'not_collected');

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '0.00', iva: '0.00' });
    const inMay = reversalOf(may, receipt.paymentId)?.mensaje ?? '';
    expect(inMay).toContain('2026-06-10');
    expect(inMay).toContain(mirror);
    expect(inMay).toContain('1000.0000');
    expect(inMay).toContain('160.0000');
    expect(inMay).toContain('no cobrado');
    expect(inMay).toContain('complementaria');
    expect(inMay).toContain('CFF art. 32');
    expect(inMay).not.toContain('cheque');

    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    const inJune = reversalOf(june, receipt.paymentId)?.mensaje ?? '';
    expect(inJune).toContain(mirror);
    expect(inJune).toContain('ningún mes');
    expect(inJune).toContain('2026-05');
  }, 120_000);

  it('a reversed advance counts in no month either', async () => {
    const b = await book('advance not collected');
    const receipt = await advance(b);
    await reverseOn(b, receipt.paymentId, day(6, 10), 'not_collected');
    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '0.00', iva: '0.00' });
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    expect(reversalOf(may, receipt.paymentId)?.mensaje).toContain('complementaria');
  }, 120_000);

  it('collected again in July, July counts the new collection whole', async () => {
    const b = await book('not collected, again');
    const { inv } = await collectedAndReversed(b, 'not_collected');
    await collect(b, inv, day(7, 5));
    expect(at16(await paper(b, 5))).toEqual({ base: '0.00', iva: '0.00' });
    expect(at16(await paper(b, 7))).toEqual({ base: '1000.00', iva: '160.00' });
  }, 120_000);
});

describe('taken_back · the IVA leaves only by an art. 7 restitution', () => {
  it('May keeps 1,000.00 / 160.00 and names the reversal; June takes nothing out and names the restitution the paper does not count', async () => {
    const b = await book('ach taken back');
    const { receipt, mirror } = await collectedAndReversed(b, 'taken_back');

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    const inMay = reversalOf(may, receipt.paymentId)?.mensaje ?? '';
    expect(inMay).toContain('2026-06-10');
    expect(inMay).toContain(mirror);
    expect(inMay).toContain('retirado');
    expect(inMay).toContain('art. 7');
    expect(inMay).not.toContain('complementaria');
    expect(inMay).not.toContain('una persona');

    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    const inJune = reversalOf(june, receipt.paymentId)?.mensaje ?? '';
    expect(inJune).toContain(mirror);
    expect(inJune).toContain('restitución del art. 7');
    expect(inJune).toContain('segundo párrafo');
    expect(inJune).toContain('no cuenta');
    expect(inJune).not.toContain('una persona');
  }, 120_000);

  it('a reversed advance keeps its IVA in May', async () => {
    const b = await book('advance taken back');
    const receipt = await advance(b);
    await reverseOn(b, receipt.paymentId, day(6, 10), 'taken_back');
    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    expect(reversalOf(june, receipt.paymentId)?.mensaje).toContain('art. 7');
  }, 120_000);

  it('its invoice collected again in July: July counts 1,000.00 / 160.00 and names the earlier reversal, with no restitution counted', async () => {
    const b = await book('taken back, again');
    const { inv, receipt } = await collectedAndReversed(b, 'taken_back');
    const again = await collect(b, inv, day(7, 5));

    const [may, june, july] = [await paper(b, 5), await paper(b, 6), await paper(b, 7)];
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    expect(at16(july)).toEqual({ base: '1000.00', iva: '160.00' });
    const inJuly = reversalOf(july, receipt.paymentId)?.mensaje ?? '';
    expect(inJuly).toContain(receipt.paymentNumber);
    expect(inJuly).toContain(again.paymentNumber);
    expect(inJuly).toContain('2026-06-10');
    expect(inJuly).toContain('2026-05');
    expect(inJuly).toContain('restitución');
  }, 120_000);

  it('collected, taken back and collected again in the same month: May counts both collections', async () => {
    const b = await book('taken back, same month');
    const inv = await ppd(b);
    const first = await collect(b, inv, day(5, 20));
    await reverseOn(b, first.paymentId, day(5, 25), 'taken_back');
    await collect(b, inv, day(5, 28));
    expect(at16(await paper(b, 5))).toEqual({ base: '2000.00', iva: '320.00' });
  }, 120_000);
});

describe('no cause on a receipt that is not a cheque · rule 3, until one is stated', () => {
  it('May keeps 1,000.00 / 160.00 and June 0; both findings name `receipt cause record`', async () => {
    const b = await book('ach no cause');
    const { receipt, mirror } = await collectedAndReversed(b);

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    for (const wp of [may, june]) {
      const text = reversalOf(wp, receipt.paymentId)?.mensaje ?? '';
      expect(text).toContain(mirror);
      expect(text).toContain('sin causa declarada');
      expect(text).toContain(`receipt cause record ${receipt.paymentNumber}`);
      expect(text).toContain('cobro causa registrar');
    }
  }, 120_000);

  it('not_collected stated later: May drops it and names the statement with what it took out', async () => {
    const b = await book('stated later, not collected');
    const { receipt } = await collectedAndReversed(b);
    expect(at16(await paper(b, 5))).toEqual({ base: '1000.00', iva: '160.00' });
    const stated = await stateReversalCause(
      b.f.entityId, receipt.paymentId, { cause: 'not_collected', reason: 'the direct debit came back unpaid' }, b.f.userId
    );
    const statedOn = (await query<{ d: string }>(
      `SELECT reversal_cause_stated_at::date::text AS d FROM customer_payments WHERE id = $1`, [receipt.paymentId]
    )).rows[0].d;
    expect(stated.cause).toBe('not_collected');

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '0.00', iva: '0.00' });
    const inMay = reversalOf(may, receipt.paymentId)?.mensaje ?? '';
    expect(inMay).toContain(`se declaró el ${statedOn}`);
    expect(inMay).toContain('después de la reversa');
    expect(inMay).toContain('160.0000');
    expect(inMay).not.toContain('receipt cause record');
    expect(reversalOf(june, receipt.paymentId)?.mensaje).toContain(`se declaró el ${statedOn}`);
  }, 120_000);

  it('taken_back stated later: May keeps its IVA and names the statement', async () => {
    const b = await book('stated later, taken back');
    const { receipt } = await collectedAndReversed(b);
    await stateReversalCause(b.f.entityId, receipt.paymentId, { cause: 'taken_back', reason: 'chargeback' }, b.f.userId);
    const may = await paper(b, 5);
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    const inMay = reversalOf(may, receipt.paymentId)?.mensaje ?? '';
    expect(inMay).toContain('se declaró el');
    expect(inMay).toContain('art. 7');
  }, 120_000);
});

describe('a cheque', () => {
  it('reversed with taken_back keeps its IVA in May: the cause, not the method, decides', async () => {
    const b = await book('cheque taken back');
    const inv = await ppd(b);
    const receipt = await collect(b, inv);
    await query(`UPDATE customer_payments SET payment_method = 'check' WHERE id = $1`, [receipt.paymentId]);
    await reverseOn(b, receipt.paymentId, day(6, 10), 'taken_back');
    expect(at16(await paper(b, 5))).toEqual({ base: '1000.00', iva: '160.00' });
  }, 120_000);

  it('reversed before the cause existed (no cause stored) reads as not collected, and says so', async () => {
    const b = await book('cheque no cause');
    const inv = await ppd(b);
    const receipt = await collect(b, inv);
    await query(`UPDATE customer_payments SET payment_method = 'check' WHERE id = $1`, [receipt.paymentId]);
    await reverseOn(b, receipt.paymentId, day(6, 10));
    // As a reversal written before migration 327 left it.
    await query(
      `UPDATE customer_payments SET reversal_cause = NULL, reversal_cause_stated_at = NULL WHERE id = $1`,
      [receipt.paymentId]
    );
    const may = await paper(b, 5);
    expect(at16(may)).toEqual({ base: '0.00', iva: '0.00' });
    expect(reversalOf(may, receipt.paymentId)?.mensaje).toContain('cheque');
  }, 120_000);
});
