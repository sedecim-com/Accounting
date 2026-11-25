import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { Command } from 'commander';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment, reverseCustomerPayment, applyCustomerPayment, unapplyCustomerPayment, getCustomerPayment,
  transferCustomerCredit,
} from '../../src/services/payments/payment-service.js';
import {
  recordCustomerCheckCashing, recordCustomerChecksCashing, CUSTOMER_CHECK_CASHING_SOURCE,
} from '../../src/services/banking/treasury-posting.js';
import { crearGrupoDeCotejo, desaplicarCotejo, type ReferenciaDeLibros } from '../../src/services/banking/match-service.js';
import { entityScope } from '../../src/database/scope.js';
import { ValidationError, type AppError } from '../../src/utils/errors.js';
import { registerBankCommand } from '../../src/cli/bank-command.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

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

/** A new PPD (or `terms`) invoice of 1,000.00 + 160.00. */
async function invoice(terms: 'PPD' | 'PUE' = 'PPD'): Promise<string> {
  const draft = await createInvoice({
    entity_id: mx.entityId, customer_id: customerId, invoice_date: '2026-05-10', due_date: '2026-05-10',
    currency_code: 'MXN', terms, created_by: mx.userId,
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

const numberOf = async (id: string) => (await getCustomerPayment(mx.entityId, id)).payment_number;
/** The sister entity gave the tenant a second user, so the reviewer is named. */
const reviewer = async () =>
  (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [mx.userId])).rows[0].email;

/** Runs one leaf in-process, as the binary would; returns what it printed. */
async function terminal(argv: string[], f: Fixture = mx): Promise<string> {
  const plain = Object.fromEntries(['dim', 'bold', 'cyan', 'red', 'green', 'yellow'].map((c) => [c, (x: string) => x]));
  const out: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  try {
    resetDeclarations();
    const program = new Command('mnemosine');
    const deps = { palette: plain as never, shutdown: () => undefined, reportError: (e: unknown) => { throw e; } };
    registerBankCommand(program, deps);
    registerReceiptCommand(program, deps);
    await program.parseAsync(['node', 'mnemosine', ...argv, '-e', f.entityId, '-t', f.tenantId]);
  } finally {
    process.stdout.write = stdout;
  }
  return out.join('');
}

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

  // MNE-001-586 (#792, part 3/3): the cash the unapply put back on account is collected on the cashing day
  // (LIVA art. 1-B), so the cashing causes the 160.00 the unapply stored for it, from 2150.
  it('T8 · applied and unapplied before the cashing: nothing is re-parked or estimated, and the cashing causes the 160.00 its cash carries', async () => {
    const { id } = await pay(null);
    const invoiceId = await invoice();
    await apply(id, invoiceId);
    const undone = await unapplyCustomerPayment(mx.entityId, id, { invoiceId, reason: 'wrong invoice' }, mx.userId);
    expect(undone).toMatchObject({ ivaReAparcado: '0.0000', ivaEstimado: false, ivaAtCashing: '160.00' });
    expect((await linesOf(undone.journalEntry.id)).map((l) => l.account).sort()).toEqual(['anticipo_clientes', 'cxc']);
    const cashed = await record(id, await bankLine(account, '2026-06-02', '1160.00'));
    expect(cashed).toMatchObject({ released: '160.0000', advanceIva: '160.0000' });
    expect(await linesOf(cashed.entryId as string)).toEqual([
      { account: 'anticipo_clientes', debit: '160.0000', credit: null },
      DUE('160.0000'),
    ]);
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
    const { id, invoiceId } = await receipt();
    const number = await numberOf(id);
    const credit = await bankLine(account, '2026-06-05', '1160.00');

    const printed = await terminal(
      ['bank', 'check', 'reconcile', '--receipt', number, '--transaction', credit, '--user', await reviewer(), '--yes', '--json']
    );
    expect((JSON.parse(printed) as { rows: unknown[] }).rows[0]).toMatchObject({
      id, payment_number: number, cleared_on: '2026-06-05', reclassified: '160.0000',
      by_invoice: [expect.objectContaining({ invoice_id: invoiceId, amount: '160.0000' })],
    });
    expect(await cashing(id)).toEqual({ date: '2026-06-05', tx: credit });
    expect(await terminal(['receipt', 'show', number])).toContain(`2026-06-05 · bank transaction ${credit}`);
  });
});

