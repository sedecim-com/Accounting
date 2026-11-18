import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { createCreditNote, issueCreditNote, applyCreditNote } from '../../src/services/ar/credit-note-service.js';
import { recordCustomerPayment } from '../../src/services/payments/payment-service.js';
import { arReconcile } from '../../src/services/ar/ar-controls.js';
import type { AppError } from '../../src/utils/errors.js';

/**
 * MNE-001-515 · an `anticipo` credit note cancels the customer's advance in
 * 2150 instead of posting as a sales return, against the real database. Each
 * scenario that states end balances runs on its own entity.
 */

const DAY = '2026-08-15';
const KEY = 'credit_note.advance.exceeds_invoiced_advance';
let pue: Fixture;
let ppd: Fixture;
let edge: Fixture;

async function customer(x: Fixture, number: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Cliente Anticipo SA', 'MXN', $4) RETURNING id`,
    [uuidv4(), x.entityId, number, x.userId]
  );
  return r.rows[0].id;
}

/** ADV as an approved advance CFDI leaves it: an invoice whose own entry credits 2150, then collected. */
async function advance(x: Fixture, customerId: string, iva: string): Promise<string> {
  const id = uuidv4();
  const total = (1000 + Number(iva)).toFixed(2);
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
       amount_due, amount_paid, currency_code, invoice_date, due_date, status, created_by)
     VALUES ($1, $2, $3, $4, '1000.00', $5, $6, $6, '0.00', 'MXN', $7, $7, 'sent', $8)`,
    [id, x.entityId, `ADV-${id.slice(0, 8)}`, customerId, iva, total, DAY, x.userId]
  );
  const lines = [
    { account_id: x.cuentas['1120'], debit_amount: total, credit_amount: null },
    { account_id: x.cuentas['2150'], debit_amount: null, credit_amount: '1000.00' },
    ...(Number(iva) > 0 ? [{ account_id: x.cuentas['2120'], debit_amount: null, credit_amount: iva }] : []),
  ];
  const entry = await createJournalEntry(
    x.entityId, DAY, 'auto_invoice' as never, 'Advance CFDI', lines as never, x.userId,
    { autoPost: true, sourceType: 'invoice', sourceId: id }
  );
  await query(`UPDATE invoices SET journal_entry_id = $1 WHERE id = $2 AND entity_id = $3`, [entry.id, id, x.entityId]);
  await collect(x, customerId, id, total);
  return id;
}

async function collect(x: Fixture, customerId: string, invoiceId: string | null, amount: string) {
  const applications = invoiceId ? [{ documentId: invoiceId, amountApplied: amount }] : [];
  return recordCustomerPayment(
    { entityId: x.entityId, counterpartyId: customerId, paymentAmount: amount, paymentDate: DAY,
      paymentMethod: 'spei', applications, onAccount: invoiceId === null },
    x.userId
  );
}

/** The final invoice (FIN): the whole sale, 5,000.00 + 800.00, issued. */
async function finalInvoice(x: Fixture, customerId: string, terms: 'PUE' | 'PPD'): Promise<string> {
  const draft = await createInvoice({
    entity_id: x.entityId, customer_id: customerId, invoice_date: DAY, due_date: DAY, currency_code: 'MXN', terms,
    lines: [{ revenue_account_id: x.cuentas['4100'], description: 'Sale', quantity: '1', unit_price: '5000.00', tax_rate: '16.0000' }],
    created_by: x.userId,
  });
  return (await issueInvoice(draft.id, x.userId, { entityId: x.entityId })).invoice.id;
}

const advanceNote = (x: Fixture, invoice_id: string, subtotal = '1000.00', tax_amount = '160.00') =>
  createCreditNote({ entity_id: x.entityId, invoice_id, type: 'anticipo', subtotal, tax_amount }, x.userId);

async function entryLines(entryId: string): Promise<Record<string, { debit: number; credit: number }>> {
  const r = await query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, COALESCE(l.debit_amount, 0)::text AS debit, COALESCE(l.credit_amount, 0)::text AS credit
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id WHERE l.journal_entry_id = $1`,
    [entryId]
  );
  return Object.fromEntries(r.rows.map((l) => [l.code, { debit: Number(l.debit), credit: Number(l.credit) }]));
}

/** Credit balance of an account over the posted entries of the entity. */
async function balance(x: Fixture, code: string): Promise<number> {
  const r = await query<{ s: string }>(
    `SELECT COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::text AS s
       FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND l.account_id = $2`,
    [x.entityId, x.cuentas[code]]
  );
  return Number(r.rows[0].s);
}

async function noteState(noteId: string) {
  const r = await query<{ status: string; entries: number }>(
    `SELECT cn.status, (SELECT COUNT(*)::int FROM journal_entries je WHERE je.source_id = cn.id) AS entries
       FROM credit_notes cn WHERE cn.id = $1`,
    [noteId]
  );
  return r.rows[0];
}

async function refusal(x: Fixture, noteId: string): Promise<AppError> {
  const err = await issueCreditNote(x.entityId, noteId, x.userId).then(() => null, (e: AppError) => e);
  expect(err?.messageKey?.key).toBe(KEY);
  expect(await noteState(noteId)).toEqual({ status: 'draft', entries: 0 });
  return err!;
}

