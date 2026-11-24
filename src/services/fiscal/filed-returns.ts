import Decimal from 'decimal.js';
import type pg from 'pg';
import { query, withTransaction } from '../../database/connection.js';
import type { EntityScope } from '../../database/scope.js';
import type { MessageParams, TranslationKey } from '../../i18n/index.js';
import { isRealCalendarDate } from '../../utils/calendar-date.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';

// ============================================================
// THE RECORD OF FILED RETURNS: ITS WRITER AND ITS READER (#308 · MNE-001-576)
//
// Migration 337 keeps one append-only row per return a person filed with the
// SAT, and one per earlier balance in favour that return credited. This
// module is the only door to them, on the pattern of 166's service:
//
//   · recordFiledReturn writes a monthly IVA return and its credits in ONE
//     transaction. The provisional ISR fits the same table, but its writer is
//     not this task's. Its two doors are `filing record` and, for an amended
//     return, `filing correct` (MNE-001-629).
//   · filedReturnInForce reads the last link of a period's chain: an amended
//     return («complementaria», CFF art. 32) replaces the one before it, and
//     the return in force is the one nobody replaces.
//   · balancesInFavorBefore (MNE-001-386) reads, for the IVA workpaper, each
//     earlier balance and what was already credited, compensated or asked
//     back from it.
//
// THE RULES ARE SAID BY KEY, in en and es, before Postgres says them as a
// constraint name: dates that are not days, a return filed before its month
// ends, a payment before the filing, an amount payable together with a
// balance in favour, more than two decimals. Two rules between rows that the
// schema cannot hold are this module's: an amendment is filed on or after
// the day of the return it replaces, and a credit (LIVA art. 6) comes from a
// return of an EARLIER month that left a balance in favour. The three UNIQUE
// violations (the acknowledgement, the period's original, the replaced
// return) are a race the pre-checks cannot close, so they are put into words
// when Postgres raises them.
//
// A CREDIT TAKES NO MORE THAN IS LEFT (MNE-001-613, LIVA art. 6). Inside the
// transaction that writes, the writer runs once the query of
// balancesInFavorBefore, the workpaper's reader, and refuses a credit above
// what its source period still holds after the returns in force of other
// periods, the compensations and a refund request. An amendment that lowers a balance below what others
// already used is refused too, naming them: the later returns are amended
// first (CFF art. 32). Every write of an entity's record of one tax takes the
// advisory lock `filed_tax_returns:<entity>:<obligation>` first, so two
// filings that credit one balance run one after the other; the writer of
// tax_balance_uses, when it comes, takes the same lock. The cap at the
// month's tax payable stays the workpaper's (prior-balance.ts): this writer
// records what was filed and does not know that tax.
//
// The entity and the user are bound inside each statement to the scope's
// tenant, so a foreign entity answers 404, never null and never a row.
// ============================================================

export type FiledReturnObligation = 'iva_monthly' | 'isr_provisional';

/** One earlier balance in favour the return credited, named by its acknowledgement. */
export interface FiledReturnCreditInput {
  /** The operation number of the return that generated the balance. */
  sourceAcknowledgement: string;
  /** Decimal string above zero, up to two places. */
  amount: string;
}

export interface FiledReturnFiling {
  /** Only `iva_monthly` is written for now. */
  obligation: FiledReturnObligation;
  /** The month the return covers, YYYY-MM. */
  period: string;
  /** YYYY-MM-DD, after the month ends. */
  filedOn: string;
  /** The operation number on the SAT's acknowledgement («número de operación del acuse»). */
  acknowledgementNumber: string;
  /** The payment reference («línea de captura»), when the return has something to pay. */
  captureLine?: string;
  /** Decimal strings, zero or more, up to two places; never both above zero. Default 0. */
  amountPayable?: string;
  balanceInFavor?: string;
  /** What was paid with this return's capture line, and when: both or neither. */
  amountPaid?: string;
  paidOn?: string;
  /** Set for an amended return: the acknowledgement of the return in force it replaces. */
  replacesAcknowledgement?: string;
  credits?: FiledReturnCreditInput[];
  /** A user of the scope's tenant; any other answers 404. */
  recordedBy?: string;
}

export interface FiledReturnCredit {
  sourceAcknowledgement: string;
  /** YYYY-MM */
  sourcePeriod: string;
  amount: string;
}

