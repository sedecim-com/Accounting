import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment, applyCustomerPayment, unapplyCustomerPayment, reverseCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

// ============================================================
// MNE-001-423 (#623, part 7/8) · THE IVA WORKPAPER COUNTS A CUSTOMER ADVANCE
// IN ITS MONTH, AND NETS IT WHERE IT IS APPLIED
//
// An advance causes its IVA the day it is collected (LIVA art. 1-B), so its
// receipt credits 2120 that day; applying it to its sale cancels that IVA
// instead of causing it twice (2120 Dr c on a PUE invoice, netted against the
// share g a PPD invoice releases); and unapplying it puts the cash back on
// account as the advance it was, its IVA caused again (the owner's «no
// re-park» of 17 Nov 2026). Each event moves 2120 in its own month, so the
// paper counts each in its own month, read from the receipt and from the
// allocation (`applied_on`, `unapplied_at`, migration 332), never from the
// receipt's date alone, and IVA-WP-CHARGED-VS-LEDGER stays silent.
//
// One entity per story, May to July 2026, every figure by hand:
//
//   PUE   May 10 advance 1,160.00 at 16 %          → May   1,000.00 / 160.00
//         Jun 15 invoice 5,000.00 + 800.00, applied Jun 20
//                                                  → June  5,000 − 1,000 / 800 − 160 = 4,000.00 / 640.00
//         Jul 06 unapplied                          → July  +1,000.00 / +160.00, the advance back
//   PPD   the same advance, a PPD invoice           → June  the share 1,000 / 160 − the advance 1,000 / 160 = 0
//         Jul 10 the other 4,640.00 collected      → July  4,000.00 / 640.00
//   PPD unapplied Jul 06                           → July  −1,000 / −160 (the share) + 1,000 / 160 (the advance) = 0
// ============================================================

const day = (month: number, d: number): string => `2026-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

interface Book {
  f: Fixture;
  customerId: string;
}

async function book(name: string): Promise<Book> {
  const f = await crearInquilino(`MNE-001-423 ${name}`);
  await seedPolicies({ tenantId: f.tenantId });
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Advance Paper SA', 'MXN', $4)`,
    [customerId, f.entityId, `C-423-${customerId.slice(0, 6)}`, f.userId]
  );
  return { f, customerId };
}

/** An advance with no invoice, recorded with its treatment. */
async function advance(b: Book, amount: string, treatment: string | undefined, date: string) {
  return recordCustomerPayment(
    {
      entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: amount, paymentDate: date,
      paymentMethod: 'spei', applications: [], onAccount: true,
      ...(treatment === undefined ? {} : { advanceTreatment: treatment }),
    },
    b.f.userId
  );
}

/** An issued sale of `price` at 16 %; PPD parks its IVA, PUE causes it on issue. */
async function invoice(b: Book, price: string, date: string, terms: 'PUE' | 'PPD'): Promise<string> {
  const draft = await createInvoice({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_date: date, due_date: date,
    currency_code: 'MXN', terms,
    lines: [{ revenue_account_id: b.f.cuentas['4100'], description: 'Synthetic sale', quantity: '1', unit_price: price, tax_rate: '16' }],
    created_by: b.f.userId,
  });
  return (await issueInvoice(draft.id, b.f.userId, { entityId: b.f.entityId })).invoice.id;
}

const apply = (b: Book, paymentId: string, invoiceId: string, amount: string, date: string) =>
  applyCustomerPayment(b.f.entityId, paymentId, [{ documentId: invoiceId, amountApplied: amount }], b.f.userId, { date });

const unapply = (b: Book, paymentId: string, invoiceId: string, date: string) =>
  unapplyCustomerPayment(b.f.entityId, paymentId, { invoiceId, reason: 'wrong invoice', date }, b.f.userId);

const paper = (b: Book, month: number): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year: 2026, month });

const codes = (wp: IvaWorkpaper): string[] => wp.findings.map((h) => h.codigo);