/**
 * MNE-001-779 (#787) · A CHEQUE CASHED WHILE ON ACCOUNT IS NOT APPLIED BEFORE
 * ITS CASHING. A price paid by cheque is paid the day the bank cashes it (LIVA
 * art. 1o.-B, second paragraph). Cashed with its cash still on account, the
 * cheque has nothing to release and its cashing posts no entry, so only the
 * receipt keeps that day; once cashed, its application causes the invoice's
 * IVA on its own day. The customer side of MNE-001-746.
 */
describe('a cheque cashed while on account is not applied, nor transferred, before its cashing', () => {
  const CASHED = '2026-07-03';
  const ON_ACCOUNT = [
    { account: 'anticipo_clientes', debit: '1160.0000', credit: null },
    { account: 'cxc', debit: null, credit: '1160.0000' },
  ];
  const applyOn = (id: string, invoiceId: string, date: string, amount = '1160.00') =>
    applyCustomerPayment(mx.entityId, id, [{ documentId: invoiceId, amountApplied: amount }], mx.userId, { date });
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as AppError);
  const applications = async (id: string) =>
    (await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries WHERE entity_id = $1 AND source_id = $2 AND source_type = 'receipt_application'`,
      [mx.entityId, id]
    )).rows[0].n;
  /** A cheque of 1,160.00 received on 2026-05-30 and left on account, cashed on 2026-07-03 with no entry. */
  async function cashedOnAccount(): Promise<string> {
    const { id } = await pay(null);
    expect(await record(id, await bankLine(account, CASHED, '1160.00'))).toMatchObject({
      released: '0.0000', entryId: null, note: 'bank.check.cashing.note.nothing_to_release',
    });
    return id;
  }

  it('T7b · applied with --date 2026-06-20 is refused by key, in en and es, writing nothing; the cashing day itself takes DR 2125 / CR 2120 160.00', async () => {
    const id = await cashedOnAccount();
    const invoiceId = await invoice();
    const before = await iva();

    const refused = await refusal(applyOn(id, invoiceId, '2026-06-20'));
    expect(refused, 'an application dated before the cashing is refused').not.toBeNull();
    expect({ key: refused?.messageKey?.key, status: refused?.statusCode, field: refused?.field }).toEqual({
      key: 'receipt.apply.date_before_cashing', status: 422, field: 'date',
    });
    const number = await numberOf(id);
    expect(refused?.message).toContain(`The bank cashed the cheque of ${number} on ${CASHED}: an application dated 2026-06-20 `);
    expect(refused?.localized('es')).toContain(`El banco cobró el cheque del cobro ${number} el ${CASHED}: una aplicación fechada el 2026-06-20 `);
    expect(await stored(id), 'no allocation').toEqual([]);
    expect(await applications(id), 'no entry').toBe('0');
    expect(await iva(), 'the 160.00 stay in 2125').toEqual(before);

    const applied = await applyOn(id, invoiceId, CASHED);
    const entry = await query<{ d: string }>(
      'SELECT entry_date::text AS d FROM journal_entries WHERE id = $1 AND entity_id = $2', [applied.journalEntry?.id, mx.entityId]
    );
    expect(entry.rows[0].d).toBe(CASHED);
    expect(await linesOf(applied.journalEntry?.id as string)).toEqual([...ON_ACCOUNT, PENDING('160.0000'), DUE('160.0000')]);
    expect(await stored(id)).toEqual(['160.0000']);
    expect(await iva()).toEqual({ pending: before.pending - 160, due: before.due + 160 });
  });

  it('T7c · of the cashing and the receipt\'s last entry, the refusal names the later day', async () => {
    const id = await cashedOnAccount();
    await applyOn(id, await invoice(), '2026-07-10', '580.00');
    const refused = await refusal(applyOn(id, await invoice(), '2026-06-20', '580.00'));
    expect(refused?.messageKey).toMatchObject({ key: 'receipt.apply.date_before_last_event', params: { since: '2026-07-10' } });
  });

  it('T7d · a cheque nobody cashed takes a dated application as before, and its cashing releases the 160.00', async () => {
    const { id } = await pay(null);
    const applied = await applyOn(id, await invoice(), '2026-06-20');
    expect(await linesOf(applied.journalEntry?.id as string)).toEqual(ON_ACCOUNT);
    expect(await stored(id)).toEqual(['0.0000']);
    expect(await record(id, await bankLine(account, CASHED, '1160.00'))).toMatchObject({ released: '160.0000' });
  });

  it('T7f · an unapply is not held to the cashing: cash applied and taken back before the bank paid is a legitimate order', async () => {
    // Applied to a PUE invoice while held, the cash releases nothing at the cashing, which posts no entry.
    const { id } = await pay(null);
    const invoiceId = await invoice('PUE');
    await applyOn(id, invoiceId, '2026-06-01');
    expect((await record(id, await bankLine(account, CASHED, '1160.00'))).entryId).toBeNull();
    const undone = await unapplyCustomerPayment(mx.entityId, id, { invoiceId, reason: 'wrong invoice', date: '2026-06-20' }, mx.userId);
    const entry = await query<{ d: string }>(
      'SELECT entry_date::text AS d FROM journal_entries WHERE id = $1 AND entity_id = $2', [undone.journalEntry.id, mx.entityId]
    );
    expect(entry.rows[0].d).toBe('2026-06-20');
  });

  it('T7e · a transfer of its cash on account dated before the cashing is refused by key, writing nothing', async () => {
    const id = await cashedOnAccount();
    const other = uuidv4();
    await query(
      `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
       VALUES ($1, $2, $3, 'Synthetic Transfer Receiver SA', 'MXN', $4)`,
      [other, mx.entityId, `C-779-${other.slice(0, 6)}`, mx.userId]
    );
    const transfer = (date: string) =>
      transferCustomerCredit(mx.entityId, id, { customerId: other, amount: '1160.00', date, reason: 'agreed by both' }, mx.userId);
    const refused = await refusal(transfer('2026-06-20'));
    expect({ key: refused?.messageKey?.key, status: refused?.statusCode, field: refused?.field }).toEqual({
      key: 'receipt.transfer.date_before_cashing', status: 422, field: 'date',
    });
    expect(refused?.message).toContain(`on ${CASHED}: a transfer dated 2026-06-20 `);
    expect(refused?.localized('es')).toContain(`el ${CASHED}: un traspaso fechado el 2026-06-20 `);
    const rows = await query('SELECT 1 FROM customer_payments WHERE transferred_from_payment_id = $1 AND entity_id = $2', [id, mx.entityId]);
    expect(rows.rows, 'no transfer row').toEqual([]);
    expect((await transfer(CASHED)).transferNumber).toMatch(/^TRF/);
  });
});

/**
 * MNE-001-557 (#700, part 3/4) · ONE CREDIT, SEVERAL CHEQUES. A deposit of
 * several cheques is one bank credit: one recording names all the receipts,
 * the credit is their exact sum, and each receipt gets its own entry. A credit
 * is used while another receipt holds it, or a live match ties it to anything
 * but the receipts named or the bank lines of their own entries.
 */
describe('one bank credit cashes several customer cheques in one act', () => {
  /** A cheque of 1,160.00 on one invoice and one of 580.00 on half of another. */
  async function pair(): Promise<{ a: { id: string; entryId: string }; b: { id: string; entryId: string } }> {
    return { a: await receipt(), b: await pay(await invoice(), 'check', '580.00') };
  }
  const recordBoth = (ids: string[], transactionId?: string) =>
    recordCustomerChecksCashing(mx.entityId, ids, { transactionId, userId: mx.userId });
  async function refusedBoth(ids: string[], transactionId: string | undefined, key: string): Promise<void> {
    const error = await recordBoth(ids, transactionId).catch((e: unknown) => e);
    expect((error as ValidationError).messageKey?.key).toBe(`bank.check.cashing.refused.${key}`);
    for (const id of ids) {
      expect(await cashing(id)).toEqual({ date: null, tx: null });
      expect(await cashingEntries(id)).toEqual([]);
    }
  }
  /** The line of a receipt's own entry on the bank account's ledger account. */
  async function bankLineOf(entryId: string): Promise<string> {
    const r = await query<{ id: string }>(
      `SELECT l.id FROM journal_entry_lines l JOIN bank_accounts ba ON ba.gl_account_id = l.account_id
        WHERE l.journal_entry_id = $1 AND ba.id = $2`,
      [entryId, account]
    );
    return r.rows[0].id;
  }
  const match = async (credit: string, bookItems: ReferenciaDeLibros[]) =>
    (await crearGrupoDeCotejo(entityScope(mx.tenantId, mx.entityId), { cuentaId: account, banco: [credit], libros: bookItems }, { userId: mx.userId }))
      .cotejos[0].matchId;
  const receiptsOf = (...ids: string[]): ReferenciaDeLibros[] => ids.map((id) => ({ tipo: 'customer_payment', id }));

  it('T12 · a credit of 1,740.00 cashes both cheques, one entry each; their sum is required, and the credit is named', async () => {
    const { a, b } = await pair();
    const ids = [a.id, b.id];
    await refusedBoth(ids, await bankLine(account, '2026-06-08', '1160.00'), 'sum_differs');
    await refusedBoth(ids, undefined, 'several_need_transaction');

    const credit = await bankLine(account, '2026-06-08', '1740.00');
    const printed = await terminal([
      'bank', 'check', 'reconcile', '--receipt', await numberOf(a.id), '--receipt', await numberOf(b.id),
      '--transaction', credit, '--user', await reviewer(), '--yes', '--json',
    ]);
    expect((JSON.parse(printed) as { rows: unknown[] }).rows).toEqual([
      expect.objectContaining({ id: a.id, cleared_on: '2026-06-08', reclassified: '160.0000' }),
      expect.objectContaining({ id: b.id, cleared_on: '2026-06-08', reclassified: '80.0000' }),
    ]);
    for (const [id, released] of [[a.id, '160.0000'], [b.id, '80.0000']]) {
      expect(await cashing(id)).toEqual({ date: '2026-06-08', tx: credit });
      const entries = await cashingEntries(id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ date: '2026-06-08', period: mx.periodos[6] });
      expect(await linesOf(entries[0].id)).toEqual([PENDING(released), DUE(released)]);
      expect(await stored(id)).toEqual([released]);
    }
  });

  it('T13 · a used credit is refused: held by another receipt, matched to a third one, or matched to a line of no receipt named', async () => {
    const { a, b } = await pair();
    const ids = [a.id, b.id];
    const held = await bankLine(account, '2026-06-09', '1740.00');
    await record((await pay(null, 'check', '1740.00')).id, held);
    await refusedBoth(ids, held, 'credit_used');

    const third = await pay(await invoice(), 'check', '580.00');
    const toThird = await bankLine(account, '2026-06-09', '1740.00');
    const foreign = await match(toThird, receiptsOf(a.id, third.id));
    await refusedBoth(ids, toThird, 'credit_matched');

    const toLine = await bankLine(account, '2026-06-09', '1740.00');
    await match(toLine, [{ id: await bankLineOf(a.entryId) }, { id: await bankLineOf(third.entryId) }]);
    await refusedBoth(ids, toLine, 'credit_matched');

    // Once the foreign match is undone, the same credit cashes the two.
    await desaplicarCotejo(entityScope(mx.tenantId, mx.entityId), foreign, { userId: mx.userId, motivo: 'cotejo-erroneo' });
    expect((await recordBoth(ids, toThird)).map((r) => r.released)).toEqual(['160.0000', '80.0000']);
  });

  it('T13 · a credit matched to the receipts named, or to the bank lines of their own entries, is theirs', async () => {
    const first = await pair();
    const toReceipts = await bankLine(account, '2026-06-10', '1740.00');
    await match(toReceipts, receiptsOf(first.a.id, first.b.id));
    expect(await recordBoth([first.a.id, first.b.id], toReceipts)).toHaveLength(2);

    const second = await pair();
    const toLines = await bankLine(account, '2026-06-10', '1740.00');
    await match(toLines, [{ id: await bankLineOf(second.a.entryId) }, { id: await bankLineOf(second.b.entryId) }]);
    expect(await recordBoth([second.a.id, second.b.id], toLines)).toHaveLength(2);
    expect(await cashing(second.b.id)).toEqual({ date: '2026-06-10', tx: toLines });
  });
});

/**
 * MNE-001-794 (#787) · A CHEQUE APPLIED AFTER THE CREDIT THAT CASHED IT. The
 * customer mirror of MNE-001-778: cash on account is applied to a PPD invoice
 * while the cheque is held (its row stores 0), and then the bank credit that
 * cashed it, of an earlier day, is recorded. The invoice is paid when both
 * have happened (LIVA art. 1o.-B): its IVA is caused on the later day, the
 * one the IVA paper counts (`countedOn`). What the bank's day causes itself
 * (cash an unapply put back on account) stays on the bank's day, and each
 * day gets its own entry. One entity per story, so each month's paper reads
 * only that story; May, June and July statements are imported.
 */
describe('a cheque applied after the credit that cashed it', () => {
  interface Book { f: Fixture; customerId: string; account: string }
  const day = (month: number, d: number): string => `2026-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  async function book(name: string): Promise<Book> {
    const f = await crearInquilino(`MNE-001-794 ${name}`);
    await seedPolicies({ tenantId: f.tenantId });
    const customerId = uuidv4();
    await query(
      `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
       VALUES ($1, $2, $3, 'Synthetic Late Applier SA', 'MXN', $4)`,
      [customerId, f.entityId, `C-794-${customerId.slice(0, 6)}`, f.userId]
    );
    const b = { f, customerId, account: await bankAccount(f, `Operating 794 ${name}`) };
    for (const month of [5, 6, 7]) {
      const end = new Date(Date.UTC(2026, month, 0)).getUTCDate();
      await query(
        `INSERT INTO bank_statements (entity_id, bank_account_id, period_start, period_end, opening_balance, closing_balance,
                                      currency_code, source_format, file_sha256, imported_by)
         VALUES ($1, $2, $3::date, $4::date, 0, 0, 'MXN', 'manual', $5, $6)`,
        [f.entityId, b.account, day(month, 1), day(month, end), uuidv4().replace(/-/g, '').padEnd(64, '0'), f.userId]
      );
    }
    return b;
  }
  /** A PPD invoice of 2026-05-10 for 1,000.00 + 160.00. */
  async function sale(b: Book): Promise<string> {
    const draft = await createInvoice({
      entity_id: b.f.entityId, customer_id: b.customerId, invoice_date: day(5, 10), due_date: day(5, 10),
      currency_code: 'MXN', terms: 'PPD', created_by: b.f.userId,
      lines: [{ revenue_account_id: b.f.cuentas['4100'], description: 'Sale', quantity: '1', unit_price: '1000.00', tax_rate: '16.0000' }],
    });
    return (await issueInvoice(draft.id, b.f.userId, { entityId: b.f.entityId })).invoice.id;
  }
  /** A cheque received on 2026-05-30 and left on account. */
  const onAccount = async (b: Book, amount: string): Promise<string> =>
    (await recordCustomerPayment({
      entityId: b.f.entityId, counterpartyId: b.customerId, paymentAmount: amount, paymentDate: day(5, 30),
      paymentMethod: 'check', bankAccountId: b.account, checkNumber: 'CHQ-794', applications: [], onAccount: true,
    }, b.f.userId)).paymentId;
  const applyOn = (b: Book, id: string, invoiceId: string, date: string, amount: string) =>
    applyCustomerPayment(b.f.entityId, id, [{ documentId: invoiceId, amountApplied: amount }], b.f.userId, { date });
  const cashOn = async (b: Book, ids: string[], date: string, amount: string) =>
    recordCustomerChecksCashing(b.f.entityId, ids, { transactionId: await bankLine(b.account, date, amount), userId: b.f.userId });
  /** A receipt's cashing entries, in day order, each line by its role. */
  async function entriesOf(b: Book, id: string) {
    const r = await query<{ id: string; date: string; period: string; lines: { role: string; debit: string | null; credit: string | null }[] }>(
      `SELECT je.id, je.entry_date::text AS date, je.fiscal_period_id AS period,
              (SELECT json_agg(json_build_object('role', ar.role, 'debit', l.debit_amount::text, 'credit', l.credit_amount::text)
                               ORDER BY l.line_number)
                 FROM journal_entry_lines l
                 JOIN account_roles ar ON ar.account_id = l.account_id AND ar.entity_id = je.entity_id AND ar.qualifier IS NULL
                WHERE l.journal_entry_id = je.id) AS lines
         FROM journal_entries je
        WHERE je.entity_id = $1 AND je.source_type = $2 AND je.source_id = $3
        ORDER BY je.entry_date, je.entry_number`,
      [b.f.entityId, CUSTOMER_CHECK_CASHING_SOURCE, id]
    );
    return r.rows;
  }
  const line = (role: string, debit: string | null, credit: string | null) => ({ role, debit, credit });
  const RELEASE = (amount: string) => [line('iva_trasladado_no_cobrado', amount, null), line('iva_trasladado', null, amount)];
  const paper = (b: Book, month: number): Promise<IvaWorkpaper> =>
    buildIvaWorkpaper({ tenantId: b.f.tenantId, entityId: b.f.entityId, year: 2026, month });
  const at16 = (wp: IvaWorkpaper) => ({
    base: Number(wp.figures.charged.tasa16.base).toFixed(2), iva: Number(wp.figures.charged.tasa16.iva).toFixed(2),
  });
  const TIE_OUT = 'IVA-WP-CHARGED-VS-LEDGER';
  const codes = (wp: IvaWorkpaper): string[] => wp.findings.map((h) => h.codigo);

  it('T14 · applied on 2026-07-10, cashed by a credit of 2026-06-10: DR 2125 / CR 2120 160.00 dated 2026-07-10, in July, where the paper counts it', async () => {
    const b = await book('applied after credit');
    const invoiceId = await sale(b);
    const id = await onAccount(b, '1160.00');
    await applyOn(b, id, invoiceId, day(7, 10), '1160.00');
    const credit = await bankLine(b.account, day(6, 10), '1160.00');
    const email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [b.f.userId])).rows[0].email;
    const number = (await getCustomerPayment(b.f.entityId, id)).payment_number;
    const argv = ['bank', 'check', 'reconcile', '--receipt', number, '--transaction', credit, '--user', email];

    const preview = await terminal([...argv, '--dry-run'], b.f);
    expect(preview).toMatch(new RegExp(`entry dated\\s+${day(7, 10)}`));
    const printed = await terminal([...argv, '--yes', '--json'], b.f);
    expect((JSON.parse(printed) as { rows: unknown[] }).rows).toEqual([
      expect.objectContaining({ id, cleared_on: day(6, 10), entry_date: day(7, 10), reclassified: '160.0000' }),
    ]);

    const entries = await entriesOf(b, id);
    expect(entries.map(({ date, period, lines }) => ({ date, period, lines }))).toEqual([
      { date: day(7, 10), period: b.f.periodos[7], lines: RELEASE('160.0000') },
    ]);
    expect((await getCustomerPayment(b.f.entityId, id)).check_cashed_date).toBe(day(6, 10));

    const [june, july] = [await paper(b, 6), await paper(b, 7)];
    expect([at16(june), june.ledger.iva_trasladado]).toEqual([{ base: '0.00', iva: '0.00' }, '0.0000']);
    expect([at16(july), july.ledger.iva_trasladado]).toEqual([{ base: '1000.00', iva: '160.00' }, '-160.0000']);
    expect(july.contributions.charged.find((c) => c.documentId === invoiceId)?.entryIds).toContain(entries[0].id);
    for (const wp of [june, july]) expect(codes(wp)).not.toContain(TIE_OUT);
  }, 180_000);

  it('T15 · two halves applied on 2026-06-20 and 2026-07-10: one entry per day, 80.00 each, in June and in July', async () => {
    const b = await book('two halves late');
    const invoiceId = await sale(b);
    const id = await onAccount(b, '1160.00');
    await applyOn(b, id, invoiceId, day(6, 20), '580.00');
    await applyOn(b, id, invoiceId, day(7, 10), '580.00');
    const [cashed] = await cashOn(b, [id], day(6, 10), '1160.00');
    expect(cashed).toMatchObject({ cashedOn: day(6, 10), released: '160.0000' });

    const entries = await entriesOf(b, id);
    expect(entries.map(({ date, period, lines }) => ({ date, period, lines }))).toEqual([
      { date: day(6, 20), period: b.f.periodos[6], lines: RELEASE('80.0000') },
      { date: day(7, 10), period: b.f.periodos[7], lines: RELEASE('80.0000') },
    ]);
    expect(await query<{ iva: string }>(
      'SELECT iva_reclass_amount::text AS iva FROM payment_allocations WHERE payment_id = $1 AND unapplied_at IS NULL ORDER BY created_at', [id]
    ).then((r) => r.rows.map((x) => x.iva)), 'the oldest row stores what the cashing released').toEqual(['160.0000', '0.0000']);

    const [june, july] = [await paper(b, 6), await paper(b, 7)];
    expect([at16(june), june.ledger.iva_trasladado]).toEqual([{ base: '500.00', iva: '80.00' }, '-80.0000']);
    expect([at16(july), july.ledger.iva_trasladado]).toEqual([{ base: '500.00', iva: '80.00' }, '-80.0000']);
    for (const wp of [june, july]) expect(codes(wp)).not.toContain(TIE_OUT);
  }, 180_000);

  it('T16 · cash an unapply put back while held is caused on the bank\'s day, and the late application on its own: two entries', async () => {
    const b = await book('back and late');
    const [first, second] = [await sale(b), await sale(b)];
    const id = await onAccount(b, '2320.00');
    await applyOn(b, id, first, day(6, 1), '1160.00');
    await unapplyCustomerPayment(b.f.entityId, id, { invoiceId: first, reason: 'wrong invoice', date: day(6, 5) }, b.f.userId);
    await applyOn(b, id, second, day(7, 10), '1160.00');
    const [cashed] = await cashOn(b, [id], day(6, 10), '2320.00');
    expect(cashed).toMatchObject({ cashedOn: day(6, 10), released: '320.0000', advanceIva: '160.0000' });

    const entries = await entriesOf(b, id);
    expect(entries.map(({ date, period, lines }) => ({ date, period, lines }))).toEqual([
      { date: day(6, 10), period: b.f.periodos[6], lines: [line('anticipo_clientes', '160.0000', null), line('iva_trasladado', null, '160.0000')] },
      { date: day(7, 10), period: b.f.periodos[7], lines: RELEASE('160.0000') },
    ]);

    const [june, july] = [await paper(b, 6), await paper(b, 7)];
    expect([at16(june).iva, june.ledger.iva_trasladado]).toEqual(['160.00', '-160.0000']);
    expect([at16(july).iva, july.ledger.iva_trasladado]).toEqual(['160.00', '-160.0000']);
    for (const wp of [june, july]) expect(codes(wp)).not.toContain(TIE_OUT);
  }, 180_000);

  it('T17 · one credit cashes two cheques: each entry on its own day; a closed month of either refuses the act, writing nothing', async () => {
    const b = await book('deposit');
    const late = await onAccount(b, '1160.00');
    await applyOn(b, late, await sale(b), day(7, 10), '1160.00');
    const onTime = await onAccount(b, '580.00');
    await applyOn(b, onTime, await sale(b), day(6, 1), '580.00');
    const credit = await bankLine(b.account, day(6, 10), '1740.00');
    const both = () => recordCustomerChecksCashing(b.f.entityId, [late, onTime], { transactionId: credit, userId: b.f.userId });

    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [b.f.periodos[7]]);
    try {
      const refused = await both().then(() => null, (e: unknown) => e as AppError);
      expect(refused?.messageKey).toMatchObject({
        key: 'bank.check.cashing.refused.entry_period_closed', params: { date: day(7, 10), cashedOn: day(6, 10) },
      });
      for (const id of [late, onTime]) {
        expect(await entriesOf(b, id)).toEqual([]);
        expect((await getCustomerPayment(b.f.entityId, id)).check_cashed_date).toBeNull();
      }
    } finally {
      await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [b.f.periodos[7]]);
    }

    const results = await both();
    expect(results.map((r) => r.released)).toEqual(['160.0000', '80.0000']);
    expect((await entriesOf(b, late)).map((e) => [e.date, e.period])).toEqual([[day(7, 10), b.f.periodos[7]]]);
    expect((await entriesOf(b, onTime)).map((e) => [e.date, e.period])).toEqual([[day(6, 10), b.f.periodos[6]]]);
  }, 180_000);
});