export interface FiledReturn {
  id: string;
  obligation: FiledReturnObligation;
  /** YYYY-MM */
  period: string;
  returnType: 'original' | 'amended';
  replacesAcknowledgement: string | null;
  filedOn: string;
  acknowledgementNumber: string;
  captureLine: string | null;
  amountPayable: string;
  balanceInFavor: string;
  amountPaid: string | null;
  paidOn: string | null;
  recordedAt: string;
  credits: FiledReturnCredit[];
}

const OBLIGATIONS: readonly FiledReturnObligation[] = ['iva_monthly', 'isr_provisional'];
const WRITTEN: readonly FiledReturnObligation[] = ['iva_monthly'];
const ISO_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** DECIMAL(19,2): seventeen digits before the point and two after (migration 337). */
const AMOUNT = /^\d{1,17}(\.\d{1,2})?$/;

/** The UNIQUE constraints of migration 337 a filing can break, and the key that says each. */
const UNIQUE_KEYS: Readonly<Record<string, TranslationKey>> = {
  filed_tax_return_acknowledgement_once: 'filed_return.acknowledgement_taken',
  filed_tax_return_one_original: 'filed_return.original_exists',
  filed_tax_return_replaced_once: 'filed_return.already_replaced',
};

/** A return already recorded that the filing names, as the lookup reads it. */
interface Referenced {
  id: string;
  acknowledgementNumber: string;
  period: string;
  filedOn: string;
  balanceInFavor: string;
}

/**
 * Records one filed return and the earlier balances it credited, in one
 * transaction: the caller's when `client` is given, a new one otherwise.
 * Never overwrites: an amended return is a new row that names the one in
 * force it replaces.
 */
export async function recordFiledReturn(
  scope: EntityScope,
  filing: FiledReturnFiling,
  client?: pg.PoolClient
): Promise<FiledReturn> {
  assertFiling(filing);
  const write = (c: pg.PoolClient) => writeFiling(c, scope, filing);
  return client ? write(client) : withTransaction(write);
}

/**
 * The return in force of a period: the link of its chain that no amended
 * return replaces, with the credits it took. Null when the entity recorded
 * nothing for that period. An entity outside the scope's tenant answers 404,
 * never null.
 */
export async function filedReturnInForce(
  scope: EntityScope,
  obligation: FiledReturnObligation,
  period: string,
  client?: pg.PoolClient
): Promise<FiledReturn | null> {
  if (!OBLIGATIONS.includes(obligation)) {
    throw invalid('obligation', 'filed_return.obligation_invalid', { value: obligation, obligations: OBLIGATIONS.join(', ') });
  }
  assertPeriod(period);
  const r = await run(client)<Partial<FiledReturn>>(
    `SELECT t.* FROM legal_entities le
       LEFT JOIN LATERAL (
         ${RETURN_SELECT}
          WHERE r.entity_id = le.id AND r.obligation = $3 AND r.period = $4::date
            AND NOT EXISTS (SELECT 1 FROM filed_tax_returns n WHERE n.replaces_return_id = r.id)
          LIMIT 1
       ) t ON true
      WHERE le.id = $1 AND le.tenant_id = $2`,
    [scope.entityId, scope.tenantId, obligation, `${period}-01`]
  );
  if (r.rows.length === 0) throw new NotFoundError('Entity', scope.entityId);
  const row = r.rows[0];
  return row.id ? (row as FiledReturn) : null;
}

/** An earlier period's balance in favour, with what the record says was already done with it. */
export interface BalanceInFavorSource {
  /** The return in force of that period. */
  acknowledgementNumber: string;
  /** YYYY-MM */
  period: string;
  filedOn: string;
  balanceInFavor: string;
  /** Credited by the returns in force of every period but the one being prepared. */
  credited: string;
  compensated: string;
  refundRequested: string;
}

/**
 * The balances in favour of the periods before `period`, oldest first: the
 * return in force of each, with what the returns in force of OTHER periods
 * credited from its chain and what was compensated or asked as a refund.
 * Summed by the source period, not the source row: a credit taken from a
 * return later amended still draws on that period's balance. A replaced
 * return's credits do not count: its amendment restates its own. What is
 * still available, and the cap, are the workpaper's (prior-balance.ts).
 * A foreign entity answers 404, never an empty list.
 */
export async function balancesInFavorBefore(
  scope: EntityScope,
  obligation: FiledReturnObligation,
  period: string,
  client?: pg.PoolClient
): Promise<BalanceInFavorSource[]> {
  assertPeriod(period);
  return readBalances(scope, obligation, period, false, client);
}

