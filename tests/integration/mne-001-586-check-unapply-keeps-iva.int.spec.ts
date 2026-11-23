import { describe, it, expect, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { createCreditNote, issueCreditNote } from '../../src/services/ar/credit-note-service.js';
import { recordCustomerPayment, unapplyCustomerPayment, applyCustomerPayment } from '../../src/services/payments/payment-service.js';
import { recordCustomerCheckCashing } from '../../src/services/banking/treasury-posting.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-586 (#792, part 3/3) · A CHEQUE UNAPPLIED BEFORE THE BANK CASHES IT
 * KEEPS ITS IVA FOR THE CASHING, AND THE CASHING CAUSES IT.
 *
 * A price paid by cheque is collected the day the bank cashes it (LIVA art.
 * 1-B, second paragraph), and cash held on account is taxed the day it is
 * collected (first paragraph). So a plain receipt by cheque unapplied from a
 * PPD invoice before its cashing posts no IVA line, its row stores the share's
 * IVA (`unapply_kept_iva_amount`, the invoice's telescope), and the cashing
 * moves it 2150 → 2120, the way an advance's does (MNE-001-558, 572): the
 * ledger's month equals the IVA paper's (MNE-001-507). Under either value of
 * `plain_receipt_unapply_iva` it stays for the cashing: nothing was caused yet,
 * so there is nothing to re-park (the coordinator's decision on #792).
 *
 * Invoices are PPD, 1,000.00 + 160.00, issued 2026-05-10; the cheque is
 * received 2026-05-15 and cashed 2026-06-01 unless a case says otherwise. One
 * entity per case. Figures by hand.
 */

const ISSUED = '2026-05-10';
const TIE_OUT = 'IVA-WP-CHARGED-VS-LEDGER';
const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

interface Book { f: Fixture; customerId: string; account: string }

let nextGl = 0;

/**
 * An entity on Mexican books with a bank account and its May and June statements; `key` answers a panel key.
 * Each case enters its tenant, because the panel is read in the tenant of the context and this file holds several.
 */
async function book(name: string, key?: [string, string]): Promise<Book> {
  const f = await crearInquilino(`MNE-001-586 ${name}`);
  await seedPolicies({ tenantId: f.tenantId });
  if (key) await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, key[0], key[1], 'it@example.test');
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Cheque Payer SA', 'MXN', $4)`,
    [customerId, f.entityId, `C-586-${customerId.slice(0, 6)}`, f.userId]
  );
  nextGl += 1;
  const glId = uuidv4();
  await query(
    `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id, currency_code, normal_balance, created_by)
     VALUES ($1, $2, 'Bank 586', 'asset', 'current_assets', $3, 'MXN', 'debit', $4)`,
    [glId, `1110-8${nextGl}`, f.entityId, f.userId]
  );
  const account = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1, $2, $3, 'Bank', $4, 'MXN', 'checking')`,
    [account, f.entityId, `Operating 586 ${name}`, glId]
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

/** Runs `receipt <argv> --json` in process as the binary would; its first row. */
async function leaf(b: Book, argv: string[]): Promise<Record<string, string>> {
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
    await program.parseAsync(['node', 'mnemosine', 'receipt', ...argv, '-e', b.f.entityId, '-t', b.f.tenantId, '-y', '--json']);
  } catch (e) {
    errors.push(e);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  if (errors.length > 0) throw new Error(`receipt ${argv.join(' ')} → ${exitCodeFor(errors[0])}: ${(errors[0] as Error).message}`);
  return (JSON.parse(out.join('')) as { rows: Record<string, string>[] }).rows[0];
}

/** An issued invoice of 1,000.00 plus 16 %, PPD unless `terms` says otherwise. */
async function invoice(b: Book, terms = 'PPD'): Promise<{ id: string; number: string }> {
  const draft = await createInvoice({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_date: ISSUED, due_date: ISSUED, currency_code: 'MXN', terms,
    lines: [{ revenue_account_id: b.f.cuentas['4100'], description: 'Synthetic fees', quantity: '1', unit_price: '1000.00', tax_rate: '16.0000' }],
    created_by: b.f.userId,
  });
  const { invoice: issued } = await issueInvoice(draft.id, b.f.userId, { entityId: b.f.entityId });
  return { id: issued.id, number: issued.invoice_number };
}

/** A cheque of `amount` received 2026-05-15 that collects `inv`; its IVA waits for the bank (MNE-001-556). */
const byCheck = (b: Book, inv: string, amount = '1160.00') =>
  recordCustomerPayment({
    entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: amount, paymentDate: '2026-05-15',
    paymentMethod: 'check', bankAccountId: b.account, checkNumber: 'CHQ-586',
    applications: [{ documentId: inv, amountApplied: amount }],
  }, b.f.userId);

const unapply = (b: Book, paymentId: string, invoiceId: string, date = '2026-05-31') =>
  unapplyCustomerPayment(b.f.entityId, paymentId, { invoiceId, reason: 'applied to the wrong sale', date }, b.f.userId);

/** The bank credit of `date` that cashes the cheque. */
async function cash(b: Book, receiptId: string, amount = '1160.00', date = '2026-06-01') {
  const credit = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
     VALUES ($1, $2, $3::date, $4, 'credit', 'synthetic deposit', false)`,
    [credit, b.account, date, amount]
  );
  return recordCustomerCheckCashing(b.f.entityId, receiptId, { transactionId: credit, userId: b.f.userId });
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