beforeAll(async () => {
  pue = await crearInquilino('Advance note PUE');
  ppd = await crearEntidadHermana(pue, 'Advance note PPD');
  edge = await crearEntidadHermana(pue, 'Advance note edges');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('an anticipo credit note cancels the invoiced advance', () => {
  let pueCustomer: string;

  it('on a PUE invoice: the dry run writes nothing, the note debits 2150 and 2120, and revenue keeps the sale', async () => {
    pueCustomer = await customer(pue, 'C-ADV-001');
    await advance(pue, pueCustomer, '160.00');
    const sale = await finalInvoice(pue, pueCustomer, 'PUE');
    const note = await advanceNote(pue, sale);

    const rehearsal = await issueCreditNote(pue.entityId, note.id, pue.userId, { dryRun: true });
    expect(rehearsal.dryRun).toBe(true);
    expect(rehearsal.journalEntry).not.toBeNull();
    expect(await noteState(note.id)).toEqual({ status: 'draft', entries: 0 });

    const issued = await issueCreditNote(pue.entityId, note.id, pue.userId);
    const lines = await entryLines(issued.journalEntry!.id);
    expect(lines['2150'].debit).toBeCloseTo(1000);
    expect(lines['2120'].debit).toBeCloseTo(160);
    expect(lines['1120'].credit).toBeCloseTo(1160);
    expect(lines['4400']).toBeUndefined();
    expect(await noteState(note.id)).toEqual({ status: 'issued', entries: 1 });

    await applyCreditNote(pue.entityId, note.id, [{ invoiceId: sale, amount: '1160.00' }], pue.userId);
    const due = await query<{ amount_due: string }>(`SELECT amount_due FROM invoices WHERE id = $1`, [sale]);
    expect(Number(due.rows[0].amount_due)).toBeCloseTo(4640);
    expect(await balance(pue, '2150')).toBeCloseTo(0);
    expect(await balance(pue, '2120')).toBeCloseTo(800);
    expect(await balance(pue, '4100')).toBeCloseTo(5000);
    expect(await balance(pue, '4400')).toBeCloseTo(0);
  });

  it('on a PPD invoice: the note debits 2125 and the collection releases the other 640.00', async () => {
    const who = await customer(ppd, 'C-ADV-002');
    await advance(ppd, who, '160.00');
    const sale = await finalInvoice(ppd, who, 'PPD');
    const note = await advanceNote(ppd, sale);
    const issued = await issueCreditNote(ppd.entityId, note.id, ppd.userId);
    const lines = await entryLines(issued.journalEntry!.id);
    expect(lines['2150'].debit).toBeCloseTo(1000);
    expect(lines['2125'].debit).toBeCloseTo(160);
    expect(lines['2120']).toBeUndefined();

    await applyCreditNote(ppd.entityId, note.id, [{ invoiceId: sale, amount: '1160.00' }], ppd.userId);
    const collection = await collect(ppd, who, sale, '4640.00');
    const moved = await entryLines(collection.journalEntry!.id);
    expect(moved['2125'].debit).toBeCloseTo(640);
    expect(moved['2120'].credit).toBeCloseTo(640);
    expect(await balance(ppd, '2150')).toBeCloseTo(0);
    expect(await balance(ppd, '2125')).toBeCloseTo(0);
    expect(await balance(ppd, '2120')).toBeCloseTo(800);
    expect(await balance(ppd, '4100')).toBeCloseTo(5000);
  });

  it('refuses a second note once the advance is applied, in both languages, and the subledger still ties', async () => {
    const sale = await finalInvoice(pue, pueCustomer, 'PUE');
    const note = await advanceNote(pue, sale);
    const err = await refusal(pue, note.id);
    for (const text of [err.message, err.localized('es')]) {
      expect(text).toContain(note.credit_note_number);
      expect(text).toContain('C-ADV-001 Cliente Anticipo SA');
      expect(text).toMatch(/\D0\.00\D/);
    }
    expect(err.localized('es')).not.toBe(err.message);

    expect((await arReconcile(pue.entityId)).balanced).toBe(true);
  });

  it('refuses when the only advance is cash on account, and names receipt apply', async () => {
    const who = await customer(edge, 'C-ADV-003');
    await collect(edge, who, null, '1160.00');
    const note = await advanceNote(edge, await finalInvoice(edge, who, 'PUE'));
    expect((await refusal(edge, note.id)).message).toContain('receipt apply');
  });

  it('refuses a note of 1,500.00 against an invoiced advance of 1,000.00', async () => {
    const who = await customer(edge, 'C-ADV-004');
    await advance(edge, who, '160.00');
    const note = await advanceNote(edge, await finalInvoice(edge, who, 'PUE'), '1500.00', '240.00');
    expect((await refusal(edge, note.id)).message).toContain('1000.00');
  });

  it('an advance at 0 % is cancelled by two lines', async () => {
    const who = await customer(edge, 'C-ADV-005');
    await advance(edge, who, '0.00');
    const note = await advanceNote(edge, await finalInvoice(edge, who, 'PUE'), '1000.00', '0.00');
    const issued = await issueCreditNote(edge.entityId, note.id, edge.userId);
    expect(await entryLines(issued.journalEntry!.id)).toEqual({
      '2150': { debit: 1000, credit: 0 },
      '1120': { debit: 0, credit: 1000 },
    });
  });

  it('a note linked to the advance invoice itself, already paid, is refused when applied', async () => {
    const who = await customer(edge, 'C-ADV-006');
    const adv = await advance(edge, who, '160.00');
    const note = await advanceNote(edge, adv);
    await issueCreditNote(edge.entityId, note.id, edge.userId);
    await expect(
      applyCreditNote(edge.entityId, note.id, [{ invoiceId: adv, amount: '1160.00' }], edge.userId)
    ).rejects.toThrow(/"paid"/);
  });
});