/** What a balance still holds to credit, never below zero (LIVA art. 6, CFF art. 23). */
export function availableOf(s: BalanceInFavorSource): Decimal {
  if (new Decimal(s.refundRequested).greaterThan(0)) return new Decimal(0);
  return Decimal.max(new Decimal(s.balanceInFavor).minus(s.credited).minus(s.compensated), 0);
}

/**
 * The reader's query. `including` also returns `period`'s own row, with what
 * the returns in force of other periods took from it: the use an amendment
 * of that period must still cover.
 */
async function readBalances(
  scope: EntityScope,
  obligation: FiledReturnObligation,
  period: string,
  including: boolean,
  client?: pg.PoolClient
): Promise<BalanceInFavorSource[]> {
  const r = await run(client)<Partial<BalanceInFavorSource>>(
    `WITH in_force AS (
       SELECT r.* FROM filed_tax_returns r
        WHERE r.entity_id = $1 AND r.obligation = $3
          AND NOT EXISTS (SELECT 1 FROM filed_tax_returns n WHERE n.replaces_return_id = r.id)
     ), credited AS (
       SELECT c.source_period, SUM(c.amount) AS amount FROM filed_tax_return_credits c
         JOIN in_force f ON f.id = c.return_id
        WHERE f.period <> $4::date GROUP BY c.source_period
     ), used AS (
       SELECT u.source_period, SUM(u.amount) FILTER (WHERE u.kind = 'compensation') AS compensated,
              SUM(u.amount) FILTER (WHERE u.kind = 'refund_request') AS refund
         FROM tax_balance_uses u WHERE u.entity_id = $1 AND u.obligation = $3 GROUP BY u.source_period
     ), sources AS (
       SELECT s.entity_id, s.acknowledgement_number AS "acknowledgementNumber",
              to_char(s.period, 'YYYY-MM') AS period, to_char(s.filed_on, 'YYYY-MM-DD') AS "filedOn",
              s.balance_in_favor::text AS "balanceInFavor", COALESCE(cr.amount, 0)::numeric(19,2)::text AS credited,
              COALESCE(us.compensated, 0)::numeric(19,2)::text AS compensated,
              COALESCE(us.refund, 0)::numeric(19,2)::text AS "refundRequested"
         FROM in_force s
         LEFT JOIN credited cr ON cr.source_period = s.period
         LEFT JOIN used us ON us.source_period = s.period
        WHERE (s.period < $4::date OR ($5::boolean AND s.period = $4::date))
          AND (s.balance_in_favor > 0 OR cr.amount > 0 OR us.compensated > 0 OR us.refund > 0)
     )
     SELECT x."acknowledgementNumber", x.period, x."filedOn", x."balanceInFavor", x.credited, x.compensated,
            x."refundRequested"
       FROM legal_entities le LEFT JOIN sources x ON x.entity_id = le.id
      WHERE le.id = $1 AND le.tenant_id = $2
      ORDER BY x.period`,
    [scope.entityId, scope.tenantId, obligation, `${period}-01`, including]
  );
  if (r.rows.length === 0) throw new NotFoundError('Entity', scope.entityId);
  return r.rows.filter((x) => x.acknowledgementNumber) as BalanceInFavorSource[];
}

