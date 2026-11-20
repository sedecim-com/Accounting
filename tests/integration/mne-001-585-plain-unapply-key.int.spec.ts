import { describe, it, expect, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { recordCustomerPayment, unapplyCustomerPayment } from '../../src/services/payments/payment-service.js';
import { recordCustomerCheckCashing } from '../../src/services/banking/treasury-posting.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-585 (#792, part 2/3) · THE PANEL KEY plain_receipt_unapply_iva LETS
 * A FIRM RE-PARK A PLAIN RECEIPT'S IVA, ONLY IN THE MONTH OF THE COLLECTION.
 *
 * By default (`keep_caused`, MNE-001-574) the unapply keeps the IVA caused
 * (LIVA arts. 1-B and 7). Under `repark_same_month` each allocation whose IVA
 * was released in the calendar month of the unapply goes back to 2125, as the
 * correction of an error before that month is declared; one released in an
 * earlier month stays caused, and a cheque the bank has not cashed released
 * nothing to re-park. The IVA paper does not follow the key: it keeps the
 * share caused and its tie-out names the re-park.
 *
 * Invoices are PPD, 1,000.00 + 160.00, issued 2026-05-10; receipts are by
 * transfer unless a case says cheque. One entity per case. Figures by hand.
 */

const ISSUED = '2026-05-10';
const KEY = 'plain_receipt_unapply_iva';
const TIE_OUT = 'IVA-WP-CHARGED-VS-LEDGER';
const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

interface Book { f: Fixture; customerId: string; account: string }

let nextGl = 0;

/** An entity on Mexican books with a bank account and its May and June statements; `repark` answers the key. */
async function book(name: string, repark: boolean): Promise<Book> {
  const f = await crearInquilino(`MNE-001-585 ${name}`);
  await seedPolicies({ tenantId: f.tenantId });
  if (repark) await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, KEY, 'repark_same_month', 'it@example.test');
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Repark Payer SA', 'MXN', $4)`,
    [customerId, f.entityId, `C-585-${customerId.slice(0, 6)}`, f.userId]
  );
  nextGl += 1;
  const glId = uuidv4();
  await query(
    `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id, currency_code, normal_balance, created_by)
     VALUES ($1, $2, 'Bank 585', 'asset', 'current_assets', $3, 'MXN', 'debit', $4)`,
    [glId, `1110-9${nextGl}`, f.entityId, f.userId]
  );
  const account = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1, $2, $3, 'Bank', $4, 'MXN', 'checking')`,
    [account, f.entityId, `Operating 585 ${name}`, glId]
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

/** Runs `receipt <argv> --json` in process as the binary would; `dry` returns the dry run's text instead. */
async function leaf(b: Book, argv: string[], dry = false): Promise<{ row: Record<string, string>; out: string }> {
  const out: string[] = [];
  const errors: unknown[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerReceiptCommand(program, { palette: plain, shutdown: () => undefined, reportError: (e: unknown) => { errors.push(e); } });
    await program.parseAsync([
      'node', 'mnemosine', 'receipt', ...argv, '-e', b.f.entityId, '-t', b.f.tenantId, '-y', ...(dry ? ['--dry-run'] : ['--json']),
    ]);
  } catch (e) {
    errors.push(e);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  if (errors.length > 0) throw new Error(`receipt ${argv.join(' ')} → ${exitCodeFor(errors[0])}: ${(errors[0] as Error).message}`);
  const text = out.join('');
  return { row: dry ? {} : (JSON.parse(text) as { rows: Record<string, string>[] }).rows[0], out: text };
}

/** An issued PPD invoice of `price` plus 16 %; with `ieps`, a line of 80.00 on 2181 as #699's fixture. */
async function invoice(b: Book, o: { price?: string; ieps?: boolean } = {}): Promise<{ id: string; number: string }> {
  const draft = await createInvoice({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_date: ISSUED, due_date: ISSUED, currency_code: 'MXN', terms: 'PPD',
    lines: [
      { revenue_account_id: b.f.cuentas['4100'], description: 'Synthetic fees', quantity: '1', unit_price: o.price ?? '1000.00', tax_rate: '16.0000' },
      ...(o.ieps ? [{ revenue_account_id: b.f.cuentas['2181'], description: 'IEPS 8 % transferred', quantity: '1', unit_price: '80.00', tax_rate: '16.0000' }] : []),
    ],
    created_by: b.f.userId,
  });
  const { invoice: issued } = await issueInvoice(draft.id, b.f.userId, { entityId: b.f.entityId });
  return { id: issued.id, number: issued.invoice_number };
}

/** A posted entry's lines by account code, each as [debit, credit] at 4 dp. */
async function linesOf(b: Book, entry: string): Promise<Record<string, [string, string]>> {
  const r = await query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, COALESCE(SUM(l.debit_amount), 0)::text AS debit, COALESCE(SUM(l.credit_amount), 0)::text AS credit
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND (je.entry_number = $2 OR je.id::text = $2)
      GROUP BY a.code`,
    [b.f.entityId, entry]
  );
  return Object.fromEntries(r.rows.map((l) => [l.code, [new Decimal(l.debit).toFixed(4), new Decimal(l.credit).toFixed(4)]]));
}