/** The credit balance of `code`, in the month given or overall, to two decimals. */
async function balance(b: Book, code: string, month?: number): Promise<string> {
  const r = await query<{ b: string }>(
    `SELECT COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::text AS b
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id AND je.entity_id = $1 AND je.status = 'posted'
       JOIN accounts a ON a.id = l.account_id AND a.code = $2
      WHERE $3::int IS NULL OR EXTRACT(MONTH FROM je.entry_date) = $3::int`,
    [b.f.entityId, code, month ?? null]
  );
  return Number(r.rows[0].b).toFixed(2);
}

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

const paper = (b: Book, month: number): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year: 2026, month });
const at16 = (wp: IvaWorkpaper) => [Number(wp.figures.charged.tasa16.base).toFixed(2), Number(wp.figures.charged.tasa16.iva).toFixed(2)];
const silent = (wp: IvaWorkpaper) => expect(wp.findings.map((h) => h.codigo)).not.toContain(TIE_OUT);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('a plain cheque unapplied before its cashing', () => {
  it('posts no IVA line and stores 160.0000; the cashing of 06-01 posts 2150 Dr 160.00 / 2120 Cr 160.00, and the ledger equals the paper', async () => {
    const b = await book('default');
    enterTenant(b.f.tenantId);
    const inv = await invoice(b);
    const r = await byCheck(b, inv.id);
    const pmt = r.paymentNumber;
    const done = await leaf(b, ['unapply', pmt, '--invoice', inv.number, '--reason', 'applied to the wrong sale', '--date', '2026-05-31']);
    expect(done).toMatchObject({ iva_reparked: '0.0000', iva_kept_caused: '0.0000', iva_at_cashing: '160.00' });
    expect(await linesOf(b, done.entry_number)).toEqual({ '1120': dr('1160'), '2150': cr('1160') });
    expect(await markers(b, r.paymentId)).toEqual(['160.0000']);

    const cashed = await cash(b, r.paymentId);
    expect(cashed).toMatchObject({ released: '160.0000', advanceIva: '160.0000' });
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2150': dr('160'), '2120': cr('160') });
    expect([await balance(b, '2120', 5), await balance(b, '2120', 6)]).toEqual(['0.00', '160.00']);
    expect([await balance(b, '2125'), await balance(b, '2150')]).toEqual(['160.00', '1000.00']);

    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual(['0.00', '0.00']);
    expect(at16(june)).toEqual(['1000.00', '160.00']);
    expect(june.ledger.iva_trasladado).toBe('-160.0000');
    silent(may);
    silent(june);
  }, 180_000);

  it('applied again after the cashing, it nets: 2150 Dr 1,000.00 / 2125 Dr 160.00 / 1120 Cr 1,160.00 with no 2120 line', async () => {
    const b = await book('again');
    enterTenant(b.f.tenantId);
    const inv = await invoice(b);
    const r = await byCheck(b, inv.id);
    await unapply(b, r.paymentId, inv.id);
    await cash(b, r.paymentId);
    const applied = await applyCustomerPayment(b.f.entityId, r.paymentId, [{ documentId: inv.id, amountApplied: '1160.00' }], b.f.userId, { date: '2026-06-05' });
    expect(await linesOf(b, applied.journalEntry!.id)).toEqual({ '2150': dr('1000'), '2125': dr('160'), '1120': cr('1160') });
    expect([await balance(b, '2120'), await balance(b, '2125'), await balance(b, '2150')]).toEqual(['160.00', '0.00', '0.00']);
    const june = await paper(b, 6);
    expect(at16(june)).toEqual(['1000.00', '160.00']);
    silent(june);
  }, 180_000);

  it('a partial cheque of 580.00 stores 80.0000, and the cashing posts 2150 Dr 80.00 / 2120 Cr 80.00', async () => {
    const b = await book('partial');
    enterTenant(b.f.tenantId);
    const inv = await invoice(b);
    const r = await byCheck(b, inv.id, '580.00');
    const undone = await unapply(b, r.paymentId, inv.id);
    expect([undone.ivaReAparcado, undone.ivaKeptCaused, undone.ivaAtCashing]).toEqual(['0.0000', '0.0000', '80.00']);
    expect(await markers(b, r.paymentId)).toEqual(['80.0000']);
    const cashed = await cash(b, r.paymentId, '580.00');
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2150': dr('80'), '2120': cr('80') });
    expect([await balance(b, '2120'), await balance(b, '2125'), await balance(b, '2150')]).toEqual(['80.00', '160.00', '500.00']);
  }, 180_000);

  it('under plain_receipt_unapply_iva = repark_same_month it is the same: nothing was caused to re-park', async () => {
    const b = await book('repark', ['plain_receipt_unapply_iva', 'repark_same_month']);
    enterTenant(b.f.tenantId);
    const inv = await invoice(b);
    const r = await byCheck(b, inv.id);
    const undone = await unapply(b, r.paymentId, inv.id, '2026-05-20');
    expect([undone.ivaReAparcado, undone.ivaKeptCaused, undone.keptBecause, undone.ivaAtCashing]).toEqual(['0.0000', '0.0000', null, '160.00']);
    expect(await linesOf(b, undone.journalEntry.id)).toEqual({ '1120': dr('1160'), '2150': cr('1160') });
    expect(await markers(b, r.paymentId)).toEqual(['160.0000']);
    const cashed = await cash(b, r.paymentId);
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2150': dr('160'), '2120': cr('160') });
  }, 180_000);
});

