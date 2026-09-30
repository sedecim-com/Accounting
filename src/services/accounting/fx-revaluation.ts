import Decimal from 'decimal.js';
import type pg from 'pg';
import { query, withTransaction } from '../../database/connection.js';
import { createJournalEntry, reverseWithinTransaction, attestEntryAsync } from './posting.js';
import { convertirAFuncional, functionalCurrencyOf, resolverTipoCambio, type TipoCambioResuelto } from './moneda-origen.js';
import { FX_REVALUATION_POLICY_KEYS, getPolicy } from '../policy/policy-service.js';
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
//     period, which must exist and be open. Whether to reverse is the panel's
//     `fx_revaluation_reversal`, whose one option today is `reverse_on_day_one`:
//     payments measure the realised difference against the document's
//     historical rate, so the book value must go back to that rate once the
//     balance sheet is dated. The mirror carries no source_type of its own; it
//     is found by `reverses_entry_id` or by the marker's `reversal_entry_id`.
//   · WHEN: on an open or soft-closed month. A soft close still accepts
//     adjusting postings until the seal, and it is where the run belongs, once
//     the cutoff has frozen the balances.
//   · ONCE, AND NEVER STALE: `fx_revaluation_runs` is the marker (migration
//     168); the ledger cannot be, because a reversed original reads as "not
//     done". Each run recomputes and subtracts what the earlier runs of the
//     period posted, so a foreign posting dated inside the period after the
//     first run is revalued by a supplementary entry (with its own mirror), and
//     nothing is ever posted twice.
//   · MXN ONLY: another functional currency, and ASC 830, are #124.
//
// The revaluation lines carry no FX columns: they move the functional value
// only, so the foreign balance the next run reads is untouched, and the lines
// are excluded from the book value it compares against. Since each one is
// reversed on day 1, a later period never sees it anyway.
// ============================================================

export const FX_REVALUATION_SOURCE = 'fx_revaluation';

/** The functional currency this engine was built and cited for (NIF B-15). */
const SUPPORTED_FUNCTIONAL = 'MXN';

/** closing_exchange_rate_source → the `exchange_rates.source` it reads, or null for the operations' one. */
const CLOSING_SOURCE: Record<string, string | null> = {
  operations_source: null,
  dof: 'dof',
  fix_banxico: 'banco_mexico',
};

/** fx_revaluation_reversal values this reader understands. Anything else fails closed. */
// TODO(#305): offer no_reversal once payments measure the realised difference against the book rate.
const REVERSAL_POLICY: ReadonlySet<string> = new Set(['reverse_on_day_one']);

/** A soft close still accepts adjusting postings until the seal: that is where the run belongs. */
const REVALUABLE_STATUSES: ReadonlySet<string> = new Set(['open', 'soft_close']);

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
  /** What earlier runs of this period already posted on this balance. */
  alreadyPosted: string;
  /** revalued − book − already posted: positive raises the balance's debit side (a gain on an asset). */
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
  /** Set when the period was already revalued and nothing moved since: nothing was posted again. */
  alreadyRun: { journalEntryId: string; reversalEntryId: string; sequence: number } | null;
  /** The run's number within the period (1, then one per supplement); null when nothing is to be posted. */
  sequence: number | null;
  entry: { id: string; number: string } | null;
  reversal: { id: string; number: string } | null;
}

/**
 * The revaluation of one balance: foreign × rate, half-up to 4 places, minus
 * its book value and minus what earlier runs of the period already posted.
 */
