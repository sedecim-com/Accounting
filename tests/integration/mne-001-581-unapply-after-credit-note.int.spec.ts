import { describe, it, expect, afterAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, withTenant, withTransaction } from '../../src/database/connection.js';
import { issuedVatOfOpenBalance, issuedVatStillParked } from '../../src/services/accounting/iva-cash-basis.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { createCreditNote, issueCreditNote, applyCreditNote } from '../../src/services/ar/credit-note-service.js';
import {
  recordCustomerPayment, applyCustomerPayment, unapplyCustomerPayment, reverseCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

// ============================================================
// MNE-001-581 (#814) · AFTER A CREDIT NOTE, AN UNAPPLY OR A REVERSAL OF A
// COLLECTION PUTS BACK INTO 2125 ONLY THE IVA OF THE BALANCE OWED AGAIN
// (LIVA arts. 1-B and 7); THE REST STAYS IN 2120, WHERE THE NOTE RESTITUTED IT
//
// One entity per story, every invoice PPD at 16 % dated 2026-10-03, every
// document posted by the real services. Balances are credit balances.
//
//   MNE-001-574 (#792, decision (A)): a receipt with no treatment keeps
//   caused what goes back to 2125, the note's restitution standing (LIVA
//   art. 7), so its unapply has no 2120 line; the figures below are after it.
//
//   U1  S 1,000 + 160 collected 1,160 10-05 (releases 160); N 200 + 32 10-10
//       (575: from 2120); unapply 10-15 → the open balance 1,160 − 232 = 928
//       carries 160 × 928 / 1,160 = 128: CR 2125 128, 32 kept out of it, and
//       the cash keeps 128 caused: CR 2150 1,160 − 128 = 1,032, no 2120 line.
//       2125 128, 2120 160 − 32 = 128.
//   U1b U1, N applied 232, 928 collected 10-20 (releases 128): 2125 0, 2120
//       128 + 128 = 256, the first receipt's 1,160 still on account with 128.
//   MNE-001-591 (#792, decision (A), follow-up 1): the 1,160 back on account is
//   two parts. 1,160 × 128 / 160 = 928 carries the 128 kept (the pool); the
//   232 the note credited is owed back to the customer and carries none. Cash
//   applied to the invoice it came from takes the pool first; anywhere else,
//   the 232 first, as plain cash always goes (ADR-0006 Decision 2).
//   U1n U1, N applied 232, the 1,160 on account applied 928 to S on 11-05: S
//       takes the pool, c = 128, base 800, against the 128 it releases: DR 2150
//       800 / DR 2125 128 / CR 1120 928, no 2120 line; 2125 0, 2120 128, 2150
//       232. November charges 0 / 0.
//   U1n2 U1n, then T (PPD 200 + 32, 11-06) gets the 232 on 11-10: c = 0, T
//       releases 32: DR 2150 232 / DR 2125 32 / CR 1120 232 / CR 2120 32;
//       2120 160, 2150 0. November charges 200 / 32 and ties.
//   U1t T first: 232 to T on 11-05 takes the plain 232 (c = 0, CR 2120 32,
//       2120 160, 2150 800); then 928 to S on 11-10 takes the pool (c = 128,
//       no 2120 line): 2120 160, 2150 0. November charges 200 / 32 and ties.
//   U1u the whole 1,160 to U (PPD 1,000 + 160, 11-06) on 11-10: the plain 232
//       (c 0), then the 928 (c 128); U releases 160: DR 2150 1,032 / DR 2125
//       160 / CR 1120 1,160 / CR 2120 32; 2120 160, as before 591.
//   MNE-001-603 (#792): one `receipt apply` spends the plain cash once, so it
//   ends where two commands end. T (PPD 200 + 32) and V (PPD 800 + 128), 11-06.
//   P1  T 232 then V 928 on 11-10: T takes the plain 232 (c 0, CR 2120 32); V
//       finds no plain left and takes the pool's 928 (c 128 against its 128):
//       DR 2150 1,032 / DR 2125 160 / CR 1120 1,160 / CR 2120 32; 2120 160,
//       2125 128 (S's 928), 2150 0. Before 603 V took the 232 again and 696 of
//       the pool (c 96): DR 2150 1,064 / CR 2120 64, 2120 192, 2150 −32.
//   P2  V then T: V the plain 232 and 696 of the pool (c 96, CR 2120 32), T the
//       pool's last 232 (c 32): the same entry and end as P1.
//   P3  T then S: T the plain 232 (CR 2120 32); S is in `own`, so it takes the
//       pool first whatever plain says (c 128): 2120 160, 2125 0, 2150 0, as U1t.
//   U2  S 100 + 16 collected 116; N 100 + 16 (2120 16); unapply → the open
//       balance is 0: no IVA line, 2125 0, 2120 0. Today 16 and −16.
//   U3  S 1,160; N 200 + 32 applied (2125 32); 928 collected (releases 128);
//       unapply → 128 back and 128 kept: 2125 128, 2120 128.
//   U4  S 1,160 collected 10-05; unapply 10-08 (160 back and kept, no note
//       yet: the pool is 1,160 at 160); N 200 + 32 10-10. MNE-001-593 (#814,
//       decision (A)): the firm still holds S's cash, kept caused, so H = 160
//       of S's parked 160 is collected: 2125 for N's IVA is 0, 32 is
//       restituted from 2120 (art. 7), and 32 of the cash's IVA leaves 2125
//       for 2150, owed back: 4400 Dr 200 / 2120 Dr 32 / 2125 Dr 32 / 1120 Cr
//       232 / 2150 Cr 32. 2120 128, 2125 128, 2150 1,032, as U1's order ends
//       (U4y); the pool is 928 at 128 and the plain cash 232.
//   U4n U4, N applied 232, 928 to S on 11-05: S is the pool's own (c 128, its
//       release 128): DR 2150 800 / DR 2125 128 / CR 1120 928; 2120 128, 2150
//       232, as U1n. Then T (PPD 200 + 32) gets the 232 on 11-10: it carries
//       nothing, so T causes its 32: 2120 160, 2150 0, as U1n2.
//   U4p U4 without the note; 580 to T (PPD 500 + 80) on 10-09 takes c 80 of
//       the pool (its release 80), so it holds 80: H = 80, S's parked 160 less
//       80 is 80, and N takes all 32 from 2125 as before. The other order (N,
//       then T on 10-12: the plain 232, then 348 of the pool, c 48 against 80,
//       CR 2120 32) ends the same: 2120 160, 2125 128, 2150 500.
//   U4w a wire R 580 stays live (80); P 580 unapplied 10-08 (marker 80); N:
//       parked 80, H 80, so 2120 Dr 32 / 2125 Dr 32 / 2150 Cr 32: 2125 48 (the
//       348 still owed), 2120 128, 2150 532. N before P's unapply ends the same.
//   U5  S 1,160; R1 580 and R2 580 (80 each); N 200 + 32 (2120 32); unapply
//       R1 → 160 × 928 / 1,160 − 80 = 48 back and kept (2125 48, 2120 128);
//       unapply R2 → 2125 read 48 (capped from 80), 128 − 48 = 80 back and
//       kept (2125 128, 2120 128).
//   U6  S 1,160; 580 by wire (80) and 580 by a cheque not cashed (0, MNE-001-556);
//       N 200 + 32 (2125 32: 48 left); unapply the wire → the cheque's cash is
//       still owed, so 1,160 − 232 carries 128: 80 back and kept, 2125 128,
//       2120 80.
//   MNE-001-592 (#814, decision (A)): cash that carried an advance's IVA
//   keeps caused only the IVA of the balance owed again too; what the note
//   restituted is not caused again (LIVA art. 7), and the cash it covers,
//   restituted × total / tax, is owed back and carries none.
//   A1  a 116 receipt recorded as a 16 % advance (2120 16), applied to S 100
//       + 16 (2125 −16, 2120 net 0); N 100 + 16 (2120 0); unapply 10-15 →
//       DR 1120 116 / CR 2150 116, no IVA line: 2125 0, 2120 0. The row
//       stores 16 restituted; the pool is 116 − 116 = 0. Before 592: CR 2150
//       100 / CR 2120 16, 2120 16.
//   A1c A1, then T 100 + 16 (10-18) gets the 116 on 10-20: plain, c = 0: DR
//       2150 116 / DR 2125 16 / CR 1120 116 / CR 2120 16; 2120 16, T's IVA.
//   A1b an advance of 1,160 applied to S 1,000 + 160; N 200 + 32 (2120 128);
//       unapply → released 160, back 128, the note kept 32, so 32 restituted
//       and 128 kept: CR 2150 1,032 / CR 2125 128, no 2120 line; 2125 128,
//       2120 128, as U1. The pool is 1,160 − 232 = 928 at 128. Before 592:
//       CR 2150 1,000 / CR 2125 128 / CR 2120 32, 2120 160.
//   A1b2 A1b, N applied 232, then 928 to S on 11-05: S takes the pool first,
//       c = 128 against its 128: DR 2150 800 / DR 2125 128 / CR 1120 928, no
//       2120 line; 2120 128, 2150 232 (owed back).
//   A1p a plain receipt's own pool: S 1,000 + 160 collected 10-05, unapplied
//       10-06 (kept 160), applied again 10-07 (c 160); N 200 + 32 (2120 128);
//       unapplied 10-15 → 32 restituted, 128 kept: CR 2150 1,032 / CR 2125
//       128, no 2120 line; 2120 128. Before 592: CR 2120 32, 2120 160.
//   R1a A1, then reversed 10-25 as taken back: the mirrors give 2120 −16 and
//       2125 16, and the correction of 16 brings both to 0, as R1.
//   R1  S 100 + 16, receipt 116; N 100 + 16 (2120 16); reversed 10-25 as
//       taken back → the mirror CR 2125 16 / DR 2120 16 and a correction DR
//       2125 16 / CR 2120 16: 2125 0, 2120 0. Today 16 and −16.
//   R2  U1, then its receipt reversed 10-25 → the mirrors put back 160 − 128
//       = 32, which no balance carries: a correction of 32; 2125 128, 2120 0.
//   R3  S 1,160 collected and reversed, no note → no correction; 2125 160.
//   R2x U4, then P reversed 10-25 → the mirrors leave 2120 −32, 2125 128 and
//       2150 32, the note's restitution from P's cash: a correction DR 2150 32
//       / CR 2120 32 (MNE-001-593); 2120 0, 2125 128, 2150 0, as R2. 581's
//       own correction reads 0: the 2125 mirrors net to 0.
// ============================================================

const day = (d: number): string => `2026-10-${String(d).padStart(2, '0')}`;

interface Book { f: Fixture; customerId: string }

async function book(name: string): Promise<Book> {
  const f = await crearInquilino(`MNE-001-581 ${name}`);
  await seedPolicies({ tenantId: f.tenantId });
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Cliente Sintetico Desaplica SA', 'MXN', $4)`,
    [customerId, f.entityId, `C-581-${customerId.slice(0, 6)}`, f.userId]
  );
  return { f, customerId };
}