async function writeFiling(c: pg.PoolClient, scope: EntityScope, f: FiledReturnFiling): Promise<FiledReturn> {
  const credits = (f.credits ?? []).map((x) => ({ ack: x.sourceAcknowledgement.trim(), amount: x.amount }));
  const replaces = f.replacesAcknowledgement?.trim();
  const named = [...new Set([...credits.map((x) => x.ack), ...(replaces ? [replaces] : [])])];

  // Who and what the filing names, read in the same transaction it is written
  // in. Filed rows never change, so what is read here stays true.
  const lookup = await c.query<{ entityFound: boolean; userFound: boolean; refs: Referenced[] }>(
    `SELECT EXISTS (SELECT 1 FROM legal_entities WHERE id = $1 AND tenant_id = $2) AS "entityFound",
            ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM users WHERE id = $3::uuid AND tenant_id = $2)) AS "userFound",
            COALESCE((
              SELECT json_agg(json_build_object(
                       'id', r.id, 'acknowledgementNumber', r.acknowledgement_number,
                       'period', to_char(r.period, 'YYYY-MM'), 'filedOn', to_char(r.filed_on, 'YYYY-MM-DD'),
                       'balanceInFavor', r.balance_in_favor::text))
                FROM filed_tax_returns r
                JOIN legal_entities le ON le.id = r.entity_id AND le.tenant_id = $2
               WHERE r.entity_id = $1 AND r.obligation = $4 AND r.acknowledgement_number = ANY($5::text[])
            ), '[]'::json) AS refs`,
    [scope.entityId, scope.tenantId, f.recordedBy ?? null, f.obligation, named]
  );
  const found = lookup.rows[0];
  if (!found?.entityFound) throw new NotFoundError('Entity', scope.entityId);
  if (!found.userFound) throw new NotFoundError('User', f.recordedBy);
  const byAck = new Map(found.refs.map((x) => [x.acknowledgementNumber, x]));

  let replaced: Referenced | undefined;
  if (replaces) {
    replaced = byAck.get(replaces);
    if (!replaced) {
      throw invalid('replacesAcknowledgement', 'filed_return.replaced_unknown', { acknowledgement: replaces });
    }
    if (replaced.period !== f.period) {
      throw invalid('replacesAcknowledgement', 'filed_return.replaced_other_period',
        { acknowledgement: replaces, replacedPeriod: replaced.period, period: f.period });
    }
    if (f.filedOn < replaced.filedOn) {
      throw invalid('filedOn', 'filed_return.amended_before_replaced',
        { filedOn: f.filedOn, acknowledgement: replaces, replacedFiledOn: replaced.filedOn });
    }
  }
  const sources = credits.map((x, i) => {
    const field = `credits[${i}].sourceAcknowledgement`;
    const source = byAck.get(x.ack);
    if (!source) throw invalid(field, 'filed_return.credit_source_unknown', { acknowledgement: x.ack });
    if (source.period >= f.period) {
      throw invalid(field, 'filed_return.credit_source_not_earlier',
        { acknowledgement: x.ack, sourcePeriod: source.period, period: f.period });
    }
    if (Number(source.balanceInFavor) === 0) {
      throw invalid(field, 'filed_return.credit_source_no_balance', { acknowledgement: x.ack });
    }
    return source;
  });

  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`filed_tax_returns:${scope.entityId}:${f.obligation}`]);
  // One read serves both rules: the earlier months for the credits and, for an
  // amendment, its own month, which `including` adds without changing the rest.
  const balances = credits.length > 0 || replaced
    ? await readBalances(scope, f.obligation, f.period, Boolean(replaced), c)
    : [];
  assertCreditsAvailable(f, credits, sources, balances);
  if (replaced) await assertAmendmentCoversUse(c, scope, f, balances);

  let id: string;
  try {
    const ins = await c.query<{ id: string }>(
      `INSERT INTO filed_tax_returns
         (entity_id, obligation, period, return_type, replaces_return_id, filed_on, acknowledgement_number,
          capture_line, amount_payable, balance_in_favor, amount_paid, paid_on, recorded_by)
       SELECT le.id, $3, $4::date, $5, $6::uuid, $7::date, $8, $9, $10::numeric, $11::numeric, $12::numeric,
              $13::date, $14::uuid
         FROM legal_entities le
        WHERE le.id = $1 AND le.tenant_id = $2
       RETURNING id`,
      [scope.entityId, scope.tenantId, f.obligation, `${f.period}-01`, replaced ? 'amended' : 'original',
       replaced?.id ?? null, f.filedOn, f.acknowledgementNumber.trim(), f.captureLine?.trim() ?? null,
       f.amountPayable ?? '0', f.balanceInFavor ?? '0', f.amountPaid ?? null, f.paidOn ?? null,
       f.recordedBy ?? null]
    );
    if (ins.rows.length !== 1) throw new NotFoundError('Entity', scope.entityId);
    id = ins.rows[0].id;
  } catch (e) {
    throw inWords(e, f, replaces);
  }
  if (sources.length > 0) {
    const written = await c.query(
      `INSERT INTO filed_tax_return_credits
         (entity_id, obligation, return_id, return_period, source_return_id, source_period, amount)
       SELECT r.entity_id, r.obligation, r.id, r.period, s.id, s.period, s.amount
         FROM filed_tax_returns r
         JOIN legal_entities le ON le.id = r.entity_id AND le.tenant_id = $2
        CROSS JOIN unnest($3::uuid[], $4::date[], $5::numeric[]) WITH ORDINALITY AS s(id, period, amount, n)
        WHERE r.id = $1
        ORDER BY s.n`,
      [id, scope.tenantId, sources.map((s) => s.id), sources.map((s) => `${s.period}-01`),
       credits.map((x) => x.amount)]
    );
    // A return never stays without one of the credits it states: this throws, and the write rolls back.
    if (written.rowCount !== sources.length) {
      throw new Error(`Filed return ${id}: ${written.rowCount} of its ${sources.length} credits were written`);
    }
  }
  const back = await c.query<FiledReturn>(`${RETURN_SELECT} WHERE r.id = $1`, [id]);
  return back.rows[0];
}

