import { describe, it, expect, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { recordCustomerPayment, applyCustomerPayment } from '../../src/services/payments/payment-service.js';
import { recordCustomerCheckCashing } from '../../src/services/banking/treasury-posting.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';

// ============================================================
// MNE-001-572 (#789, part 1/2) · A CUSTOMER ADVANCE RECEIVED BY CHEQUE IS NOT
// APPLIED AGAINST IVA NOBODY HAS CAUSED, AND THE EXCESS OF A CHEQUE
// COLLECTION CAUSES ITS IVA ON THE CASHING DAY.
//
// A price paid by cheque, and its IVA, is collected the day the bank cashes
// it (LIVA art. 1-B, second paragraph). Hand figures 1-17 of the plan (#789,
// comment 7013731567): 16 %, an entity on Mexican books, a cheque of
// 1,160.00 received 2026-05-30 and cashed by a bank credit of 2026-06-01.
// One entity per story; receipts and events go through the services, and
// only the bank's statements and lines are inserted, as the 507 spec does.
// ============================================================

const day = (month: number, d: number): string => `2026-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const TIE_OUT = 'IVA-WP-CHARGED-VS-LEDGER';
const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

interface Book { f: Fixture; customerId: string; account: string; gl: string }

let nextGl = 0;

async function book(name: string): Promise<Book> {
  const f = await crearInquilino(`MNE-001-572 ${name}`);
  await seedPolicies({ tenantId: f.tenantId });
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Cheque Advance SA', 'MXN', $4)`,
    [customerId, f.entityId, `C-572-${customerId.slice(0, 6)}`, f.userId]
  );
  nextGl += 1;
  const gl = `1110-8${nextGl}`;
  const glId = uuidv4();
  await query(
    `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id, currency_code, normal_balance, created_by)
     VALUES ($1, $2, 'Bank 572', 'asset', 'current_assets', $3, 'MXN', 'debit', $4)`,
    [glId, gl, f.entityId, f.userId]
  );
  const account = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1, $2, $3, 'Bank', $4, 'MXN', 'checking')`,
    [account, f.entityId, `Operating 572 ${name}`, glId]
  );
  for (const month of [5, 6]) {
    const end = new Date(Date.UTC(2026, month, 0)).getUTCDate();
    await query(
      `INSERT INTO bank_statements (entity_id, bank_account_id, period_start, period_end, opening_balance, closing_balance,
                                    currency_code, source_format, file_sha256, imported_by)
       VALUES ($1, $2, $3::date, $4::date, 0, 0, 'MXN', 'manual', $5, $6)`,
      [f.entityId, account, day(month, 1), day(month, end), uuidv4().replace(/-/g, '').padEnd(64, '0'), f.userId]
    );
  }
  return { f, customerId, account, gl };
}

/** An issued sale of one line; 'PPD' parks its IVA, null reads as PUE. */
async function invoice(b: Book, price: string, opts: { terms?: string | null; rate?: string; date?: string } = {}) {
  const date = opts.date ?? day(5, 31);
  const draft = await createInvoice({
    entity_id: b.f.entityId, customer_id: b.customerId, invoice_date: date, due_date: date,
    currency_code: 'MXN', terms: opts.terms ?? null,
    lines: [{ revenue_account_id: b.f.cuentas['4100'], description: 'Synthetic sale', quantity: '1', unit_price: price, tax_rate: opts.rate ?? '16.0000' }],
    created_by: b.f.userId,
  });
  const issued = (await issueInvoice(draft.id, b.f.userId, { entityId: b.f.entityId })).invoice;
  return { id: issued.id, number: issued.invoice_number };
}

/** The advance of the plan: a cheque of 1,160.00 at `treatment`, received 2026-05-30 with no invoice. */
const advance = (b: Book, treatment = '16') =>
  recordCustomerPayment({
    entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: '1160.00', paymentDate: day(5, 30),
    paymentMethod: 'check', bankAccountId: b.account, checkNumber: 'CHQ-572', onAccount: true,
    advanceTreatment: treatment, applications: [],
  }, b.f.userId);

/** A collection of 1,500.00 by cheque on 2026-05-30 that pays `invoiceId` and leaves 340.00 on account. */
const excess = (b: Book, invoiceId: string, treatment?: string) =>
  recordCustomerPayment({
    entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: '1500.00', paymentDate: day(5, 30),
    paymentMethod: 'check', bankAccountId: b.account, checkNumber: 'CHQ-572X', onAccount: true,
    ...(treatment !== undefined ? { advanceTreatment: treatment } : { advanceTreatmentFromInvoice: true }),
    applications: [{ documentId: invoiceId, amountApplied: '1160.00' }],
  }, b.f.userId);

/** The bank credit of 2026-06-01 that cashes the cheque, and its cashing entry. */
async function cash(b: Book, receiptId: string, amount = '1160.00') {
  const credit = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
     VALUES ($1, $2, $3::date, $4, 'credit', 'synthetic deposit', false)`,
    [credit, b.account, day(6, 1), amount]
  );
  return recordCustomerCheckCashing(b.f.entityId, receiptId, { transactionId: credit, userId: b.f.userId });
}