async function sale(b: Book, price: string, date = day(3)): Promise<string> {
  const draft = await createInvoice({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_date: date, due_date: date, currency_code: 'MXN',
    terms: 'PPD',
    lines: [{ revenue_account_id: b.f.cuentas['4100'], description: 'Synthetic sale', quantity: '1', unit_price: price, tax_rate: '16' }],
    created_by: b.f.userId,
  });
  return (await issueInvoice(draft.id, b.f.userId, { entityId: b.f.entityId })).invoice.id;
}

const collect = (b: Book, invoiceId: string, amount: string, date = day(5)) =>
  recordCustomerPayment(
    { entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: amount, paymentDate: date,
      paymentMethod: 'spei', applications: [{ documentId: invoiceId, amountApplied: amount }] },
    b.f.userId
  );

async function note(b: Book, invoiceId: string, subtotal: string, tax: string, apply?: string): Promise<string> {
  const cn = await createCreditNote({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_id: invoiceId, type: 'devolucion',
    credit_date: day(10), subtotal, tax_amount: tax,
  }, b.f.userId);
  await issueCreditNote(b.f.entityId, cn.id, b.f.userId);
  if (apply) await applyCreditNote(b.f.entityId, cn.id, [{ invoiceId, amount: apply }], b.f.userId);
  return cn.credit_note_number;
}

