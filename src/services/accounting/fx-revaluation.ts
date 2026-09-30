import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { createJournalEntry, reverseWithinTransaction, attestEntryAsync } from './posting.js';
import { convertirAFuncional, functionalCurrencyOf, resolverTipoCambio, type TipoCambioResuelto } from './moneda-origen.js';
import { getPolicy } from '../policy/policy-service.js';
import { AccountingError, NotFoundError } from '../../utils/errors.js';
import { JournalEntryType } from '../../types/index.js';
import type { JournalEntry } from '../../types/index.js';

type EntryLine = Parameters<typeof createJournalEntry>[4][number];

// ============================================================
// MNE-001-083 · THE CLOSING REVALUATION (NIF B-15, unrealised half)
//
// The realised difference is booked when a document is paid (moneda-origen).
// Until then a receivable, a payable or a bank balance kept in dollars sits in
// the books at the rates it was born with, and the balance sheet at the close
// says what the dollars were worth then, not now. This engine revalues those
// balances at the closing rate and posts the gap to the exchange gain and loss
// accounts, as the owner decided on #305:
//
//   · WHAT: the foreign-currency lines of the `cxc`, `cxp` and `banco` role
//     accounts and of every bank account's GL account, per account and
//     currency, read from the ledger's own FX columns (foreign balance vs its
//     functional book value) up to the period's last day.
//   · AT WHICH RATE: the one `closing_exchange_rate_source` chooses, for the
//     period's LAST CALENDAR DAY, exactly. A missing rate fails the run; it
//     never takes the previous business day.
//   · HOW: one `adjusting` entry with its own source_type (`fx_revaluation`,
//     never `closing`) on the last day, and its mirror on day 1 of the next
//     period, which must exist and be open. Reversing is what keeps the
//     realised difference of a later payment right: payments measure it
//     against the document's historical rate, so the book value must go back
//     to that rate once the balance sheet is dated. `sin_reversion` is not
//     offered until payments read the book rate instead (owner, 2026-09-26).
//   · ONCE: `fx_revaluation_runs` is the marker (migration 168). The ledger
//     cannot be, because a reversed original reads as "not done".
//
// The revaluation lines carry no FX columns: they move the functional value
// only, so the foreign balance the next run reads is untouched, and the lines
// are excluded from the book value it compares against. Since each one is
// reversed on day 1, a later period never sees it anyway.
// ============================================================

export const FX_REVALUATION_SOURCE = 'fx_revaluation';

/** closing_exchange_rate_source → the `exchange_rates.source` it reads, or null for the operations' one. */
const CLOSING_SOURCE: Record<string, string | null> = {
  operations_source: null,
  dof: 'dof',
  fix_banxico: 'banco_mexico',
};

export interface RevaluationLine {
  accountId: string;
  accountCode: string;
  currency: string;
  /** Foreign balance, debit positive. */
  foreignBalance: string;
  /** Its functional value in the books, debit positive. */
  bookBalance: string;
  rate: string;
  revaluedBalance: string;
  /** revalued − book: positive raises the balance's debit side (a gain on an asset). */
  difference: string;
}

export interface RevaluationRun {
  periodId: string;
  periodName: string;
  closingDate: string;
  reversalDate: string | null;
  rates: Array<TipoCambioResuelto & { currency: string }>;
  lines: RevaluationLine[];
  gain: string;
  loss: string;
  /** Set when the period was already revalued: nothing was computed or posted again. */
  alreadyRun: { journalEntryId: string; reversalEntryId: string } | null;
  entry: { id: string; number: string } | null;
  reversal: { id: string; number: string } | null;
}

/** The revaluation of one balance: foreign × rate, half-up to 4 places, minus its book value. */
export function revalue(foreign: string, book: string, rate: string): { revalued: string; difference: string } {
  const revalued = convertirAFuncional(foreign, rate);
  return { revalued, difference: new Decimal(revalued).minus(book).toFixed(4) };
}

/** Gain and loss totals of the lines: an increase of a debit balance or a decrease of a credit one is a gain. */
export function gainAndLoss(lines: Array<Pick<RevaluationLine, 'difference'>>): { gain: string; loss: string } {
  let gain = new Decimal(0);
  let loss = new Decimal(0);
  for (const l of lines) {
    const d = new Decimal(l.difference);
    if (d.greaterThan(0)) gain = gain.plus(d);
    else loss = loss.minus(d);
  }
  return { gain: gain.toFixed(4), loss: loss.toFixed(4) };
}

interface PeriodRow {
  id: string;
  period_name: string;
  period_type: string;
  status: string;
  end_date: string;
}