describe('applied again before the cashing', () => {
  it('is refused by default, naming the cashing, as a held cheque\'s advance is (cheque_advance_before_cashing = refuse)', async () => {
    const b = await book('refused');
    enterTenant(b.f.tenantId);
    const inv = await invoice(b);
    const r = await byCheck(b, inv.id);
    await unapply(b, r.paymentId, inv.id);
    const refused = await applyCustomerPayment(
      b.f.entityId, r.paymentId, [{ documentId: inv.id, amountApplied: '1160.00' }], b.f.userId, { date: '2026-05-31' }
    ).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'ADVANCE_BY_CHEQUE_NOT_CASHED' });
    expect((refused as Error).message).toContain('bank check reconcile --receipt');
  }, 180_000);

  it('under defer_to_cashing posts 2150 Dr 1,160.00 / 1120 Cr 1,160.00, and the cashing 2125 Dr 160.00 / 2120 Cr 160.00 with no 2150 line', async () => {
    const b = await book('deferred', ['cheque_advance_before_cashing', 'defer_to_cashing']);
    enterTenant(b.f.tenantId);
    const inv = await invoice(b);
    const r = await byCheck(b, inv.id);
    await unapply(b, r.paymentId, inv.id);
    const applied = await applyCustomerPayment(b.f.entityId, r.paymentId, [{ documentId: inv.id, amountApplied: '1160.00' }], b.f.userId, { date: '2026-05-31' });
    expect(await linesOf(b, applied.journalEntry!.id)).toEqual({ '2150': dr('1160'), '1120': cr('1160') });
    const cashed = await cash(b, r.paymentId);
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2125': dr('160'), '2120': cr('160') });
    expect([await balance(b, '2120'), await balance(b, '2125'), await balance(b, '2150')]).toEqual(['160.00', '0.00', '0.00']);
  }, 180_000);
});

describe('guards', () => {
  it('a PUE invoice parked nothing: no marker, and the cashing posts nothing', async () => {
    const b = await book('pue');
    enterTenant(b.f.tenantId);
    const inv = await invoice(b, 'PUE');
    const r = await byCheck(b, inv.id);
    const undone = await unapply(b, r.paymentId, inv.id);
    expect(undone.ivaAtCashing).toBe('0.00');
    expect(await markers(b, r.paymentId)).toEqual([null]);
    expect(await cash(b, r.paymentId)).toMatchObject({ released: '0.0000', entryId: null });
  }, 180_000);

  it('a credit note while the cheque waits restitutes nothing from 2120: the IVA of its cash on account is not caused yet', async () => {
    const b = await book('note');
    enterTenant(b.f.tenantId);
    const inv = await invoice(b);
    const r = await byCheck(b, inv.id);
    await unapply(b, r.paymentId, inv.id);
    const cn = await createCreditNote({
      entity_id: b.f.entityId, customer_id: b.customerId, invoice_id: inv.id, type: 'devolucion',
      credit_date: '2026-05-31', subtotal: '200.00', tax_amount: '32.00',
    }, b.f.userId);
    await issueCreditNote(b.f.entityId, cn.id, b.f.userId);
    const entry = (await query<{ id: string }>(
      'SELECT journal_entry_id AS id FROM credit_notes WHERE id = $1 AND entity_id = $2', [cn.id, b.f.entityId]
    )).rows[0].id;
    const lines = await linesOf(b, entry);
    expect(lines['2125']).toEqual(dr('32'));
    expect(lines['2120']).toBeUndefined();
    expect(lines['2150']).toBeUndefined();
  }, 180_000);
});