const unapply = (b: Book, paymentId: string, invoiceId: string, date = day(15)) =>
  unapplyCustomerPayment(b.f.entityId, paymentId, { invoiceId, reason: 'wrong invoice', date }, b.f.userId);

/** `receipt reverse` has no --date: its mirrors take the clock's day. */
async function reverse(b: Book, paymentId: string) {
  vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date(`${day(25)}T12:00:00`));
  try {
    return await reverseCustomerPayment(b.f.entityId, paymentId, { reason: 'taken back', cause: 'taken_back' }, b.f.userId);
  } finally {
    vi.useRealTimers();
  }
}

/** Credit balances of 2125 and 2120 over the entity's posted entries, two decimals. */
async function vat(b: Book): Promise<{ '2125': string; '2120': string }> {
  return { '2125': await balanceOf(b, '2125'), '2120': await balanceOf(b, '2120') };
}

/** The credit balance of one account over the entity's posted entries, two decimals. */
async function balanceOf(b: Book, code: string): Promise<string> {
  return (await query<{ s: string }>(
    `SELECT COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::numeric(19,2)::text AS s
       FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND l.account_id = $2`,
    [b.f.entityId, b.f.cuentas[code]]
  )).rows[0].s;
}

/** One entry's lines by account code: debit minus credit, two decimals, and their descriptions. */
async function linesOf(b: Book, entryId: string): Promise<{ net: Record<string, string>; text: string }> {
  const r = await query<{ code: string; net: string; text: string }>(
    `SELECT a.code, SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))::numeric(19,2)::text AS net,
            string_agg(l.description, ' | ') AS text
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
       JOIN journal_entries je ON je.id = l.journal_entry_id AND je.entity_id = $1
      WHERE l.journal_entry_id = $2 GROUP BY a.code`,
    [b.f.entityId, entryId]
  );
  return { net: Object.fromEntries(r.rows.map((x) => [x.code, x.net])), text: r.rows.map((x) => x.text).join(' | ') };
}

/** The receipt's reversal corrections: [amount, description]. */
async function corrections(b: Book, paymentId: string): Promise<[string, string][]> {
  const r = await query<{ amount: string; text: string }>(
    `SELECT SUM(l.debit_amount)::numeric(19,2)::text AS amount, MIN(l.description) AS text
       FROM journal_entries je JOIN journal_entry_lines l ON l.journal_entry_id = je.id
      WHERE je.entity_id = $1 AND je.source_type = 'receipt_reversal_iva' AND je.source_id = $2 AND je.status = 'posted'
      GROUP BY je.id`,
    [b.f.entityId, paymentId]
  );
  return r.rows.map((x) => [x.amount, x.text]);
}

const october = (b: Book): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year: 2026, month: 10 });
const november = (b: Book): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year: 2026, month: 11 });
const nov = (d: number): string => `2026-11-${String(d).padStart(2, '0')}`;

