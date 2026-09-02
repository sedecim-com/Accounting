import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { ValidationError, NotFoundError } from '../../utils/errors.js';
import type { BalanceSheetSection, IncomeStatementSection } from '../../types/index.js';
import {
  avisoDeCierreEnRango,
  criterioDeCierreEnInformes,
  predicadoSinCierre,
  type AvisoDeCierre,
  type RangoConsultado,
} from './criterio-cierre.js';

// ============================================================
// REPORTING — domain service
//
// Until now the six financial reports existed THREE times: inline in
// src/api/rest/routes/reports.ts, again in src/ai/tools/report-tools.ts,
// and nowhere at all for the CLI. src/services/reporting/ was an empty
// directory. Three copies of a trial balance is three trial balances.
//
// The file is deliberately split in two layers, because the three
// surfaces agree about the QUERY and disagree about the PRESENTATION:
//
//   query*Rows()  — the SQL. One implementation, shared by REST, the
//                   agent tools and the CLI. This is the part where a
//                   mistake produces a wrong number.
//   get*()        — assembly: sections, sign conventions, totals. Used
//                   by REST and the CLI, which publish the same shape.
//                   The agent tools keep their own (2-decimal, flatter)
//                   projection over the same rows, because changing what
//                   the agent sees is not a refactor.
//
// Two rules hold everywhere here:
//
//   MONEY IS A STRING. Postgres hands numerics back as strings and they
//   stay strings: Decimal for arithmetic, .toFixed(scale) on the way out.
//   No amount is ever a JS number, at any point, on any path.
//
//   TOTALS ARE COMPUTED OVER EVERY ROW, NEVER OVER A PAGE. limit/offset
//   slice what is DISPLAYED and the caller is handed `total` so it can
//   say so. A trial balance that quietly shows 50 of 412 accounts and
//   foots to those 50 is not a trial balance.
//
// The parenthesized (jel JOIN je) pair is load-bearing in every query:
// chaining two LEFT JOINs keeps lines from draft/pending/void entries
// when the je predicate fails. That defect was fixed once in the routes
// (and in migrations 010/012 for the materialized views) and must not
// come back here.
// ============================================================

/** Storage scale of every money column in the ledger: DECIMAL(19,4). */
export const LEDGER_SCALE = 4;

// ------------------------------------------------------------
// PERIOD RESOLUTION
// ------------------------------------------------------------

