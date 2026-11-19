import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { softClosePeriod, hardClosePeriod } from '../../src/services/accounting/period-close.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment, applyCustomerPayment, reverseCustomerPayment, type EntradaPago,
} from '../../src/services/payments/payment-service.js';
import { recordCustomerCheckCashing, CUSTOMER_CHECK_CASHING_SOURCE } from '../../src/services/banking/treasury-posting.js';
import { Command } from 'commander';
import { registerBankCommand } from '../../src/cli/bank-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-458 (#623, part 1/8) · A CUSTOMER ADVANCE IN THE LEDGER.
 *
 * An advance with no invoice causes its IVA the day it is collected (LIVA
 * art. 1-B; NIF D-1): bank Dr · 2150 Cr for the base · 2120 Cr for the IVA,
 * and the receipt keeps the treatment it was recorded with. Every figure
 * below is computed by hand.
 */

let mx: Fixture;
let us: Fixture;
let customerId: string;

async function newCustomer(f: Fixture, currency: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Advance Payer SA', $4, $5)`,
    [id, f.entityId, `C-458-${id.slice(0, 6)}`, currency, f.userId]
  );
  return id;
}

function advance(amount: string, treatment?: string, extra: Partial<EntradaPago> = {}): EntradaPago {
  return {
    entityId: mx.entityId, counterpartyId: customerId, paymentAmount: amount, paymentDate: '2026-08-15',
    paymentMethod: 'spei', applications: [], onAccount: true,
    ...(treatment === undefined ? {} : { advanceTreatment: treatment }),
    ...extra,
  };
}

/** The entry's lines by account id: [debit, credit]. */
async function linesOf(entryId: string): Promise<Record<string, [number, number]>> {
  const r = await query<{ account_id: string; debit: string; credit: string }>(
    `SELECT account_id, COALESCE(SUM(debit_amount), 0)::text AS debit, COALESCE(SUM(credit_amount), 0)::text AS credit
       FROM journal_entry_lines WHERE journal_entry_id = $1 GROUP BY account_id`,
    [entryId]
  );
  return Object.fromEntries(r.rows.map((l) => [l.account_id, [Number(l.debit), Number(l.credit)]]));
}

/** Runs one `bank` leaf in-process, as the binary would; returns what it printed. */
async function bankLeaf(argv: string[]): Promise<string> {
  const plain = Object.fromEntries(['dim', 'bold', 'cyan', 'red', 'green', 'yellow'].map((c) => [c, (x: string) => x]));
  const out: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  try {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerBankCommand(program, { palette: plain as never, shutdown: () => undefined, reportError: (e: unknown) => { throw e; } });
    await program.parseAsync(['node', 'mnemosine', 'bank', ...argv, '-e', mx.entityId, '-t', mx.tenantId]);
  } finally {
    process.stdout.write = stdout;
  }
  return out.join('');
}

/** Posted balances (debit − credit) of bank, 2150 and 2120. */
async function balances(): Promise<number[]> {
  const r = await query<{ account_id: string; b: string }>(
    `SELECT l.account_id, SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))::text AS b
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id AND je.status = 'posted'
      WHERE je.entity_id = $1 GROUP BY l.account_id`,
    [mx.entityId]
  );
  const by = new Map(r.rows.map((x) => [x.account_id, Number(x.b)]));
  return ['1111', '2150', '2120'].map((code) => by.get(mx.cuentas[code]) ?? 0);
}

async function stored(paymentId: string) {
  const r = await query(
    `SELECT advance_factor_type AS type, advance_tax_rate::text AS rate,
            advance_base_amount::text AS base, advance_iva_amount::text AS iva
       FROM customer_payments WHERE id = $1 AND entity_id = $2`,
    [paymentId, mx.entityId]
  );
  return r.rows[0];
}

/** A sale of 5,000.00 plus 16 % IVA, issued and posted. */
async function saleInvoice(): Promise<string> {
  const draft = await createInvoice({
    entity_id: mx.entityId, customer_id: customerId, invoice_date: '2026-08-20', due_date: '2026-08-20',
    currency_code: 'MXN', terms: null, created_by: mx.userId,
    lines: [{ revenue_account_id: mx.cuentas['4100'], description: 'Sale', quantity: '1', unit_price: '5000.00', tax_rate: '16.0000' }],
  });
  return (await issueInvoice(draft.id, mx.userId, { entityId: mx.entityId })).invoice.id;
}