const gap = (wp: IvaWorkpaper) => wp.findings.find((h) => h.codigo === 'IVA-WP-CHARGED-VS-LEDGER');
const at16 = (wp: IvaWorkpaper) => ({
  base: Number(wp.figures.charged.tasa16.base).toFixed(2),
  iva: Number(wp.figures.charged.tasa16.iva).toFixed(2),
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

/** U1's story, which R2 continues. */
async function collectedNotedUnapplied(name: string) {
  const b = await book(name);
  const s = await sale(b, '1000.00');
  const receipt = await collect(b, s, '1160.00');
  const n = await note(b, s, '200.00', '32.00');
  const undone = await unapply(b, receipt.paymentId, s);
  return { b, s, receipt, n, undone };
}

/** MNE-001-593 · U4's story: collected 10-05, unapplied 10-08 keeping all 160 caused, then N on 10-10. */
async function unappliedThenNoted(name: string) {
  const b = await book(name);
  const s = await sale(b, '1000.00');
  const receipt = await collect(b, s, '1160.00');
  const undone = await unapply(b, receipt.paymentId, s, day(8));
  expect([undone.ivaReAparcado, undone.ivaKeptCaused]).toEqual(['0.0000', '160.0000']);
  const n = await note(b, s, '200.00', '32.00');
  return { b, s, receipt, n };
}

const noteId = async (b: Book, number: string): Promise<string> => (await query<{ id: string }>(
  `SELECT id FROM credit_notes WHERE entity_id = $1 AND credit_note_number = $2`, [b.f.entityId, number]
)).rows[0].id;

const noteEntry = async (b: Book, number: string): Promise<string> => (await query<{ id: string }>(
  `SELECT journal_entry_id AS id FROM credit_notes WHERE entity_id = $1 AND credit_note_number = $2`, [b.f.entityId, number]
)).rows[0].id;

/** MNE-001-593 · The three balances both orders must end with. */
async function ledger(b: Book): Promise<{ '2120': string; '2125': string; '2150': string }> {
  return { '2120': await balanceOf(b, '2120'), '2125': await balanceOf(b, '2125'), '2150': await balanceOf(b, '2150') };
}

/** U1, then N applied to S for 232: S owes 928 and the receipt's 1,160 is on account (MNE-001-591). */
async function notedOnAccount(name: string) {
  const u1 = await collectedNotedUnapplied(name);
  const id = (await query<{ id: string }>(
    `SELECT id FROM credit_notes WHERE entity_id = $1 AND credit_note_number = $2`, [u1.b.f.entityId, u1.n]
  )).rows[0].id;
  await applyCreditNote(u1.b.f.entityId, id, [{ invoiceId: u1.s, amount: '232.00' }], u1.b.f.userId);
  expect(await vat(u1.b)).toEqual({ '2125': '128.00', '2120': '128.00' });
  expect(await balanceOf(u1.b, '2150')).toBe('1032.00');
  return u1;
}

describe('an unapply after a credit note re-parks only the IVA of the balance owed again (LIVA arts. 1-B and 7)', () => {
  it('U1 · collected whole, a partial note: 128 goes back to 2125 and stays caused on the cash, 32 stays out, and October ties out', async () => {
    const { b, n, undone } = await collectedNotedUnapplied('U1');
    expect([undone.ivaReAparcado, undone.ivaKeptCaused]).toEqual(['0.0000', '128.0000']);
    const entry = await linesOf(b, undone.journalEntry.id);
    expect(entry.net).toEqual({ '1120': '1160.00', '2150': '-1032.00', '2125': '-128.00' });
    expect(entry.text).toContain(`kept in iva_trasladado: 32.0000 restituted by credit note ${n}`);
    expect(entry.text).toContain('the reopened balance carries 128.0000');
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '128.00' });

    const wp = await october(b);
    // 1,000 / 160 collected, less the note's 200 / 32; the unapply ends 128 and puts the same 128 back on account.
    expect(at16(wp)).toEqual({ base: '800.00', iva: '128.00' });
    expect(gap(wp)).toBeUndefined();
  }, 120_000);

  it('U1b · then the note is applied and the 928 left is collected: it releases 128 and 2125 ends at 0', async () => {
    const { b, s, n } = await collectedNotedUnapplied('U1b');
    const id = (await query<{ id: string }>(
      `SELECT id FROM credit_notes WHERE entity_id = $1 AND credit_note_number = $2`, [b.f.entityId, n]
    )).rows[0].id;
    await applyCreditNote(b.f.entityId, id, [{ invoiceId: s, amount: '232.00' }], b.f.userId);
    await collect(b, s, '928.00', day(20));
    // The first receipt's 1,160 is still on account, carrying the 128 it kept (MNE-001-574).
    expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '256.00' });
  }, 120_000);

  // MNE-001-591: the cash applied to the invoice it came from takes the pool first (c = 128), so 2120 stays at
  // 128, where decision (A) reads it; the 232 the note covers stays on account carrying nothing.
  it('U1n · then the note is applied and the cash on account pays S\'s 928: it takes the pool\'s 128, 2120 stays at 128, and November charges nothing', async () => {
    const { b, s, receipt } = await notedOnAccount('U1n');
    const applied = await applyCustomerPayment(b.f.entityId, receipt.paymentId, [{ documentId: s, amountApplied: '928.00' }], b.f.userId, { date: nov(5) });
    expect((await linesOf(b, applied.journalEntry!.id)).net).toEqual({ '2150': '800.00', '2125': '128.00', '1120': '-928.00' });
    expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '128.00' });
    expect(await balanceOf(b, '2150')).toBe('232.00');
    const wp = await november(b);
    expect(at16(wp)).toEqual({ base: '0.00', iva: '0.00' });
    expect(gap(wp)).toBeUndefined();
    expect(gap(await october(b))).toBeUndefined();
  }, 120_000);

  it('U1n2 · then T gets the 232 the note covers: it carries nothing, T causes its own 32, and November ties out at 200 / 32', async () => {
    const { b, s, receipt } = await notedOnAccount('U1n2');
    await applyCustomerPayment(b.f.entityId, receipt.paymentId, [{ documentId: s, amountApplied: '928.00' }], b.f.userId, { date: nov(5) });
    const t = await sale(b, '200.00', nov(6));
    const applied = await applyCustomerPayment(b.f.entityId, receipt.paymentId, [{ documentId: t, amountApplied: '232.00' }], b.f.userId, { date: nov(10) });
    expect((await linesOf(b, applied.journalEntry!.id)).net).toEqual({ '2150': '232.00', '2125': '32.00', '1120': '-232.00', '2120': '-32.00' });
    expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '160.00' });
    expect(await balanceOf(b, '2150')).toBe('0.00');
    const wp = await november(b);
    expect(at16(wp)).toEqual({ base: '200.00', iva: '32.00' });
    expect(gap(wp)).toBeUndefined();
  }, 120_000);

  it('U1t · T first: the 232 goes to T carrying nothing, then S takes the pool, and both steps end where (A) reads them', async () => {
    const { b, s, receipt } = await notedOnAccount('U1t');
    const t = await sale(b, '200.00', nov(5));
    const toT = await applyCustomerPayment(b.f.entityId, receipt.paymentId, [{ documentId: t, amountApplied: '232.00' }], b.f.userId, { date: nov(5) });
    expect((await linesOf(b, toT.journalEntry!.id)).net).toEqual({ '2150': '232.00', '2125': '32.00', '1120': '-232.00', '2120': '-32.00' });
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '160.00' });
    expect(await balanceOf(b, '2150')).toBe('800.00');
    const toS = await applyCustomerPayment(b.f.entityId, receipt.paymentId, [{ documentId: s, amountApplied: '928.00' }], b.f.userId, { date: nov(10) });
    expect((await linesOf(b, toS.journalEntry!.id)).net).toEqual({ '2150': '800.00', '2125': '128.00', '1120': '-928.00' });
    expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '160.00' });
    expect(await balanceOf(b, '2150')).toBe('0.00');
    const wp = await november(b);
    expect(at16(wp)).toEqual({ base: '200.00', iva: '32.00' });
    expect(gap(wp)).toBeUndefined();
  }, 120_000);

  it('U1u · the whole 1,160 to another invoice takes the plain 232 and then the pool, as before 591: 2120 ends at 160', async () => {
    const { b, receipt } = await notedOnAccount('U1u');
    const u = await sale(b, '1000.00', nov(6));
    const applied = await applyCustomerPayment(b.f.entityId, receipt.paymentId, [{ documentId: u, amountApplied: '1160.00' }], b.f.userId, { date: nov(10) });
    expect((await linesOf(b, applied.journalEntry!.id)).net).toEqual({ '2150': '1032.00', '2125': '160.00', '1120': '-1160.00', '2120': '-32.00' });
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '160.00' });
    const wp = await november(b);
    expect(at16(wp)).toEqual({ base: '200.00', iva: '32.00' });
    expect(gap(wp)).toBeUndefined();
  }, 120_000);

  it('P1 · T then V in one command: T spends the plain 232, so V takes the pool\'s 928 and its 128, 2120 ends at 160 and 2150 at 0 (MNE-001-603)', async () => {
    const { b, receipt } = await notedOnAccount('P1');
    const t = await sale(b, '200.00', nov(6));
    const v = await sale(b, '800.00', nov(6));
    const applied = await applyCustomerPayment(b.f.entityId, receipt.paymentId, [
      { documentId: t, amountApplied: '232.00' }, { documentId: v, amountApplied: '928.00' },
    ], b.f.userId, { date: nov(10) });
    expect((await linesOf(b, applied.journalEntry!.id)).net).toEqual({ '2150': '1032.00', '2125': '160.00', '1120': '-1160.00', '2120': '-32.00' });
    expect(await ledger(b)).toEqual({ '2120': '160.00', '2125': '128.00', '2150': '0.00' });
    const wp = await november(b);
    expect(at16(wp)).toEqual({ base: '200.00', iva: '32.00' });
    expect(gap(wp)).toBeUndefined();
  }, 120_000);

  it('P2 · V then T in one command: V takes the plain 232 and 696 of the pool, T the pool\'s last 232, and both end as P1', async () => {
    const { b, receipt } = await notedOnAccount('P2');
    const t = await sale(b, '200.00', nov(6));
    const v = await sale(b, '800.00', nov(6));
    const applied = await applyCustomerPayment(b.f.entityId, receipt.paymentId, [
      { documentId: v, amountApplied: '928.00' }, { documentId: t, amountApplied: '232.00' },
    ], b.f.userId, { date: nov(10) });
    expect((await linesOf(b, applied.journalEntry!.id)).net).toEqual({ '2150': '1032.00', '2125': '160.00', '1120': '-1160.00', '2120': '-32.00' });
    expect(await ledger(b)).toEqual({ '2120': '160.00', '2125': '128.00', '2150': '0.00' });
    const wp = await november(b);
    expect(at16(wp)).toEqual({ base: '200.00', iva: '32.00' });
    expect(gap(wp)).toBeUndefined();
  }, 120_000);

  it('P3 · T then S in one command: S is the pool\'s own invoice and takes it first, unchanged by 603, and ends as U1t', async () => {
    const { b, s, receipt } = await notedOnAccount('P3');
    const t = await sale(b, '200.00', nov(6));
    const applied = await applyCustomerPayment(b.f.entityId, receipt.paymentId, [
      { documentId: t, amountApplied: '232.00' }, { documentId: s, amountApplied: '928.00' },
    ], b.f.userId, { date: nov(10) });
    expect((await linesOf(b, applied.journalEntry!.id)).net).toEqual({ '2150': '1032.00', '2125': '160.00', '1120': '-1160.00', '2120': '-32.00' });
    expect(await ledger(b)).toEqual({ '2120': '160.00', '2125': '0.00', '2150': '0.00' });
    const wp = await november(b);
    expect(at16(wp)).toEqual({ base: '200.00', iva: '32.00' });
    expect(gap(wp)).toBeUndefined();
  }, 120_000);

  it('U2 · the issue\'s own example: a note for the whole invoice leaves nothing to re-park, and October\'s tie-out is silent', async () => {
    const b = await book('U2');
    const s = await sale(b, '100.00');
    const receipt = await collect(b, s, '116.00');
    const n = await note(b, s, '100.00', '16.00');
    const undone = await unapply(b, receipt.paymentId, s);
    expect(undone.ivaReAparcado).toBe('0.0000');
    const entry = await linesOf(b, undone.journalEntry.id);
    expect(entry.net).toEqual({ '1120': '116.00', '2150': '-116.00' });
    expect(entry.text).toContain(`kept in iva_trasladado: 16.0000 restituted by credit note ${n}`);
    expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '0.00' });

    const wp = await october(b);
    expect(at16(wp)).toEqual({ base: '0.00', iva: '0.00' });
    expect(gap(wp)).toBeUndefined();
  }, 120_000);

  it('U3 · a note posted before the collection already left 2125: all the release goes back and stays caused on the cash', async () => {
    const b = await book('U3');
    const s = await sale(b, '1000.00');
    await note(b, s, '200.00', '32.00', '232.00');
    const receipt = await collect(b, s, '928.00');
    const undone = await unapply(b, receipt.paymentId, s);
    expect([undone.ivaReAparcado, undone.ivaKeptCaused]).toEqual(['0.0000', '128.0000']);
    expect((await linesOf(b, undone.journalEntry.id)).net).toEqual({ '1120': '928.00', '2150': '-800.00', '2125': '-128.00' });
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '128.00' });
  }, 120_000);

  it('U4 · an unapply before the note keeps it all caused; the note restitutes 32 from 2120 and the cash it covers is owed back, as the note-first order ends', async () => {
    const { b, s, receipt, n } = await unappliedThenNoted('U4');
    const entry = await linesOf(b, await noteEntry(b, n));
    expect(entry.net).toEqual({ '4400': '200.00', '2120': '32.00', '2125': '32.00', '1120': '-232.00', '2150': '-32.00' });
    expect(entry.text).toContain(`IVA of credit note ${n}'s reduction restituted from cash kept on account by ${receipt.paymentNumber}: now owed back`);
    expect(await ledger(b)).toEqual({ '2120': '128.00', '2125': '128.00', '2150': '1032.00' });
    const parked = await withTenant(b.f.tenantId, () => withTransaction((client) => issuedVatStillParked(client, b.f.entityId, s)));
    expect(parked.parked).toBe('128.0000');

    const wp = await october(b);
    // +160 collected, −160 + 160 the unapply, −32 the note: 128, the ledger's.
    expect(at16(wp)).toEqual({ base: '800.00', iva: '128.00' });
    expect(wp.contributions.charged.find((c) => c.documentKind === 'credit_note')?.breakdown.tasa16)
      .toEqual({ base: '-200.0000', iva: '-32.0000' });
    expect(gap(wp)).toBeUndefined();
  }, 120_000);

  it('U4y · its twin in the other order (U1: the note, then the unapply) ends with the same 2120, 2125 and 2150', async () => {
    const { b } = await collectedNotedUnapplied('U4y');
    expect(await ledger(b)).toEqual({ '2120': '128.00', '2125': '128.00', '2150': '1032.00' });
    expect(gap(await october(b))).toBeUndefined();
  }, 120_000);

  it('U4n · then the note is applied and the cash pays S\'s 928 from the pool (as U1n), and T\'s 232 later carries nothing (as U1n2)', async () => {
    const { b, s, receipt, n } = await unappliedThenNoted('U4n');
    await applyCreditNote(b.f.entityId, await noteId(b, n), [{ invoiceId: s, amount: '232.00' }], b.f.userId);
    const toS = await applyCustomerPayment(b.f.entityId, receipt.paymentId, [{ documentId: s, amountApplied: '928.00' }], b.f.userId, { date: nov(5) });
    expect((await linesOf(b, toS.journalEntry!.id)).net).toEqual({ '2150': '800.00', '2125': '128.00', '1120': '-928.00' });
    expect(await ledger(b)).toEqual({ '2120': '128.00', '2125': '0.00', '2150': '232.00' });
    const wp = await november(b);
    expect(at16(wp)).toEqual({ base: '0.00', iva: '0.00' });
    expect(gap(wp)).toBeUndefined();
    expect(gap(await october(b))).toBeUndefined();

    const t = await sale(b, '200.00', nov(6));
    const toT = await applyCustomerPayment(b.f.entityId, receipt.paymentId, [{ documentId: t, amountApplied: '232.00' }], b.f.userId, { date: nov(10) });
    expect((await linesOf(b, toT.journalEntry!.id)).net).toEqual({ '2150': '232.00', '2125': '32.00', '1120': '-232.00', '2120': '-32.00' });
    expect(await ledger(b)).toEqual({ '2120': '160.00', '2125': '0.00', '2150': '0.00' });
    const later = await november(b);
    expect(at16(later)).toEqual({ base: '200.00', iva: '32.00' });
    expect(gap(later)).toBeUndefined();
  }, 120_000);

  it('U4p · part of the pool already gone: H is what it still holds, the note takes its 32 from 2125, and the other order ends the same', async () => {
    const first = await book('U4p');
    const s = await sale(first, '1000.00');
    const receipt = await collect(first, s, '1160.00');
    await unapply(first, receipt.paymentId, s, day(8));
    const t = await sale(first, '500.00');
    await applyCustomerPayment(first.f.entityId, receipt.paymentId, [{ documentId: t, amountApplied: '580.00' }], first.f.userId, { date: day(9) });
    const n = await note(first, s, '200.00', '32.00');
    expect((await linesOf(first, await noteEntry(first, n))).net).toEqual({ '4400': '200.00', '2125': '32.00', '1120': '-232.00' });
    expect(await ledger(first)).toEqual({ '2120': '160.00', '2125': '128.00', '2150': '500.00' });
    expect(gap(await october(first))).toBeUndefined();

    const { b, receipt: other } = await unappliedThenNoted('U4p other order');
    const t2 = await sale(b, '500.00');
    const toT = await applyCustomerPayment(b.f.entityId, other.paymentId, [{ documentId: t2, amountApplied: '580.00' }], b.f.userId, { date: day(12) });
    expect((await linesOf(b, toT.journalEntry!.id)).net).toEqual({ '2150': '532.00', '2125': '80.00', '1120': '-580.00', '2120': '-32.00' });
    expect(await ledger(b)).toEqual({ '2120': '160.00', '2125': '128.00', '2150': '500.00' });
    expect(gap(await october(b))).toBeUndefined();
  }, 120_000);

  it('U4w · partly collected: the note restitutes from the unapplied receipt\'s kept cash, and the note-first order ends the same', async () => {
    const story = async (name: string, noteFirst: boolean) => {
      const b = await book(name);
      const s = await sale(b, '1000.00');
      await collect(b, s, '580.00');
      const p = await collect(b, s, '580.00', day(6));
      if (!noteFirst) await unapply(b, p.paymentId, s, day(8));
      const n = await note(b, s, '200.00', '32.00');
      if (noteFirst) await unapply(b, p.paymentId, s);
      return { b, n };
    };
    const after = await story('U4w', false);
    expect((await linesOf(after.b, await noteEntry(after.b, after.n))).net)
      .toEqual({ '4400': '200.00', '2120': '32.00', '2125': '32.00', '1120': '-232.00', '2150': '-32.00' });
    expect(await ledger(after.b)).toEqual({ '2120': '128.00', '2125': '48.00', '2150': '532.00' });
    expect(gap(await october(after.b))).toBeUndefined();

    const before = await story('U4w note first', true);
    expect(await ledger(before.b)).toEqual({ '2120': '128.00', '2125': '48.00', '2150': '532.00' });
    expect(gap(await october(before.b))).toBeUndefined();
  }, 120_000);

  it('U5 · two receipts: the second unapply reads 2125 at the open balance\'s 48, not the 80 its release would say', async () => {
    const b = await book('U5');
    const s = await sale(b, '1000.00');
    const r1 = await collect(b, s, '580.00');
    const r2 = await collect(b, s, '580.00', day(6));
    await note(b, s, '200.00', '32.00');
    const first = await unapply(b, r1.paymentId, s);
    expect([first.ivaReAparcado, first.ivaKeptCaused]).toEqual(['0.0000', '48.0000']);
    expect(await vat(b)).toEqual({ '2125': '48.00', '2120': '128.00' });
    const second = await unapply(b, r2.paymentId, s, day(16));
    expect([second.ivaReAparcado, second.ivaKeptCaused]).toEqual(['0.0000', '80.0000']);
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '128.00' });
  }, 120_000);

  it('U6 · a cheque not cashed yet still holds its IVA in 2125, so its cash is part of the balance owed', async () => {
    const b = await book('U6');
    const s = await sale(b, '1000.00');
    const wire = await collect(b, s, '580.00');
    await recordCustomerPayment(
      { entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: '580.00', paymentDate: day(6),
        paymentMethod: 'check', applications: [{ documentId: s, amountApplied: '580.00' }] },
      b.f.userId
    );
    await note(b, s, '200.00', '32.00');
    // 160 − 80 released by the wire − 32 by the note; the cheque released nothing.
    expect(await vat(b)).toEqual({ '2125': '48.00', '2120': '80.00' });
    // Open again: 1,160 − 232, the cheque's 580 included, carries 128, so the wire's 80 all goes back.
    const undone = await unapply(b, wire.paymentId, s);
    expect([undone.ivaReAparcado, undone.ivaKeptCaused]).toEqual(['0.0000', '80.0000']);
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '80.00' });
  }, 120_000);
});