export interface PeriodRange {
  start_date: string;
  end_date: string;
  /** The fiscal period's own name when one matched, else the expression. */
  period_name: string;
  /** Present only when a real row in fiscal_periods was matched. */
  fiscal_period_id?: string;
  /**
   * false when the range came from calendar arithmetic rather than from
   * fiscal_periods. A 4-4-5 or 13-period calendar does NOT line up with
   * calendar months, so a caller should say so rather than imply the
   * range is the entity's period.
   */
  matched_fiscal_period: boolean;
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const QUARTER_RE = /^(\d{4})-?Q([1-4])$/i;
const YEAR_RE = /^(?:FY)?(\d{4})$/i;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Last calendar day of a month, computed in UTC so no local zone can shift it. */
function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

interface FiscalPeriodRow {
  id: string;
  period_name: string;
  start_date: string;
  end_date: string;
}

async function findPeriodsByName(entityId: string, pattern: string): Promise<FiscalPeriodRow[]> {
  const result = await query<FiscalPeriodRow>(
    `SELECT id, period_name, start_date::text AS start_date, end_date::text AS end_date
     FROM fiscal_periods
     WHERE entity_id = $1 AND period_name ILIKE $2
     ORDER BY start_date`,
    [entityId, pattern]
  );
  return result.rows;
}

function calendarRange(expr: string): { start_date: string; end_date: string } | null {
  const month = MONTH_RE.exec(expr);
  if (month) {
    const [, y, m] = month;
    const monthNum = parseInt(m, 10);
    if (monthNum < 1 || monthNum > 12) return null;
    return { start_date: `${y}-${m}-01`, end_date: lastDayOfMonth(parseInt(y, 10), monthNum) };
  }
  const quarter = QUARTER_RE.exec(expr);
  if (quarter) {
    const [, y, q] = quarter;
    const first = (parseInt(q, 10) - 1) * 3 + 1;
    return {
      start_date: `${y}-${pad(first)}-01`,
      end_date: lastDayOfMonth(parseInt(y, 10), first + 2),
    };
  }
  const year = YEAR_RE.exec(expr);
  if (year) {
    const [, y] = year;
    return { start_date: `${y}-01-01`, end_date: `${y}-12-31` };
  }
  return null;
}

async function resolveSinglePeriod(entityId: string, expr: string): Promise<PeriodRange> {
  const trimmed = expr.trim();
  if (!trimmed) throw new ValidationError('An empty period expression selects nothing.');

  // 1. The entity's own period names win: they are the authority on what a
  //    period IS, whatever shape the fiscal calendar has.
  const exact = await findPeriodsByName(entityId, trimmed);
  if (exact.length === 1) {
    const p = exact[0];
    return {
      start_date: p.start_date,
      end_date: p.end_date,
      period_name: p.period_name,
      fiscal_period_id: p.id,
      matched_fiscal_period: true,
    };
  }
  if (exact.length > 1) {
    return spanOf(exact, trimmed);
  }

  // 2. Calendar arithmetic: 2026-07, 2026-Q3, FY2026, 2026.
  const calendar = calendarRange(trimmed);
  if (calendar) {
    // If a fiscal period happens to have exactly those bounds, prefer it —
    // then the answer carries a period id and is not merely a date range.
    const aligned = await query<FiscalPeriodRow>(
      `SELECT id, period_name, start_date::text AS start_date, end_date::text AS end_date
       FROM fiscal_periods
       WHERE entity_id = $1 AND start_date = $2 AND end_date = $3`,
      [entityId, calendar.start_date, calendar.end_date]
    );
    if (aligned.rows.length === 1) {
      const p = aligned.rows[0];
      return {
        start_date: p.start_date,
        end_date: p.end_date,
        period_name: p.period_name,
        fiscal_period_id: p.id,
        matched_fiscal_period: true,
      };
    }
    return { ...calendar, period_name: trimmed, matched_fiscal_period: false };
  }

  // 3. Free text against the period names, e.g. "january".
  const fuzzy = await findPeriodsByName(entityId, `%${trimmed}%`);
  if (fuzzy.length === 1) {
    const p = fuzzy[0];
    return {
      start_date: p.start_date,
      end_date: p.end_date,
      period_name: p.period_name,
      fiscal_period_id: p.id,
      matched_fiscal_period: true,
    };
  }
  if (fuzzy.length > 1) return spanOf(fuzzy, trimmed);

  const known = await query<{ period_name: string }>(
    `SELECT period_name FROM fiscal_periods WHERE entity_id = $1 ORDER BY start_date LIMIT 24`,
    [entityId]
  );
  throw new ValidationError(
    `No period matches "${trimmed}". Use a period name, 2026-07, 2026-Q3, FY2026, or a range a..b.` +
      (known.rows.length
        ? ` Known periods: ${known.rows.map((r) => r.period_name).join(', ')}.`
        : ' This entity has no fiscal periods defined.')
  );
}

/** Several consecutive periods matched one expression: report their span. */
function spanOf(rows: FiscalPeriodRow[], _expr: string): PeriodRange {
  return {
    start_date: rows[0].start_date,
    end_date: rows[rows.length - 1].end_date,
    period_name: `${rows[0].period_name}..${rows[rows.length - 1].period_name}`,
    matched_fiscal_period: rows.length === 1,
  };
}

/**
 * Turns `--period` into a date range. Accepts a fiscal period name, a
 * calendar expression (2026-07, 2026-Q3, FY2026, 2026) or a range `a..b`
 * whose ends are resolved independently.
 */
export async function resolvePeriodRange(entityId: string, expr: string): Promise<PeriodRange> {
  const trimmed = expr.trim();
  const sep = trimmed.indexOf('..');
  if (sep > 0) {
    const from = await resolveSinglePeriod(entityId, trimmed.slice(0, sep));
    const to = await resolveSinglePeriod(entityId, trimmed.slice(sep + 2));
    if (from.start_date > to.end_date) {
      throw new ValidationError(
        `The period range "${trimmed}" ends (${to.end_date}) before it starts (${from.start_date}).`
      );
    }
    return {
      start_date: from.start_date,
      end_date: to.end_date,
      period_name: `${from.period_name}..${to.period_name}`,
      matched_fiscal_period: false,
    };
  }
  return resolveSinglePeriod(entityId, trimmed);
}

// ------------------------------------------------------------
// TRIAL BALANCE
// ------------------------------------------------------------

export interface TrialBalanceQueryRow {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  debit_total: string;
  credit_total: string;
  ending_balance: string;
}

export interface TrialBalanceFilters extends RangoConsultado {
  /** Activity of ONE fiscal period. Mutually exclusive with the date filters. */
  fiscalPeriodId?: string;
  /** Cumulative: every posted entry up to and including this date. */
  asOfDate?: string;
  /** Activity between two dates. Used by the CLI's --since/--until and --period. */
  sinceDate?: string;
  untilDate?: string;
  /** Roll up to at most this account level. The REST surface defaults it to 5. */
  maxLevel?: number;
  /**
   * Pide la balanza EN CRUDO, sin pasar por `informes_asientos_de_cierre`.
   *
   * Lo usa el cotejo contra las vistas materializadas, que no saben de
   * criterios de presentación: si el informe dejara fuera el cierre y la vista
   * no, el cotejo denunciaría una deriva que no existe. No es una superficie
   * de informe y por eso no obedece al panel.
   */
  ignoreClosingPolicy?: boolean;
}

/** Builds the `AND …` fragment that lives INSIDE the (jel JOIN je) pair. */
function entryFilter(filters: TrialBalanceFilters, params: unknown[], start: number): string {
  let i = start;
  if (filters.fiscalPeriodId) {
    params.push(filters.fiscalPeriodId);
    return `AND je.fiscal_period_id = $${i}`;
  }
  if (filters.asOfDate) {
    params.push(filters.asOfDate);
    return `AND je.entry_date <= $${i}`;
  }
  const parts: string[] = [];
  if (filters.sinceDate) {
    params.push(filters.sinceDate);
    parts.push(`AND je.entry_date >= $${i++}`);
  }
  if (filters.untilDate) {
    params.push(filters.untilDate);
    parts.push(`AND je.entry_date <= $${i++}`);
  }
  return parts.join(' ');
}

/**
 * One row per active account with its posted debits, credits and
 * debit-positive ending balance. Zero-activity accounts are KEPT: a trial
 * balance that hides them hides the accounts someone forgot to use.
 */
export async function queryTrialBalanceRows(
  entityId: string,
  filters: TrialBalanceFilters = {}
): Promise<TrialBalanceQueryRow[]> {
  const params: unknown[] = [entityId];
  let where = 'WHERE a.entity_id = $1 AND a.is_active = true';
  let i = 2;

  if (filters.maxLevel !== undefined) {
    where += ` AND a.account_level <= $${i++}`;
    params.push(filters.maxLevel);
  }
  const periodFilter = entryFilter(filters, params, i);

  // El criterio del panel se aplica AQUÍ, donde pasan las tres superficies.
  // Por omisión la balanza SÍ cuenta los asientos de cierre —es lo que ata la
  // balanza con el mayor— y quien la publica añade la nota que lo dice.
  const criterio = filters.ignoreClosingPolicy
    ? null
    : await criterioDeCierreEnInformes(entityId);
  const closingFilter = criterio && !criterio.enBalanza ? predicadoSinCierre() : '';
  // Unidos sin dejar un hueco cuando uno de los dos falta: los predicados del
  // par (jel JOIN je) se leen —y se prueban— como una sola cadena.
  const jeFilters = [periodFilter, closingFilter].filter((p) => p !== '').join(' ');

  const result = await query<TrialBalanceQueryRow>(
    `SELECT
      a.id AS account_id,
      a.code AS account_code,
      a.name AS account_name,
      a.account_type,
      COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0) AS debit_total,
      COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0) AS credit_total,
      COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) AS ending_balance
    FROM accounts a
    LEFT JOIN (journal_entry_lines jel
               JOIN journal_entries je
                 ON je.id = jel.journal_entry_id
                AND je.status = 'posted' ${jeFilters})
           ON jel.account_id = a.id
    ${where}
    GROUP BY a.id, a.code, a.name, a.account_type
    ORDER BY a.code`,
    params
  );
  return result.rows;
}

export interface TrialBalanceTotals {
  total_debits: string;
  total_credits: string;
  is_balanced: boolean;
}

/**
 * Foots a trial balance. The tolerance is one cent, which is a statement
 * about rounding, not about correctness: anything larger is a real break.
 */
export function totalTrialBalance(
  rows: Pick<TrialBalanceQueryRow, 'debit_total' | 'credit_total'>[],
  scale: number = LEDGER_SCALE
): TrialBalanceTotals {
  const debits = rows.reduce((sum, r) => sum.plus(new Decimal(r.debit_total)), new Decimal(0));
  const credits = rows.reduce((sum, r) => sum.plus(new Decimal(r.credit_total)), new Decimal(0));
  return {
    total_debits: debits.toFixed(scale),
    total_credits: credits.toFixed(scale),
    is_balanced: debits.minus(credits).abs().lessThanOrEqualTo('0.01'),
  };
}

export interface TrialBalanceReport {
  entity_id: string;
  rows: TrialBalanceQueryRow[];
  /** Accounts the filters matched, before limit/offset. */
  total: number;
  /** Footed over every matched account, never over the displayed page. */
  totals: TrialBalanceTotals;
  /**
   * Presente sólo cuando el rango contiene el cierre del ejercicio. Sin esta
   * nota, una balanza que lo cuenta y un estado de resultados que no parecen
   * discrepar, y quien los ata a mano concluye que uno de los dos miente.
   */
  closing?: AvisoDeCierre;
}

export interface TrialBalanceOptions extends TrialBalanceFilters {
  /** Drop accounts whose ending balance is exactly zero. */
  excludeZero?: boolean;
  limit?: number;
  offset?: number;
  scale?: number;
}

export async function getTrialBalance(
  entityId: string,
  opts: TrialBalanceOptions = {}
): Promise<TrialBalanceReport> {
  const all = await queryTrialBalanceRows(entityId, opts);
  const matched = opts.excludeZero
    ? all.filter((r) => !new Decimal(r.ending_balance).isZero())
    : all;

  // Footing happens here, over every matched row, BEFORE the page is cut.
  const totals = totalTrialBalance(matched, opts.scale ?? LEDGER_SCALE);
  const offset = opts.offset ?? 0;
  const rows = opts.limit === undefined
    ? matched.slice(offset)
    : matched.slice(offset, offset + opts.limit);

  const closing = await avisoDeCierreEnRango(entityId, opts, 'trial-balance');
  return {
    entity_id: entityId,
    rows,
    total: matched.length,
    totals,
    ...(closing ? { closing } : {}),
  };
}

// ------------------------------------------------------------
// BALANCE SHEET
// ------------------------------------------------------------

export interface BalanceSheetQueryRow {
  id: string;
  code: string;
  name: string;
  account_type: string;
  fs_category: string | null;
  balance: string;
}

/**
 * Debit-positive balances of every permanent account with a non-zero
 * balance at the cutoff. Sign conversion happens in the assembly, once.
 */
export async function queryBalanceSheetRows(
  entityId: string,
  asOfDate: string
): Promise<BalanceSheetQueryRow[]> {
  const result = await query<BalanceSheetQueryRow>(
    `SELECT
      a.account_type, a.fs_category, a.code, a.name, a.id,
      COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) as balance
    FROM accounts a
    LEFT JOIN (journal_entry_lines jel
               JOIN journal_entries je
                 ON je.id = jel.journal_entry_id
                AND je.status = 'posted' AND je.entry_date <= $2)
           ON jel.account_id = a.id
    -- NOT filtered by is_active: a retired account that still carries a
    -- balance belongs on the balance sheet. Excluding it silently removed
    -- real money from the statement and was one of the reasons it did not
    -- foot. Accounts with a zero balance are dropped by the HAVING anyway.
    WHERE a.entity_id = $1
      AND a.account_type IN ('asset', 'liability', 'equity', 'contra_asset', 'contra_liability', 'contra_equity')
    GROUP BY a.id, a.account_type, a.fs_category, a.code, a.name
    HAVING COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) != 0
    ORDER BY a.code`,
    [entityId, asOfDate]
  );
  return result.rows;
}

/**
 * naturalSign flips the debit-positive raw balance into each section's
 * natural sign so contra accounts NET against their section instead of
 * inflating it (summing abs() overstated assets by accumulated depreciation).
 */
export function buildBalanceSheetSection(
  rows: BalanceSheetQueryRow[],
  types: string[],
  name: string,
  naturalSign: 1 | -1,
  scale: number = LEDGER_SCALE
): BalanceSheetSection {
  const accounts = rows.filter((r) => types.includes(r.account_type));
  const categorized = new Map<string, BalanceSheetQueryRow[]>();
  for (const acct of accounts) {
    const cat = acct.fs_category || 'other';
    if (!categorized.has(cat)) categorized.set(cat, []);
    categorized.get(cat)!.push(acct);
  }

  const subsections = Array.from(categorized.entries()).map(([cat, accts]) => ({
    name: cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    total: accts.reduce((sum, a) => sum.plus(a.balance), new Decimal(0)).times(naturalSign).toFixed(scale),
    accounts: accts.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      balance: new Decimal(a.balance).times(naturalSign).toFixed(scale),
    })),
  }));

  return {
    name,
    total: subsections.reduce((sum, s) => sum.plus(new Decimal(s.total)), new Decimal(0)).toFixed(scale),
    subsections,
  };
}