async function periodToRevalue(client: pg.PoolClient, entityId: string, periodId: string): Promise<PeriodRow> {
  // FOR UPDATE: two runs on the same period queue here, and the second one
  // finds the first one's marker instead of posting again.
  const r = await client.query<PeriodRow>(
    `SELECT id, period_name, period_type, status, to_char(end_date, 'YYYY-MM-DD') AS end_date
       FROM fiscal_periods WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
    [periodId, entityId]
  );
  const p = r.rows[0];
  if (!p) throw new NotFoundError('Fiscal period', periodId);
  if (p.period_type !== 'regular' || p.status !== 'open') {
    throw new AccountingError(
      'FX_REVALUATION_PERIOD_NOT_OPEN',
      `${p.period_name} is ${p.period_type} and ${p.status}: the revaluation belongs to an open regular ` +
        'month, before its close.'
    );
  }
  return p;
}

/** Day 1 of N+1, which must exist and be open: the mirror is never left for later. */
async function reversalPeriod(
  client: pg.PoolClient,
  entityId: string,
  period: PeriodRow
): Promise<{ id: string; startDate: string }> {
  const r = await client.query<{ id: string; status: string; start_date: string }>(
    `SELECT id, status, to_char(start_date, 'YYYY-MM-DD') AS start_date
       FROM fiscal_periods
      WHERE entity_id = $1 AND period_type = 'regular' AND start_date = $2::date + 1`,
    [entityId, period.end_date]
  );
  const next = r.rows[0];
  if (!next || next.status !== 'open') {
    throw new AccountingError(
      'FX_REVALUATION_NEXT_PERIOD_NOT_OPEN',
      `The revaluation of ${period.period_name} is reversed on the first day of the next period, and ` +
        (next ? `that period is ${next.status}.` : 'that period does not exist.') +
        ' Open it (in December, open the next fiscal year first) and run it again: nothing was posted.'
    );
  }
  return { id: next.id, startDate: next.start_date };
}

/** The foreign balances of receivables, payables and banks at the period's last day, per account and currency. */
async function foreignBalances(
  client: pg.PoolClient,
  entityId: string,
  closingDate: string,
  functional: string
): Promise<Array<{ account_id: string; code: string; currency: string; foreign: string; book: string }>> {
  const r = await client.query<{ account_id: string; code: string; currency: string; foreign: string; book: string }>(
    `WITH scope AS (
       SELECT account_id FROM account_roles
        WHERE entity_id = $1 AND role IN ('cxc', 'cxp', 'banco')
       UNION
       SELECT gl_account_id FROM bank_accounts WHERE entity_id = $1
     )
     SELECT l.account_id, a.code, l.currency_code AS currency,
            SUM(COALESCE(l.foreign_debit, 0) - COALESCE(l.foreign_credit, 0))::text AS foreign,
            SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))::text AS book
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id AND a.entity_id = je.entity_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND je.entry_date <= $2::date
        AND l.account_id IN (SELECT account_id FROM scope)
        AND l.currency_code IS NOT NULL AND l.currency_code <> $3
      GROUP BY l.account_id, a.code, l.currency_code
      ORDER BY a.code, l.currency_code`,
    [entityId, closingDate, functional]
  );
  return r.rows;
}

async function closingRate(
  client: pg.PoolClient,
  ctx: { tenantId: string; entityId: string },
  currency: string,
  functional: string,
  closingDate: string
): Promise<TipoCambioResuelto> {
  const policy = await getPolicy(ctx, 'closing_exchange_rate_source', client);
  if (!(policy.value in CLOSING_SOURCE)) {
    throw new AccountingError(
      'FX_POLITICA_DESCONOCIDA',
      `closing_exchange_rate_source is "${policy.value}" and this reader only understands ` +
        `${Object.keys(CLOSING_SOURCE).join(', ')}. Fix it with mnemosine pending.`
    );
  }
  const source = CLOSING_SOURCE[policy.value];
  return resolverTipoCambio(client, ctx, {
    de: currency,
    a: functional,
    fecha: closingDate,
    ...(source ? { source } : {}),
  });
}

async function roleAccount(client: pg.PoolClient, entityId: string, role: string): Promise<string> {
  const r = await client.query<{ account_id: string }>(
    'SELECT account_id FROM account_roles WHERE entity_id = $1 AND role = $2 AND qualifier IS NULL',
    [entityId, role]
  );
  if (!r.rows[0]) {
    throw new AccountingError('MISSING_ROLE_ACCOUNT', `No account is mapped to the role "${role}" in this entity.`);
  }
  return r.rows[0].account_id;
}

/**
 * Revalue the period's open foreign balances. With `dryRun` it computes and
 * checks everything the post needs (the rate, the next open period) and
 * writes nothing.
 */
export async function revalueForeignBalances(
  ctx: { tenantId: string; entityId: string },
  periodId: string,
  userId: string,
  opts: { dryRun?: boolean } = {}
): Promise<RevaluationRun> {
  const posted: string[] = [];
  const result = await withTransaction(async (client) => {
    const period = await periodToRevalue(client, ctx.entityId, periodId);
    const base: RevaluationRun = {
      periodId: period.id,
      periodName: period.period_name,
      closingDate: period.end_date,
      reversalDate: null,
      rates: [],
      lines: [],
      gain: '0.0000',
      loss: '0.0000',
      alreadyRun: null,
      entry: null,
      reversal: null,
    };

    const marker = await client.query<{ journal_entry_id: string; reversal_entry_id: string }>(
      'SELECT journal_entry_id, reversal_entry_id FROM fx_revaluation_runs WHERE entity_id = $1 AND fiscal_period_id = $2',
      [ctx.entityId, period.id]
    );
    if (marker.rows[0]) {
      return {
        ...base,
        alreadyRun: {
          journalEntryId: marker.rows[0].journal_entry_id,
          reversalEntryId: marker.rows[0].reversal_entry_id,
        },
      };
    }

    const next = await reversalPeriod(client, ctx.entityId, period);
    const functional = await functionalCurrencyOf(client, ctx.entityId);
    const balances = (await foreignBalances(client, ctx.entityId, period.end_date, functional)).filter(
      (b) => !new Decimal(b.foreign).isZero() || !new Decimal(b.book).isZero()
    );

    const rates = new Map<string, TipoCambioResuelto>();
    for (const currency of new Set(balances.map((b) => b.currency))) {
      rates.set(currency, await closingRate(client, ctx, currency, functional, period.end_date));
    }
    const lines: RevaluationLine[] = balances.map((b) => {
      const rate = (rates.get(b.currency) as TipoCambioResuelto).tasa;
      const { revalued, difference } = revalue(b.foreign, b.book, rate);
      return {
        accountId: b.account_id,
        accountCode: b.code,
        currency: b.currency,
        foreignBalance: new Decimal(b.foreign).toFixed(4),
        bookBalance: new Decimal(b.book).toFixed(4),
        rate,
        revaluedBalance: revalued,
        difference,
      };
    });
    const moving = lines.filter((l) => !new Decimal(l.difference).isZero());
    const run: RevaluationRun = {
      ...base,
      reversalDate: next.startDate,
      rates: [...rates.entries()].map(([currency, r]) => ({ currency, ...r })),
      lines,
      ...gainAndLoss(moving),
    };
    if (opts.dryRun || moving.length === 0) return run;

    const entryLines: EntryLine[] = moving.map((l) => {
      const amount = new Decimal(l.difference).abs().toFixed(4);
      const up = new Decimal(l.difference).greaterThan(0);
      return {
        account_id: l.accountId,
        debit_amount: up ? amount : null,
        credit_amount: up ? null : amount,
        description: `FX revaluation ${l.currency} ${l.foreignBalance} @ ${l.rate}`,
      };
    });
    if (new Decimal(run.gain).greaterThan(0)) {
      entryLines.push({
        account_id: await roleAccount(client, ctx.entityId, 'utilidad_cambiaria'),
        debit_amount: null,
        credit_amount: run.gain,
        description: 'Unrealised exchange gain (NIF B-15)',
      });
    }
    if (new Decimal(run.loss).greaterThan(0)) {
      entryLines.push({
        account_id: await roleAccount(client, ctx.entityId, 'perdida_cambiaria'),
        debit_amount: run.loss,
        credit_amount: null,
        description: 'Unrealised exchange loss (NIF B-15)',
      });
    }

    const entry: JournalEntry = await createJournalEntry(
      ctx.entityId,
      period.end_date,
      JournalEntryType.ADJUSTING,
      `FX revaluation ${period.period_name} at the ${period.end_date} closing rate`,
      entryLines,
      userId,
      { autoPost: true, client, sourceType: FX_REVALUATION_SOURCE, sourceId: period.id, fiscalPeriodId: period.id }
    );
    const reversal = await reverseWithinTransaction(
      client,
      entry,
      userId,
      `Reversal of ${entry.entry_number}: FX revaluation of ${period.period_name}, reversed on day 1`,
      next.startDate,
      next.id
    );
    await client.query(
      `INSERT INTO fx_revaluation_runs
         (entity_id, fiscal_period_id, journal_entry_id, reversal_entry_id, rate_date, rates, created_by)
       VALUES ($1, $2, $3, $4, $5::date, $6::jsonb, $7)`,
      [
        ctx.entityId,
        period.id,
        entry.id,
        reversal.id,
        period.end_date,
        JSON.stringify(Object.fromEntries(run.rates.map((r) => [r.currency, { rate: r.tasa, source: r.fuente }]))),
        userId,
      ]
    );
    posted.push(entry.id, reversal.id);
    return {
      ...run,
      entry: { id: entry.id, number: entry.entry_number },
      reversal: { id: reversal.id, number: reversal.entry_number },
    };
  });
  // Attestation must see committed data: after the transaction, never inside it.
  for (const id of posted) attestEntryAsync(ctx.tenantId, ctx.entityId, id);
  return result;
}
