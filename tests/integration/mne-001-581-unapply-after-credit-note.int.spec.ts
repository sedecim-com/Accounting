import { describe, it, expect, afterAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
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
//   U1  S 1,000 + 160 collected 1,160 10-05 (releases 160); N 200 + 32 10-10
//       (575: from 2120); unapply 10-15 → the open balance 1,160 − 232 = 928
//       carries 160 × 928 / 1,160 = 128: DR 2120 128 / CR 2125 128, 32 kept.
//       2125 128, 2120 160 − 32 − 128 = 0. Today 160 and −32.
//   U1b U1, N applied 232, 928 collected 10-20 (releases 128): 2125 0, 2120
//       128 = 928 × 16 / 116. Today 32 and 96.
//   U2  S 100 + 16 collected 116; N 100 + 16 (2120 16); unapply → the open
//       balance is 0: no IVA line, 2125 0, 2120 0. Today 16 and −16.
//   U3  S 1,160; N 200 + 32 applied (2125 32); 928 collected (releases 128);
//       unapply → 128 back, as today: 2125 128, 2120 0.
//   U4  S 1,160 collected; unapply (160 back, no note yet); N 200 + 32 (575:
//       2125 32) → 2125 128, 2120 0, as today.
//   U5  S 1,160; R1 580 and R2 580 (80 each); N 200 + 32 (2120 32); unapply
//       R1 → 160 × 928 / 1,160 − 80 = 48 back (2125 48, 2120 80); unapply R2
//       → 2125 read 48 (capped from 80), 128 − 48 = 80 back (2125 128, 2120
//       0). Today 80 / 48, then 160 / −32.
//   U6  S 1,160; 580 by wire (80) and 580 by a cheque not cashed (0, MNE-001-556);
//       N 200 + 32 (2125 32: 48 left); unapply the wire → the cheque's cash is
//       still owed, so 1,160 − 232 carries 128: 80 back, 2125 128, 2120 0.
//   A1  a 116 receipt recorded as a 16 % advance (2120 16), applied to S 100
//       + 16 (2125 −16, 2120 net 0); N 100 + 16 (2120 16); unapply → DR 1120
//       116 / CR 2150 100 / CR 2120 16, no 2125 line: 2125 0, 2120 16, the
//       advance's IVA on the cash on account. Today 16 and 0.
//   R1  S 100 + 16, receipt 116; N 100 + 16 (2120 16); reversed 10-25 as
//       taken back → the mirror CR 2125 16 / DR 2120 16 and a correction DR
//       2125 16 / CR 2120 16: 2125 0, 2120 0. Today 16 and −16.
//   R2  U1, then its receipt reversed 10-25 → the mirrors put back 160 − 128
//       = 32, which no balance carries: a correction of 32; 2125 128, 2120 0.
//   R3  S 1,160 collected and reversed, no note → no correction; 2125 160.
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

async function sale(b: Book, price: string): Promise<string> {
  const draft = await createInvoice({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_date: day(3), due_date: day(3), currency_code: 'MXN',
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
  const of = async (code: string) => (await query<{ s: string }>(
    `SELECT COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::numeric(19,2)::text AS s
       FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND l.account_id = $2`,
    [b.f.entityId, b.f.cuentas[code]]
  )).rows[0].s;
  return { '2125': await of('2125'), '2120': await of('2120') };
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

describe('an unapply after a credit note re-parks only the IVA of the balance owed again (LIVA arts. 1-B and 7)', () => {
  it('U1 · collected whole, a partial note: 128 goes back to 2125, 32 stays in 2120, and October names the 128 it re-parked', async () => {
    const { b, n, undone } = await collectedNotedUnapplied('U1');
    expect(undone.ivaReAparcado).toBe('128.0000');
    const entry = await linesOf(b, undone.journalEntry.id);
    expect(entry.net).toEqual({ '1120': '1160.00', '2150': '-1160.00', '2120': '128.00', '2125': '-128.00' });
    expect(entry.text).toContain(`kept in iva_trasladado: 32.0000 restituted by credit note ${n}`);
    expect(entry.text).toContain('the reopened balance carries 128.0000');
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '0.00' });

    const wp = await october(b);
    // 1,000 / 160 collected, less the note's 200 / 32; the unapply nets 0 (MNE-001-518 rule 1).
    expect(at16(wp)).toEqual({ base: '800.00', iva: '128.00' });
    expect(gap(wp)?.mensaje).toContain('el IVA de 128.0000 sigue causado');
  }, 120_000);

  it('U1b · then the note is applied and the 928 left is collected: it releases 128 and 2125 ends at 0', async () => {
    const { b, s, n } = await collectedNotedUnapplied('U1b');
    const id = (await query<{ id: string }>(
      `SELECT id FROM credit_notes WHERE entity_id = $1 AND credit_note_number = $2`, [b.f.entityId, n]
    )).rows[0].id;
    await applyCreditNote(b.f.entityId, id, [{ invoiceId: s, amount: '232.00' }], b.f.userId);
    await collect(b, s, '928.00', day(20));
    expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '128.00' });
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

  it('U3 · a note posted before the collection already left 2125: the unapply re-parks all it released, as before', async () => {
    const b = await book('U3');
    const s = await sale(b, '1000.00');
    await note(b, s, '200.00', '32.00', '232.00');
    const receipt = await collect(b, s, '928.00');
    const undone = await unapply(b, receipt.paymentId, s);
    expect(undone.ivaReAparcado).toBe('128.0000');
    expect((await linesOf(b, undone.journalEntry.id)).net).toMatchObject({ '2120': '128.00', '2125': '-128.00' });
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '0.00' });
  }, 120_000);

  it('U4 · an unapply before the note re-parks it all, and the note then takes its IVA from 2125', async () => {
    const b = await book('U4');
    const s = await sale(b, '1000.00');
    const receipt = await collect(b, s, '1160.00');
    const undone = await unapply(b, receipt.paymentId, s, day(8));
    expect(undone.ivaReAparcado).toBe('160.0000');
    await note(b, s, '200.00', '32.00');
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '0.00' });
  }, 120_000);

  it('U5 · two receipts: the second unapply reads 2125 at the open balance\'s 48, not the 80 its release would say', async () => {
    const b = await book('U5');
    const s = await sale(b, '1000.00');
    const r1 = await collect(b, s, '580.00');
    const r2 = await collect(b, s, '580.00', day(6));
    await note(b, s, '200.00', '32.00');
    expect((await unapply(b, r1.paymentId, s)).ivaReAparcado).toBe('48.0000');
    expect(await vat(b)).toEqual({ '2125': '48.00', '2120': '80.00' });
    expect((await unapply(b, r2.paymentId, s, day(16))).ivaReAparcado).toBe('80.0000');
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '0.00' });
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
    expect((await unapply(b, wire.paymentId, s)).ivaReAparcado).toBe('80.0000');
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '0.00' });
  }, 120_000);

  it('A1 · an advance (MNE-001-461): nothing goes back to 2125, and the advance\'s 16 comes back whole to 2120', async () => {
    const b = await book('A1');
    const s = await sale(b, '100.00');
    const advance = await recordCustomerPayment(
      { entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: '116.00', paymentDate: day(4),
        paymentMethod: 'spei', applications: [], onAccount: true, advanceTreatment: '16' },
      b.f.userId
    );
    await applyCustomerPayment(b.f.entityId, advance.paymentId, [{ documentId: s, amountApplied: '116.00' }], b.f.userId, { date: day(5) });
    await note(b, s, '100.00', '16.00');
    expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '0.00' });
    const undone = await unapply(b, advance.paymentId, s);
    expect(undone.ivaReAparcado).toBe('0.0000');
    expect((await linesOf(b, undone.journalEntry.id)).net).toEqual({ '1120': '116.00', '2150': '-100.00', '2120': '-16.00' });
    expect(await vat(b)).toEqual({ '2125': '0.00', '2120': '16.00' });
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

  it('R2 · after a capped unapply the mirrors put back 160 − 128 = 32, and the correction takes those 32 out', async () => {
    const { b, receipt } = await collectedNotedUnapplied('R2');
    await reverse(b, receipt.paymentId);
    expect((await corrections(b, receipt.paymentId)).map((c) => c[0])).toEqual(['32.00']);
    expect(await vat(b)).toEqual({ '2125': '128.00', '2120': '0.00' });
  }, 120_000);

  it('R3 · with no note the reversal posts no correction, as before', async () => {
    const b = await book('R3');
    const s = await sale(b, '1000.00');
    const receipt = await collect(b, s, '1160.00');
    await reverse(b, receipt.paymentId);
    expect(await corrections(b, receipt.paymentId)).toEqual([]);
    expect(await vat(b)).toEqual({ '2125': '160.00', '2120': '0.00' });
  }, 120_000);
});
