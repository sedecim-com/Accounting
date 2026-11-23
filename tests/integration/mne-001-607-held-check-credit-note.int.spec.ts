import { describe, it, expect, afterAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations, reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { createCreditNote, issueCreditNote, applyCreditNote } from '../../src/services/ar/credit-note-service.js';
import {
  recordCustomerPayment, unapplyCustomerPayment, applyCustomerPayment, reverseCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { recordCustomerCheckCashing } from '../../src/services/banking/treasury-posting.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

/**
 * MNE-001-607 (#792, risk 2 of #891) · A CREDIT NOTE WHILE A CUSTOMER'S CHEQUE
 * IS HELD: THE CASHING CAUSES ONLY THE IVA THE NOTE DID NOT RESTITUTE.
 *
 * A plain cheque unapplied from a PPD invoice before its cashing stores the
 * IVA the cashing will cause (MNE-001-586). A credit note issued while it
 * waits lowers the consideration and its IVA (LIVA art. 7); nothing of that
 * IVA was caused yet, so the note takes it from 2125, and the cash it covers
 * is owed back to the customer, not consideration (art. 1-B). By decision (A)
 * of #792 (comment 7033297830) the cash on account keeps caused only the IVA
 * of the balance owed again: the cashing causes the marker less what the note
 * restituted, which ends where a note after the cashing ends (MNE-001-593).
 *
 * Invoice S is PPD, 1,000.00 + 160.00, issued 05-10; a cheque of 1,160.00
 * received 05-15 collects it; the unapply of 05-20 stores 160.0000; note N is
 * 200.00 + 32.00, applied to S. One entity per case. Figures by hand.
 */

const TIE_OUT = 'IVA-WP-CHARGED-VS-LEDGER';

interface Book { f: Fixture; customerId: string; account: string; invoiceId: string; paymentId: string }

let nextGl = 0;

/** An entity with a bank account, May and June statements, S issued and the cheque received and unapplied. */
async function book(name: string): Promise<Book> {
  const f = await crearInquilino(`MNE-001-607 ${name}`);
  await seedPolicies({ tenantId: f.tenantId });
  enterTenant(f.tenantId);
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Held Payer SA', 'MXN', $4)`,
    [customerId, f.entityId, `C-607-${customerId.slice(0, 6)}`, f.userId]
  );
  nextGl += 1;
  const glId = uuidv4();
  await query(
    `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id, currency_code, normal_balance, created_by)
     VALUES ($1, $2, 'Bank 607', 'asset', 'current_assets', $3, 'MXN', 'debit', $4)`,
    [glId, `1110-7${nextGl}`, f.entityId, f.userId]
  );
  const account = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1, $2, $3, 'Bank', $4, 'MXN', 'checking')`,
    [account, f.entityId, `Operating 607 ${name}`, glId]
  );
  for (const [start, end] of [['2026-05-01', '2026-05-31'], ['2026-06-01', '2026-06-30']]) {
    await query(
      `INSERT INTO bank_statements (entity_id, bank_account_id, period_start, period_end, opening_balance, closing_balance,
                                    currency_code, source_format, file_sha256, imported_by)
       VALUES ($1, $2, $3::date, $4::date, 0, 0, 'MXN', 'manual', $5, $6)`,
      [f.entityId, account, start, end, uuidv4().replace(/-/g, '').padEnd(64, '0'), f.userId]
    );
  }
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: customerId, invoice_date: '2026-05-10', due_date: '2026-05-10', currency_code: 'MXN', terms: 'PPD',
    lines: [{ revenue_account_id: f.cuentas['4100'], description: 'Synthetic fees', quantity: '1', unit_price: '1000.00', tax_rate: '16.0000' }],
    created_by: f.userId,
  });
  const invoiceId = (await issueInvoice(draft.id, f.userId, { entityId: f.entityId })).invoice.id;
  const r = await recordCustomerPayment({
    entityId: f.entityId, counterpartyId: customerId, paymentAmount: '1160.00', paymentDate: '2026-05-15',
    paymentMethod: 'check', bankAccountId: account, checkNumber: 'CHQ-607',
    applications: [{ documentId: invoiceId, amountApplied: '1160.00' }],
  }, f.userId);
  await unapplyCustomerPayment(f.entityId, r.paymentId, { invoiceId, reason: 'applied to the wrong sale', date: '2026-05-20' }, f.userId);
  return { f, customerId, account, invoiceId, paymentId: r.paymentId };
}

/** Note N of 200.00 + 32.00 on `date`, applied to S; its entry's id. */
async function note(b: Book, date: string): Promise<string> {
  const cn = await createCreditNote({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_id: b.invoiceId, type: 'devolucion',
    credit_date: date, subtotal: '200.00', tax_amount: '32.00',
  }, b.f.userId);
  await issueCreditNote(b.f.entityId, cn.id, b.f.userId);
  await applyCreditNote(b.f.entityId, cn.id, [{ invoiceId: b.invoiceId, amount: '232.00' }], b.f.userId);
  return (await query<{ id: string }>(
    'SELECT journal_entry_id AS id FROM credit_notes WHERE id = $1 AND entity_id = $2', [cn.id, b.f.entityId]
  )).rows[0].id;
}

/** The bank credit of 06-01 that cashes the cheque. */
async function cash(b: Book) {
  const credit = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
     VALUES ($1, $2, '2026-06-01'::date, 1160.00, 'credit', 'synthetic deposit', false)`,
    [credit, b.account]
  );
  return recordCustomerCheckCashing(b.f.entityId, b.paymentId, { transactionId: credit, userId: b.f.userId });
}