/** A 16 % advance of `cash` recorded on 10-04 and applied whole to a new S at `price` on 10-05. */
async function advanceApplied(name: string, price: string, cash: string) {
  const b = await book(name);
  const s = await sale(b, price);
  const advance = await recordCustomerPayment(
    { entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: cash, paymentDate: day(4),
      paymentMethod: 'spei', applications: [], onAccount: true, advanceTreatment: '16' },
    b.f.userId
  );
  await applyCustomerPayment(b.f.entityId, advance.paymentId, [{ documentId: s, amountApplied: cash }], b.f.userId, { date: day(5) });
  return { b, s, advance };
}

/** A1's story, which A1c and R1a continue: S 100 + 16 paid by the advance, N 100 + 16, unapplied 10-15. */
async function advanceNotedUnapplied(name: string) {
  const { b, s, advance } = await advanceApplied(name, '100.00', '116.00');
  const n = await note(b, s, '100.00', '16.00');
  expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '0.00' });
  const undone = await unapply(b, advance.paymentId, s);
  return { b, s, advance, n, undone };
}

/** A1b's story, which A1b2 continues: S 1,000 + 160 paid by an advance of 1,160, N 200 + 32, unapplied 10-15. */
async function bigAdvanceNotedUnapplied(name: string) {
  const { b, s, advance } = await advanceApplied(name, '1000.00', '1160.00');
  const n = await note(b, s, '200.00', '32.00');
  expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '128.00' });
  const undone = await unapply(b, advance.paymentId, s);
  return { b, s, advance, n, undone };
}

