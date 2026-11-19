import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { Command } from 'commander';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment, reverseCustomerPayment, applyCustomerPayment, unapplyCustomerPayment, getCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import {
  recordCustomerCheckCashing, CUSTOMER_CHECK_CASHING_SOURCE,
} from '../../src/services/banking/treasury-posting.js';
import { ValidationError } from '../../src/utils/errors.js';
import { registerBankCommand } from '../../src/cli/bank-command.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-506 (#700, part 1/4) · A CUSTOMER CHEQUE KEEPS THE DAY THE BANK CASHED IT.
 *
 * The receipt holds the bank credit that paid the cheque and that credit's
 * date, together. A cheque posted before the hold (part 2, below) had its
 * IVA released by its own entry, so its cashing posts none.
 * Receipts go through the service; only the bank lines are inserted.
 */

let mx: Fixture;
let sister: Fixture;
let customerId: string;
let account: string;
let nextGl = 0;

async function bankAccount(f: Fixture, name: string, currency = 'MXN'): Promise<string> {
  nextGl += 1;
  const gl = uuidv4();
  await query(
    `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id, currency_code, normal_balance, created_by)
     VALUES ($1, $2, $3, 'asset', 'current_assets', $4, $5, 'debit', $6)`,
    [gl, `1110-5${nextGl}`, `Bank ${name}`, f.entityId, currency, f.userId]
  );
  const id = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1, $2, $3, 'Bank', $4, $5, 'checking')`,
    [id, f.entityId, name, gl, currency]
  );
  return id;
}

/** A line of the bank statement. */
async function bankLine(inAccount: string, date: string, amount: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
     VALUES ($1, $2, $3::date, $4, $5, 'synthetic deposit', false)`,
    [id, inAccount, date, amount, amount.startsWith('-') ? 'debit' : 'credit']
  );
  return id;
}

/** A new PPD invoice of 1,000.00 + 160.00. */
async function invoice(): Promise<string> {
  const draft = await createInvoice({
    entity_id: mx.entityId, customer_id: customerId, invoice_date: '2026-05-10', due_date: '2026-05-10',
    currency_code: 'MXN', terms: 'PPD', created_by: mx.userId,
    lines: [{ revenue_account_id: mx.cuentas['4100'], description: 'Sale', quantity: '1', unit_price: '1000.00', tax_rate: '16.0000' }],
  });
  return (await issueInvoice(draft.id, mx.userId, { entityId: mx.entityId })).invoice.id;
}

/** A receipt of 2026-05-30 through the service; with no invoice its cash stays on account. */
async function pay(
  invoiceId: string | null, method = 'check', amount = '1160.00', bankAccountId: string | null = account
): Promise<{ id: string; entryId: string }> {
  const r = await recordCustomerPayment({
    entityId: mx.entityId, counterpartyId: customerId, paymentAmount: amount, paymentDate: '2026-05-30',
    paymentMethod: method, bankAccountId,
    applications: invoiceId ? [{ documentId: invoiceId, amountApplied: amount }] : [],
    onAccount: invoiceId === null,
  }, mx.userId);
  return { id: r.paymentId, entryId: r.journalEntry?.id as string };
}

/** A receipt of 1,160.00 by `method` that settles one new PPD invoice. */
async function receipt(method = 'check', bankAccountId: string | null = account): Promise<{ id: string; invoiceId: string; entryId: string }> {
  const invoiceId = await invoice();
  return { ...(await pay(invoiceId, method, '1160.00', bankAccountId)), invoiceId };
}

/** A cheque posted before the hold existed: its own entry released the IVA on the receipt's day. */
async function checkOfBefore(): Promise<{ id: string; invoiceId: string }> {
  const r = await receipt('spei');
  await query(`UPDATE customer_payments SET payment_method = 'check' WHERE id = $1`, [r.id]);
  return r;
}

