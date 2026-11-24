import { describe, it, expect, afterAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment, unapplyCustomerPayment, applyCustomerPayment, reverseCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { recordCustomerCheckCashing } from '../../src/services/banking/treasury-posting.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

/**
 * MNE-001-608 (#792, risk 3 of #891) · THE IEPS OF A HELD CHEQUE'S CASH IS
 * CAUSED ON THE CASHING DAY, AS ITS IVA IS.
 *
 * IEPS is caused when the price is collected (LIEPS art. 10), with LIVA's
 * tests of collection (art. 5o.-C), and a price paid by cheque is collected
 * the day the bank cashes it (LIVA art. 1-B, second paragraph). A plain cheque
 * unapplied from a PPD invoice before its cashing stores the share's IVA on its
 * row (MNE-001-586); the IEPS of the same share is the invoice's parked IEPS in
 * the same proportion, so the cashing posts 2150 Dr / 2180 Cr for it, tagged
 * with the cheque, and the cash on account carries it (MNE-001-590): a later
 * application nets it instead of causing the next invoice's IEPS again.
 *
 * A and B are PPD: 1,000.00 + IEPS 8 % 80.00 on 2181 + IVA 16 % on 1,080.00 =
 * 172.80, so 1,252.80; A is issued 2026-05-10 and B 2026-05-22. The cheque of
 * 1,252.80 collects A on 05-15 and is unapplied on 05-20; the bank cashes it
 * on 06-01. One entity per case. Every figure is computed by hand.
 */

interface Book { f: Fixture; customerId: string; account: string }

let nextGl = 0;

/**
 * An entity on Mexican books with a bank account and its May and June statements; `key` answers a panel key.
 * Each case enters its tenant, because the panel is read in the tenant of the context and this file holds several.
 */
async function book(name: string, key?: [string, string]): Promise<Book> {
  const f = await crearInquilino(`MNE-001-608 ${name}`);
  await seedPolicies({ tenantId: f.tenantId });
  if (key) await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, key[0], key[1], 'it@example.test');
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic IEPS Cheque Payer SA', 'MXN', $4)`,
    [customerId, f.entityId, `C-608-${customerId.slice(0, 6)}`, f.userId]
  );
  nextGl += 1;
  const glId = uuidv4();
  await query(
    `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id, currency_code, normal_balance, created_by)
     VALUES ($1, $2, 'Bank 608', 'asset', 'current_assets', $3, 'MXN', 'debit', $4)`,
    [glId, `1110-6${nextGl}`, f.entityId, f.userId]
  );
  const account = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1, $2, $3, 'Bank', $4, 'MXN', 'checking')`,
    [account, f.entityId, `Operating 608 ${name}`, glId]
  );
  for (const [start, end] of [['2026-05-01', '2026-05-31'], ['2026-06-01', '2026-06-30']]) {
    await query(
      `INSERT INTO bank_statements (entity_id, bank_account_id, period_start, period_end, opening_balance, closing_balance,
                                    currency_code, source_format, file_sha256, imported_by)
       VALUES ($1, $2, $3::date, $4::date, 0, 0, 'MXN', 'manual', $5, $6)`,
      [f.entityId, account, start, end, uuidv4().replace(/-/g, '').padEnd(64, '0'), f.userId]
    );
  }
  return { f, customerId, account };
}

/** An issued PPD invoice of 1,000.00 at 16 % with a line of 80.00 of IEPS on 2181, as #699's fixture. */
async function invoice(b: Book, date = '2026-05-10'): Promise<{ id: string; number: string }> {
  const draft = await createInvoice({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_date: date, due_date: date, currency_code: 'MXN', terms: 'PPD',
    lines: [
      { revenue_account_id: b.f.cuentas['4100'], description: 'Synthetic goods', quantity: '1', unit_price: '1000.00', tax_rate: '16.0000' },
      { revenue_account_id: b.f.cuentas['2181'], description: 'IEPS 8 % transferred', quantity: '1', unit_price: '80.00', tax_rate: '16.0000' },
    ],
    created_by: b.f.userId,
  });
  const { invoice: issued } = await issueInvoice(draft.id, b.f.userId, { entityId: b.f.entityId });
  return { id: issued.id, number: issued.invoice_number };
}

/** The cheque of 1,252.80 received 2026-05-15 that collects A, unapplied from it on 05-20: its IVA and IEPS wait for the bank. */
async function heldAndUnapplied(b: Book, a: string): Promise<string> {
  const r = await recordCustomerPayment({
    entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: '1252.80', paymentDate: '2026-05-15',
    paymentMethod: 'check', bankAccountId: b.account, checkNumber: 'CHQ-608',
    applications: [{ documentId: a, amountApplied: '1252.80' }],
  }, b.f.userId);
  const undone = await unapplyCustomerPayment(b.f.entityId, r.paymentId, { invoiceId: a, reason: 'applied to the wrong sale', date: '2026-05-20' }, b.f.userId);
  expect(await linesOf(b, undone.journalEntry.id)).toEqual({ '1120': dr('1252.80'), '2150': cr('1252.80') });
  return r.paymentId;
}

/** The bank credit of 06-01 that cashes the cheque. */
async function cash(b: Book, receiptId: string) {
  const credit = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
     VALUES ($1, $2, '2026-06-01'::date, '1252.80', 'credit', 'synthetic deposit', false)`,
    [credit, b.account]
  );
  return recordCustomerCheckCashing(b.f.entityId, receiptId, { transactionId: credit, userId: b.f.userId });
}

