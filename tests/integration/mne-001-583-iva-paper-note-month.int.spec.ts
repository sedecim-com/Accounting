import { describe, it, expect, afterAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { createCreditNote, issueCreditNote } from '../../src/services/ar/credit-note-service.js';
import { recordCustomerPayment, unapplyCustomerPayment, reverseCustomerPayment } from '../../src/services/payments/payment-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

// ============================================================
// MNE-001-583 (#814) · A COLLECTION REVERSED AS NOT COLLECTED AFTER A CREDIT
// NOTE RESTITUTED ITS IVA: THE PAPER NAMES THE NOTE'S MONTH, AND STOPS
// SUBTRACTING WHAT THE NOTE RESTITUTED THAT WAS NEVER CAUSED (LIVA arts. 1-B, 7)
//
// One entity per story. Every invoice PPD at 16 % dated 2026-09-03, every
// collection by wire on 09-05, every note a return dated 10-10, and every
// reversal at a clock of 2026-11-05. The receipt counts in no month
// (MNE-001-518, rule 2); since MNE-001-581 its reversal posts a correction,
// `receipt_reversal_iva`, whose 2120 credit is what the note restituted from
// it, so the receipt's 2120 nets to that over its life.
//
//   P1  S 100 + 16 collected 116; N 100 + 16 (575: DR 2120 16, nothing
//       parked); R reversed not_collected: mirror DR 2120 16, correction CR
//       2120 16. October subtracted 100 / 16 for N; now 0 / 0: nothing was
//       caused, so nothing is restituted. Ledger October −16, paper 0: the
//       tie-out names N for 16.
//   P2  S 1,000 + 160 collected 1,160 (releases 160); N 200 + 32 (2120 32);
//       reversed: the mirrors put back 160, the reopened 928 carries 160 ×
//       928 / 1,160 = 128, so the correction is 32. October 0 / 0.
//   P3  S 1,160; R1 580 (releases 80) and R2 580 on 09-06 (80); N 200 + 32
//       (2120 32); R1 reversed: R2's 580 stays, so the 348 owed again carries
//       160 × 928 / 1,160 − 80 = 48, and the correction is 80 − 48 = 32.
//       October 0 / 0; September counts only R2: 500 / 80 = 580 × 16 / 116.
//   P4  MNE-001-593: S 1,160 collected, unapplied 09-08 keeping its 160
//       caused; N 200 + 32 restitutes 32 from that kept cash (2120 Dr 32);
//       reversed: a correction DR 2150 32 / CR 2120 32. October 0 / 0.
//   P5  P1 reversed taken_back: the money arrived, its IVA was caused and N
//       restituted it (rule 3). October −100 / −16, as before.
//   P6  S 100 + 16 collected and reversed not_collected, no note: nothing
//       new, October 0 / 0 with no finding.
//   P7  P1 with the reversal on 09-20, before N's date though after its
//       posting (581, risk 3): October still names N, whose month it is.
// ============================================================

const sep = (d: number): string => `2026-09-${String(d).padStart(2, '0')}`;

interface Book { f: Fixture; customerId: string }

async function book(name: string): Promise<Book> {
  const f = await crearInquilino(`MNE-001-583 ${name}`);
  await seedPolicies({ tenantId: f.tenantId });
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Cliente Sintetico Reversa SA', 'MXN', $4)`,
    [customerId, f.entityId, `C-583-${customerId.slice(0, 6)}`, f.userId]
  );
  return { f, customerId };
}

async function sale(b: Book, price: string): Promise<string> {
  const draft = await createInvoice({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_date: sep(3), due_date: sep(3), currency_code: 'MXN',
    terms: 'PPD',
    lines: [{ revenue_account_id: b.f.cuentas['4100'], description: 'Synthetic sale', quantity: '1', unit_price: price, tax_rate: '16' }],
    created_by: b.f.userId,
  });
  return (await issueInvoice(draft.id, b.f.userId, { entityId: b.f.entityId })).invoice.id;
}

const collect = (b: Book, invoiceId: string, amount: string, date = sep(5)) =>
  recordCustomerPayment(
    { entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: amount, paymentDate: date,
      paymentMethod: 'spei', applications: [{ documentId: invoiceId, amountApplied: amount }] },
    b.f.userId
  );

async function note(b: Book, invoiceId: string, subtotal: string, tax: string, date = '2026-10-10'): Promise<string> {
  const cn = await createCreditNote({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_id: invoiceId, type: 'devolucion',
    credit_date: date, subtotal, tax_amount: tax,
  }, b.f.userId);
  await issueCreditNote(b.f.entityId, cn.id, b.f.userId);
  return cn.credit_note_number;
}

/** `receipt reverse` has no --date: its mirrors take the clock's day. */
async function reverse(b: Book, paymentId: string, cause: 'not_collected' | 'taken_back' = 'not_collected', on = '2026-11-05') {
  vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date(`${on}T12:00:00`));
  try {
    return await reverseCustomerPayment(b.f.entityId, paymentId, { reason: 'bounced', cause }, b.f.userId);
  } finally {
    vi.useRealTimers();
  }
}

const paper = (b: Book, month: number): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year: 2026, month });
const at16 = (wp: IvaWorkpaper) => ({
  base: Number(wp.figures.charged.tasa16.base).toFixed(2),
  iva: Number(wp.figures.charged.tasa16.iva).toFixed(2),
});
const reversedFinding = (wp: IvaWorkpaper, receipt: string) =>
  wp.findings.find((h) => h.codigo === 'IVA-WP-RECEIPT-REVERSED' && h.documentNumber === receipt);
