import { describe, it, expect, afterAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations, reverseJournalEntry, voidJournalEntry } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { createCreditNote, issueCreditNote, applyCreditNote } from '../../src/services/ar/credit-note-service.js';
import {
  recordCustomerPayment, unapplyCustomerPayment, applyCustomerPayment, reverseCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { recordCustomerCheckCashing } from '../../src/services/banking/treasury-posting.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

/**
 * MNE-001-612 (#792, risk 1 of #905) · A CREDIT NOTE ON A HELD CHEQUE,
 * REVERSED WITH `entry reverse` AFTER THE CASHING THAT NETTED IT.
 *
 * A note issued while a customer's cheque is held takes its IVA from 2125 and
 * tags that line `held_restitution`; the cashing then causes the marker less
 * it (MNE-001-607, decision (A) of #792). Reversing the note afterwards gives
 * 2125 its IVA back through the mirror, but the cashing already caused that
 * much less: the reversal posts its own correction, 2150 Dr / 2120 Cr, dated
 * with it (NIF B-1: the posted entries stay as they are), so the books end as
 * if the note had never been issued. The IVA paper counts that IVA in the
 * reversal's month by default (`note_reversal_after_cashing_iva`).
 *
 * Invoice S is PPD, 1,000.00 + 160.00, issued 05-10; a cheque of 1,160.00
 * received 05-15 collects it; the unapply of 05-20 stores 160.0000; note N,
 * 200.00 + 32.00 on 05-25, is applied to S; the bank cashes the cheque on
 * 06-01. One entity per case. Figures by hand.
 */

const TIE_OUT = 'IVA-WP-CHARGED-VS-LEDGER';
const KEY = 'note_reversal_after_cashing_iva';
const PAIR = 'held_restitution_reversal';

interface Book { f: Fixture; customerId: string; account: string; invoiceId: string; paymentId: string }

let nextGl = 0;

/** An entity with a bank account, May to July statements, S issued, the cheque received and unapplied. */
async function book(name: string): Promise<Book> {
  const f = await crearInquilino(`MNE-001-612 ${name}`);
  await seedPolicies({ tenantId: f.tenantId });
  enterTenant(f.tenantId);
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Held Payer SA', 'MXN', $4)`,
    [customerId, f.entityId, `C-612-${customerId.slice(0, 6)}`, f.userId]
  );
  nextGl += 1;
  const glId = uuidv4();
  await query(
    `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id, currency_code, normal_balance, created_by)
     VALUES ($1, $2, 'Bank 612', 'asset', 'current_assets', $3, 'MXN', 'debit', $4)`,
    [glId, `1110-8${nextGl}`, f.entityId, f.userId]
  );
  const account = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1, $2, $3, 'Bank', $4, 'MXN', 'checking')`,
    [account, f.entityId, `Operating 612 ${name}`, glId]
  );
  for (const [start, end] of [['2026-05-01', '2026-05-31'], ['2026-06-01', '2026-06-30'], ['2026-07-01', '2026-07-31']]) {
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
    paymentMethod: 'check', bankAccountId: account, checkNumber: 'CHQ-612',
    applications: [{ documentId: invoiceId, amountApplied: '1160.00' }],
  }, f.userId);
  await unapplyCustomerPayment(f.entityId, r.paymentId, { invoiceId, reason: 'applied to the wrong sale', date: '2026-05-20' }, f.userId);
  return { f, customerId, account, invoiceId, paymentId: r.paymentId };
}

/** Note N of 200.00 + 32.00 on 05-25, applied to S; its entry's id. */
async function note(b: Book): Promise<string> {
  const cn = await createCreditNote({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_id: b.invoiceId, type: 'devolucion',
    credit_date: '2026-05-25', subtotal: '200.00', tax_amount: '32.00',
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

/** The correction pairs the entity holds: date and lines by account code, each as [debit, credit] at 4 dp. */
async function pairs(b: Book): Promise<{ date: string; source: string; lines: Record<string, [string, string]> }[]> {
  const r = await query<{ id: string; date: string; source: string; code: string; debit: string; credit: string }>(
    `SELECT je.id::text, je.entry_date::text AS date, je.source_id::text AS source, a.code,
            COALESCE(SUM(l.debit_amount), 0)::text AS debit, COALESCE(SUM(l.credit_amount), 0)::text AS credit
       FROM journal_entries je
       JOIN journal_entry_lines l ON l.journal_entry_id = je.id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND je.source_type = $2
      GROUP BY je.id, je.entry_date, je.source_id, a.code
      ORDER BY je.entry_date, je.id, a.code`,
    [b.f.entityId, PAIR]
  );
  const out = new Map<string, { date: string; source: string; lines: Record<string, [string, string]> }>();
  for (const x of r.rows) {
    const e = out.get(x.id) ?? { date: x.date, source: x.source, lines: {} };
    e.lines[x.code] = [new Decimal(x.debit).toFixed(4), new Decimal(x.credit).toFixed(4)];
    out.set(x.id, e);
  }
  return [...out.values()];
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
const tieOut = (wp: IvaWorkpaper) => wp.findings.find((h) => h.codigo === TIE_OUT);
const silent = (wp: IvaWorkpaper) => expect(wp.findings.map((h) => h.codigo)).not.toContain(TIE_OUT);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('the note reversed after the cashing', () => {
  it('C1 · N reversed on 07-10 posts 2150 Dr 32.00 / 2120 Cr 32.00 that day: 2120 160.00, 2125 160.00, 2150 1,000.00; June reads as filed and July ties at 200.00 / 32.00', async () => {
    const b = await book('reversed after');
    const entry = await note(b);
    await cash(b);
    expect(await vat(b)).toEqual(['128.00', '128.00', '1032.00']);

    await reverseJournalEntry(entry, b.f.userId, { reason: 'CFDI cancelled', reversalDate: '2026-07-10' });
    expect(await pairs(b)).toEqual([{ date: '2026-07-10', source: b.paymentId, lines: { '2120': cr('32'), '2150': dr('32') } }]);
    expect(await vat(b)).toEqual(['160.00', '160.00', '1000.00']);
    expect(await vat(b, 7)).toEqual(['32.00', '32.00', '-32.00']);

    const [may, june, july] = [await paper(b, 5), await paper(b, 6), await paper(b, 7)];
    expect(at16(may)).toEqual(['0.00', '0.00']);
    expect(at16(june)).toEqual(['800.00', '128.00']);
    expect(june.ledger.iva_trasladado).toBe('-128.0000');
    expect(at16(july)).toEqual(['200.00', '32.00']);
    expect(july.ledger.iva_trasladado).toBe('-32.0000');
    silent(may);
    silent(june);
    silent(july);
  }, 240_000);

  it('C2 · under cashing_month the same ledger, June reads the whole marker and names the amended return, and the month of the pair names it', async () => {
    const b = await book('cashing month');
    await resolvePolicy({ tenantId: b.f.tenantId, entityId: b.f.entityId }, KEY, 'cashing_month', 'it@example.test');
    const entry = await note(b);
    await cash(b);
    // `entry void` reaches the same correction.
    await voidJournalEntry(entry, b.f.userId, 'CFDI cancelled');
    expect((await pairs(b)).map((p) => p.lines)).toEqual([{ '2120': cr('32'), '2150': dr('32') }]);
    expect(await vat(b)).toEqual(['160.00', '160.00', '1000.00']);

    const june = await paper(b, 6);
    expect(at16(june)).toEqual(['1000.00', '160.00']);
    expect(june.ledger.iva_trasladado).toBe('-128.0000');
    expect(tieOut(june)?.mensaje).toContain('CFF art. 32');
    expect(tieOut(june)?.mensaje).toContain(KEY);
    // The void is dated today, so the pair's month is today's.
    const [{ date }] = await pairs(b);
    const month = await paper(b, Number(date.slice(5, 7)));
    expect(month.ledger.iva_trasladado).toBe('-32.0000');
    expect(tieOut(month)?.mensaje).toContain(KEY);
  }, 240_000);

  it('C3 · applied again for 928.00 on 06-05, then N reversed 07-10: 2150 keeps 200.00, the cash of the 232.00 now carrying 32.00, and July ties at 200.00 / 32.00', async () => {
    const b = await book('again');
    const entry = await note(b);
    await cash(b);
    await applyCustomerPayment(b.f.entityId, b.paymentId, [{ documentId: b.invoiceId, amountApplied: '928.00' }], b.f.userId, { date: '2026-06-05' });
    expect(await vat(b)).toEqual(['128.00', '0.00', '232.00']);

    await reverseJournalEntry(entry, b.f.userId, { reason: 'CFDI cancelled', reversalDate: '2026-07-10' });
    expect(await vat(b)).toEqual(['160.00', '32.00', '200.00']);
    const july = await paper(b, 7);
    expect(at16(july)).toEqual(['200.00', '32.00']);
    silent(july);
    const june = await paper(b, 6);
    expect(at16(june)).toEqual(['800.00', '128.00']);
    silent(june);
  }, 240_000);
});

describe('when no pair, or another date', () => {
  it('R1 · N reversed on 05-28, before the cashing, posts no pair: the cashing causes all 160.00', async () => {
    const b = await book('before');
    const entry = await note(b);
    await reverseJournalEntry(entry, b.f.userId, { reason: 'CFDI cancelled', reversalDate: '2026-05-28' });
    expect(await pairs(b)).toEqual([]);
    await cash(b);
    expect(await vat(b)).toEqual(['160.00', '160.00', '1000.00']);
    expect(await pairs(b)).toEqual([]);
  }, 240_000);

  it('R2 · reversed after the cashing was recorded but dated 05-28, before it: the pair is dated 06-01, and June ties at 1,000.00 / 160.00', async () => {
    const b = await book('backdated');
    const entry = await note(b);
    await cash(b);
    await reverseJournalEntry(entry, b.f.userId, { reason: 'CFDI cancelled', reversalDate: '2026-05-28' });
    expect((await pairs(b)).map((p) => p.date)).toEqual(['2026-06-01']);
    expect(await vat(b, 6)).toEqual(['160.00', '0.00', '-160.00']);
    const june = await paper(b, 6);
    expect(at16(june)).toEqual(['1000.00', '160.00']);
    silent(june);
  }, 240_000);

  it('R3 · the receipt reversed on 07-20 after the pair mirrors it with the cashing: 2120 0, 2125 160.00, 2150 0', async () => {
    const b = await book('receipt reversed');
    const entry = await note(b);
    await cash(b);
    await reverseJournalEntry(entry, b.f.userId, { reason: 'CFDI cancelled', reversalDate: '2026-07-10' });
    vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date('2026-07-20T12:00:00'));
    try {
      await reverseCustomerPayment(b.f.entityId, b.paymentId, { reason: 'taken back', cause: 'taken_back' }, b.f.userId);
    } finally {
      vi.useRealTimers();
    }
    expect(await vat(b)).toEqual(['0.00', '160.00', '0.00']);
  }, 240_000);
});