const dr = (x: string): [string, string] => [new Decimal(x).toFixed(4), '0.0000'];
const cr = (x: string): [string, string] => ['0.0000', new Decimal(x).toFixed(4)];

/** The markers of the receipt's allocations, oldest first. */
async function markers(b: Book, paymentId: string): Promise<(string | null)[]> {
  const r = await query<{ kept: string | null }>(
    `SELECT pa.unapply_kept_iva_amount::text AS kept
       FROM payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $2
      WHERE pa.payment_id = $1 ORDER BY pa.created_at`,
    [paymentId, b.f.entityId]
  );
  return r.rows.map((x) => x.kept);
}

const record = (b: Book, inv: string, amount: string) => leaf(b, ['record', inv, '--amount', amount, '--date', '2026-05-15']);
const unapplyArgs = (pmt: string, inv: string, date: string) =>
  ['unapply', pmt, '--invoice', inv, '--reason', 'applied to the wrong sale', '--date', date];

/** A cheque of 1,160.00 received 2026-05-15 that collects `inv`; its IVA waits for the bank (MNE-001-556). */
const byCheck = (b: Book, inv: string) =>
  recordCustomerPayment({
    entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: '1160.00', paymentDate: '2026-05-15',
    paymentMethod: 'check', bankAccountId: b.account, checkNumber: 'CHQ-585',
    applications: [{ documentId: inv, amountApplied: '1160.00' }],
  }, b.f.userId);