const gap = (wp: IvaWorkpaper) => wp.findings.find((h) => h.codigo === 'IVA-WP-CHARGED-VS-LEDGER');

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

/** October's paper names the note, its uncaused IVA and the amended return, and stops subtracting it. */
async function expectOctoberNamesNote(b: Book, receipt: string, n: string, amount: string) {
  const october = await paper(b, 10);
  expect(at16(october)).toEqual({ base: '0.00', iva: '0.00' });
  expect(october.contributions.charged.filter((c) => c.documentKind === 'credit_note')).toEqual([]);
  const named = reversedFinding(october, receipt);
  expect(named?.mensaje).toContain(`La nota de crédito ${n} del 2026-10-10`);
  expect(named?.mensaje).toContain(`restituyó ${amount} de IVA que el cobro ${receipt} nunca causó`);
  expect(named?.mensaje).toContain('Si la declaración de 2026-10 ya se presentó restándolo, se corrige con una complementaria (CFF art. 32)');
  // Ledger −amount (the note), paper 0: the tie-out names the note for the whole gap.
  const tie = gap(october);
  expect(tie?.mensaje).toContain(`De la diferencia de ${amount}, estos documentos explican ${amount}`);
  expect(tie?.mensaje).toContain(`la nota de crédito ${n} restituyó ${amount} de IVA que el cobro ${receipt}`);
}

describe('a collection reversed as not collected after a note: the note\'s month no longer subtracts what was never caused', () => {
  it('P1 · the issue: N 100 + 16 restituted the 16 R never caused, so October reads 0 / 0 and names N, and November names October', async () => {
    const b = await book('P1');
    const s = await sale(b, '100.00');
    const r = await collect(b, s, '116.00');
    const n = await note(b, s, '100.00', '16.00');
    await reverse(b, r.paymentId);
    await expectOctoberNamesNote(b, r.paymentNumber, n, '16.0000');
    const november = await paper(b, 11);
    expect(reversedFinding(november, r.paymentNumber)?.mensaje)
      .toContain(`La nota ${n}, en 2026-10, restituyó 16.0000 que este cobro no causó: esa declaración también se corrige con una complementaria.`);
    // The mirror and the correction net 0 in November: the tie-out is silent.
    expect(gap(november)).toBeUndefined();
  }, 120_000);

  it('P2 · a partial note on an invoice collected whole: the correction is 32, and October subtracts nothing', async () => {
    const b = await book('P2');
    const s = await sale(b, '1000.00');
    const r = await collect(b, s, '1160.00');
    const n = await note(b, s, '200.00', '32.00');
    await reverse(b, r.paymentId);
    await expectOctoberNamesNote(b, r.paymentNumber, n, '32.0000');
  }, 120_000);

  it('P3 · one receipt of two reversed: its 32 is the note\'s, September keeps the other receipt\'s 80', async () => {
    const b = await book('P3');
    const s = await sale(b, '1000.00');
    const r1 = await collect(b, s, '580.00');
    await collect(b, s, '580.00', sep(6));
    const n = await note(b, s, '200.00', '32.00');
    await reverse(b, r1.paymentId);
    await expectOctoberNamesNote(b, r1.paymentNumber, n, '32.0000');
    expect(at16(await paper(b, 9))).toEqual({ base: '500.00', iva: '80.00' });
  }, 120_000);

  it('P4 · MNE-001-593: a note that restituted from the cash kept on account, its correction from 2150, reads the same', async () => {
    const b = await book('P4');
    const s = await sale(b, '1000.00');
    const r = await collect(b, s, '1160.00');
    const undone = await unapplyCustomerPayment(b.f.entityId, r.paymentId, { invoiceId: s, reason: 'wrong invoice', date: sep(8) }, b.f.userId);
    expect(undone.ivaKeptCaused).toBe('160.0000');
    const n = await note(b, s, '200.00', '32.00');
    await reverse(b, r.paymentId);
    await expectOctoberNamesNote(b, r.paymentNumber, n, '32.0000');
  }, 120_000);

  it('P7 · a note dated after the reversal (posted before it, 581 risk 3): October still names it, though the receipt was reversed in September', async () => {
    const b = await book('P7');
    const s = await sale(b, '100.00');
    const r = await collect(b, s, '116.00');
    const n = await note(b, s, '100.00', '16.00');
    await reverse(b, r.paymentId, 'not_collected', sep(20));
    await expectOctoberNamesNote(b, r.paymentNumber, n, '16.0000');
  }, 120_000);
});

describe('controls: a taken-back receipt caused its IVA, and with no note nothing changes', () => {
  it('P5 · taken back: N still restitutes the 16 R caused, October reads −100 / −16 and ties out', async () => {
    const b = await book('P5');
    const s = await sale(b, '100.00');
    const r = await collect(b, s, '116.00');
    await note(b, s, '100.00', '16.00');
    await reverse(b, r.paymentId, 'taken_back');
    const october = await paper(b, 10);
    expect(at16(october)).toEqual({ base: '-100.00', iva: '-16.00' });
    expect(reversedFinding(october, r.paymentNumber)).toBeUndefined();
    expect(gap(october)).toBeUndefined();
  }, 120_000);

  it('P6 · no note: October has nothing to name', async () => {
    const b = await book('P6');
    const s = await sale(b, '100.00');
    const r = await collect(b, s, '116.00');
    await reverse(b, r.paymentId);
    const october = await paper(b, 10);
    expect(at16(october)).toEqual({ base: '0.00', iva: '0.00' });
    expect(october.findings).toEqual([]);
  }, 120_000);
});