/**
 * The net result of every temporary account, from inception through the
 * cutoff, as a debit-positive figure.
 *
 * Summing from inception rather than from the start of the fiscal year is
 * deliberate and is what makes the statement foot unconditionally: a closing
 * entry debits revenue and credits expense, so a year that HAS been closed
 * nets to zero here and its result is already sitting in retained earnings.
 * What survives is exactly the result not yet swept — which is precisely what
 * equity is missing. No fiscal-year lookup, and no double count when a prior
 * year was closed.
 */
export async function queryUnclosedEarnings(
  entityId: string,
  asOfDate: string
): Promise<string> {
  const result = await query<{ balance: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) AS balance
     FROM accounts a
     JOIN journal_entry_lines jel ON jel.account_id = a.id
     JOIN journal_entries je ON je.id = jel.journal_entry_id
      AND je.status = 'posted' AND je.entry_date <= $2
     WHERE a.entity_id = $1
       AND a.account_type IN ('revenue', 'expense', 'contra_revenue')`,
    [entityId, asOfDate]
  );
  return result.rows[0]?.balance ?? '0';
}

export interface BalanceSheetReport {
  entity_id: string;
  as_of_date: string;
  assets: BalanceSheetSection;
  liabilities: BalanceSheetSection;
  equity: BalanceSheetSection;
  total_liabilities_and_equity: string;
  /** assets.total − (liabilities.total + equity.total). Zero when the books are sound. */
  out_of_balance: string;
  is_balanced: boolean;
}

export async function getBalanceSheet(
  entityId: string,
  opts: { asOfDate: string; scale?: number }
): Promise<BalanceSheetReport> {
  const scale = opts.scale ?? LEDGER_SCALE;
  const rows = await queryBalanceSheetRows(entityId, opts.asOfDate);

  const assets = buildBalanceSheetSection(rows, ['asset', 'contra_asset'], 'Assets', 1, scale);
  const liabilities = buildBalanceSheetSection(rows, ['liability', 'contra_liability'], 'Liabilities', -1, scale);
  const equity = buildBalanceSheetSection(rows, ['equity', 'contra_equity'], 'Equity', -1, scale);

  // The result of the period belongs to the owners, so it is presented inside
  // equity. Without it the statement is short by exactly the unclosed result
  // and cannot foot — which is what it did before this line existed.
  const unclosed = await queryUnclosedEarnings(entityId, opts.asOfDate);
  const earnings = new Decimal(unclosed).times(-1); // debit-positive → equity's natural sign
  if (!earnings.isZero()) {
    equity.subsections.push({
      name: 'Result Of The Period',
      total: earnings.toFixed(scale),
      accounts: [],
    });
    equity.total = new Decimal(equity.total).plus(earnings).toFixed(scale);
  }

  const totalLiabilitiesAndEquity = new Decimal(liabilities.total)
    .plus(new Decimal(equity.total))
    .toFixed(scale);
  const outOfBalance = new Decimal(assets.total).minus(totalLiabilitiesAndEquity);

  return {
    entity_id: entityId,
    as_of_date: opts.asOfDate,
    assets,
    liabilities,
    equity,
    total_liabilities_and_equity: totalLiabilitiesAndEquity,
    out_of_balance: outOfBalance.toFixed(scale),
    is_balanced: outOfBalance.isZero(),
  };
}

// ------------------------------------------------------------
// INCOME STATEMENT
// ------------------------------------------------------------

export interface IncomeStatementQueryRow {
  id: string;
  code: string;
  name: string;
  account_type: string;
  fs_category: string | null;
  debit_total: string;
  credit_total: string;
}

/**
 * `nonzero-net` keeps accounts whose debits and credits do not cancel — the
 * historical REST rule. `any-activity` keeps every account that moved at all,
 * including one that nets to zero, which is what the agent tool reports.
 * The distinction is real, so it is a parameter and not a silent choice.
 */
export type IncomeStatementInclude = 'nonzero-net' | 'any-activity';

export async function queryIncomeStatementRows(
  entityId: string,
  opts: { startDate: string; endDate: string; include?: IncomeStatementInclude }
): Promise<IncomeStatementQueryRow[]> {
  // EL FILTRO DEL CIERRE, UNA VEZ, DONDE PASAN LAS TRES SUPERFICIES.
  //
  // Sin él, un ejercicio con 10 000 de ventas imprime «Net income 0.0000»: el
  // asiento que barre el resultado va fechado el último día del periodo que
  // cierra, o sea DENTRO del rango, y cancela exactamente lo que el informe
  // acaba de sumar. No depende de `include` —ese parámetro decide qué cuentas
  // se muestran, no qué asientos se cuentan— porque si dependiera, la balanza
  // del agente y la del REST volverían a contestar cosas distintas.
  const criterio = await criterioDeCierreEnInformes(entityId);
  const closingFilter = criterio.enEstadoDeResultados ? '' : predicadoSinCierre();

  const having =
    (opts.include ?? 'nonzero-net') === 'any-activity'
      ? `HAVING COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0) != 0
             OR COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0) != 0`
      : `HAVING COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) != 0`;

  const result = await query<IncomeStatementQueryRow>(
    `SELECT
      a.account_type, a.fs_category, a.code, a.name, a.id,
      COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0) AS debit_total,
      COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0) AS credit_total
    FROM accounts a
    LEFT JOIN (journal_entry_lines jel
               JOIN journal_entries je
                 ON je.id = jel.journal_entry_id
                AND je.status = 'posted' AND je.entry_date BETWEEN $2 AND $3
                ${closingFilter})
           ON jel.account_id = a.id
    WHERE a.entity_id = $1 AND a.is_active = true
      AND a.account_type IN ('revenue', 'expense')
    GROUP BY a.id, a.account_type, a.fs_category, a.code, a.name
    ${having}
    ORDER BY a.code`,
    [entityId, opts.startDate, opts.endDate]
  );
  return result.rows;
}

/** Debit-positive net movement of one income-statement account. */
export function netMovement(row: Pick<IncomeStatementQueryRow, 'debit_total' | 'credit_total'>): Decimal {
  return new Decimal(row.debit_total).minus(new Decimal(row.credit_total));
}

/**
 * Revenue is credit-natural (its raw debit-positive amount is negative), so
 * the sign is flipped instead of abs()-ed — abs() would inflate a section
 * holding contra-natural rows, e.g. sales returns booked as revenue debits.
 */
export function buildIncomeStatementSection(
  rows: IncomeStatementQueryRow[],
  type: 'revenue' | 'expense',
  scale: number = LEDGER_SCALE
): IncomeStatementSection {
  const naturalSign = type === 'revenue' ? -1 : 1;
  const accounts = rows.filter((r) => r.account_type === type);
  const total = accounts
    .reduce((sum, a) => sum.plus(netMovement(a)), new Decimal(0))
    .times(naturalSign);
  return {
    name: type === 'revenue' ? 'Revenue' : 'Expenses',
    total: total.toFixed(scale),
    accounts: accounts.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      amount: netMovement(a).times(naturalSign).toFixed(scale),
    })),
  };
}

export interface IncomeStatementReport {
  entity_id: string;
  start_date: string;
  end_date: string;
  revenue: IncomeStatementSection;
  expenses: IncomeStatementSection;
  net_income: string;
  /** Presente sólo cuando el rango contiene el cierre del ejercicio. */
  closing?: AvisoDeCierre;
}

export async function getIncomeStatement(
  entityId: string,
  opts: { startDate: string; endDate: string; include?: IncomeStatementInclude; scale?: number }
): Promise<IncomeStatementReport> {
  const scale = opts.scale ?? LEDGER_SCALE;
  const rows = await queryIncomeStatementRows(entityId, opts);
  const revenue = buildIncomeStatementSection(rows, 'revenue', scale);
  const expenses = buildIncomeStatementSection(rows, 'expense', scale);
  const closing = await avisoDeCierreEnRango(
    entityId,
    { sinceDate: opts.startDate, untilDate: opts.endDate },
    'income-statement'
  );
  return {
    entity_id: entityId,
    start_date: opts.startDate,
    end_date: opts.endDate,
    revenue,
    expenses,
    net_income: new Decimal(revenue.total).minus(new Decimal(expenses.total)).toFixed(scale),
    ...(closing ? { closing } : {}),
  };
}

// ------------------------------------------------------------
// GENERAL LEDGER
// ------------------------------------------------------------

export interface LedgerQueryRow {
  account_id: string;
  account_code: string;
  account_name: string;
  journal_entry_id: string;
  entry_number: string;
  entry_date: Date | string;
  entry_type: string;
  entry_description: string | null;
  line_number: number;
  debit_amount: string | null;
  credit_amount: string | null;
  line_description: string | null;
  cost_center_id: string | null;
  project_id: string | null;
}

export interface LedgerFilters {
  accountId?: string;
  /** What a person types. Resolved in SQL so no extra round trip is needed. */
  accountCode?: string;
  startDate?: string;
  endDate?: string;
}

function ledgerWhere(entityId: string, filters: LedgerFilters): { where: string; params: unknown[] } {
  let where = "WHERE a.entity_id = $1 AND je.status = 'posted'";
  const params: unknown[] = [entityId];
  let i = 2;
  if (filters.accountId) { where += ` AND a.id = $${i++}`; params.push(filters.accountId); }
  if (filters.accountCode) { where += ` AND a.code = $${i++}`; params.push(filters.accountCode); }
  if (filters.startDate) { where += ` AND je.entry_date >= $${i++}`; params.push(filters.startDate); }
  if (filters.endDate) { where += ` AND je.entry_date <= $${i++}`; params.push(filters.endDate); }
  return { where, params };
}

/** Rows only. The count is a separate call because not every caller pays for it. */
export async function queryLedgerRows(
  entityId: string,
  filters: LedgerFilters & { limit: number; offset?: number }
): Promise<LedgerQueryRow[]> {
  const { where, params } = ledgerWhere(entityId, filters);
  const i = params.length + 1;
  const result = await query<LedgerQueryRow>(
    `SELECT
      a.id as account_id, a.code as account_code, a.name as account_name,
      je.id as journal_entry_id, je.entry_number, je.entry_date, je.entry_type, je.description as entry_description,
      jel.line_number, jel.debit_amount, jel.credit_amount, jel.description as line_description,
      jel.cost_center_id, jel.project_id
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id = jel.journal_entry_id
     JOIN accounts a ON a.id = jel.account_id
     ${where}
     ORDER BY a.code, je.entry_date, je.entry_number, jel.line_number
     LIMIT $${i} OFFSET $${i + 1}`,
    [...params, filters.limit, filters.offset ?? 0]
  );
  return result.rows;
}

export async function countLedgerRows(entityId: string, filters: LedgerFilters): Promise<number> {
  const { where, params } = ledgerWhere(entityId, filters);
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id = jel.journal_entry_id
     JOIN accounts a ON a.id = jel.account_id
     ${where}`,
    params
  );
  return parseInt(result.rows[0].count, 10);
}