/** A posted entry's lines by account code, each as [debit, credit] at 4 dp. */
async function linesOf(b: Book, entryId: string): Promise<Record<string, [string, string]>> {
  const r = await query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, COALESCE(SUM(l.debit_amount), 0)::text AS debit, COALESCE(SUM(l.credit_amount), 0)::text AS credit
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND je.id = $2
      GROUP BY a.code`,
    [b.f.entityId, entryId]
  );
  return Object.fromEntries(r.rows.map((l) => [l.code, [new Decimal(l.debit).toFixed(4), new Decimal(l.credit).toFixed(4)]]));
}

const dr = (x: string): [string, string] => [new Decimal(x).toFixed(4), '0.0000'];
const cr = (x: string): [string, string] => ['0.0000', new Decimal(x).toFixed(4)];

/** The credit balances of 2120, 2125 and 2150, to two decimals, in the month given or overall. */
async function vat(b: Book, month?: number): Promise<[string, string, string]> {
  const out: string[] = [];
  for (const code of ['2120', '2125', '2150']) {
    const r = await query<{ b: string }>(
      `SELECT COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::text AS b
         FROM journal_entry_lines l
         JOIN journal_entries je ON je.id = l.journal_entry_id AND je.entity_id = $1 AND je.status = 'posted'
         JOIN accounts a ON a.id = l.account_id AND a.code = $2
        WHERE $3::int IS NULL OR EXTRACT(MONTH FROM je.entry_date) = $3::int`,
      [b.f.entityId, code, month ?? null]
    );
    out.push(Number(r.rows[0].b).toFixed(2));
  }
  return out as [string, string, string];
}

const paper = (b: Book, month: number): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year: 2026, month });
const at16 = (wp: IvaWorkpaper) => [Number(wp.figures.charged.tasa16.base).toFixed(2), Number(wp.figures.charged.tasa16.iva).toFixed(2)];
const silent = (wp: IvaWorkpaper) => expect(wp.findings.map((h) => h.codigo)).not.toContain(TIE_OUT);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('a credit note while the cheque is held', () => {
  it('N on 05-25 takes 32.00 from 2125; the cashing of 06-01 posts 2150 Dr 128.00 / 2120 Cr 128.00, and June ties out at 800.00 / 128.00', async () => {
    const b = await book('held');
    const entry = await note(b, '2026-05-25');
    const lines = await linesOf(b, entry);
    expect(lines['2125']).toEqual(dr('32'));
    expect([lines['2120'], lines['2150']]).toEqual([undefined, undefined]);
    expect(await vat(b, 5)).toEqual(['0.00', '128.00', '1160.00']);

    const cashed = await cash(b);
    expect(cashed).toMatchObject({ released: '128.0000', advanceIva: '128.0000' });
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2150': dr('128'), '2120': cr('128') });
    expect(await vat(b)).toEqual(['128.00', '128.00', '1032.00']);

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual(['0.00', '0.00']);
    expect(at16(june)).toEqual(['800.00', '128.00']);
    expect(june.ledger.iva_trasladado).toBe('-128.0000');
    silent(may);
    silent(june);
  }, 180_000);

  it('the other order, cashed on 06-01 and N on 06-10, ends the same: 2120 128.00, 2125 128.00, 2150 1,032.00', async () => {
    const b = await book('cashed first');
    const cashed = await cash(b);
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2150': dr('160'), '2120': cr('160') });
    await note(b, '2026-06-10');
    expect(await vat(b)).toEqual(['128.00', '128.00', '1032.00']);
    silent(await paper(b, 6));
  }, 180_000);

  it('applied again on 06-05 for the 928.00 owed, it nets: 2150 Dr 800.00 / 2125 Dr 128.00 / 1120 Cr 928.00, and 232.00 stays owed back', async () => {
    const b = await book('again');
    await note(b, '2026-05-25');
    await cash(b);
    const applied = await applyCustomerPayment(
      b.f.entityId, b.paymentId, [{ documentId: b.invoiceId, amountApplied: '928.00' }], b.f.userId, { date: '2026-06-05' }
    );
    expect(await linesOf(b, applied.journalEntry!.id)).toEqual({ '2150': dr('800'), '2125': dr('128'), '1120': cr('928') });
    expect(await vat(b)).toEqual(['128.00', '0.00', '232.00']);
    const june = await paper(b, 6);
    expect(at16(june)).toEqual(['800.00', '128.00']);
    silent(june);
  }, 180_000);
});

describe('a reversal undoes the adjustment', () => {
  it('N reversed on 05-28, before the cashing: the cashing causes all 160.00 again', async () => {
    const b = await book('note reversed');
    const entry = await note(b, '2026-05-25');
    await reverseJournalEntry(entry, b.f.userId, { reason: 'CFDI cancelled', reversalDate: '2026-05-28' });
    const cashed = await cash(b);
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2150': dr('160'), '2120': cr('160') });
    expect(await vat(b)).toEqual(['160.00', '160.00', '1000.00']);
    silent(await paper(b, 6));
  }, 180_000);

  it('the receipt reversed after the cashing: its mirrors take out the 128.00 caused, with no correction pair, and 2125 keeps 128.00', async () => {
    const b = await book('receipt reversed');
    await note(b, '2026-05-25');
    await cash(b);
    vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date('2026-06-25T12:00:00'));
    try {
      await reverseCustomerPayment(b.f.entityId, b.paymentId, { reason: 'taken back', cause: 'taken_back' }, b.f.userId);
    } finally {
      vi.useRealTimers();
    }
    expect(await vat(b)).toEqual(['0.00', '128.00', '0.00']);
    const pairs = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1 AND source_type = 'receipt_reversal_iva'`, [b.f.entityId]
    );
    expect(pairs.rows[0].n).toBe('0');
  }, 180_000);
});