/** What each allocation of the receipt stored as restituted (342) and kept (338), oldest first. */
async function storedOf(b: Book, paymentId: string): Promise<{ restituted: string | null; kept: string | null }[]> {
  return (await query<{ restituted: string | null; kept: string | null }>(
    `SELECT pa.unapply_restituted_iva_amount::text AS restituted, pa.unapply_kept_iva_amount::text AS kept
       FROM payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
      WHERE pa.payment_id = $2 ORDER BY pa.created_at`,
    [b.f.entityId, paymentId]
  )).rows;
}

describe('MNE-001-592 · cash that carried an advance\'s IVA keeps caused only the IVA of the balance owed again (decision (A), LIVA arts. 1-B and 7)', () => {
  it('A1 · a note for the whole sale: the advance\'s 16 is not caused again, the 116 is owed back carrying none, and October ties out at 0', async () => {
    const { b, advance, n, undone } = await advanceNotedUnapplied('A1');
    expect(undone.ivaReAparcado).toBe('0.0000');
    const entry = await linesOf(b, undone.journalEntry.id);
    expect(entry.net).toEqual({ '1120': '116.00', '2150': '-116.00' });
    expect(entry.text).toContain(`advance IVA restituted by credit note ${n} stays out (LIVA art. 7): 16.0000`);
    expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '0.00' });
    expect(await balanceOf(b, '2150')).toBe('116.00');
    expect(await storedOf(b, advance.paymentId)).toEqual([{ restituted: '16.0000', kept: null }]);

    const wp = await october(b);
    // +16 the advance, 0 the application, −16 the note, 0 the unapply (its share 16 − 16, its advance 16 − 16).
    expect(at16(wp)).toEqual({ base: '0.00', iva: '0.00' });
    expect(gap(wp)).toBeUndefined();
  }, 120_000);

  it('A1c · then T takes the 116: it is plain cash, so T causes its own 16 once, and October ties out at 100 / 16', async () => {
    const { b, advance } = await advanceNotedUnapplied('A1c');
    const t = await sale(b, '100.00', day(18));
    const applied = await applyCustomerPayment(b.f.entityId, advance.paymentId, [{ documentId: t, amountApplied: '116.00' }], b.f.userId, { date: day(20) });
    expect((await linesOf(b, applied.journalEntry!.id)).net).toEqual({ '2150': '116.00', '2125': '16.00', '1120': '-116.00', '2120': '-16.00' });
    expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '16.00' });
    expect(await balanceOf(b, '2150')).toBe('0.00');
    const wp = await october(b);
    expect(at16(wp)).toEqual({ base: '100.00', iva: '16.00' });
    expect(gap(wp)).toBeUndefined();

    // Migration 342: only a closed row stores a restitution, and never 0.
    const [closed, live] = (await query<{ id: string }>(
      `SELECT pa.id FROM payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
        WHERE pa.payment_id = $2 ORDER BY pa.created_at`,
      [b.f.entityId, advance.paymentId]
    )).rows.map((r) => r.id);
    for (const [id, value] of [[closed, '0'], [live, '1']] as const) {
      await expect(query(`UPDATE payment_allocations SET unapply_restituted_iva_amount = $2 WHERE id = $1`, [id, value]))
        .rejects.toThrow(/payment_allocations_unapply_restituted_iva_closed/);
    }
  }, 120_000);

  it('A1b · U1\'s twin with an advance: 32 restituted, 128 kept, no 2120 line, the same balances as U1, and October ties out', async () => {
    const { b, advance, undone } = await bigAdvanceNotedUnapplied('A1b');
    expect(undone.ivaReAparcado).toBe('0.0000');
    expect((await linesOf(b, undone.journalEntry.id)).net).toEqual({ '1120': '1160.00', '2150': '-1032.00', '2125': '-128.00' });
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '128.00' });
    expect(await balanceOf(b, '2150')).toBe('1032.00');
    expect(await storedOf(b, advance.paymentId)).toEqual([{ restituted: '32.0000', kept: null }]);

    const wp = await october(b);
    // +160 −160 +160 −32 −(160 − 32) +(160 − 32) = 128; bases 1,000 − 1,000 + 1,000 + 1,000 − 1,000 − 200 = 800.
    expect(at16(wp)).toEqual({ base: '800.00', iva: '128.00' });
    expect(gap(wp)).toBeUndefined();
  }, 120_000);

  it('A1b2 · then the note is applied and the 928 goes back to S: S takes the pool\'s 128, 2120 stays at 128, 232 is owed back, and November charges nothing', async () => {
    const { b, s, advance, n } = await bigAdvanceNotedUnapplied('A1b2');
    const id = (await query<{ id: string }>(
      `SELECT id FROM credit_notes WHERE entity_id = $1 AND credit_note_number = $2`, [b.f.entityId, n]
    )).rows[0].id;
    await applyCreditNote(b.f.entityId, id, [{ invoiceId: s, amount: '232.00' }], b.f.userId);
    const applied = await applyCustomerPayment(b.f.entityId, advance.paymentId, [{ documentId: s, amountApplied: '928.00' }], b.f.userId, { date: nov(5) });
    expect((await linesOf(b, applied.journalEntry!.id)).net).toEqual({ '2150': '800.00', '2125': '128.00', '1120': '-928.00' });
    expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '128.00' });
    expect(await balanceOf(b, '2150')).toBe('232.00');
    const wp = await november(b);
    expect(at16(wp)).toEqual({ base: '0.00', iva: '0.00' });
    expect(gap(wp)).toBeUndefined();
    expect(gap(await october(b))).toBeUndefined();
  }, 120_000);

  it('A1p · a plain receipt unapplied from the pool it took: 32 restituted, 128 kept, no 2120 line, and October ties out', async () => {
    const b = await book('A1p');
    const s = await sale(b, '1000.00');
    const receipt = await collect(b, s, '1160.00');
    await unapply(b, receipt.paymentId, s, day(6));
    const again = await applyCustomerPayment(b.f.entityId, receipt.paymentId, [{ documentId: s, amountApplied: '1160.00' }], b.f.userId, { date: day(7) });
    expect((await linesOf(b, again.journalEntry!.id)).net).toEqual({ '2150': '1000.00', '2125': '160.00', '1120': '-1160.00' });
    await note(b, s, '200.00', '32.00');
    expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '128.00' });
    const undone = await unapply(b, receipt.paymentId, s);
    expect([undone.ivaReAparcado, undone.ivaKeptCaused]).toEqual(['0.0000', '0.0000']);
    expect((await linesOf(b, undone.journalEntry.id)).net).toEqual({ '1120': '1160.00', '2150': '-1032.00', '2125': '-128.00' });
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '128.00' });
    expect(await storedOf(b, receipt.paymentId)).toEqual([
      { restituted: null, kept: '160.0000' }, { restituted: '32.0000', kept: null },
    ]);

    const wp = await october(b);
    // Shares 160 − 160 + 160 − (160 − 32); on account +160 − 160 + (160 − 32); the note −32: 128.
    expect(at16(wp)).toEqual({ base: '800.00', iva: '128.00' });
    expect(gap(wp)).toBeUndefined();
  }, 120_000);
});