export interface GeneralLedgerReport {
  rows: LedgerQueryRow[];
  /** Movements the filters matched, before limit/offset — the truncation signal. */
  total: number;
  period_debits: string;
  period_credits: string;
}

export async function getGeneralLedger(
  entityId: string,
  filters: LedgerFilters & { limit: number; offset?: number; scale?: number }
): Promise<GeneralLedgerReport> {
  const scale = filters.scale ?? LEDGER_SCALE;
  const total = await countLedgerRows(entityId, filters);
  const rows = await queryLedgerRows(entityId, filters);
  const debits = rows.reduce((s, r) => s.plus(new Decimal(r.debit_amount ?? 0)), new Decimal(0));
  const credits = rows.reduce((s, r) => s.plus(new Decimal(r.credit_amount ?? 0)), new Decimal(0));
  return {
    rows,
    total,
    // Footed over the PAGE, and named so: a general ledger page is a window,
    // not a statement, and pretending otherwise would be the lie.
    period_debits: debits.toFixed(scale),
    period_credits: credits.toFixed(scale),
  };
}

// ------------------------------------------------------------
// AGED RECEIVABLES / PAYABLES
// ------------------------------------------------------------

export interface AgedReceivableRow {
  customer_id: string;
  customer_name: string;
  customer_number: string;
  invoice_id: string;
  invoice_number: string;
  invoice_date: Date | string;
  due_date: Date | string;
  total_amount: string;
  amount_due: string;
  days_overdue: number;
}