const NAMED = ['cxc', 'anticipo_clientes', 'iva_trasladado_no_cobrado', 'iva_trasladado'];
const PENDING = (amount: string) => ({ account: 'iva_trasladado_no_cobrado', debit: amount, credit: null });
const DUE = (amount: string) => ({ account: 'iva_trasladado', debit: null, credit: amount });

/** An entry's lines, each account by its role; the one with none of these roles is the bank's. */
async function linesOf(entryId: string) {
  const r = await query<{ account_id: string; debit: string | null; credit: string | null }>(
    `SELECT l.account_id, l.debit_amount::text AS debit, l.credit_amount::text AS credit
       FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
      WHERE je.id = $1 AND je.entity_id = $2 ORDER BY l.line_number`,
    [entryId, mx.entityId]
  );
  return r.rows.map((l) => ({
    account: NAMED.find((role) => mx.roles[role] === l.account_id) ?? 'bank', debit: l.debit, credit: l.credit,
  }));
}

/** What the entity's posted ledger holds in 2125 (pending) and 2120 (due). */
async function iva(): Promise<{ pending: number; due: number }> {
  const r = await query<{ account_id: string; balance: string }>(
    `SELECT l.account_id, SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0))::text AS balance
       FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND l.account_id = ANY($2::uuid[])
      GROUP BY l.account_id`,
    [mx.entityId, [mx.roles.iva_trasladado_no_cobrado, mx.roles.iva_trasladado]]
  );
  const of = (role: string) => Number(r.rows.find((x) => x.account_id === mx.roles[role])?.balance ?? 0);
  return { pending: of('iva_trasladado_no_cobrado'), due: of('iva_trasladado') };
}

async function stored(paymentId: string): Promise<(string | null)[]> {
  const r = await query<{ iva: string | null }>(
    'SELECT iva_reclass_amount::text AS iva FROM payment_allocations WHERE payment_id = $1 AND unapplied_at IS NULL ORDER BY created_at', [paymentId]
  );
  return r.rows.map((x) => x.iva);
}

async function cashing(id: string): Promise<{ date: string | null; tx: string | null }> {
  const r = await query<{ date: string | null; tx: string | null }>(
    'SELECT check_cashed_date::text AS date, check_cashed_tx_id AS tx FROM customer_payments WHERE id = $1', [id]
  );
  return r.rows[0];
}

async function cashingEntries(id: string) {
  const r = await query<{ id: string; date: string; period: string; lines: { role: string; debit: string | null; credit: string | null }[] }>(
    `SELECT je.id, je.entry_date::text AS date, je.fiscal_period_id AS period,
            (SELECT json_agg(json_build_object('role', ar.role, 'debit', l.debit_amount::text, 'credit', l.credit_amount::text)
                             ORDER BY l.line_number)
               FROM journal_entry_lines l
               JOIN account_roles ar ON ar.account_id = l.account_id AND ar.entity_id = je.entity_id AND ar.qualifier IS NULL
              WHERE l.journal_entry_id = je.id) AS lines
       FROM journal_entries je
      WHERE je.entity_id = $1 AND je.source_type = $2 AND je.source_id = $3`,
    [mx.entityId, CUSTOMER_CHECK_CASHING_SOURCE, id]
  );
  return r.rows;
}

const record = (id: string, transactionId: string | undefined, f: Fixture = mx, dryRun = false) =>
  recordCustomerCheckCashing(f.entityId, id, { transactionId, userId: f.userId, dryRun });