/**
 * Each credit draws on what its source PERIOD still holds, in the order the
 * credits come: the reader sums by period, so two credits naming a month's
 * original and its amendment share one figure. The filing's own period is
 * left out by the reader, so an amendment is checked against what the
 * return it replaces did not use, not against it twice.
 */
function assertCreditsAvailable(
  f: FiledReturnFiling, credits: ReadonlyArray<{ ack: string; amount: string }>, sources: readonly Referenced[],
  balances: readonly BalanceInFavorSource[]
): void {
  const left = new Map(balances.map((x) => [x.period, availableOf(x)]));
  credits.forEach((x, i) => {
    const sourcePeriod = sources[i].period;
    const available = left.get(sourcePeriod) ?? new Decimal(0);
    if (available.lessThan(x.amount)) {
      throw invalid(`credits[${i}].amount`, 'filed_return.credit_above_available', {
        acknowledgement: x.ack, sourcePeriod, requested: new Decimal(x.amount).toFixed(2), available: available.toFixed(2),
      });
    }
    left.set(sourcePeriod, available.minus(x.amount));
  });
}

/**
 * An amendment keeps at least what the returns in force of other periods
 * credited from its month and what was compensated from it. Below that the
 * record would hold a credit LIVA art. 6 does not allow, so it is refused,
 * naming the returns to amend first: the conservative reading of #308.
 */
async function assertAmendmentCoversUse(
  c: pg.PoolClient, scope: EntityScope, f: FiledReturnFiling, balances: readonly BalanceInFavorSource[]
): Promise<void> {
  const own = balances.find((x) => x.period === f.period);
  if (!own) return;
  const used = new Decimal(own.credited).plus(own.compensated);
  const balance = new Decimal(f.balanceInFavor ?? 0);
  if (balance.greaterThanOrEqualTo(used)) return;
  const by = await c.query<{ returns: string | null }>(
    `SELECT string_agg(r.acknowledgement_number, ', ' ORDER BY r.period, r.acknowledgement_number) AS returns
       FROM filed_tax_returns r
      WHERE r.entity_id = $1 AND r.obligation = $2
        AND NOT EXISTS (SELECT 1 FROM filed_tax_returns n WHERE n.replaces_return_id = r.id)
        AND EXISTS (SELECT 1 FROM filed_tax_return_credits k WHERE k.return_id = r.id AND k.source_period = $3::date)`,
    [scope.entityId, f.obligation, `${f.period}-01`]
  );
  throw invalid('balanceInFavor', 'filed_return.amended_below_used', {
    period: f.period, balance: balance.toFixed(2), used: used.toFixed(2), credited: own.credited,
    compensated: own.compensated, returns: by.rows[0]?.returns ?? '—',
  });
}

/** A return with the acknowledgement it replaces and its credits, in the shape of FiledReturn. */
const RETURN_SELECT = `
  SELECT r.id, r.obligation, to_char(r.period, 'YYYY-MM') AS period, r.return_type AS "returnType",
         p.acknowledgement_number AS "replacesAcknowledgement", to_char(r.filed_on, 'YYYY-MM-DD') AS "filedOn",
         r.acknowledgement_number AS "acknowledgementNumber", r.capture_line AS "captureLine",
         r.amount_payable::text AS "amountPayable", r.balance_in_favor::text AS "balanceInFavor",
         r.amount_paid::text AS "amountPaid", to_char(r.paid_on, 'YYYY-MM-DD') AS "paidOn",
         to_char(r.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt",
         COALESCE((
           SELECT json_agg(json_build_object(
                    'sourceAcknowledgement', s.acknowledgement_number,
                    'sourcePeriod', to_char(s.period, 'YYYY-MM'), 'amount', c.amount::text) ORDER BY c.seq)
             FROM filed_tax_return_credits c
             JOIN filed_tax_returns s ON s.id = c.source_return_id
            WHERE c.return_id = r.id
         ), '[]'::json) AS credits
    FROM filed_tax_returns r
    LEFT JOIN filed_tax_returns p ON p.id = r.replaces_return_id`;