describe('a reversal after a credit note takes back out of 2125 what its mirrors put there and no balance carries', () => {
  it('R1 · the mirror re-parks 16, a correction of 16 takes it out, and October\'s tie-out is silent', async () => {
    const b = await book('R1');
    const s = await sale(b, '100.00');
    const receipt = await collect(b, s, '116.00');
    const n = await note(b, s, '100.00', '16.00');
    const reversed = await reverse(b, receipt.paymentId);
    const fixes = await corrections(b, receipt.paymentId);
    expect(fixes).toHaveLength(1);
    expect(fixes[0][0]).toBe('16.00');
    expect(fixes[0][1]).toContain(`IVA restituted by credit note ${n} stays out of iva_trasladado_no_cobrado`);
    expect(reversed.attestations).toHaveLength(reversed.reversals.length + 1);
    expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '0.00' });
    expect(gap(await october(b))).toBeUndefined();
  }, 120_000);

  it('R1a · A1 reversed as taken back: the mirrors give 2120 −16 and 2125 16, a correction of 16 brings both to 0, and October ties out', async () => {
    const { b, advance, n } = await advanceNotedUnapplied('R1a');
    await reverse(b, advance.paymentId);
    const fixes = await corrections(b, advance.paymentId);
    expect(fixes.map((c) => c[0])).toEqual(['16.00']);
    expect(fixes[0][1]).toContain(`IVA restituted by credit note ${n} stays out of iva_trasladado_no_cobrado`);
    expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '0.00' });
    expect(gap(await october(b))).toBeUndefined();
  }, 120_000);

  it('R2 · after a capped unapply the mirrors put back 160 − 128 = 32, and the correction takes those 32 out', async () => {
    const { b, receipt } = await collectedNotedUnapplied('R2');
    await reverse(b, receipt.paymentId);
    expect((await corrections(b, receipt.paymentId)).map((c) => c[0])).toEqual(['32.00']);
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '0.00' });
  }, 120_000);

  it('R2x · after a note restituted from the cash the receipt kept on account, its reversal takes that restitution back out of 2150 and ends as R2', async () => {
    const { b, receipt, n } = await unappliedThenNoted('R2x');
    await reverse(b, receipt.paymentId);
    const fixes = await corrections(b, receipt.paymentId);
    expect(fixes.map((c) => c[0])).toEqual(['32.00']);
    expect(fixes[0][1]).toContain(`IVA restituted by credit note ${n} from the cash ${receipt.paymentNumber} kept on account`);
    expect(await ledger(b)).toEqual({ '2120': '0.00', '2125': '128.00', '2150': '0.00' });
  }, 120_000);

  it('R3 · with no note the reversal posts no correction, as before', async () => {
    const b = await book('R3');
    const s = await sale(b, '1000.00');
    const receipt = await collect(b, s, '1160.00');
    await reverse(b, receipt.paymentId);
    expect(await corrections(b, receipt.paymentId)).toEqual([]);
    expect(await vat(b)).toEqual({ '2125': '160.00', '2120': '0.00' });
  }, 120_000);

  it('R4 · an invoice the entity does not have: nothing is parked, its open balance carries no IVA, and neither read throws', async () => {
    const b = await book('R4');
    const missing = uuidv4();
    const [parked, open] = await withTenant(b.f.tenantId, () => withTransaction(async (client) => [
      await issuedVatStillParked(client, b.f.entityId, missing),
      await issuedVatOfOpenBalance(client, b.f.entityId, missing),
    ] as const));
    expect(parked).toEqual({ parked: '0.0000', estimated: false });
    expect(open).toEqual({ target: '0.0000', hasNote: false, hasEnded: false, noteNumbers: '' });
  }, 120_000);
});