/** Refused with `key`, and the receipt still holds no cashing. */
async function refused(id: string, transactionId: string, key: string): Promise<void> {
  const error = await record(id, transactionId).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as ValidationError).messageKey?.key).toBe(`bank.check.cashing.refused.${key}`);
  expect(await cashing(id)).toEqual({ date: null, tx: null });
  expect(await cashingEntries(id)).toEqual([]);
}

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-506 cheque cashing MX');
  sister = await crearEntidadHermana(mx, 'MNE-001-506 sister');
  account = await bankAccount(mx, 'Operating 506');
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic Cheque Payer SA', 'MXN', $4)`,
    [customerId, mx.entityId, `C-506-${customerId.slice(0, 6)}`, mx.userId]
  );
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('a customer cheque keeps the day the bank cashed it', () => {
  it('T1 · a cheque whose receipt already released its IVA: the credit and its date are kept together, and no entry is posted', async () => {
    const { id } = await checkOfBefore();
    const credit = await bankLine(account, '2026-06-01', '1160.00');

    const rehearsal = await record(id, credit, mx, true);
    expect(rehearsal).toMatchObject({ dryRun: true, cashedOn: '2026-06-01', entryId: null });
    expect(await cashing(id)).toEqual({ date: null, tx: null });

    const r = await record(id, credit);
    expect(r).toMatchObject({
      receiptId: id, cashedOn: '2026-06-01', released: '0.0000', byInvoice: [], entryId: null, entryNumber: null,
      note: 'bank.check.cashing.note.already_released', dryRun: false,
    });
    expect(r.transaction).toMatchObject({ id: credit, date: '2026-06-01', amount: '1160.0000' });
    expect(await cashing(id)).toEqual({ date: '2026-06-01', tx: credit });
    expect(await cashingEntries(id)).toEqual([]);
    const audit = await query<{ new_values: Record<string, unknown> }>(
      `SELECT new_values FROM audit_log WHERE entity_type = 'customer_payments' AND entity_id = $1 AND legal_entity_id = $2`,
      [id, mx.entityId]
    );
    expect(audit.rows.map((x) => x.new_values)).toContainEqual(
      expect.objectContaining({ check_cashed_date: '2026-06-01', check_cashed_tx_id: credit, iva_released: '0.0000', journal_entry_id: null })
    );

    // T2 · a second recording, against the same credit or a new one.
    for (const tx of [credit, await bankLine(account, '2026-06-02', '1160.00')]) {
      const again = await record(id, tx).catch((e: unknown) => e);
      expect((again as ValidationError).messageKey?.key).toBe('bank.check.cashing.refused.already_cashed');
    }
    expect(await cashing(id)).toEqual({ date: '2026-06-01', tx: credit });

    // T2 · the credit another receipt holds as its cashing.
    await refused((await receipt()).id, credit, 'credit_used');
  });

  it('T2 · refused, nothing written: an earlier credit, another amount, a charge, another account', async () => {
    const { id } = await receipt();
    await refused(id, await bankLine(account, '2026-05-29', '1160.00'), 'credit_before_receipt');
    await refused(id, await bankLine(account, '2026-06-01', '1159.99'), 'amount_differs');
    await refused(id, await bankLine(account, '2026-06-01', '-1160.00'), 'amount_differs');
    await refused(id, await bankLine(await bankAccount(mx, 'Savings 506'), '2026-06-01', '1160.00'), 'other_account');
  });

  it('T2 · refused, nothing written: a receipt by transfer, and a reversed cheque', async () => {
    const credit = await bankLine(account, '2026-06-01', '1160.00');
    await refused((await receipt('spei')).id, credit, 'not_a_cheque');
    const bounced = await receipt();
    await reverseCustomerPayment(mx.entityId, bounced.id, { reason: 'returned unpaid', cause: 'not_collected' }, mx.userId);
    await refused(bounced.id, credit, 'not_completed');
  });

  it('T2 · another entity of the same tenant reads the receipt, and the credit, as not found', async () => {
    const { id } = await receipt();
    // The sister's own credit, so the receipt is the only thing it cannot see.
    const foreign = await bankLine(await bankAccount(sister, 'Sister 506'), '2026-06-01', '1160.00');
    await expect(record(id, foreign, sister)).rejects.toThrow(/Customer Payment .* not found/);
    await expect(record(id, foreign)).rejects.toThrow(/Bank Transaction .* not found/);
    expect(await cashing(id)).toEqual({ date: null, tx: null });
  });

  it('T2 · a receipt that names no account takes a credit of any account in its currency, and no other currency', async () => {
    const { id } = await receipt('check', null);
    await refused(id, await bankLine(await bankAccount(mx, 'Dollars 506', 'USD'), '2026-06-01', '1160.00'), 'currency_differs');
    const credit = await bankLine(account, '2026-06-03', '1160.00');
    await record(id, credit);
    expect(await cashing(id)).toEqual({ date: '2026-06-03', tx: credit });
  });

  it('T3 · the database rejects the date without the credit', async () => {
    const { id } = await receipt();
    await expect(
      query(`UPDATE customer_payments SET check_cashed_date = '2026-06-01' WHERE id = $1`, [id])
    ).rejects.toThrow(/customer_payments_check_cashing_whole/);
  });
});