export function revalue(
  foreign: string,
  book: string,
  rate: string,
  alreadyPosted = '0'
): { revalued: string; difference: string } {
  const revalued = convertirAFuncional(foreign, rate);
  return { revalued, difference: new Decimal(revalued).minus(book).minus(alreadyPosted).toFixed(4) };
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

export interface PostedLine {
  accountId: string;
  accountCode: string;
  currency: string;
  difference: string;
}

/** What the earlier runs of the period posted, per `account|currency`. */
export function postedSoFar(runs: Array<{ lines: PostedLine[] }>): Map<string, { accountCode: string; posted: string }> {
  const byBalance = new Map<string, { accountCode: string; posted: string }>();
  for (const run of runs) {
    for (const l of run.lines) {
      const key = `${l.accountId}|${l.currency}`;
      const before = byBalance.get(key)?.posted ?? '0';
      byBalance.set(key, { accountCode: l.accountCode, posted: new Decimal(before).plus(l.difference).toFixed(4) });
    }
  }
  return byBalance;
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
  // reads the first one's marker instead of posting again.
  const r = await client.query<PeriodRow>(
    `SELECT id, period_name, period_type, status, to_char(end_date, 'YYYY-MM-DD') AS end_date
       FROM fiscal_periods WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
    [periodId, entityId]
  );
  const p = r.rows[0];
  if (!p) throw new NotFoundError('Fiscal period', periodId);
  if (p.period_type !== 'regular' || !REVALUABLE_STATUSES.has(p.status)) {
    throw new AccountingError('FX_REVALUATION_PERIOD_NOT_OPEN', {
      key: 'error.FX_REVALUATION_PERIOD_NOT_OPEN',
      params: { period: p.period_name, type: p.period_type, status: p.status },
    });
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
    throw new AccountingError('FX_REVALUATION_NEXT_PERIOD_NOT_OPEN', {
      key: 'error.FX_REVALUATION_NEXT_PERIOD_NOT_OPEN',
      params: { period: period.period_name, status: next ? next.status : 'missing' },
    });
  }
  return { id: next.id, startDate: next.start_date };
}

interface Balance {
  account_id: string;
  code: string;
  currency: string;
  foreign: string;
  book: string;
}

/** The foreign balances of receivables, payables and banks at the period's last day, per account and currency. */
async function foreignBalances(
  client: pg.PoolClient,
  entityId: string,
  closingDate: string,
  functional: string
): Promise<Balance[]> {
  const r = await client.query<Balance>(
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
  closingDate: string,
  /** The source an earlier run of the period measured at: it wins over the panel. */
  fixedSource?: string
): Promise<TipoCambioResuelto> {
  if (fixedSource) return resolverTipoCambio(client, ctx, { de: currency, a: functional, fecha: closingDate, source: fixedSource });
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

/** fx_revaluation_reversal, read and checked: an unknown value fails closed instead of skipping the mirror. */
async function assertReversalPolicy(client: pg.PoolClient, ctx: { tenantId: string; entityId: string }): Promise<void> {
  const policy = await getPolicy(ctx, 'fx_revaluation_reversal', client);
  if (!REVERSAL_POLICY.has(policy.value)) {
    throw new AccountingError(
      'FX_POLITICA_DESCONOCIDA',
      `fx_revaluation_reversal is "${policy.value}" and this reader only understands ` +
        `${[...REVERSAL_POLICY].join(', ')}. Fix it with mnemosine pending.`
    );
  }
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

interface PriorRun {
  sequence: number;
  journal_entry_id: string;
  reversal_entry_id: string;
  lines: PostedLine[];
  /** Per currency, the rate and the source it was read from. */
  rates: Record<string, { rate: string; source: string }>;
}

/**
 * MNE-001-112 · the source a period's first run fixed, per currency. A
 * supplement measures at it, not at whatever the panel says today: one
 * period's balance sheet at two closing rates is not a revaluation. It is
 * what lets `closing_exchange_rate_source` change at the start of a fiscal
 * year while the past year's last months are still live (see
 * `assertNoLiveRevaluation`). A currency the earlier runs did not see takes
 * the one source they used; with none recorded, or several, the panel rules.
 */
export function sourcesFixedBy(prior: Array<Pick<PriorRun, 'rates'>>): (currency: string) => string | undefined {
  const recorded = new Map<string, string>();
  for (const run of prior) {
    for (const [currency, r] of Object.entries(run.rates ?? {})) {
      if (!recorded.has(currency)) recorded.set(currency, r.source);
    }
  }
  const all = new Set(recorded.values());
  const single = all.size === 1 ? [...all][0] : undefined;
  return (currency) => recorded.get(currency) ?? single;
}

/**
 * The marker is trusted only as far as the ledger (inviolable since migration
 * 041) agrees with it: the period's `fx_revaluation` entries must be exactly
 * the rows' entries, and their net per revalued account what the rows say. A
 * deleted, repointed or rewritten row would otherwise let the run post again.
 */
async function assertMarkerMatchesLedger(
  client: pg.PoolClient,
  entityId: string,
  period: PeriodRow,
  prior: PriorRun[]
): Promise<void> {
  const entries = await client.query<{ id: string }>(
    `SELECT id FROM journal_entries
      WHERE entity_id = $1 AND source_type = $2 AND source_id = $3 AND status = 'posted'`,
    [entityId, FX_REVALUATION_SOURCE, period.id]
  );
  const inLedger = new Set(entries.rows.map((r) => r.id));
  const inMarker = new Set(prior.map((r) => r.journal_entry_id));
  let agrees = inLedger.size === inMarker.size && [...inMarker].every((id) => inLedger.has(id));
  if (agrees && inLedger.size > 0) {
    // The gain and loss lines are the counterpart, not a revalued balance.
    const net = await client.query<{ account_id: string; net: string }>(
      `SELECT account_id, SUM(COALESCE(debit_amount, 0) - COALESCE(credit_amount, 0))::text AS net
         FROM journal_entry_lines
        WHERE journal_entry_id = ANY($1::uuid[])
          AND account_id NOT IN (SELECT account_id FROM account_roles
                                  WHERE entity_id = $2 AND role IN ('utilidad_cambiaria', 'perdida_cambiaria'))
        GROUP BY account_id`,
      [[...inLedger], entityId]
    );
    const markerNet = new Map<string, Decimal>();
    for (const run of prior) {
      for (const l of run.lines) {
        markerNet.set(l.accountId, (markerNet.get(l.accountId) ?? new Decimal(0)).plus(l.difference));
      }
    }
    const ledgerNet = new Map(net.rows.map((r) => [r.account_id, new Decimal(r.net)]));
    const accounts = new Set([...markerNet.keys(), ...ledgerNet.keys()]);
    agrees = [...accounts].every((a) => (ledgerNet.get(a) ?? new Decimal(0)).equals(markerNet.get(a) ?? new Decimal(0)));
  }
  if (!agrees) {
    throw new AccountingError('FX_REVALUATION_MARKER_MISMATCH', {
      key: 'error.FX_REVALUATION_MARKER_MISMATCH',
      params: { period: period.period_name, ledger: inLedger.size, marker: inMarker.size },
    });
  }
}

/**
 * Revalue the period's open foreign balances. With `dryRun` it computes and
 * checks everything the post needs (the rate, the next open period) and
 * writes nothing. `expect` is the gain and loss the user confirmed on the
 * plan: a live run whose recomputation differs posts nothing.
 */
export async function revalueForeignBalances(
  ctx: { tenantId: string; entityId: string },
  periodId: string,
  userId: string,
  opts: { dryRun?: boolean; expect?: { gain: string; loss: string } } = {}
): Promise<RevaluationRun> {
  const toAttest: string[] = [];
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
      sequence: null,
      entry: null,
      reversal: null,
    };

    const prior = (
      await client.query<PriorRun>(
        `SELECT sequence, journal_entry_id, reversal_entry_id, lines, rates
           FROM fx_revaluation_runs WHERE entity_id = $1 AND fiscal_period_id = $2
          ORDER BY sequence`,
        [ctx.entityId, period.id]
      )
    ).rows;
    await assertMarkerMatchesLedger(client, ctx.entityId, period, prior);
    const posted = postedSoFar(prior);
    const last = prior.at(-1);

    // Read against the entity's own functional currency: for an entity in one
    // this engine does not know (only MXN), any balance tagged with another
    // currency (MXN included) is something it cannot revalue, and saying so
    // beats skipping it. Nothing tagged is nothing to refuse.
    const functional = await functionalCurrencyOf(client, ctx.entityId);
    const ledger = await foreignBalances(client, ctx.entityId, period.end_date, functional);
    if (functional !== SUPPORTED_FUNCTIONAL && (ledger.length > 0 || prior.length > 0)) {
      throw new AccountingError('FX_REVALUATION_FUNCTIONAL_NOT_SUPPORTED', {
        key: 'error.FX_REVALUATION_FUNCTIONAL_NOT_SUPPORTED',
        params: { currency: functional },
      });
    }
    // A balance an earlier run revalued and that has left the ledger since
    // (paid in full) still needs that revaluation taken back.
    const inLedger = new Set(ledger.map((b) => `${b.account_id}|${b.currency}`));
    for (const [key, p] of posted) {
      if (inLedger.has(key)) continue;
      const [accountId, currency] = key.split('|');
      ledger.push({ account_id: accountId, code: p.accountCode, currency, foreign: '0', book: '0' });
    }
    const balances = ledger
      .map((b) => ({ ...b, posted: posted.get(`${b.account_id}|${b.currency}`)?.posted ?? '0.0000' }))
      .filter((b) => ![b.foreign, b.book, b.posted].every((v) => new Decimal(v).isZero()));
    // MNE-001-112: nothing in a foreign currency is nothing to revalue, and it
    // asks for no rate, no reversal policy and no open next period. The close
    // conductor runs this step on every entity, most of which never touch a
    // dollar: a December without the next year opened must still close.
    if (balances.length === 0) return base;

    await assertReversalPolicy(client, ctx);
    const next = await reversalPeriod(client, ctx.entityId, period);

    const fixed = sourcesFixedBy(prior);
    const rates = new Map<string, TipoCambioResuelto>();
    for (const currency of new Set(balances.map((b) => b.currency))) {
      rates.set(
        currency,
        await closingRate(client, ctx, currency, SUPPORTED_FUNCTIONAL, period.end_date, fixed(currency))
      );
    }
    const lines: RevaluationLine[] = balances.map((b) => {
      const rate = (rates.get(b.currency) as TipoCambioResuelto).tasa;
      const { revalued, difference } = revalue(b.foreign, b.book, rate, b.posted);
      return {
        accountId: b.account_id,
        accountCode: b.code,
        currency: b.currency,
        foreignBalance: new Decimal(b.foreign).toFixed(4),
        bookBalance: new Decimal(b.book).toFixed(4),
        rate,
        revaluedBalance: revalued,
        alreadyPosted: b.posted,
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
    if (moving.length === 0) {
      if (!last) return run;
      return {
        ...run,
        alreadyRun: { journalEntryId: last.journal_entry_id, reversalEntryId: last.reversal_entry_id, sequence: last.sequence },
      };
    }
    const sequence = (last?.sequence ?? 0) + 1;
    if (opts.dryRun) return { ...run, sequence };
    if (opts.expect && (opts.expect.gain !== run.gain || opts.expect.loss !== run.loss)) {
      throw new AccountingError('FX_REVALUATION_PLAN_CHANGED', {
        key: 'error.FX_REVALUATION_PLAN_CHANGED',
        params: {
          period: period.period_name,
          expectedGain: opts.expect.gain,
          expectedLoss: opts.expect.loss,
          gain: run.gain,
          loss: run.loss,
        },
      });
    }

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
      `FX revaluation ${period.period_name} at the ${period.end_date} closing rate` +
        (sequence > 1 ? ` (supplement ${sequence})` : ''),
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
    const postedLines: PostedLine[] = moving.map((l) => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      currency: l.currency,
      difference: l.difference,
    }));
    await client.query(
      `INSERT INTO fx_revaluation_runs
         (entity_id, fiscal_period_id, journal_entry_id, reversal_entry_id, sequence, rate_date, rates, lines, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7::jsonb, $8::jsonb, $9)`,
      [
        ctx.entityId,
        period.id,
        entry.id,
        reversal.id,
        sequence,
        period.end_date,
        JSON.stringify(Object.fromEntries(run.rates.map((r) => [r.currency, { rate: r.tasa, source: r.fuente }]))),
        JSON.stringify(postedLines),
        userId,
      ]
    );
    toAttest.push(entry.id, reversal.id);
    return {
      ...run,
      sequence,
      entry: { id: entry.id, number: entry.entry_number },
      reversal: { id: reversal.id, number: reversal.entry_number },
    };
  });
  // Attestation must see committed data: after the transaction, never inside it.
  for (const id of toAttest) attestEntryAsync(ctx.tenantId, ctx.entityId, id);
  return result;
}

/**
 * The adjusting entries the period's revaluation runs posted, read from the
 * marker. The close conductor records them: the ledger alone cannot say,
 * because every revaluation is reversed on day 1 by design.
 */
export async function revaluationEntriesOf(entityId: string, periodId: string): Promise<string[]> {
  const r = await query<{ journal_entry_id: string }>(
    `SELECT journal_entry_id FROM fx_revaluation_runs
      WHERE entity_id = $1 AND fiscal_period_id = $2 ORDER BY sequence`,
    [entityId, periodId]
  );
  return r.rows.map((x) => x.journal_entry_id);
}

/**
 * MNE-001-112 · the owner's transition rule (#305, 2026-09-26): a key the
 * revaluation reads changes only at the start of the fiscal year, or when no
 * revaluation is live. Both halves, per entity the row governs:
 *
 *  · NO REVALUATION LIVE: every period with a revaluation run is hard-closed.
 *    Until the seal a late foreign posting can still call for a supplement,
 *    and a supplement under the new key would measure one period's balance
 *    sheet with two criteria.
 *  · THE START OF A FISCAL YEAR: some fiscal year of the entity has no run in
 *    it or after it, and every regular period before it is either revalued or
 *    hard-closed. The old key measured the whole past year and the new one
 *    measures the whole new year; no month of either is left to be measured
 *    by the other. What stays live from the past year is kept at its own
 *    source by the engine (`sourcesFixedBy`): a supplement measures at the
 *    source the period's first run used, not at the new key. The rule reads
 *    the ledger, not the clock.
 *
 * The scope follows the row being written: an entity's row checks that
 * entity; the tenant's row checks the entities it governs, which are those
 * without a row of their own for the key.
 */
export async function assertNoLiveRevaluation(
  ctx: { tenantId: string; entityId?: string },
  key: string
): Promise<void> {
  if (!FX_REVALUATION_POLICY_KEYS.has(key)) return;
  const r = await query<{ period_name: string; entity_name: string }>(
    `SELECT fp.period_name, le.name AS entity_name
       FROM fx_revaluation_runs run
       JOIN fiscal_periods fp ON fp.id = run.fiscal_period_id AND fp.entity_id = run.entity_id
       JOIN legal_entities le ON le.id = run.entity_id
      WHERE le.tenant_id = $1
        AND ($2::uuid IS NOT NULL OR NOT EXISTS (
              SELECT 1 FROM policy_decisions pd
               WHERE pd.tenant_id = le.tenant_id AND pd.entity_id = run.entity_id AND pd.key = $3))
        AND ($2::uuid IS NULL OR run.entity_id = $2::uuid)
        AND fp.status <> 'hard_close'
        AND NOT EXISTS (
              SELECT 1 FROM fiscal_years fy
               WHERE fy.entity_id = run.entity_id
                 AND NOT EXISTS (
                       SELECT 1 FROM fx_revaluation_runs later
                         JOIN fiscal_periods lp ON lp.id = later.fiscal_period_id AND lp.entity_id = later.entity_id
                        WHERE later.entity_id = run.entity_id AND lp.end_date >= fy.start_date)
                 AND NOT EXISTS (
                       SELECT 1 FROM fiscal_periods pp
                        WHERE pp.entity_id = run.entity_id AND pp.period_type = 'regular'
                          AND pp.end_date < fy.start_date AND pp.status <> 'hard_close'
                          AND NOT EXISTS (SELECT 1 FROM fx_revaluation_runs pr
                                           WHERE pr.entity_id = pp.entity_id AND pr.fiscal_period_id = pp.id)))
      ORDER BY fp.start_date, le.name
      LIMIT 1`,
    [ctx.tenantId, ctx.entityId ?? null, key]
  );
  const live = r.rows[0];
  if (live) {
    throw new AccountingError('FX_REVALUATION_KEY_LOCKED', {
      key: 'error.FX_REVALUATION_KEY_LOCKED',
      params: { policy: key, period: live.period_name, entity: live.entity_name },
    });
  }
}

// ============================================================
// MNE-001-112 · WHAT `ar reconcile` AND `ap reconcile` NEED TO READ A
// FOREIGN-CURRENCY SUBLEDGER
//
// A document's `amount_due` is in its own currency, and the control account
// is in the functional one. The control carries an open foreign document at
// the rate it was born with (bills.exchange_rate, invoices.exchange_rate as
// MNE-001-081 writes it back), because payments book the realised difference
// against that same rate. So the subledger's book value is `amount_due ×
// exchange_rate`, rounded as `convertirAFuncional` rounds a posting.
//
// And between the close and day 1 the control also carries the revaluation:
// an entry of this engine, or its mirror, is neither a document nor a manual
// entry. The reconciliations show it as its own line.
// ============================================================

/**
 * SQL: the book value of a document's open balance in the functional
 * currency. `alias` is the document table's alias, `entityParam` the
 * placeholder of the entity id (the functional currency is read in the SQL).
 */
export function bookAmountDueSql(alias: string, entityParam: string): string {
  return (
    `CASE WHEN ${alias}.currency_code IS NULL OR ${alias}.currency_code = ` +
    `(SELECT functional_currency FROM legal_entities WHERE id = ${entityParam}) ` +
    `THEN ${alias}.amount_due ELSE ROUND(${alias}.amount_due * ${alias}.exchange_rate, 4) END`
  );
}

/** Open foreign documents per currency: what the subledger holds in each, and at what book value. */
export interface ForeignOpen {
  currency: string;
  foreign: string;
  book: string;
}

/**
 * Net debit − credit that revaluation entries and their mirrors leave on an
 * account up to `asOf` (every date when omitted). The revaluation of a closed
 * month is live until its day-1 mirror.
 */
export async function revaluationOnAccount(entityId: string, accountId: string, asOf?: string): Promise<Decimal> {
  const r = await query<{ net: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0)::text AS net
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND jel.account_id = $2
        AND ($3::date IS NULL OR je.entry_date <= $3::date)
        AND (je.source_type = $4 OR EXISTS (
              SELECT 1 FROM journal_entries orig
               WHERE orig.id = je.reverses_entry_id AND orig.entity_id = je.entity_id
                 AND orig.source_type = $4))`,
    [entityId, accountId, asOf ?? null, FX_REVALUATION_SOURCE]
  );
  return new Decimal(r.rows[0]?.net ?? '0');
}