function run(client?: pg.PoolClient) {
  return client
    ? <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => client.query<T>(sql, params)
    : query;
}

function invalid(field: string, key: TranslationKey, params: MessageParams): ValidationError {
  return new ValidationError({ key, params }, field);
}

/** A UNIQUE of migration 337, said in words; anything else goes through as it came. */
function inWords(e: unknown, f: FiledReturnFiling, replaces: string | undefined): unknown {
  const err = e as { code?: string; constraint?: string };
  const key = err?.code === '23505' && err.constraint ? UNIQUE_KEYS[err.constraint] : undefined;
  if (!key) return e;
  const acknowledgement = key === 'filed_return.already_replaced' ? replaces ?? '' : f.acknowledgementNumber.trim();
  return new ConflictError({ key, params: { acknowledgement, period: f.period } });
}

function assertPeriod(period: string): void {
  if (!ISO_MONTH.test(period)) throw invalid('period', 'filed_return.period_invalid', { value: period });
}

/** The first day of the month after `period` (YYYY-MM): the earliest a return for it is filed. */
function dayAfterPeriod(period: string): string {
  const [, y, m] = ISO_MONTH.exec(period)!;
  const year = Number(y) + (m === '12' ? 1 : 0);
  const month = m === '12' ? 1 : Number(m) + 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

function assertAmount(field: string, value: string | undefined): void {
  if (value !== undefined && !AMOUNT.test(value)) throw invalid(field, 'filed_return.amount_invalid', { value });
}

/**
 * The rules of one return that need no other row, said before Postgres
 * says them as a CHECK of migration 337.
 */
function assertFiling(f: FiledReturnFiling): void {
  if (!WRITTEN.includes(f.obligation)) {
    throw invalid('obligation', 'filed_return.obligation_not_written', { value: f.obligation });
  }
  assertPeriod(f.period);
  if (!isRealCalendarDate(f.filedOn)) {
    throw invalid('filedOn', 'filed_return.filed_on_not_a_day', { value: f.filedOn });
  }
  const earliest = dayAfterPeriod(f.period);
  if (f.filedOn < earliest) {
    throw invalid('filedOn', 'filed_return.filed_before_period_ends', { value: f.filedOn, period: f.period, earliest });
  }
  if (f.acknowledgementNumber.trim() === '') {
    throw invalid('acknowledgementNumber', 'filed_return.acknowledgement_required', {});
  }
  if (f.captureLine !== undefined && f.captureLine.trim() === '') {
    throw invalid('captureLine', 'filed_return.capture_line_blank', {});
  }
  if (f.replacesAcknowledgement !== undefined && f.replacesAcknowledgement.trim() === '') {
    throw invalid('replacesAcknowledgement', 'filed_return.acknowledgement_required', {});
  }
  assertAmount('amountPayable', f.amountPayable);
  assertAmount('balanceInFavor', f.balanceInFavor);
  assertAmount('amountPaid', f.amountPaid);
  if (Number(f.amountPayable ?? 0) > 0 && Number(f.balanceInFavor ?? 0) > 0) {
    throw invalid('balanceInFavor', 'filed_return.payable_and_in_favor',
      { payable: f.amountPayable!, inFavor: f.balanceInFavor! });
  }
  if ((f.amountPaid === undefined) !== (f.paidOn === undefined)) {
    throw invalid(f.paidOn === undefined ? 'paidOn' : 'amountPaid', 'filed_return.payment_incomplete', {});
  }
  if (f.paidOn !== undefined) {
    if (!isRealCalendarDate(f.paidOn)) throw invalid('paidOn', 'filed_return.paid_on_not_a_day', { value: f.paidOn });
    if (f.paidOn < f.filedOn) {
      throw invalid('paidOn', 'filed_return.paid_before_filed', { paidOn: f.paidOn, filedOn: f.filedOn });
    }
  }
  const seen = new Set<string>();
  (f.credits ?? []).forEach((x, i) => {
    const ack = x.sourceAcknowledgement.trim();
    if (ack === '') throw invalid(`credits[${i}].sourceAcknowledgement`, 'filed_return.acknowledgement_required', {});
    if (seen.has(ack)) {
      throw invalid(`credits[${i}].sourceAcknowledgement`, 'filed_return.credit_repeated', { acknowledgement: ack });
    }
    seen.add(ack);
    assertAmount(`credits[${i}].amount`, x.amount);
    if (Number(x.amount) === 0) throw invalid(`credits[${i}].amount`, 'filed_return.credit_amount_not_positive', {});
  });
}