export interface AgedPayableRow {
  vendor_id: string;
  vendor_name: string;
  vendor_number: string;
  bill_id: string;
  bill_number: string;
  bill_date: Date | string;
  due_date: Date | string;
  total_amount: string;
  amount_due: string;
  days_overdue: number;
}

/** Which order the caller publishes. Both were already in use; neither wins by default. */
export type AgingOrder = 'party' | 'overdue';

export const RECEIVABLE_OPEN_STATUSES = ['sent', 'viewed', 'partially_paid', 'overdue'] as const;
export const PAYABLE_OPEN_STATUSES = ['approved', 'posted', 'partially_paid'] as const;

/**
 * IMPORTANT, and the reason `as_of_date` is narrower than it looks: this
 * reads `amount_due` AS IT IS NOW. The cutoff only ages the due date; it does
 * NOT reconstruct what was owed on that date. An aged listing "as of
 * 31 December" produced today is therefore today's balances with December's
 * ageing — fine for a collections call, wrong for an auditor. Rebuilding the
 * point in time needs the payment history, which no table here carries in a
 * usable shape (see the catalog's 🟡 note on aged-payables).
 */
export async function queryAgedReceivableRows(
  entityId: string,
  opts: { asOfDate: string; order?: AgingOrder }
): Promise<AgedReceivableRow[]> {
  const orderBy = opts.order === 'overdue' ? 'days_overdue DESC, c.company_name' : 'c.company_name, i.due_date';
  const result = await query<AgedReceivableRow>(
    `SELECT
      c.id as customer_id, c.company_name as customer_name, c.customer_number,
      i.id as invoice_id, i.invoice_number, i.invoice_date, i.due_date,
      i.total_amount, i.amount_due,
      ($2::date - i.due_date) as days_overdue
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.entity_id = $1 AND i.status IN ('sent', 'viewed', 'partially_paid', 'overdue')
      AND i.amount_due > 0
    ORDER BY ${orderBy}`,
    [entityId, opts.asOfDate]
  );
  return result.rows;
}