async function count(table: 'customer_payments' | 'payment_allocations', f: Fixture = mx): Promise<number> {
  const sql = table === 'customer_payments'
    ? 'SELECT COUNT(*)::text AS n FROM customer_payments WHERE entity_id = $1'
    : `SELECT COUNT(*)::text AS n FROM payment_allocations a
         JOIN customer_payments p ON p.id = a.payment_id WHERE p.entity_id = $1`;
  return Number((await query<{ n: string }>(sql, [f.entityId])).rows[0].n);
}

/** The receipt is refused with `match`, and no receipt is written. */
async function refused(input: EntradaPago, f: Fixture, match: object): Promise<void> {
  const before = await count('customer_payments', f);
  await expect(recordCustomerPayment(input, f.userId)).rejects.toMatchObject(match);
  expect(await count('customer_payments', f)).toBe(before);
}

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-458 advance MX');
  us = await crearInquilino('MNE-001-458 advance US', { pais: 'US' });
  customerId = await newCustomer(mx, 'MXN');
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('a customer advance recorded with its treatment', () => {
  let paymentId: string;

  it('posts 1,160.00 at 16 % as bank 1,160.00 / 2150 1,000.00 / 2120 160.00 and keeps what was stated', async () => {
    const r = await recordCustomerPayment(advance('1160.00', '16'), mx.userId);
    paymentId = r.paymentId;
    expect(r.advance).toEqual({ treatment: '16', factorType: 'tasa', taxRate: '16.00', base: '1000.00', iva: '160.00' });
    // Three lines and no other: no revenue account moves.
    expect(await linesOf(r.journalEntry!.id)).toEqual({
      [mx.cuentas['1111']]: [1160, 0], [mx.cuentas['2150']]: [0, 1000], [mx.cuentas['2120']]: [0, 160],
    });
    expect(await stored(paymentId)).toEqual({ type: 'tasa', rate: '16.00', base: '1000.0000', iva: '160.0000' });
    expect(await count('payment_allocations')).toBe(0);
  });

  it('refuses to apply it until part 5/8, and writes nothing', async () => {
    const invoiceId = await saleInvoice();
    await expect(
      applyCustomerPayment(mx.entityId, paymentId, [{ documentId: invoiceId, amountApplied: '1160.00' }], mx.userId)
    ).rejects.toMatchObject({ code: 'ADVANCE_APPLICATION_NOT_WIRED', messageKey: { key: 'receipt.advance.application_not_wired' } });
    expect(await count('payment_allocations')).toBe(0);
    const inv = await query<{ due: string }>('SELECT amount_due::text AS due FROM invoices WHERE id = $1', [invoiceId]);
    expect(Number(inv.rows[0].due)).toBe(5800);
  });

  it('is undone by receipt reverse with one mirror: bank, 2150 and 2120 hold what they held', async () => {
    const before = await balances();
    const r = await recordCustomerPayment(advance('1160.00', '16'), mx.userId);
    expect(await balances()).toEqual([before[0] + 1160, before[1] - 1000, before[2] - 160]);
    await reverseCustomerPayment(mx.entityId, r.paymentId, { reason: 'Returned transfer' }, mx.userId);
    expect(await balances()).toEqual(before);
  });

  it('takes the base as the cash over 1 + rate, rounded half up to the cent, and the IVA as the difference', async () => {
    // 1,000.00 / 1.16 = 862.0689… → 862.07; 1,000.00 − 862.07 = 137.93.
    const a = await recordCustomerPayment(advance('1000.00', '16'), mx.userId);
    expect(await linesOf(a.journalEntry!.id)).toEqual({
      [mx.cuentas['1111']]: [1000, 0], [mx.cuentas['2150']]: [0, 862.07], [mx.cuentas['2120']]: [0, 137.93],
    });
    // 1,080.00 / 1.08 = 1,000.00.
    const b = await recordCustomerPayment(advance('1080.00', '8'), mx.userId);
    expect(b.advance).toMatchObject({ factorType: 'tasa', taxRate: '8.00', base: '1000.00', iva: '80.00' });
    expect(await linesOf(b.journalEntry!.id)).toEqual({
      [mx.cuentas['1111']]: [1080, 0], [mx.cuentas['2150']]: [0, 1000], [mx.cuentas['2120']]: [0, 80],
    });
  });

  it.each([
    ['0', { type: 'tasa', rate: '0.00', base: '500.0000', iva: '0.0000' }],
    ['exempt', { type: 'exento', rate: null, base: '500.0000', iva: '0.0000' }],
    ['not-subject', { type: 'no_objeto', rate: null, base: '500.0000', iva: '0.0000' }],
  ])('at %s the whole amount goes to 2150 with no IVA line, and the receipt keeps the treatment', async (treatment, kept) => {
    const r = await recordCustomerPayment(advance('500.00', treatment), mx.userId);
    expect(await linesOf(r.journalEntry!.id)).toEqual({ [mx.cuentas['1111']]: [500, 0], [mx.cuentas['2150']]: [0, 500] });
    expect(await stored(r.paymentId)).toEqual(kept);
  });

  it('with no treatment the service records cash on account as before', async () => {
    const r = await recordCustomerPayment(advance('340.00'), mx.userId);
    expect(r.advance).toBeNull();
    expect(await linesOf(r.journalEntry!.id)).toEqual({ [mx.cuentas['1111']]: [340, 0], [mx.cuentas['2150']]: [0, 340] });
    expect(await stored(r.paymentId)).toEqual({ type: null, rate: null, base: null, iva: null });
  });
});

