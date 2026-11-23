import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { AccountingError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import { assertBankCurrency, bankAccountOf } from '../accounting/ar-ap-posting.js';
import { assertPayerTrace, assertRastroDePago } from './payment-service.js';
import { BALANCE_TRANSFER_METHOD } from './cash-on-account.js';

// ============================================================
// COMPLETING THE TRACE OF A PAYMENT ALREADY REGISTERED (MNE-001-568, #612)
//
// The Anexo 24 journal file declares, inside the voucher that moves money,
// the instrument that moved it: the cheque's number, or the account and bank
// the transfer went to. `payment create` captures them, and until now nothing
// wrote them afterwards: a payment registered without one blocked its month's
// file for good, and the file is asked for after the month is closed.
//
// WHAT THIS IS AND WHAT IT IS NOT. Filling an empty field from the evidence
// (the SPEI receipt, the cheque stub, the bank statement) is the capture that
// `payment create` would have made, made late. It adds no fact and writes no
// figure: no entry is created, changed or reversed, which is why it runs in
// any period state, with no `--force`. Correcting a value already captured is
// another act (NIF B-1 governs corrections) and is refused here: a voucher of
// three years ago keeps saying where the money went then.
//
// HOW IT IS GUARDED. A locked read decides every refusal; one UPDATE per
// completion writes each field only while it is still empty, scoped by entity
// and state, and checks its row count (invariant 3). One audit row says who,
// why, from which empty value, in which period state, for which entry, and
// how many voucher files of that month were already archived.
//
// LINKING A BANK ACCOUNT (MNE-001-569). The voucher reads our bank (its
// c_Banco code and account number) from the bank account the payment names.
// One linked afterwards is accepted only where the ledger already agrees:
// the payment has a posted entry, the ledger account that bank account posts
// to (the rule `bankAccountOf` applies at posting) is on a line of that very
// entry (not today's `banco` role, which may have changed since), and its
// currency is the payment's. Anything else would declare a bank the ledger
// did not move. An inactive account is accepted: this is history, and
// `assertPayableBankAccount` guards new money movement only.
//
// THE RECEIPT (MNE-001-570). A receipt's origin is the customer's: the bank
// it paid from (or that issued its cheque) and its account, the columns 335
// added, which `receipt record` captures. `receipt trace record` completes
// them, its cheque number and our bank account, on the same rules and the
// same guarded UPDATE, under the receipts' table, with #611's payer checks
// run on the merged trace.
//
// A TRANSFER HAS NO TRACE (MNE-001-594). A transfer of customer credit
// (MNE-001-498) is a receipts row that received no money: its entry moves
// 2150 to 2150, and migration 339 keeps its bank account empty. There is no
// cheque, payer bank or bank account of ours to complete, so it is refused
// on the locked read, before any other check, naming it and its source.
// ============================================================

/** The states whose entry stays posted: a reversal leaves the original entry in its month. */
const COMPLETABLE = ['completed', 'reversed'] as const;

/** The trace of a vendor payment, under the flags `payment trace record` takes. */
export interface VendorTraceFields {
  checkNumber?: string | null;
  toAccount?: string | null;
  toBank?: string | null;
  toForeignBank?: string | null;
  /** The bank account the payment went through, by id: `--bank`, resolved by the caller. */
  bankAccountId?: string | null;
}

/** The trace of a receipt, under the flags `receipt trace record` takes (MNE-001-570). */
export interface ReceiptTraceFields {
  checkNumber?: string | null;
  payerBank?: string | null;
  payerAccount?: string | null;
  payerForeignBank?: string | null;
  /** The bank account the money went into, by id: `--bank`, resolved by the caller. */
  bankAccountId?: string | null;
}

export type TraceSide = 'vendor' | 'customer';

type DestinationColumn = 'cuenta_destino' | 'banco_destino_sat' | 'banco_destino_extranjero';
type PayerColumn = 'cuenta_origen' | 'banco_origen_sat' | 'banco_origen_extranjero';
type TextColumn = 'check_number' | DestinationColumn | PayerColumn;
type Column = TextColumn | 'bank_account_id';

interface FieldSpec { key: string; column: TextColumn; flag: string; max: number }

// Cheque/@Num admits 20 characters; a longer one fails the whole file against the XSD.
const CHECK_NUMBER: FieldSpec = { key: 'checkNumber', column: 'check_number', flag: '--check-number', max: 20 };

/** Each side: its table (and audited name), its resolver's name, and what each flag fills. */
const SIDES: Readonly<Record<TraceSide, {
  table: string; resource: string; nothingGiven: 'payment.trace.nothing_given' | 'receipt.trace.nothing_given'; fields: readonly FieldSpec[];
}>> = {
  vendor: {
    table: 'vendor_payments',
    resource: 'Vendor payment',
    nothingGiven: 'payment.trace.nothing_given',
    fields: [
      CHECK_NUMBER,
      { key: 'toAccount', column: 'cuenta_destino', flag: '--to-account', max: 50 },
      { key: 'toBank', column: 'banco_destino_sat', flag: '--to-bank', max: 3 },
      { key: 'toForeignBank', column: 'banco_destino_extranjero', flag: '--to-foreign-bank', max: 150 },
    ],
  },
  customer: {
    table: 'customer_payments',
    resource: 'Customer payment',
    nothingGiven: 'receipt.trace.nothing_given',
    // The limits of 335's columns and of the payment node, as `receipt record` holds them.
    fields: [
      CHECK_NUMBER,
      { key: 'payerAccount', column: 'cuenta_origen', flag: '--payer-account', max: 50 },
      { key: 'payerBank', column: 'banco_origen_sat', flag: '--payer-bank', max: 3 },
      { key: 'payerForeignBank', column: 'banco_origen_extranjero', flag: '--payer-foreign-bank', max: 150 },
    ],
  },
};

export interface TraceField {
  column: Column;
  flag: string;
  /** The value as shown and audited: an account by its last four digits, a bank account by its name. */
  shown: string;
}

export interface TraceCompletion {
  paymentId: string;
  paymentNumber: string;
  status: string;
  /** What this completion wrote (or, in a dry run, would write). */
  filled: TraceField[];
  /** What was given and already held that same value: a retry is harmless. */
  unchanged: TraceField[];
  journalEntry: string | null;
  /** The month of the voucher, as YYYY-MM. */
  period: string;
  periodStatus: string | null;
  /** Voucher files of that month archived before this completion; nothing rewrites them. */
  archivedVoucherFiles: number;
}

type Row = {
  payment_number: string; status: string; payment_method: string; payment_date: string;
  journal_entry_id: string | null; bank_account_id: string | null; currency_code: string;
} & Record<DestinationColumn | 'check_number', string | null> & Partial<Record<PayerColumn, string | null>>;

/** The ways a trace field is shown outside the payment row: never an account in clear. */
function shown(column: TextColumn, value: string): string {
  return column === 'cuenta_destino' || column === 'cuenta_origen' ? `…${value.slice(-4)}` : value;
}

function given(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

/**
 * Fills the empty trace fields of a payment that is completed or reversed: a
 * vendor payment's cheque and destination, or a receipt's cheque and payer
 * (MNE-001-570). A field given with the value it already holds is reported
 * unchanged; one given with another value is refused, naming the stored one.
 * `bankAccountId` links the bank account the money went through, under
 * `bankLink`'s checks.
 */
export async function completePaymentTrace(
  entityId: string, side: 'vendor', paymentId: string, fields: VendorTraceFields,
  reason: string, userId: string, opts?: { dryRun?: boolean; client?: pg.PoolClient }
): Promise<TraceCompletion>;
export async function completePaymentTrace(
  entityId: string, side: 'customer', paymentId: string, fields: ReceiptTraceFields,
  reason: string, userId: string, opts?: { dryRun?: boolean; client?: pg.PoolClient }
): Promise<TraceCompletion>;
export async function completePaymentTrace(
  entityId: string,
  side: TraceSide,
  paymentId: string,
  fields: VendorTraceFields | ReceiptTraceFields,
  reason: string,
  userId: string,
  opts: { dryRun?: boolean; client?: pg.PoolClient } = {}
): Promise<TraceCompletion> {
  const spec = SIDES[side];
  const values = fields as Record<string, string | null | undefined>;
  const wanted = spec.fields.map((f) => ({ ...f, value: given(values[f.key]) })).filter((f) => f.value !== null);
  const bankAccountId = given(fields.bankAccountId);
  if (wanted.length === 0 && bankAccountId === null) throw new ValidationError({ key: spec.nothingGiven });
  if (reason.trim() === '' && opts.dryRun !== true) throw new ValidationError({ key: 'payment.trace.reason_required' });
  for (const f of wanted) {
    const length = (f.value as string).length;
    if (length > f.max) {
      throw new ValidationError({ key: 'payment.trace.too_long', params: { flag: f.flag, max: f.max, length } });
    }
  }
  const columns = spec.fields.map((f) => f.column);

  const run = async (client: pg.PoolClient): Promise<TraceCompletion> => {
    // The columns come from SIDES, never from the caller.
    const found = await client.query<Row>(
      `SELECT payment_number, status, payment_method, payment_date::text AS payment_date, journal_entry_id,
              bank_account_id, currency_code,
              ${[...new Set(['check_number', 'cuenta_destino', 'banco_destino_sat', 'banco_destino_extranjero', ...columns])].join(', ')}
         FROM ${spec.table} WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
      [paymentId, entityId]
    );
    if (found.rows.length === 0) throw new NotFoundError(spec.resource, paymentId);
    const row = found.rows[0];
    if (side === 'customer' && row.payment_method === BALANCE_TRANSFER_METHOD) {
      const source = (await client.query<{ payment_number: string }>(
        `SELECT s.payment_number FROM customer_payments t
           JOIN customer_payments s ON s.id = t.transferred_from_payment_id AND s.entity_id = t.entity_id
          WHERE t.id = $1 AND t.entity_id = $2`,
        [paymentId, entityId]
      )).rows[0];
      throw new ValidationError({
        key: 'receipt.trace.balance_transfer',
        params: { number: row.payment_number, source: source?.payment_number ?? '?' },
      });
    }
    if (!(COMPLETABLE as readonly string[]).includes(row.status)) {
      throw new ValidationError({
        key: 'payment.trace.not_completable', params: { number: row.payment_number, status: row.status },
      });
    }

    const filled: (TraceField & { value: string })[] = [];
    const unchanged: TraceField[] = [];
    for (const f of wanted) {
      const value = f.value as string;
      const stored = given(row[f.column]);
      if (stored === null) {
        filled.push({ column: f.column, flag: f.flag, shown: shown(f.column, value), value });
      } else if (stored === value) {
        unchanged.push({ column: f.column, flag: f.flag, shown: shown(f.column, value) });
      } else {
        throw new ValidationError({
          key: 'payment.trace.already_captured',
          params: { number: row.payment_number, flag: f.flag, stored: shown(f.column, stored) },
        });
      }
    }

    const linked = bankAccountId === null ? null : await bankLink(client, entityId, row, bankAccountId);
    if (linked !== null) {
      const field = { column: 'bank_account_id' as const, flag: '--bank', shown: linked.name };
      if (row.bank_account_id === null) filled.push({ ...field, value: linked.id });
      else unchanged.push(field);
    }

    // The capture's rules, on what the payment will hold once completed.
    const merged = (column: TextColumn): string | null =>
      given(row[column]) ?? filled.find((f) => f.column === column)?.value ?? null;
    if (side === 'vendor') {
      assertRastroDePago(
        {
          paymentMethod: row.payment_method,
          checkNumber: merged('check_number'),
          cuentaDestino: merged('cuenta_destino'),
          bancoDestinoSat: merged('banco_destino_sat'),
          bancoDestinoExtranjero: merged('banco_destino_extranjero'),
        },
        'proveedor'
      );
    } else {
      assertRastroDePago(
        {
          paymentMethod: row.payment_method,
          checkNumber: merged('check_number'),
          cuentaDestino: row.cuenta_destino,
          bancoDestinoSat: row.banco_destino_sat,
          bancoDestinoExtranjero: row.banco_destino_extranjero,
        },
        'cliente'
      );
      assertPayerTrace(
        {
          paymentMethod: row.payment_method,
          checkNumber: merged('check_number'),
          payerAccount: merged('cuenta_origen'),
          payerBankCode: merged('banco_origen_sat'),
          payerForeignBank: merged('banco_origen_extranjero'),
        },
        'cliente'
      );
    }

    // The voucher's month and its state: the entry's period, or the payment's date with none.
    const entry = (await client.query<{ entry_number: string; entry_date: string; status: string | null }>(
      `SELECT je.entry_number, je.entry_date::text AS entry_date, fp.status
         FROM journal_entries je LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
        WHERE je.id = $1 AND je.entity_id = $2`,
      [row.journal_entry_id, entityId]
    )).rows[0];
    const date = entry?.entry_date ?? row.payment_date;
    const periodStatus = entry?.status ?? (await client.query<{ status: string }>(
      `SELECT status FROM fiscal_periods
        WHERE entity_id = $1 AND start_date <= $2::date AND end_date >= $2::date AND period_number <= 12
        ORDER BY period_number LIMIT 1`,
      [entityId, date]
    )).rows[0]?.status ?? null;
    const archived = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM sat_anexo24_artefactos
        WHERE entity_id = $1 AND tipo = 'poliza' AND anio = $2 AND mes = $3`,
      [entityId, Number(date.slice(0, 4)), Number(date.slice(5, 7))]
    );

    const result: TraceCompletion = {
      paymentId,
      paymentNumber: row.payment_number,
      status: row.status,
      filled: filled.map(({ column, flag, shown: s }) => ({ column, flag, shown: s })),
      unchanged,
      journalEntry: entry?.entry_number ?? null,
      period: date.slice(0, 7),
      periodStatus,
      archivedVoucherFiles: archived.rows[0]?.n ?? 0,
    };
    // A dry run decides every refusal above and writes nothing.
    if (filled.length === 0 || opts.dryRun === true) return result;

    const param = (column: Column): string | null => filled.find((f) => f.column === column)?.value ?? null;
    // Entity, state, each field still empty, and one row, or nothing (invariant 3).
    // Each text column is $4.., the bank account the last parameter.
    const bank = columns.length + 4;
    const written = await client.query(
      `UPDATE ${spec.table}
          SET ${columns.map((c, i) => `${c} = COALESCE(${c}, $${i + 4})`).join(',\n              ')},
              bank_account_id = COALESCE(bank_account_id, $${bank}),
              updated_at = NOW()
        WHERE id = $1 AND entity_id = $2 AND status = ANY($3::text[])
          ${columns.map((c, i) => `AND ($${i + 4}::text IS NULL OR ${c} IS NULL)`).join('\n          ')}
          AND ($${bank}::uuid IS NULL OR bank_account_id IS NULL)
        RETURNING id`,
      [paymentId, entityId, COMPLETABLE, ...columns.map(param), param('bank_account_id')]
    );
    if (written.rowCount !== 1) {
      throw new AccountingError('TRACE_RACE', { key: 'payment.trace.race', params: { number: row.payment_number } });
    }

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      legalEntityId: entityId,
      userId,
      action: 'update',
      entityType: spec.table,
      entityId: paymentId,
      oldValues: Object.fromEntries(filled.map((f) => [f.column, null])),
      newValues: {
        evento: 'complete_trace',
        ...Object.fromEntries(filled.map((f) => [f.column, f.shown])),
        // The account linked, by id and by name; its number stays on the bank account.
        ...(linked !== null && row.bank_account_id === null ? { bank_account_id: linked.id, bank_account: linked.name } : {}),
        period_status: periodStatus,
        journal_entry: result.journalEntry,
        archived_voucher_files: result.archivedVoucherFiles,
      },
      reason,
    });

    return result;
  };

  return opts.client ? run(opts.client) : withTransaction(run);
}