export async function queryAgedPayableRows(
  entityId: string,
  opts: { asOfDate: string; order?: AgingOrder }
): Promise<AgedPayableRow[]> {
  const orderBy = opts.order === 'overdue' ? 'days_overdue DESC, v.company_name' : 'v.company_name, b.due_date';
  const result = await query<AgedPayableRow>(
    `SELECT
      v.id as vendor_id, v.company_name as vendor_name, v.vendor_number,
      b.id as bill_id, b.bill_number, b.bill_date, b.due_date,
      b.total_amount, b.amount_due,
      ($2::date - b.due_date) as days_overdue
    FROM bills b
    JOIN vendors v ON v.id = b.vendor_id
    WHERE b.entity_id = $1 AND b.status IN ('approved', 'posted', 'partially_paid')
      AND b.amount_due > 0
    ORDER BY ${orderBy}`,
    [entityId, opts.asOfDate]
  );
  return result.rows;
}

export interface AgingReport<Row> {
  entity_id: string;
  as_of_date: string;
  rows: Row[];
  /** Open documents matched, before limit/offset. */
  total: number;
  /** Summed over every matched document, never over the page. */
  total_due: string;
}

function sumDue(rows: { amount_due: string }[], scale: number): string {
  return rows.reduce((s, r) => s.plus(new Decimal(r.amount_due)), new Decimal(0)).toFixed(scale);
}