/** The 16 % box at the cent, as the paper declares it. */
const at16 = (wp: IvaWorkpaper) => ({
  base: Number(wp.figures.charged.tasa16.base).toFixed(2),
  iva: Number(wp.figures.charged.tasa16.iva).toFixed(2),
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('an advance applied to a PUE invoice', () => {
  let b: Book;
  let receipt: Awaited<ReturnType<typeof advance>>;
  let may: IvaWorkpaper;
  let applicationEntry: string;

  beforeAll(async () => {
    b = await book('PUE');
    receipt = await advance(b, '1160.00', '16', day(5, 10));
    may = await paper(b, 5);
  }, 120_000);

  it('counts in the month it was collected, at its rate, and ties to 2120', () => {
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(may.ledger.iva_trasladado).toBe('-160.0000');
    expect(codes(may)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    // It traces the receipt's own entry.
    const c = may.contributions.charged.find((x) => x.documentId === receipt.paymentId);
    expect(c).toMatchObject({ documentKind: 'receipt', documentNumber: receipt.paymentNumber, entryIds: [receipt.journalEntry!.id] });
  });

  it('the month it is applied nets it out of the invoice, traced to the application entry, and the advance\'s month does not move', async () => {
    const inv = await invoice(b, '5000.00', day(6, 15), 'PUE');
    const applied = await apply(b, receipt.paymentId, inv, '1160.00', day(6, 20));
    applicationEntry = applied.journalEntry!.id;

    const june = await paper(b, 6);
    expect(at16(june)).toEqual({ base: '4000.00', iva: '640.00' });
    expect(june.ledger.iva_trasladado).toBe('-640.0000');
    expect(codes(june)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    const c = june.contributions.charged.find((x) => x.documentId === receipt.paymentId);
    expect(c?.entryIds).toEqual([applicationEntry]);
    expect(c?.breakdown.tasa16).toEqual({ base: '-1000.0000', iva: '-160.0000' });

    expect(at16(await paper(b, 5))).toEqual(at16(may));
  }, 120_000);

  it('unapplied in a later month, the advance is back in that month, and the months before do not move', async () => {
    const inv = (await query<{ invoice_id: string }>(
      'SELECT invoice_id FROM payment_allocations WHERE payment_id = $1', [receipt.paymentId]
    )).rows[0].invoice_id;
    const undone = await unapply(b, receipt.paymentId, inv, day(7, 6));

    const july = await paper(b, 7);
    expect(at16(july)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(july.ledger.iva_trasladado).toBe('-160.0000');
    expect(codes(july)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    expect(july.contributions.charged.find((x) => x.documentId === receipt.paymentId)?.entryIds).toEqual([undone.journalEntry.id]);

    const june = await paper(b, 6);
    expect(at16(june)).toEqual({ base: '4000.00', iva: '640.00' });
    expect(codes(june)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    expect(at16(await paper(b, 5))).toEqual(at16(may));
  }, 120_000);
});

describe('an advance applied to a PPD invoice', () => {
  it('nets to 0 in the month it is applied, and the rest of the sale counts when it is collected', async () => {
    const b = await book('PPD');
    const receipt = await advance(b, '1160.00', '16', day(5, 10));
    const inv = await invoice(b, '5000.00', day(6, 15), 'PPD');
    const applied = await apply(b, receipt.paymentId, inv, '1160.00', day(6, 20));
    await recordCustomerPayment(
      {
        entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: '4640.00', paymentDate: day(7, 10),
        paymentMethod: 'spei', applications: [{ documentId: inv, amountApplied: '4640.00' }],
      },
      b.f.userId
    );

    const [may, june, july] = [await paper(b, 5), await paper(b, 6), await paper(b, 7)];
    expect(at16(may)).toEqual({ base: '1000.00', iva: '160.00' });
    // The share the advance settles, 1,000.00 and 160.00, less the advance's own.
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    expect(june.ledger.iva_trasladado).toBe('0.0000');
    expect(at16(july)).toEqual({ base: '4000.00', iva: '640.00' });
    for (const wp of [may, june, july]) expect(codes(wp)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    // May holds the advance, not the share its cash settled in June: that share is June's, with the advance netted.
    expect(may.contributions.charged.map((c) => [c.documentKind, c.documentId])).toEqual([['receipt', receipt.paymentId]]);
    const share = june.contributions.charged.find((c) => c.documentId === inv);
    expect(share).toMatchObject({ entryIds: [applied.journalEntry!.id], breakdown: { tasa16: { base: '1000.0000', iva: '160.0000' } } });
  }, 120_000);

  it('unapplied in a later month, that month lists the ended share and the advance back, netting 0, and the month applied does not move', async () => {
    const b = await book('PPD unapplied');
    const receipt = await advance(b, '1160.00', '16', day(5, 10));
    const inv = await invoice(b, '5000.00', day(6, 15), 'PPD');
    await apply(b, receipt.paymentId, inv, '1160.00', day(6, 20));
    await unapply(b, receipt.paymentId, inv, day(7, 6));

    const [june, july] = [await paper(b, 6), await paper(b, 7)];
    expect(at16(june)).toEqual({ base: '0.00', iva: '0.00' });
    expect(at16(july)).toEqual({ base: '0.00', iva: '0.00' });
    const share = july.contributions.charged.find((x) => x.documentId === inv);
    const back = july.contributions.charged.find((x) => x.documentId === receipt.paymentId);
    expect(share?.breakdown.tasa16).toEqual({ base: '-1000.0000', iva: '-160.0000' });
    expect(back?.breakdown.tasa16).toEqual({ base: '1000.0000', iva: '160.0000' });
    for (const wp of [june, july]) {
      expect(wp.ledger.iva_trasladado).toBe('0.0000');
      expect(codes(wp)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    }
  }, 120_000);
});

describe('what an advance with no IVA puts in the paper', () => {
  it('at 0 %, exempt and not subject it lands in tasa0, exento and the no-objeto base, and the last two enter the proportion', async () => {
    const b = await book('treatments');
    await advance(b, '1000.00', '0', day(5, 10));
    await advance(b, '500.00', 'exempt', day(5, 11));
    await advance(b, '300.00', 'not-subject', day(5, 12));

    const may = await paper(b, 5);
    expect(may.figures.charged.tasa0).toEqual({ base: '1000.0000', iva: '0.0000' });
    expect(may.figures.charged.exento).toEqual({ base: '500.0000', iva: '0.0000' });
    expect(may.figures.chargedNotSubject).toBe('300.0000');
    expect(may.figures.proration).toMatchObject({ taxedActs: '1000.0000', totalActs: '1800.0000' });
    expect(codes(may)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
  }, 120_000);
});

describe('a PPD share released by a later application', () => {
  it('counts in the month of the application, not of the receipt, traced to the application entry', async () => {
    const b = await book('later application');
    const inv = await invoice(b, '1000.00', day(5, 5), 'PPD');
    // Cash on account with no treatment, as the service still records it.
    const receipt = await advance(b, '1160.00', undefined, day(5, 25));
    const applied = await apply(b, receipt.paymentId, inv, '1160.00', day(6, 10));

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '0.00', iva: '0.00' });
    expect(at16(june)).toEqual({ base: '1000.00', iva: '160.00' });
    expect(june.contributions.charged.find((x) => x.documentId === inv)?.entryIds).toEqual([applied.journalEntry!.id]);
    for (const wp of [may, june]) expect(codes(wp)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
  }, 120_000);
});

// MNE-001-558 records an advance by cheque: its receipt credits 2150 whole, with no 2120 line, and the IVA
// waits for the bank's cashing (LIVA art. 1-B, second paragraph). Returned before it is cashed, nothing was
// ever caused, so no month counts it and 2120 never moved.
describe('an advance received by cheque and reversed in its own month', () => {
  it('counts in no month, and 2120 is silent in both', async () => {
    const b = await book('cheque reversed');
    const account = uuidv4();
    await query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
       VALUES ($1, $2, 'Cheques 423', 'Bank', $3, 'MXN', 'checking')`,
      [account, b.f.entityId, b.f.cuentas['1111']]
    );
    const receipt = await recordCustomerPayment(
      {
        entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: '1160.00', paymentDate: day(5, 10),
        paymentMethod: 'check', bankAccountId: account, checkNumber: '423001',
        applications: [], onAccount: true, advanceTreatment: '16',
      },
      b.f.userId
    );
    await reverseCustomerPayment(b.f.entityId, receipt.paymentId, { reason: 'Cheque returned' }, b.f.userId);

    for (const wp of [await paper(b, 5), await paper(b, 6)]) {
      expect(at16(wp)).toEqual({ base: '0.00', iva: '0.00' });
      expect(wp.ledger.iva_trasladado).toBe('0.0000');
      expect(wp.contributions.charged.find((x) => x.documentId === receipt.paymentId)).toBeUndefined();
      expect(codes(wp)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
    }
  }, 120_000);
});