/**
 * Decides whether a bank account may be linked to the payment, in the plan's
 * order (#612, decision 8): a posted entry; the ledger account the bank
 * account posts to, by `bankAccountOf`; that account on a line of the entry;
 * the currency, by `assertBankCurrency`; and, last, no other account linked.
 * Returns the account to report as filled or unchanged; refuses otherwise.
 */
async function bankLink(
  client: pg.PoolClient,
  entityId: string,
  row: Pick<Row, 'payment_number' | 'journal_entry_id' | 'bank_account_id' | 'currency_code'>,
  bankAccountId: string
): Promise<{ id: string; name: string }> {
  const account = (await client.query<{ id: string; account_name: string }>(
    'SELECT id, account_name FROM bank_accounts WHERE id = $1 AND entity_id = $2',
    [bankAccountId, entityId]
  )).rows[0];
  if (account === undefined) throw new NotFoundError('Bank Account', bankAccountId);
  if (row.journal_entry_id === null) {
    throw new ValidationError({ key: 'payment.trace.bank_no_entry', params: { number: row.payment_number } });
  }
  const candidate = await bankAccountOf(client, entityId, account.id);
  const lines = await client.query<{ account_id: string; code: string; money: boolean }>(
    `SELECT DISTINCT l.account_id::text AS account_id, a.code,
            (l.account_id IN (SELECT gl_account_id FROM bank_accounts WHERE entity_id = $2
                              UNION SELECT account_id FROM account_roles
                                     WHERE entity_id = $2 AND role = 'banco' AND qualifier IS NULL)) AS money
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id AND je.entity_id = $2
       JOIN accounts a ON a.id = l.account_id AND a.entity_id = $2
      WHERE l.journal_entry_id = $1
      ORDER BY a.code`,
    [row.journal_entry_id, entityId]
  );
  if (!lines.rows.some((l) => l.account_id === candidate.glAccountId)) {
    const code = (await client.query<{ code: string }>(
      'SELECT code FROM accounts WHERE id = $1 AND entity_id = $2', [candidate.glAccountId, entityId]
    )).rows[0]?.code ?? candidate.glAccountId;
    const entry = (await client.query<{ entry_number: string }>(
      'SELECT entry_number FROM journal_entries WHERE id = $1 AND entity_id = $2', [row.journal_entry_id, entityId]
    )).rows[0]?.entry_number ?? row.journal_entry_id;
    const money = lines.rows.filter((l) => l.money).map((l) => l.code);
    throw new ValidationError({
      key: 'payment.trace.bank_not_in_entry',
      params: {
        number: row.payment_number, entry, moved: (money.length > 0 ? money : lines.rows.map((l) => l.code)).join(', '),
        account: account.account_name, candidate: code,
      },
    });
  }
  assertBankCurrency(candidate, row.currency_code, row.payment_number);
  if (row.bank_account_id !== null && row.bank_account_id !== account.id) {
    const stored = (await client.query<{ account_name: string }>(
      'SELECT account_name FROM bank_accounts WHERE id = $1 AND entity_id = $2', [row.bank_account_id, entityId]
    )).rows[0]?.account_name ?? row.bank_account_id;
    throw new ValidationError({
      key: 'payment.trace.already_captured', params: { number: row.payment_number, flag: '--bank', stored },
    });
  }
  return { id: account.id, name: account.account_name };
}