/**
 * MNE-001-558 (#700, part 4/4; #623, comment 6961035083) · T14. A price paid
 * by cheque, and its IVA, is paid the day the bank cashes it (LIVA art. 1-B,
 * second paragraph), which governs over the advance's day of receipt.
 */
describe('an advance received by cheque causes its IVA the day the bank cashes it', () => {
  it('credits 2150 whole on the receipt, posts DR 2150 / CR 2120 160.00 on the cashing day, and reverses to nothing', async () => {
    const account = uuidv4();
    await query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
       VALUES ($1, $2, 'Cheques 558', 'Bank', $3, 'MXN', 'checking')`,
      [account, mx.entityId, mx.cuentas['1111']]
    );
    const before = await balances();

    const r = await recordCustomerPayment(
      advance('1160.00', '16', { paymentMethod: 'check', bankAccountId: account, checkNumber: '558001' }), mx.userId
    );
    // The receipt keeps what was stated; its entry causes no IVA.
    expect(r.advance).toMatchObject({ factorType: 'tasa', base: '1000.00', iva: '160.00' });
    expect(await stored(r.paymentId)).toEqual({ type: 'tasa', rate: '16.00', base: '1000.0000', iva: '160.0000' });
    expect(await linesOf(r.journalEntry!.id)).toEqual({ [mx.cuentas['1111']]: [1160, 0], [mx.cuentas['2150']]: [0, 1160] });
    expect(await balances()).toEqual([before[0] + 1160, before[1] - 1160, before[2]]);

    const credit = uuidv4();
    await query(
      `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
       VALUES ($1, $2, '2026-09-03', 1160.00, 'credit', 'synthetic cheque deposit', false)`,
      [credit, account]
    );
    // The preview names the line from 2150, and the dry run writes nothing.
    const preview = await bankLeaf(['check', 'reconcile', '--receipt', r.paymentNumber, '--dry-run']);
    expect(preview).toMatch(new RegExp(`anticipo_clientes · ${r.paymentNumber}\\s+160\\.0000`));
    expect(preview).toMatch(new RegExp(`iva_trasladado · ${r.paymentNumber}\\s+.*160\\.0000`));
    expect(await balances()).toEqual([before[0] + 1160, before[1] - 1160, before[2]]);

    const cashed = await recordCustomerCheckCashing(mx.entityId, r.paymentId, { userId: mx.userId });
    expect(cashed).toMatchObject({
      transaction: { id: credit }, cashedOn: '2026-09-03', released: '160.0000', advanceIva: '160.0000', iepsReleased: '0.0000', byInvoice: [], note: null,
    });
    const entry = await query<{ date: string; period: string }>(
      `SELECT entry_date::text AS date, fiscal_period_id AS period FROM journal_entries
        WHERE id = $1 AND entity_id = $2 AND source_type = $3 AND source_id = $4`,
      [cashed.entryId, mx.entityId, CUSTOMER_CHECK_CASHING_SOURCE, r.paymentId]
    );
    expect(entry.rows).toEqual([{ date: '2026-09-03', period: mx.periodos[9] }]);
    expect(await linesOf(cashed.entryId!)).toEqual({ [mx.cuentas['2150']]: [160, 0], [mx.cuentas['2120']]: [0, 160] });
    expect(await balances()).toEqual([before[0] + 1160, before[1] - 1000, before[2] - 160]);

    // The reversal mirrors the receipt's entry and the cashing's.
    await reverseCustomerPayment(mx.entityId, r.paymentId, { reason: 'Cheque returned' }, mx.userId);
    expect(await balances()).toEqual(before);
  });
});

describe('what a stated treatment is refused for, with nothing written', () => {
  it('a treatment outside 16, 8, 0, exempt and not-subject', async () => {
    await refused(advance('1160.00', '17'), mx, { messageKey: { key: 'receipt.advance.treatment_unknown' } });
  });

  it('a treatment on a receipt that names an invoice (the excess is part 8/8)', async () => {
    const applications = [{ documentId: await saleInvoice(), amountApplied: '100.00' }];
    await refused(advance('1160.00', '16', { applications }), mx, { messageKey: { key: 'receipt.advance.only_without_invoice' } });
  });

  it('an entity that does not keep Mexican books: it posts as before and takes no treatment', async () => {
    const input: EntradaPago = {
      entityId: us.entityId, counterpartyId: await newCustomer(us, 'USD'), paymentAmount: '1160.00',
      paymentDate: '2026-08-15', paymentMethod: 'ach', applications: [], onAccount: true,
    };
    const r = await recordCustomerPayment(input, us.userId);
    expect(await linesOf(r.journalEntry!.id)).toEqual({
      [us.roles.banco]: [1160, 0], [us.roles.anticipo_clientes]: [0, 1160],
    });
    await refused({ ...input, advanceTreatment: '16' }, us, { messageKey: { key: 'receipt.advance.not_mexican_books' } });
  });

  it('a customer in another currency (T23)', async () => {
    const usdCustomer = await newCustomer(mx, 'USD');
    await refused(advance('1160.00', '16', { counterpartyId: usdCustomer }), mx, {
      message: expect.stringContaining('fuente_tipo_cambio'),
    });
  });

  it('a date in a hard-closed period', async () => {
    await softClosePeriod(mx.periodos[1], mx.entityId, mx.userId);
    await hardClosePeriod(mx.periodos[1], mx.entityId, mx.userId);
    await refused(advance('1160.00', '16', { paymentDate: '2026-01-15' }), mx, { code: 'PERIOD_CLOSED' });
  });
});

describe('the coherence CHECK of the migration', () => {
  it.each([
    ['a rate with no factor type', `advance_tax_rate = 16`],
    ['a rate on an exempt advance', `advance_factor_type = 'exento', advance_tax_rate = 16, advance_base_amount = 340, advance_iva_amount = 0`],
    ['IVA on an exempt advance', `advance_factor_type = 'exento', advance_base_amount = 300, advance_iva_amount = 40`],
    ['a rate treatment with no rate', `advance_factor_type = 'tasa', advance_base_amount = 300, advance_iva_amount = 40`],
    ['a factor type the column does not know', `advance_factor_type = 'cuota', advance_base_amount = 340, advance_iva_amount = 0`],
    ['a negative base', `advance_factor_type = 'no_objeto', advance_base_amount = -1, advance_iva_amount = 0`],
  ])('refuses %s', async (_name, assignment) => {
    const r = await recordCustomerPayment(advance('340.00'), mx.userId);
    await expect(
      query(`UPDATE customer_payments SET ${assignment} WHERE id = $1 AND entity_id = $2 AND status = 'completed'`,
        [r.paymentId, mx.entityId])
    ).rejects.toThrow(/customer_payments_advance_treatment_coherent/);
  });
});