const apply = (b: Book, receiptId: string, invoiceId: string, amount: string, date: string) =>
  applyCustomerPayment(b.f.entityId, receiptId, [{ documentId: invoiceId, amountApplied: amount }], b.f.userId, { date });

/** A posted entry's lines by account code, each as [debit, credit] at 4 dp. */
async function linesOf(b: Book, entry: string): Promise<Record<string, [string, string]>> {
  const r = await query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, COALESCE(SUM(l.debit_amount), 0)::text AS debit, COALESCE(SUM(l.credit_amount), 0)::text AS credit
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND je.id::text = $2
      GROUP BY a.code`,
    [b.f.entityId, entry]
  );
  return Object.fromEntries(r.rows.map((l) => [l.code, [new Decimal(l.debit).toFixed(4), new Decimal(l.credit).toFixed(4)]]));
}

const dr = (x: string): [string, string] => [new Decimal(x).toFixed(4), '0.0000'];
const cr = (x: string): [string, string] => ['0.0000', new Decimal(x).toFixed(4)];

/** Credit balances of 2120, 2125, 2150, 2180 and 2181, overall or in one month of 2026, to two decimals. */
async function balances(b: Book, month?: number): Promise<string[]> {
  const r = await query<{ code: string; b: string }>(
    `SELECT a.code, COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::text AS b
       FROM accounts a
       LEFT JOIN journal_entry_lines l ON l.account_id = a.id
        AND l.journal_entry_id IN (
          SELECT id FROM journal_entries
           WHERE entity_id = $1 AND status = 'posted' AND ($2::int IS NULL OR EXTRACT(MONTH FROM entry_date) = $2::int))
      WHERE a.entity_id = $1 AND a.code IN ('2120', '2125', '2150', '2180', '2181') GROUP BY a.code`,
    [b.f.entityId, month ?? null]
  );
  return ['2120', '2125', '2150', '2180', '2181'].map((c) => new Decimal(r.rows.find((x) => x.code === c)?.b ?? 0).toFixed(2));
}

/** The tags of the cashing's 2180 lines. */
async function tagsOn2180(b: Book, entry: string): Promise<unknown[]> {
  const r = await query<{ tags: unknown }>(
    `SELECT l.tags FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id AND je.entity_id = $1
       JOIN accounts a ON a.id = l.account_id AND a.code = '2180'
      WHERE je.id = $2`,
    [b.f.entityId, entry]
  );
  return r.rows.map((x) => x.tags);
}

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('a held cheque unapplied from a PPD invoice with IEPS, then cashed', () => {
  it('H1 · the cashing of 06-01 also posts 2150 Dr 80.00 / 2180 Cr 80.00, tagged with A and the cheque: June causes the IEPS it collected', async () => {
    const b = await book('H1');
    enterTenant(b.f.tenantId);
    const a = await invoice(b);
    const receipt = await heldAndUnapplied(b, a.id);
    expect(await balances(b)).toEqual(['0.00', '172.80', '1252.80', '0.00', '80.00']);

    const cashed = await cash(b, receipt);
    expect(cashed).toMatchObject({ released: '172.8000', advanceIva: '172.8000', iepsReleased: '80.0000' });
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2150': dr('252.80'), '2120': cr('172.80'), '2180': cr('80') });
    expect(await tagsOn2180(b, cashed.entryId!)).toEqual([{ ieps_release: { invoice_id: a.id, payment_id: receipt } }]);
    expect(await balances(b)).toEqual(['172.80', '172.80', '1000.00', '80.00', '80.00']);
    expect(await balances(b, 6)).toEqual(['172.80', '0.00', '-252.80', '80.00', '0.00']);

    const june = await buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year: 2026, month: 6 });
    expect(june.findings.map((h) => h.codigo)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
  }, 180_000);

  it('H2 · the pool applied to B on 07-05 nets that IEPS: 2150 Dr 1,000.00 / 2125 Dr 172.80 / 2181 Dr 80.00 / 1120 Cr 1,252.80, and July causes none', async () => {
    const b = await book('H2');
    enterTenant(b.f.tenantId);
    const a = await invoice(b);
    const receipt = await heldAndUnapplied(b, a.id);
    const bInv = await invoice(b, '2026-05-22');
    await cash(b, receipt);
    const applied = await apply(b, receipt, bInv.id, '1252.80', '2026-07-05');
    expect(await linesOf(b, applied.journalEntry!.id)).toEqual({
      '2150': dr('1000'), '2125': dr('172.80'), '2181': dr('80'), '1120': cr('1252.80'),
    });
    expect(await balances(b, 7)).toEqual(['0.00', '-172.80', '-1000.00', '0.00', '-80.00']);
    expect(await balances(b)).toEqual(['172.80', '172.80', '0.00', '80.00', '80.00']);
  }, 180_000);
});

describe('cash taken from the held pool before the cashing (cheque_advance_before_cashing = defer_to_cashing)', () => {
  it('H3 · all of it to B on 05-25: the cashing releases B\'s 80.00 from 2181 and causes none on the cash, which is gone', async () => {
    const b = await book('H3', ['cheque_advance_before_cashing', 'defer_to_cashing']);
    enterTenant(b.f.tenantId);
    const a = await invoice(b);
    const receipt = await heldAndUnapplied(b, a.id);
    const bInv = await invoice(b, '2026-05-22');
    const applied = await apply(b, receipt, bInv.id, '1252.80', '2026-05-25');
    expect(await linesOf(b, applied.journalEntry!.id)).toEqual({ '2150': dr('1252.80'), '1120': cr('1252.80') });
    expect(await balances(b)).toEqual(['0.00', '345.60', '0.00', '0.00', '160.00']);

    const cashed = await cash(b, receipt);
    expect(cashed).toMatchObject({ iepsReleased: '80.0000' });
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2125': dr('172.80'), '2120': cr('172.80'), '2181': dr('80'), '2180': cr('80') });
    expect(await balances(b)).toEqual(['172.80', '172.80', '0.00', '80.00', '80.00']);
  }, 180_000);

  it('H4 · 626.40 to B on 05-25: the cashing causes 40.00 on the cash still on account, and the rest to B on 06-05 nets it', async () => {
    const b = await book('H4', ['cheque_advance_before_cashing', 'defer_to_cashing']);
    enterTenant(b.f.tenantId);
    const a = await invoice(b);
    const receipt = await heldAndUnapplied(b, a.id);
    const bInv = await invoice(b, '2026-05-22');
    const first = await apply(b, receipt, bInv.id, '626.40', '2026-05-25');
    expect(await linesOf(b, first.journalEntry!.id)).toEqual({ '2150': dr('626.40'), '1120': cr('626.40') });

    // B's share 86.40 (2125 → 2120) and r 40.00 (2181 → 2180); the advance term 172.80 − 86.40 = 86.40 and
    // the held IEPS 80.00 − 80.00 × 626.40 / 1,252.80 = 40.00, both from 2150.
    const cashed = await cash(b, receipt);
    expect(cashed).toMatchObject({ released: '172.8000', iepsReleased: '80.0000' });
    expect(await linesOf(b, cashed.entryId!)).toEqual({
      '2125': dr('86.40'), '2150': dr('126.40'), '2120': cr('172.80'), '2181': dr('40'), '2180': cr('80'),
    });
    expect(await balances(b)).toEqual(['172.80', '259.20', '500.00', '80.00', '120.00']);

    // e = 40.00, the remainder; c = 86.40; B releases g 86.40 and r 40.00.
    const rest = await apply(b, receipt, bInv.id, '626.40', '2026-06-05');
    expect(await linesOf(b, rest.journalEntry!.id)).toEqual({
      '2150': dr('500'), '2125': dr('86.40'), '2181': dr('40'), '1120': cr('626.40'),
    });
    expect(await balances(b)).toEqual(['172.80', '172.80', '0.00', '80.00', '80.00']);
  }, 180_000);
});

describe('controls', () => {
  it('R1 · the receipt reversed (taken back) after the cashing: its mirrors take the 80.00 out of 2180 with the rest', async () => {
    const b = await book('R1');
    enterTenant(b.f.tenantId);
    const a = await invoice(b);
    const receipt = await heldAndUnapplied(b, a.id);
    await cash(b, receipt);
    vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date('2026-06-10T12:00:00'));
    try {
      await reverseCustomerPayment(b.f.entityId, receipt, { reason: 'taken back', cause: 'taken_back' }, b.f.userId);
    } finally {
      vi.useRealTimers();
    }
    expect(await balances(b)).toEqual(['0.00', '172.80', '0.00', '0.00', '80.00']);
  }, 180_000);
});