const apply = (b: Book, receiptId: string, invoiceId: string, date: string) =>
  applyCustomerPayment(b.f.entityId, receiptId, [{ documentId: invoiceId, amountApplied: '1160.00' }], b.f.userId, { date });

/** The lines of a posted entry by account code: [debit, credit]. */
async function linesOf(b: Book, entryId: string): Promise<Record<string, [number, number]>> {
  const r = await query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, COALESCE(SUM(l.debit_amount), 0)::text AS debit, COALESCE(SUM(l.credit_amount), 0)::text AS credit
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.entity_id = $1 AND je.id = $2 AND je.status = 'posted'
      GROUP BY a.code`,
    [b.f.entityId, entryId]
  );
  return Object.fromEntries(r.rows.map((l) => [l.code, [Number(l.debit), Number(l.credit)]]));
}

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

/** What a refusal must leave as it was: the receipt's allocations, the entity's entries, the invoice's balance. */
async function footprint(b: Book, receiptId: string, invoiceId: string): Promise<string> {
  const r = await query<{ allocations: string; entries: string; due: string }>(
    `SELECT (SELECT COUNT(*) FROM payment_allocations WHERE payment_id = $2)::text AS allocations,
            (SELECT COUNT(*) FROM journal_entries WHERE entity_id = $1)::text AS entries,
            (SELECT amount_due::text FROM invoices WHERE id = $3 AND entity_id = $1) AS due`,
    [b.f.entityId, receiptId, invoiceId]
  );
  return JSON.stringify(r.rows[0]);
}

const paper = (b: Book, month: number): Promise<IvaWorkpaper> =>
  buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year: 2026, month });
const at16 = (wp: IvaWorkpaper) => ({
  base: Number(wp.figures.charged.tasa16.base).toFixed(2),
  iva: Number(wp.figures.charged.tasa16.iva).toFixed(2),
});
const silent = (wp: IvaWorkpaper) => expect(wp.findings.map((h) => h.codigo)).not.toContain(TIE_OUT);

/** `receipt <argv> --json -y`, in process: its first row and what it wrote to stderr. */
async function receiptLeaf(b: Book, argv: string[]): Promise<{ row: Record<string, string>; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const errors: unknown[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerReceiptCommand(program, { palette: plain, shutdown: () => undefined, reportError: (e: unknown) => { errors.push(e); } });
    await program.parseAsync(['node', 'mnemosine', 'receipt', ...argv, '-e', b.f.entityId, '-t', b.f.tenantId, '--json', '-y']);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  if (errors.length > 0) {
    const e = errors[0] as Error;
    throw new Error(`receipt ${argv.join(' ')} → ${exitCodeFor(e)}: ${e.message}`);
  }
  return { row: (JSON.parse(out.join('')) as { rows: Record<string, string>[] }).rows[0], err: err.join('') };
}

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('figures 1-6 · an advance by cheque is not applied to a PPD invoice before its cashing', () => {
  it('is refused before the cashing, and after it 2120 carries the IVA once, in June', async () => {
    const b = await book('ppd');
    const receipt = await advance(b);
    expect(await linesOf(b, receipt.journalEntry!.id)).toEqual({ [b.gl]: [1160, 0], '2150': [0, 1160] });
    const inv = await invoice(b, '5000.00', { terms: 'PPD' });
    expect(await balance(b, '2125')).toBe('800.00');

    // 3 · refused, naming the receipt, the invoice, the IVA, the command and the key; nothing is written.
    const before = await footprint(b, receipt.paymentId, inv.id);
    const refused = await apply(b, receipt.paymentId, inv.id, day(5, 31)).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'ADVANCE_BY_CHEQUE_NOT_CASHED' });
    const message = (refused as Error).message;
    for (const part of [receipt.paymentNumber, inv.number, '160.00', `mnemosine bank check reconcile --receipt ${receipt.paymentNumber}`, 'cheque_advance_before_cashing']) {
      expect(message).toContain(part);
    }
    expect(await footprint(b, receipt.paymentId, inv.id)).toBe(before);

    // 4 · the cashing causes the advance's IVA.
    const cashed = await cash(b, receipt.paymentId);
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2150': [160, 0], '2120': [0, 160] });

    // 5 · applied after it: g = 800 × 1,160 / 5,800 = 160.00 = c, so no 2120 line.
    const applied = await apply(b, receipt.paymentId, inv.id, day(6, 2));
    expect(await linesOf(b, applied.journalEntry!.id)).toEqual({ '2150': [1000, 0], '2125': [160, 0], '1120': [0, 1160] });

    // 6 · the ledger and the paper agree in both months.
    expect([await balance(b, '2120', 5), await balance(b, '2120', 6)]).toEqual(['0.00', '160.00']);
    expect([await balance(b, '2125'), await balance(b, '2150')]).toEqual(['640.00', '0.00']);
    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may)).toEqual({ base: '0.00', iva: '0.00' });
    expect(at16(june)).toEqual({ base: '1000.00', iva: '160.00' });
    silent(may);
    silent(june);
  }, 180_000);
});

describe('figures 7-10 · a PUE invoice at the receipt\'s own treatment is applied before the cashing', () => {
  it('cancels the invoice\'s IVA in May, and the cashing causes the advance\'s in June', async () => {
    const b = await book('pue same');
    const receipt = await advance(b);
    const inv = await invoice(b, '1000.00');
    expect(await balance(b, '2120', 5)).toBe('160.00');
    const applied = await apply(b, receipt.paymentId, inv.id, day(5, 31));
    expect(await linesOf(b, applied.journalEntry!.id)).toEqual({ '2150': [1000, 0], '2120': [160, 0], '1120': [0, 1160] });
    const cashed = await cash(b, receipt.paymentId);
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2150': [160, 0], '2120': [0, 160] });
    expect([await balance(b, '2120', 5), await balance(b, '2120', 6), await balance(b, '2150')]).toEqual(['0.00', '160.00', '0.00']);
  }, 180_000);
});

describe('figure 11 · a PUE invoice at another treatment', () => {
  it('is refused before the cashing; under defer_to_cashing it is refused as not wired, naming part 2', async () => {
    const b = await book('pue zero');
    // The panel is read in the tenant of the context, as the binary sets it: this file holds several.
    enterTenant(b.f.tenantId);
    const receipt = await advance(b);
    const inv = await invoice(b, '1160.00', { rate: '0.0000' });
    const before = await footprint(b, receipt.paymentId, inv.id);
    await expect(apply(b, receipt.paymentId, inv.id, day(5, 31))).rejects.toMatchObject({ code: 'ADVANCE_BY_CHEQUE_NOT_CASHED' });

    await resolvePolicy({ tenantId: b.f.tenantId, entityId: b.f.entityId }, 'cheque_advance_before_cashing', 'defer_to_cashing', 'it@example.test');
    const deferred = await apply(b, receipt.paymentId, inv.id, day(5, 31)).catch((e: unknown) => e);
    expect(deferred).toMatchObject({ code: 'CHEQUE_ADVANCE_DEFERRAL_NOT_WIRED' });
    expect((deferred as Error).message).toContain('2/2');
    expect(await footprint(b, receipt.paymentId, inv.id)).toBe(before);
  }, 180_000);

  it('an advance at 0 % carries no IVA to cancel, so it is applied before the cashing', async () => {
    const b = await book('zero advance');
    const receipt = await advance(b, '0');
    const inv = await invoice(b, '5000.00', { terms: 'PPD' });
    const applied = await apply(b, receipt.paymentId, inv.id, day(5, 31));
    expect(await linesOf(b, applied.journalEntry!.id)).toEqual({ '2150': [1160, 0], '1120': [0, 1160] });
  }, 180_000);
});

describe('figures 12-14 · the excess of a cheque collection causes its IVA on the cashing day', () => {
  it('12-13 · it keeps 16.00 / 293.10 / 46.90, and the cashing moves 2125 Dr 160.00 / 2150 Dr 46.90 / 2120 Cr 206.90', async () => {
    const b = await book('excess');
    const inv = await invoice(b, '1000.00', { terms: 'PPD', date: day(5, 20) });
    const receipt = await excess(b, inv.id);
    expect(receipt.advance).toMatchObject({ treatment: '16', base: '293.10', iva: '46.90' });
    expect(await linesOf(b, receipt.journalEntry!.id)).toEqual({ [b.gl]: [1500, 0], '1120': [0, 1160], '2150': [0, 340] });
    const stored = await query<{ s: string }>(
      `SELECT concat_ws('/', advance_tax_rate, advance_base_amount, advance_iva_amount) AS s FROM customer_payments WHERE id = $1`,
      [receipt.paymentId]
    );
    expect(stored.rows[0].s).toBe('16.00/293.1000/46.9000');
    const cashed = await cash(b, receipt.paymentId, '1500.00');
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2125': [160, 0], '2150': [46.9, 0], '2120': [0, 206.9] });
    expect([await balance(b, '2120', 6), await balance(b, '2150')]).toEqual(['206.90', '293.10']);
    expect(at16(await paper(b, 6)).iva).toBe('206.90');
  }, 180_000);

  it('14 · with --tax-rate 0 it keeps 0 % / 340.00 / 0.00, and the cashing moves only the 160.00 of 2125', async () => {
    const b = await book('excess zero');
    const inv = await invoice(b, '1000.00', { terms: 'PPD', date: day(5, 20) });
    const receipt = await excess(b, inv.id, '0');
    expect(receipt.advance).toMatchObject({ treatment: '0', base: '340.00', iva: '0.00' });
    const cashed = await cash(b, receipt.paymentId, '1500.00');
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2125': [160, 0], '2120': [0, 160] });
  }, 180_000);
});

describe('figures 15-17 · the excess receipt\'s cash unapplied', () => {
  it('15 · before the cashing it goes back whole to 2150, and the cashing causes 206.90 then', async () => {
    const b = await book('unapply before');
    const inv = await invoice(b, '1000.00', { terms: 'PPD', date: day(5, 20) });
    const receipt = await excess(b, inv.id);
    const undone = await receiptLeaf(b, ['unapply', receipt.paymentNumber, '--invoice', inv.number, '--reason', 'wrong invoice', '--date', day(5, 31)]);
    expect(undone.row).toMatchObject({ iva_reparked: '0.0000', advance_iva_restored: '0.00', iva_at_cashing: '160.00' });
    expect(undone.err).toContain('160.00');
    const entry = await query<{ id: string }>('SELECT id FROM journal_entries WHERE entity_id = $1 AND entry_number = $2', [b.f.entityId, undone.row.entry_number]);
    expect(await linesOf(b, entry.rows[0].id)).toEqual({ '1120': [1160, 0], '2150': [0, 1160] });

    const cashed = await cash(b, receipt.paymentId, '1500.00');
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2150': [206.9, 0], '2120': [0, 206.9] });
    expect([await balance(b, '2150'), await balance(b, '2125')]).toEqual(['1293.10', '160.00']);
    expect([await balance(b, '2120', 5), await balance(b, '2120', 6)]).toEqual(['0.00', '206.90']);
    const [may, june] = [await paper(b, 5), await paper(b, 6)];
    expect(at16(may).iva).toBe('0.00');
    expect(at16(june).iva).toBe('206.90');
    silent(may);
    silent(june);
  }, 180_000);

  it('16 · on a PUE invoice the same two entries, and 2120 reads May 160.00 and June 206.90', async () => {
    const b = await book('unapply pue');
    const inv = await invoice(b, '1000.00', { date: day(5, 20) });
    const receipt = await excess(b, inv.id);
    const undone = await receiptLeaf(b, ['unapply', receipt.paymentNumber, '--invoice', inv.number, '--reason', 'wrong invoice', '--date', day(5, 31)]);
    const entry = await query<{ id: string }>('SELECT id FROM journal_entries WHERE entity_id = $1 AND entry_number = $2', [b.f.entityId, undone.row.entry_number]);
    expect(await linesOf(b, entry.rows[0].id)).toEqual({ '1120': [1160, 0], '2150': [0, 1160] });
    const cashed = await cash(b, receipt.paymentId, '1500.00');
    expect(await linesOf(b, cashed.entryId!)).toEqual({ '2150': [206.9, 0], '2120': [0, 206.9] });
    expect([await balance(b, '2120', 5), await balance(b, '2120', 6)]).toEqual(['160.00', '206.90']);
  }, 180_000);

  it('17 · after the cashing it is 462\'s: 2150 Cr 1,000.00 / 2125 Cr 160.00 and no 2120 line', async () => {
    const b = await book('unapply after');
    const inv = await invoice(b, '1000.00', { terms: 'PPD', date: day(5, 20) });
    const receipt = await excess(b, inv.id);
    await cash(b, receipt.paymentId, '1500.00');
    const undone = await receiptLeaf(b, ['unapply', receipt.paymentNumber, '--invoice', inv.number, '--reason', 'wrong invoice', '--date', day(6, 2)]);
    expect(undone.row).toMatchObject({ iva_at_cashing: '0.00' });
    const entry = await query<{ id: string }>('SELECT id FROM journal_entries WHERE entity_id = $1 AND entry_number = $2', [b.f.entityId, undone.row.entry_number]);
    expect(await linesOf(b, entry.rows[0].id)).toEqual({ '1120': [1160, 0], '2150': [0, 1000], '2125': [0, 160] });
  }, 180_000);
});