/**
 * MNE-001-556 (#700, part 2/4) · THE HOLD. While a cheque in the functional
 * currency has no cashing recorded, its receipt and its applications release
 * no IVA; the cashing releases it on the bank's day. What tells a held cheque
 * apart is its method and its cashing, never the 0 its allocation stores:
 * every allocation stores what it released, 0 included (MNE-001-459).
 */
describe('a cheque releases its IVA the day the bank cashes it', () => {
  const BANK_AND_AR = [
    { account: 'bank', debit: '1160.0000', credit: null },
    { account: 'cxc', debit: null, credit: '1160.0000' },
  ];
  const apply = (id: string, invoiceId: string) =>
    applyCustomerPayment(mx.entityId, id, [{ documentId: invoiceId, amountApplied: '1160.00' }], mx.userId);

  it('T4 · by cheque the receipt posts bank against the receivable and no IVA line; by transfer, the entry of today', async () => {
    const byCheck = await receipt();
    expect(await linesOf(byCheck.entryId)).toEqual(BANK_AND_AR);
    expect(await stored(byCheck.id)).toEqual(['0.0000']);

    const transfer = await receipt('spei');
    expect(await linesOf(transfer.entryId)).toEqual([...BANK_AND_AR, PENDING('160.0000'), DUE('160.0000')]);
    expect(await stored(transfer.id)).toEqual(['160.0000']);
  });

  it('T5 · cashed on 2026-06-01: DR 2125 / CR 2120 160.00 that day, in June, stored on the allocation', async () => {
    const before = await iva();
    const { id, invoiceId } = await receipt();
    expect(await iva()).toEqual({ pending: before.pending + 160, due: before.due });

    const credit = await bankLine(account, '2026-06-01', '1160.00');
    const r = await record(id, credit);
    expect(r).toMatchObject({ released: '160.0000', note: null });
    expect(r.byInvoice).toEqual([expect.objectContaining({ invoiceId, amount: '160.0000' })]);
    const entries = await cashingEntries(id);
    expect(entries).toHaveLength(1);
    // T6 · the cashing of the 1st lands in June, not in the receipt's May.
    expect(entries[0]).toMatchObject({ id: r.entryId, date: '2026-06-01', period: mx.periodos[6] });
    expect(await linesOf(r.entryId as string)).toEqual([PENDING('160.0000'), DUE('160.0000')]);
    expect(await stored(id)).toEqual(['160.0000']);
    expect(await iva()).toEqual({ pending: before.pending, due: before.due + 160 });
    expect(await getCustomerPayment(mx.entityId, id)).toMatchObject({ check_cashed_date: '2026-06-01', check_cashed_tx_id: credit });
  });

  it('T6 · a closed month refuses the cashing while there is IVA to post, and writes nothing', async () => {
    const { id } = await receipt();
    const credit = await bankLine(account, '2026-07-01', '1160.00');
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [mx.periodos[7]]);
    try {
      await refused(id, credit, 'period_closed');
    } finally {
      await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [mx.periodos[7]]);
    }
    expect(await stored(id)).toEqual(['0.0000']);
  });

  it('an allocation that stores no figure counts as released: its cashing posts nothing', async () => {
    const { id } = await receipt();
    await query('UPDATE payment_allocations SET iva_reclass_amount = NULL WHERE payment_id = $1', [id]);
    const r = await record(id, await bankLine(account, '2026-06-01', '1160.00'));
    expect(r).toMatchObject({ released: '0.0000', entryId: null, note: 'bank.check.cashing.note.already_released' });
    expect(await cashingEntries(id)).toEqual([]);
  });

  it('T7 · cash on account applied before the cashing releases nothing, and the cashing releases it; applied after, as today', async () => {
    const ON_ACCOUNT = [
      { account: 'anticipo_clientes', debit: '1160.0000', credit: null },
      { account: 'cxc', debit: null, credit: '1160.0000' },
    ];
    const early = await pay(null);
    const applied = await apply(early.id, await invoice());
    expect(await linesOf(applied.journalEntry?.id as string)).toEqual(ON_ACCOUNT);
    expect(await stored(early.id)).toEqual(['0.0000']);
    const r = await record(early.id, await bankLine(account, '2026-06-02', '1160.00'));
    expect(r).toMatchObject({ released: '160.0000', cashedOn: '2026-06-02' });
    expect(await linesOf(r.entryId as string)).toEqual([PENDING('160.0000'), DUE('160.0000')]);

    const late = await pay(null);
    expect(await record(late.id, await bankLine(account, '2026-06-02', '1160.00'))).toMatchObject({
      released: '0.0000', entryId: null, note: 'bank.check.cashing.note.nothing_to_release',
    });
    const after = await apply(late.id, await invoice());
    expect(await linesOf(after.journalEntry?.id as string)).toEqual([...ON_ACCOUNT, PENDING('160.0000'), DUE('160.0000')]);
    expect(await stored(late.id)).toEqual(['160.0000']);
  });

  it('T8 · applied and unapplied before the cashing: nothing is re-parked or estimated, and the cashing releases nothing', async () => {
    const { id } = await pay(null);
    const invoiceId = await invoice();
    await apply(id, invoiceId);
    const undone = await unapplyCustomerPayment(mx.entityId, id, { invoiceId, reason: 'wrong invoice' }, mx.userId);
    expect(undone).toMatchObject({ ivaReAparcado: '0.0000', ivaEstimado: false });
    expect((await linesOf(undone.journalEntry.id)).map((l) => l.account).sort()).toEqual(['anticipo_clientes', 'cxc']);
    expect(await record(id, await bankLine(account, '2026-06-02', '1160.00'))).toMatchObject({ released: '0.0000', entryId: null });
  });

  it('T9 · two halves of one invoice: 80.00 on the transfer\'s day, 80.00 on the cashing day, and 2125 ends where it began', async () => {
    const before = await iva();
    const invoiceId = await invoice();
    const transfer = await pay(invoiceId, 'spei', '580.00');
    expect((await linesOf(transfer.entryId)).slice(2)).toEqual([PENDING('80.0000'), DUE('80.0000')]);
    const byCheck = await pay(invoiceId, 'check', '580.00');
    expect(await linesOf(byCheck.entryId)).toHaveLength(2);
    expect(await iva()).toEqual({ pending: before.pending + 80, due: before.due + 80 });

    const r = await record(byCheck.id, await bankLine(account, '2026-06-03', '580.00'));
    expect(r).toMatchObject({ released: '80.0000' });
    expect(await iva()).toEqual({ pending: before.pending, due: before.due + 160 });
  });

  it('T10 · a cashed cheque reversed: every entry has its mirror, the cashing\'s included, and the IVA is back', async () => {
    const { id } = await receipt();
    const parked = await iva();
    const credit = await bankLine(account, '2026-06-01', '1160.00');
    const cashed = await record(id, credit);
    const r = await reverseCustomerPayment(mx.entityId, id, { reason: 'returned after cashing', cause: 'not_collected' }, mx.userId);
    expect(r.reversals).toHaveLength(2);
    expect(r.reversals.map((x) => x.of)).toContain(cashed.entryNumber);
    expect(await iva()).toEqual(parked);
    // The two columns stay on the reversed row, as history.
    expect(await cashing(id)).toEqual({ date: '2026-06-01', tx: credit });
  });

  it('with no credit named, the one credit of that amount from the receipt\'s day in its account is taken; several are listed, never picked', async () => {
    const own = await bankAccount(mx, 'Deposits 556');
    const { id } = await receipt('check', own);
    const none = await record(id, undefined).catch((e: unknown) => e);
    expect((none as ValidationError).messageKey?.key).toBe('bank.check.cashing.refused.no_credit');

    await bankLine(own, '2026-05-29', '1160.00');
    await bankLine(own, '2026-06-01', '1159.99');
    const first = await bankLine(own, '2026-06-01', '1160.00');
    const second = await bankLine(own, '2026-06-04', '1160.00');
    const several = await record(id, undefined).catch((e: unknown) => e);
    expect((several as ValidationError).messageKey).toMatchObject({
      key: 'bank.check.cashing.refused.several_credits', params: { candidates: expect.stringContaining(second) },
    });
    expect(await cashing(id)).toEqual({ date: null, tx: null });

    // Once the other cheque of that amount holds its credit, one candidate is left.
    await record((await receipt('check', own)).id, second);
    expect(await record(id, undefined)).toMatchObject({ cashedOn: '2026-06-01', released: '160.0000' });
    expect(await cashing(id)).toEqual({ date: '2026-06-01', tx: first });

    const noAccount = await record((await receipt('check', null)).id, undefined).catch((e: unknown) => e);
    expect((noAccount as ValidationError).messageKey?.key).toBe('bank.check.cashing.refused.transaction_needed');
  });

  it('T11 · from the terminal: `bank check reconcile --receipt` records the cashing, and `receipt show` says it', async () => {
    const plain = Object.fromEntries(['dim', 'bold', 'cyan', 'red', 'green', 'yellow'].map((c) => [c, (x: string) => x]));
    /** Runs one leaf in-process, as the binary would; returns what it printed. */
    const terminal = async (argv: string[]): Promise<string> => {
      const out: string[] = [];
      const stdout = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
      try {
        resetDeclarations();
        const program = new Command('mnemosine');
        const deps = { palette: plain as never, shutdown: () => undefined, reportError: (e: unknown) => { throw e; } };
        registerBankCommand(program, deps);
        registerReceiptCommand(program, deps);
        await program.parseAsync(['node', 'mnemosine', ...argv, '-e', mx.entityId, '-t', mx.tenantId]);
      } finally {
        process.stdout.write = stdout;
      }
      return out.join('');
    };
    const { id, invoiceId } = await receipt();
    const number = (await getCustomerPayment(mx.entityId, id)).payment_number;
    const credit = await bankLine(account, '2026-06-05', '1160.00');

    // The sister entity gave the tenant a second user, so the reviewer is named.
    const user = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [mx.userId])).rows[0].email;
    const printed = await terminal(
      ['bank', 'check', 'reconcile', '--receipt', number, '--transaction', credit, '--user', user, '--yes', '--json']
    );
    expect((JSON.parse(printed) as { rows: unknown[] }).rows[0]).toMatchObject({
      id, payment_number: number, cleared_on: '2026-06-05', reclassified: '160.0000',
      by_invoice: [expect.objectContaining({ invoice_id: invoiceId, amount: '160.0000' })],
    });
    expect(await cashing(id)).toEqual({ date: '2026-06-05', tx: credit });
    expect(await terminal(['receipt', 'show', number])).toContain(`2026-06-05 · bank transaction ${credit}`);
  });
});