function paginate<T>(rows: T[], limit?: number, offset?: number): T[] {
  const from = offset ?? 0;
  return limit === undefined ? rows.slice(from) : rows.slice(from, from + limit);
}

export interface AgingOptions {
  asOfDate: string;
  order?: AgingOrder;
  limit?: number;
  offset?: number;
  scale?: number;
}

export async function getAgedReceivables(
  entityId: string,
  opts: AgingOptions
): Promise<AgingReport<AgedReceivableRow>> {
  const all = await queryAgedReceivableRows(entityId, opts);
  return {
    entity_id: entityId,
    as_of_date: opts.asOfDate,
    rows: paginate(all, opts.limit, opts.offset),
    total: all.length,
    total_due: sumDue(all, opts.scale ?? LEDGER_SCALE),
  };
}

export async function getAgedPayables(
  entityId: string,
  opts: AgingOptions
): Promise<AgingReport<AgedPayableRow>> {
  const all = await queryAgedPayableRows(entityId, opts);
  return {
    entity_id: entityId,
    as_of_date: opts.asOfDate,
    rows: paginate(all, opts.limit, opts.offset),
    total: all.length,
    total_due: sumDue(all, opts.scale ?? LEDGER_SCALE),
  };
}

// ------------------------------------------------------------
// F01 · AUXILIAR DE CUENTA — saldo inicial → movimientos → final
//
// La forma que pide el XML XC del SAT (Anexo 24): por cuenta y
// periodo, el inicial, cada movimiento y el final. El inicial sale de
// account_balances.beginning_balance — que sólo siembra el cierre DURO
// del periodo ANTERIOR: mientras ése no cierre, el campo dice 0 y eso
// es ausencia de arrastre, no un saldo; la vista lo dice con
// `inicial_confiable` y con `periodo_anterior` en lugar de fingir.
// ------------------------------------------------------------