/** The bank credit of `date` that cashes the cheque. */
async function cash(b: Book, receiptId: string, date: string) {
  const credit = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
     VALUES ($1, $2, $3::date, '1160.00', 'credit', 'synthetic deposit', false)`,
    [credit, b.account, date]
  );
  return recordCustomerCheckCashing(b.f.entityId, receiptId, { transactionId: credit, userId: b.f.userId });
}

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('repark_same_month', () => {
  it('H · collected 05-15 and unapplied 05-20: the IVA goes back to 2125, no marker; the paper keeps it and its tie-out names the re-park', async () => {
    const b = await book('H', true);
    const inv = await invoice(b);
    const pmt = (await record(b, inv.number, '1160.00')).row.payment_number;
    const dry = await leaf(b, unapplyArgs(pmt, inv.number, '2026-05-20'), true);
    expect(dry.out).toContain('IVA re-parked 160.0000');
    expect(dry.out).not.toContain('IVA kept caused');

    const done = await leaf(b, unapplyArgs(pmt, inv.number, '2026-05-20'));
    expect(done.row).toMatchObject({ iva_reparked: '160.0000', iva_kept_caused: '0.0000' });
    expect(await linesOf(b, done.row.entry_number)).toEqual({
      '1120': dr('1160'), '2150': cr('1160'), '2120': dr('160'), '2125': cr('160'),
    });
    const id = (await query<{ id: string }>(`SELECT id FROM customer_payments WHERE entity_id = $1 AND payment_number = $2`, [b.f.entityId, pmt])).rows[0].id;
    expect(await markers(b, id)).toEqual([null]);

    // The paper reads LIVA art. 1-B whatever the key says: May keeps 1,000 / 160, and the ledger moved 0.
    const may = await buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year: 2026, month: 5 });
    expect([Number(may.figures.charged.tasa16.base).toFixed(2), Number(may.figures.charged.tasa16.iva).toFixed(2)]).toEqual(['1000.00', '160.00']);
    expect(may.ledger.iva_trasladado).toBe('0.0000');
    const gap = may.findings.find((h) => h.codigo === TIE_OUT);
    expect(gap?.mensaje).toContain('re-aparcó');
  }, 180_000);

  it('I · unapplied 06-10, a month after the collection: kept caused as by default, and the dry run says why', async () => {
    const b = await book('I', true);
    const inv = await invoice(b);
    const pmt = (await record(b, inv.number, '1160.00')).row.payment_number;
    const dry = await leaf(b, unapplyArgs(pmt, inv.number, '2026-06-10'), true);
    expect(dry.out).toContain('IVA kept caused 160.0000 (LIVA art. 1-B)');
    expect(dry.out).toContain(`${KEY} re-parks only in the month the IVA was released, and it was released before 2026-06`);

    const done = await leaf(b, unapplyArgs(pmt, inv.number, '2026-06-10'));
    expect(done.row).toMatchObject({ iva_reparked: '0.0000', iva_kept_caused: '160.0000' });
    expect(await linesOf(b, done.row.entry_number)).toEqual({ '1120': dr('1160'), '2150': cr('1000'), '2125': cr('160') });
  }, 180_000);

  it('J · the IEPS goes back with the IVA: 2180 Dr 80.00 / 2181 Cr 80.00, tagged with the invoice', async () => {
    const b = await book('J', true);
    const inv = await invoice(b, { ieps: true });
    const pmt = (await record(b, inv.number, '1252.80')).row.payment_number;
    const done = await leaf(b, unapplyArgs(pmt, inv.number, '2026-05-20'));
    expect(done.row).toMatchObject({ iva_reparked: '172.8000', iva_kept_caused: '0.0000' });
    expect(await linesOf(b, done.row.entry_number)).toEqual({
      '1120': dr('1252.80'), '2150': cr('1252.80'), '2120': dr('172.80'), '2125': cr('172.80'), '2180': dr('80'), '2181': cr('80'),
    });
    const tagged = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
        WHERE je.entity_id = $1 AND je.entry_number = $2 AND l.tags -> 'ieps_release' ->> 'invoice_id' = $3`,
      [b.f.entityId, done.row.entry_number, inv.id]
    );
    expect(tagged.rows[0].n).toBe('2');
  }, 180_000);

  // The release day, not the receipt's date: a cheque received 05-15 and cashed 06-02 released its IVA in June.
  it('H′ · a cheque cashed 06-02 and unapplied 06-05 re-parks: its IVA was released in June, not in May', async () => {
    const b = await book('H cheque', true);
    // The panel is read in the tenant of the context, as the binary sets it: this file holds several.
    enterTenant(b.f.tenantId);
    const inv = await invoice(b);
    const r = await byCheck(b, inv.id);
    await cash(b, r.paymentId, '2026-06-02');
    const undone = await unapplyCustomerPayment(b.f.entityId, r.paymentId, { invoiceId: inv.id, reason: 'wrong sale', date: '2026-06-05' }, b.f.userId);
    expect([undone.ivaReAparcado, undone.ivaKeptCaused, undone.keptBecause]).toEqual(['160.0000', '0.0000', null]);
    expect(await linesOf(b, undone.journalEntry.id)).toEqual({ '1120': dr('1160'), '2150': cr('1160'), '2120': dr('160'), '2125': cr('160') });
  }, 180_000);

  it('a cheque the bank has not cashed is never re-parked: nothing was caused', async () => {
    const b = await book('held', true);
    // The panel is read in the tenant of the context, as the binary sets it: this file holds several.
    enterTenant(b.f.tenantId);
    const inv = await invoice(b);
    const r = await byCheck(b, inv.id);
    const undone = await unapplyCustomerPayment(b.f.entityId, r.paymentId, { invoiceId: inv.id, reason: 'wrong sale', date: '2026-05-20' }, b.f.userId);
    expect([undone.ivaReAparcado, undone.ivaKeptCaused]).toEqual(['0.0000', '0.0000']);
    expect(await linesOf(b, undone.journalEntry.id)).toEqual({ '1120': dr('1160'), '2150': cr('1160') });
  }, 180_000);
});

describe('keep_caused, the default', () => {
  it('the same unapply of 05-20 keeps the IVA caused and stores the marker', async () => {
    const b = await book('default', false);
    // The panel is read in the tenant of the context, as the binary sets it: this file holds several.
    enterTenant(b.f.tenantId);
    const inv = await invoice(b);
    const r = await recordCustomerPayment({
      entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: '1160.00', paymentDate: '2026-05-15',
      paymentMethod: 'spei', applications: [{ documentId: inv.id, amountApplied: '1160.00' }],
    }, b.f.userId);
    const undone = await unapplyCustomerPayment(b.f.entityId, r.paymentId, { invoiceId: inv.id, reason: 'wrong sale', date: '2026-05-20' }, b.f.userId);
    expect([undone.ivaReAparcado, undone.ivaKeptCaused, undone.keptBecause]).toEqual(['0.0000', '160.0000', 'default']);
    expect(await markers(b, r.paymentId)).toEqual(['160.0000']);
  }, 180_000);
});