export interface AuxiliaryView {
  account_code: string;
  account_name: string;
  period_name: string;
  period_status: string;
  inicial: string;
  /**
   * El inicial es un ACUMULADO ARRASTRADO y no un cero por ausencia de
   * arrastre. Lo jura el estado del periodo ANTERIOR, no el del consultado.
   */
  inicial_confiable: boolean;
  /** Periodo del que tendría que venir el arrastre, y en qué estado está. */
  periodo_anterior: { period_name: string; status: string } | null;
  movimientos: LedgerQueryRow[];
  /** Movimientos totales del filtro, antes de limit/offset. */
  total_movimientos: number;
  cargos: string;
  abonos: string;
  final: string;
  /** inicial + cargos − abonos, para exhibir cualquier deriva contra account_balances. */
  final_calculado: string;
}

export async function getAuxiliaryView(
  entityId: string,
  accountCode: string,
  periodName: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<AuxiliaryView> {
  const cuenta = await query<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM accounts WHERE entity_id = $1 AND code = $2`,
    [entityId, accountCode]
  );
  if (cuenta.rows.length === 0) throw new NotFoundError('Account', accountCode);

  const periodos = await query<{ id: string; period_name: string; status: string; start_date: string; end_date: string }>(
    `SELECT id, period_name, status, start_date::text AS start_date, end_date::text AS end_date
       FROM fiscal_periods WHERE entity_id = $1 AND period_name ILIKE $2
      ORDER BY start_date`,
    [entityId, `%${periodName}%`]
  );
  if (periodos.rows.length === 0) throw new NotFoundError('Fiscal period', periodName);
  if (periodos.rows.length > 1) {
    throw new ValidationError(
      `"${periodName}" casa ${periodos.rows.length} periodos (${periodos.rows.map((p) => p.period_name).join(', ')}): precisa el nombre.`
    );
  }
  const periodo = periodos.rows[0];

  const saldo = await query<{ beginning: string; ending: string; d: string; c: string }>(
    `SELECT beginning_balance::text AS beginning, ending_balance::text AS ending,
            debit_total::text AS d, credit_total::text AS c
       FROM account_balances WHERE account_id = $1 AND fiscal_period_id = $2`,
    [cuenta.rows[0].id, periodo.id]
  );
  const fila = saldo.rows[0];

  const filtros = {
    accountCode,
    startDate: periodo.start_date,
    endDate: periodo.end_date,
  };
  const total = await countLedgerRows(entityId, filtros);
  const movimientos = await queryLedgerRows(entityId, {
    ...filtros,
    limit: opts.limit ?? total,
    offset: opts.offset,
  });

  // EL INICIAL LO JURA EL PERIODO ANTERIOR, NO EL CONSULTADO.
  //
  // `beginning_balance` sólo lo siembra carryForwardBalances, y eso corre
  // dentro del cierre DURO del periodo que precede a éste. Mirar el estado
  // del periodo consultado contestaba otra pregunta: agosto puede estar
  // 'hard_close' con julio abierto —se cierra fuera de orden más a menudo de
  // lo que se admite— y entonces el inicial de agosto es 0 por falta de
  // arrastre, no porque el acumulado sea cero. Al revés también: agosto
  // abierto con julio cerrado tiene un inicial perfectamente arrastrado que
  // la vista declaraba dudoso. El XML del Anexo 24 atesta este campo como
  // verdad, así que aquí una respuesta cómoda es una declaración falsa.
  //
  // Sin periodo anterior no hubo arrastre posible, y el inicial no puede
  // presentarse como acumulado: se declara no confiable en vez de suponer.
  const anterior = await query<{ period_name: string; status: string }>(
    `SELECT period_name, status
       FROM fiscal_periods
      WHERE entity_id = $1 AND end_date < $2
      ORDER BY end_date DESC, start_date DESC
      LIMIT 1`,
    [entityId, periodo.start_date]
  );
  const previo = anterior.rows[0] ?? null;

  const inicial = new Decimal(fila?.beginning ?? 0);
  const cargos = new Decimal(fila?.d ?? 0);
  const abonos = new Decimal(fila?.c ?? 0);
  return {
    account_code: cuenta.rows[0].code,
    account_name: cuenta.rows[0].name,
    period_name: periodo.period_name,
    period_status: periodo.status,
    inicial: inicial.toFixed(LEDGER_SCALE),
    inicial_confiable: previo !== null && (previo.status === 'hard_close' || previo.status === 'locked'),
    periodo_anterior: previo,
    movimientos,
    total_movimientos: total,
    cargos: cargos.toFixed(LEDGER_SCALE),
    abonos: abonos.toFixed(LEDGER_SCALE),
    final: new Decimal(fila?.ending ?? 0).toFixed(LEDGER_SCALE),
    final_calculado: inicial.plus(cargos).minus(abonos).toFixed(LEDGER_SCALE),
  };
}
