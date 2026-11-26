import Decimal from 'decimal.js';
import type pg from 'pg';
import { query, currentTenant } from '../../database/connection.js';
import { ValidationError, NotFoundError } from '../../utils/errors.js';
import type { BalanceSheetSection, IncomeStatementSection } from '../../types/index.js';
import {
  avisoDeCierreEnRango,
  condicionDeCierre,
  criterioDeCierreEnInformes,
  predicadoSinCierre,
  type AvisoDeCierre,
  type RangoConsultado,
} from './criterio-cierre.js';
import {
  criterioDeCuentasArchivadas,
  predicadoDeCuentaEnBalanza,
} from './criterio-archivadas.js';
import { getPolicy } from '../policy/policy-service.js';
import { resolvePeriod } from '../accounting/fiscal-calendar-service.js';
import { IEPS_DUE_ROLE, IEPS_MOVE_TAG, IEPS_UNCOLLECTED_ROLE } from '../accounting/ieps-roles.js';
import { NEVER_RECEIVABLE_STATUSES, amountDueAsOfSql, voidedAfterSql } from '../ar/customer-service.js';
import { HELD_RESTITUTION_TAG } from '../payments/customer-advance.js';
import { sqlKeepsMexicanBooks } from '../jurisdiction/jurisdiction.js';

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
//                   agent tools and the CLI — and by the services that
//                   read a balance to guard money (the AR and AP
//                   reconciliations, the prepaid backing, the IEPS on cash basis, the
//                   external-ledger diff, the close's fixed-asset box,
//                   the FX revaluation line, its foreign balances and
//                   its marker's net, the IVA paper's withholding
//                   per sale and receipt movement, the DIOT's exempt
//                   revenue, the cash-flow statement's movement by
//                   account and its non-cash entries, and its tie-out's
//                   opening and movement of cash and residue suspects,
//                   the opening check's ledger, the receivable a
//                   collection credits and the held IVA a reversed note
//                   gives back, an invoice's IVA taken, the VAT put back,
//                   a bank account's book balance and posted lines; T14, #101). This is
//                   the part
//                   where a mistake produces a wrong number.
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
  /**
   * Pide la balanza EN CRUDO, sin pasar por `informes_asientos_de_cierre`.
   *
   * Lo usa el cotejo contra las vistas materializadas, que no saben de
   * criterios de presentación: si el informe dejara fuera el cierre y la vista
   * no, el cotejo denunciaría una deriva que no existe. No es una superficie
   * de informe y por eso no obedece al panel.
   */
  ignoreClosingPolicy?: boolean;
  /**
   * Leaves the closing entries (and their reversals) out whatever the panel
   * says. A tax figure is not a presentation choice: the December close
   * sweeps the year's revenue, and the provisional ISR of December would
   * read zero income (MNE-001-059).
   */
  excludeClosingEntries?: boolean;
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
 * One row per account with its posted debits, credits and debit-positive
 * ending balance. Zero-activity accounts are KEPT: a trial balance that hides
 * them hides the accounts someone forgot to use.
 *
 * T13 · `is_active` DEJÓ DE SER UN FILTRO Y PASÓ A SER UNA CORTESÍA. Antes
 * decía `AND a.is_active = true` a secas, y con eso `account archive 4100`
 * —que sólo exige saldo de por vida cero, justo lo que tiene una cuenta de
 * resultados ya barrida por el cierre— borraba de la balanza del ejercicio
 * FIRMADO una cuenta con 10 000 al haber y 10 000 al debe. La cuenta viva
 * entra siempre; la archivada entra cuando el mayor la respalda hasta el
 * corte. El porqué entero, y qué parte de esto decide el panel, en
 * criterio-archivadas.ts.
 */
export async function queryTrialBalanceRows(
  entityId: string,
  filters: TrialBalanceFilters = {},
  // A caller inside a transaction passes its client, so the balance reads the
  // same snapshot as the rest of its work and does not take a second
  // pooled connection while it holds the first (MNE-001-058).
  client?: pg.PoolClient
): Promise<TrialBalanceQueryRow[]> {
  const params: unknown[] = [entityId];
  let where = 'WHERE a.entity_id = $1';

  const periodFilter = entryFilter(filters, params, 2);
  // EL TOPE DEL INFORME, en el `$n` que `entryFilter` acaba de ocupar. Su
  // precedencia es la de aquél —periodo, luego corte, luego el `hasta` del
  // rango— y `sinceDate` a solas no cuenta: es cota INFERIOR y no sirve de
  // tope. Cero = la balanza no tiene tope por arriba.
  const posicionDelCorte =
    filters.fiscalPeriodId || filters.asOfDate || filters.untilDate ? params.length : 0;

  // El criterio del panel se aplica AQUÍ, donde pasan las tres superficies.
  // Por omisión la balanza SÍ cuenta los asientos de cierre —es lo que ata la
  // balanza con el mayor— y quien la publica añade la nota que lo dice.
  const criterio = filters.ignoreClosingPolicy
    ? null
    : await criterioDeCierreEnInformes(entityId, client);
  const closingFilter =
    filters.excludeClosingEntries || (criterio && !criterio.enBalanza) ? predicadoSinCierre() : '';
  // Unidos sin dejar un hueco cuando uno de los dos falta: los predicados del
  // par (jel JOIN je) se leen —y se prueban— como una sola cadena.
  const jeFilters = [periodFilter, closingFilter].filter((p) => p !== '').join(' ');

  // QUÉ CUENTAS ENTRAN. Va detrás de `entryFilter` porque éste ya empujó sus
  // parámetros y la numeración sigue donde él la dejó. `ignoreClosingPolicy`
  // lo apaga por lo mismo que apaga el criterio del cierre: la balanza EN
  // CRUDO del cotejo contra las materializadas no es un informe: los dos lados
  // tienen que leer el mismo juego de cuentas o la deriva que declaran es suya
  // y no del dato.
  //
  // Esto ESTUVO MAL ARGUMENTADO, y conviene que quede escrito: aquí decía que
  // «las vistas materializan TODO lo posteado». No lo hacían — las dos
  // filtraban `a.is_active = true` —, así que dejar el mayor sin predicado
  // contra unas vistas filtradas no quitaba una deriva inventada sino que la
  // INTRODUCÍA, permanente. La migración 071 alinea las vistas con la regla de
  // T13, y sólo por eso esta rama es correcta ahora.
  const archivadas = filters.ignoreClosingPolicy
    ? null
    : await criterioDeCuentasArchivadas(entityId, client);
  where += predicadoDeCuentaEnBalanza(archivadas, filters, posicionDelCorte);

  const run = (text: string, values: unknown[]) =>
    client ? client.query<TrialBalanceQueryRow>(text, values) : query<TrialBalanceQueryRow>(text, values);
  const result = await run(
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

// ------------------------------------------------------------
// F07a · LA CUARTA COLUMNA: EL SALDO INICIAL DE LA BALANZA
//
// El nodo Ctas de la BalanzaComprobacion (Anexo 24) pide CUATRO cifras por
// cuenta —SaldoIni, Debe, Haber y SaldoFin— y la autoridad RECALCULA
// SaldoIni + Debe − Haber = SaldoFin sobre el archivo que recibe. Aquí había
// tres, y la tercera no es la que su nombre promete: para un rango,
// `ending_balance` NO es un saldo final, es el MOVIMIENTO NETO del rango
// (Debe − Haber, la misma resta escrita de otra manera). Renombrarla rompe
// cuatro superficies, así que se queda como está y la cuarta columna llega
// al lado, con su nombre propio.
//
// Y `final_balance` NO se calcula como inicial + debe − haber. Escrito así, el
// recálculo del SAT saldría bien SIEMPRE —es la misma expresión— y no
// comprobaría nada. Se pide APARTE al mayor, acumulado al corte, y lo que la
// balanza publica es si las dos cuentas coinciden (`cuadra`) y qué cuentas no
// (`descuadres`). Es donde se ve, por ejemplo, un asiento fechado fuera del
// periodo fiscal al que pertenece: el movimiento se filtra por
// `fiscal_period_id` y el acumulado por fecha, y ahí las dos lecturas se
// separan en vez de taparse.
//
// DE DÓNDE SALE EL INICIAL lo decide el panel. La única fuente que existía
// —`account_balances.beginning_balance`— la siembra ÚNICAMENTE
// carryForwardBalances, que corre dentro del cierre DURO: una entidad que sólo
// cierra en suave habría declarado CEROS en todas las cuentas, o sea que abrió
// el mes en nada, firmado. El defecto del panel es derivarlo del mayor, que es
// cierto en cualquier estado del periodo.
//
// CALCULABLE NO ES FIRME, y el informe dice las dos cosas:
//   · CALCULABLE es que haya cifra. Derivada del mayor la hay siempre —por eso
//     `firme` es el único campo que hace falta publicar aquí—; arrastrada del
//     cierre puede no haberla, y entonces esta balanza se niega en vez de
//     poner un cero.
//   · FIRME es que la cifra ya no pueda cambiar, y eso lo jura el periodo
//     ANTERIOR, no el consultado: un inicial derivado sobre un mes abierto es
//     correcto hoy y puede ser otro mañana, porque todavía se puede postear
//     ahí. Es la misma distinción que `inicial_confiable` hace en el auxiliar
//     (getAuxiliaryView), con una diferencia: allí el cero podía significar
//     «no hubo arrastre», y aquí no hay ceros por ausencia.
//
// Las tres consultas —movimiento, inicial y final— llevan el MISMO criterio de
// asientos de cierre (`informes_asientos_de_cierre`). Si no, el ejercicio ya
// barrido se sumaría al inicial de una balanza que no lo cuenta y las cuatro
// columnas hablarían de libros distintos. Con el criterio por omisión —la
// balanza SÍ cuenta el cierre— el acumulado de una cuenta de resultados se
// pone solo en cero al cruzar el cierre del ejercicio, que es justo lo que el
// SaldoIni de enero necesita.
// ------------------------------------------------------------

/**
 * Valor por omisión de 'anexo24_balanza_saldo_inicial'. Se repite aquí por lo
 * mismo que en criterio-cierre: un informe no debe morir por no poder leer una
 * política.
 */
const SALDO_INICIAL_POR_OMISION = 'derivar_del_mayor';

export interface AccumulatedBalanceRow {
  account_id: string;
  /** Acumulado DEUDOR-POSITIVO (Σ debe − Σ haber) hasta el corte. */
  balance: string;
}

/**
 * El acumulado de cada cuenta hasta un corte: la versión para TODAS las
 * cuentas de la suma que `getAuxiliaryView` hacía para una sola.
 *
 * `inclusive` distingue las dos preguntas que la balanza necesita, que son la
 * misma consulta con `<` o con `<=`: el SALDO INICIAL es todo lo posteado
 * ANTES del primer día del rango (estricto — incluir ese día metería el
 * movimiento del propio periodo en su inicial), y el SALDO FINAL es todo lo
 * posteado HASTA el último día inclusive.
 *
 * Aquí los JOIN son internos, no el par (jel JOIN je) colgado de un LEFT: esa
 * disciplina existe para que una cuenta SIN actividad siga apareciendo en la
 * balanza, y este resultado no es una lista de cuentas sino un índice de
 * acumulados. La cuenta que no aparece se lee como cero, y es cero.
 */
export async function queryAccumulatedBalances(
  entityId: string,
  corte: {
    date?: string;
    inclusive: boolean;
    /**
     * The fiscal period the cut belongs to. Two periods can share a day —
     * December 31 is December's last and the year-end adjustment period's
     * only one (#304)— and on that day the date cannot say which entries come
     * first. With the period, the order of the books decides on the year's
     * last day: the shared-day
     * entries of an EARLIER period join the beginning balance, and those of a
     * LATER one stay out of the ending balance. Only shared days: an entry
     * dated outside its own period is still read by its date, so the
     * mismatch it causes is still reported.
     */
    periodId?: string;
  },
  filters: {
    ignoreClosingPolicy?: boolean;
    /** Only this account: the balance a control or a guard reads. */
    accountId?: string;
    /** Only these accounts: a balance a close box reads over a set (MNE-001-436). */
    accountIds?: readonly string[];
    /**
     * Run inside the caller's transaction. A guard that measures a balance
     * and then consumes it (prepaid backing, under its FOR UPDATE) must read
     * both on the same connection, or it measures outside its own lock.
     * Only with `ignoreClosingPolicy`: the panel read goes through the pool,
     * so a client plus the panel would read the policy outside the caller's
     * transaction — that combination is refused, not silently half-honoured.
     */
    client?: pg.PoolClient;
  } = {}
): Promise<AccumulatedBalanceRow[]> {
  if (filters.client && !filters.ignoreClosingPolicy) {
    throw new ValidationError(
      'queryAccumulatedBalances: a transaction client requires ignoreClosingPolicy — the report panel is read outside the transaction'
    );
  }
  const params: unknown[] = [entityId];
  let dateFilter = '';
  if (corte.date !== undefined) {
    params.push(corte.date);
    dateFilter = `AND je.entry_date ${corte.inclusive ? '<=' : '<'} $2`;
    if (corte.periodId !== undefined) {
      params.push(corte.periodId);
      dateFilter = corte.inclusive
        ? `${dateFilter} AND NOT ${sharedDayOfAnotherPeriod('>')}`
        : `AND (je.entry_date < $2 OR ${sharedDayOfAnotherPeriod('<')})`;
    }
  }
  const criterio = filters.ignoreClosingPolicy
    ? null
    : await criterioDeCierreEnInformes(entityId);
  const closingFilter = criterio && !criterio.enBalanza ? predicadoSinCierre() : '';
  let accountFilter = '';
  if (filters.accountId !== undefined) {
    params.push(filters.accountId);
    accountFilter = `AND a.id = $${params.length}`;
  }
  if (filters.accountIds !== undefined) {
    params.push([...filters.accountIds]);
    accountFilter = `${accountFilter} AND a.id = ANY($${params.length}::uuid[])`.trim();
  }
  const client = filters.client;
  const run = client
    ? <T extends pg.QueryResultRow>(sql: string, p: unknown[]) => client.query<T>(sql, p)
    : query;

  const result = await run<AccumulatedBalanceRow>(
    // La resta va escrita como Σcargos − Σabonos, y no como Σ(cargos − abonos)
    // que es la forma de las otras cinco consultas de este archivo. Dicen lo
    // mismo; la diferencia es que el criterio E1.2 CUENTA las cinco
    // apariciones literales de aquella expresión para que ningún mutante pueda
    // invertir una y esconderse entre las demás, y una sexta copia idéntica
    // devolvería la cuenta a cinco justo cuando el mutante la quita. El orden
    // —cargos MENOS abonos— es lo que aquí se afirma, y lo sostiene la prueba
    // de conducta: si se invierte, el saldo inicial de febrero sale −4 500.
    `SELECT
      jel.account_id,
      COALESCE(SUM(COALESCE(jel.debit_amount, 0)) - SUM(COALESCE(jel.credit_amount, 0)), 0) AS balance
    FROM accounts a
    JOIN journal_entry_lines jel ON jel.account_id = a.id
    JOIN journal_entries je
      ON je.id = jel.journal_entry_id
     AND je.entity_id = $1
     AND je.status = 'posted' ${dateFilter} ${closingFilter}
    WHERE a.entity_id = $1 ${accountFilter}
    GROUP BY jel.account_id`,
    params
  );
  return result.rows;
}

/**
 * The lifetime posted balance of ONE account, debit-positive, straight from
 * the ledger: every posted entry, closing entries included. It is the number
 * a control account is reconciled against and the number that backs a
 * prepaid schedule; neither is a presentation, so the report panel's closing
 * criterion does not apply. An account without lines reads as zero.
 */
export async function queryAccountBalance(
  entityId: string,
  accountId: string,
  client?: pg.PoolClient
): Promise<Decimal> {
  const rows = await queryAccumulatedBalances(
    entityId,
    { inclusive: true },
    { ignoreClosingPolicy: true, accountId, ...(client ? { client } : {}) }
  );
  return new Decimal(rows[0]?.balance ?? '0');
}

export interface EntryMovementRow {
  journal_entry_id: string;
  entry_number: string;
  entry_date: Date;
  description: string | null;
  /** Net debit-positive movement the entry left on the account. */
  amount: string;
  /** Who created the entry (`journal_entries.created_by`); the caller names the user. */
  created_by: string;
  /**
   * Σ `amount` and the count over EVERY row the filters keep, before `limit`:
   * a control that lists a page must still explain its balance with all of
   * them (TOTALS ARE COMPUTED OVER EVERY ROW, above).
   */
  total_amount: string;
  total_entries: number;
}

export interface EntryMovementFilters {
  /**
   * Leave out entries whose `source_type` is one of these, AND the reversals
   * of such entries. An engine reversal is born with a NULL `source_type`
   * (the reversal path does not carry the origin over), so filtering on the
   * column alone would list every clean void as if someone had typed it.
   */
  excludeSourceTypes?: readonly string[];
  /**
   * The mirror of `excludeSourceTypes`: only entries whose `source_type` is
   * one of these, AND the reversals of such entries (the FX revaluation and
   * its day-1 mirror, MNE-001-436).
   */
  onlySourceTypes?: readonly string[];
  /** Leave out these entries by id. */
  excludeEntryIds?: readonly string[];
  /** Only entries dated on or before this day (YYYY-MM-DD), the control's cut. */
  asOf?: string;
  /** Only these entries: the net a document's own entry left on the account. */
  entryIds?: readonly string[];
  /** Only entries whose net movement on the account is a debit. */
  netDebitsOnly?: boolean;
  /** Oldest first (default) or newest first; the entry number breaks ties. */
  order?: 'oldest' | 'newest';
  limit?: number;
  /**
   * Run inside the caller's transaction (MNE-001-437): a tax paper reads its
   * documents and their entries on one connection, as `queryTrialBalanceRows`
   * and `queryAccumulatedBalances` already allow.
   */
  client?: pg.PoolClient;
}

/**
 * The movement of ONE account broken down by posted entry: what a control
 * lists when it has to say WHICH entries explain its balance. Entity and
 * account scope live in the SQL, bounded on BOTH sides — the entry's entity
 * and the account's — like queryAccumulatedBalances: the schema does not
 * forbid a line whose account belongs to another entity than its entry, and
 * a balance and the list that explains it must count the same lines.
 */
export async function queryEntryMovementsOnAccount(
  entityId: string,
  accountId: string,
  filters: EntryMovementFilters = {}
): Promise<EntryMovementRow[]> {
  const params: unknown[] = [entityId, accountId];
  const where: string[] = [];
  if (filters.excludeSourceTypes) {
    params.push([...filters.excludeSourceTypes]);
    const types = `$${params.length}::text[]`;
    where.push(
      `AND (je.source_type IS NULL OR NOT (je.source_type = ANY(${types})))
        AND NOT EXISTS (
              SELECT 1
                FROM journal_entries orig
               WHERE orig.id = je.reverses_entry_id
                 AND orig.entity_id = je.entity_id
                 AND orig.source_type = ANY(${types}))`
    );
  }
  if (filters.onlySourceTypes) {
    params.push([...filters.onlySourceTypes]);
    const types = `$${params.length}::text[]`;
    where.push(
      `AND (je.source_type = ANY(${types}) OR EXISTS (
              SELECT 1
                FROM journal_entries orig
               WHERE orig.id = je.reverses_entry_id
                 AND orig.entity_id = je.entity_id
                 AND orig.source_type = ANY(${types})))`
    );
  }
  if (filters.excludeEntryIds) {
    params.push([...filters.excludeEntryIds]);
    where.push(`AND NOT (je.id = ANY($${params.length}::uuid[]))`);
  }
  if (filters.asOf !== undefined) {
    params.push(filters.asOf);
    where.push(`AND je.entry_date <= $${params.length}::date`);
  }
  if (filters.entryIds) {
    params.push([...filters.entryIds]);
    where.push(`AND je.id = ANY($${params.length}::uuid[])`);
  }
  const having = filters.netDebitsOnly
    ? 'HAVING SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)) > 0'
    : '';
  const direction = filters.order === 'newest' ? 'DESC' : 'ASC';
  let limit = '';
  if (filters.limit !== undefined) {
    params.push(filters.limit);
    limit = `LIMIT $${params.length}`;
  }

  const client = filters.client;
  const run = client
    ? (sql: string, p: unknown[]) => client.query<EntryMovementRow>(sql, p)
    : (sql: string, p: unknown[]) => query<EntryMovementRow>(sql, p);
  const result = await run(
    `SELECT je.id           AS journal_entry_id,
            je.entry_number AS entry_number,
            je.entry_date   AS entry_date,
            je.description  AS description,
            je.created_by::text AS created_by,
            SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0))::text AS amount,
            (SUM(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0))) OVER ())::text AS total_amount,
            (COUNT(*) OVER ())::int AS total_entries
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id AND a.entity_id = $1
      WHERE je.entity_id = $1 AND je.status = 'posted' AND jel.account_id = $2
        ${where.join(' ')}
      GROUP BY je.id, je.entry_number, je.entry_date, je.description, je.created_by
      ${having}
      ORDER BY je.entry_date ${direction}, je.entry_number ${direction}
      ${limit}`,
    params
  );
  return result.rows;
}

/**
 * The entry is dated on the fiscal year's LAST day, which its own period
 * shares with the period of the cut ($3), and its period comes before ('<')
 * or after ('>') that one in the same fiscal year.
 *
 * Only that day: it is the one two periods share by design (December and the
 * adjustment period 13). Any other overlap is a calendar anomaly, and there
 * the date and the period keep disagreeing so the balance reports it.
 */
function sharedDayOfAnotherPeriod(order: '<' | '>'): string {
  return `EXISTS (SELECT 1 FROM fiscal_periods own
                    JOIN fiscal_periods cut ON cut.id = $3
                    JOIN fiscal_years fy ON fy.id = cut.fiscal_year_id
                   WHERE own.id = je.fiscal_period_id
                     AND je.entry_date = fy.end_date
                     AND own.fiscal_year_id = cut.fiscal_year_id
                     AND own.period_number ${order} cut.period_number
                     AND je.entry_date BETWEEN own.start_date AND own.end_date
                     AND je.entry_date BETWEEN cut.start_date AND cut.end_date)`;
}

/** Índice cuenta → acumulado, con Decimal ya construido. */
function indiceDeSaldos(rows: AccumulatedBalanceRow[]): Map<string, Decimal> {
  return new Map(rows.map((r) => [r.account_id, new Decimal(r.balance)]));
}

/** El ANTES de una balanza: la fecha desde la que se cuenta el movimiento. */
interface RangoDeLaBalanza {
  /** Primer día del rango. El inicial es todo lo posteado ESTRICTAMENTE antes. */
  desde: string;
  /** Último día, cuando el rango lo tiene acotado. */
  hasta?: string;
  fiscal_period_id?: string;
  period_name?: string;
}

/**
 * Una balanza sólo tiene saldo inicial cuando tiene un ANTES.
 *
 * `asOfDate` y la historia completa arrancan en el origen de los libros: su
 * inicial no es cero por falta de datos, es cero porque no hay nada anterior,
 * y publicar una columna de ceros ahí invita a leerlos como arrastre. Por eso
 * devuelve null y las columnas se omiten en vez de inventarse.
 */
async function rangoDeLaBalanza(
  entityId: string,
  filters: TrialBalanceFilters
): Promise<RangoDeLaBalanza | null> {
  if (filters.fiscalPeriodId) {
    // La entidad va DENTRO del SQL: un id de periodo de otra entidad no puede
    // fechar la balanza de ésta.
    const r = await query<{ id: string; period_name: string; start_date: string; end_date: string }>(
      `SELECT id, period_name, start_date::text AS start_date, end_date::text AS end_date
         FROM fiscal_periods WHERE id = $1 AND entity_id = $2`,
      [filters.fiscalPeriodId, entityId]
    );
    const p = r.rows[0];
    if (!p) return null;
    return {
      desde: p.start_date,
      hasta: p.end_date,
      fiscal_period_id: p.id,
      period_name: p.period_name,
    };
  }
  if (filters.sinceDate) {
    return { desde: filters.sinceDate, ...(filters.untilDate ? { hasta: filters.untilDate } : {}) };
  }
  return null;
}

/**
 * El periodo que precede al rango, con su estado. Es quien jura si el inicial
 * es FIRME: mirar el estado del periodo consultado contesta otra pregunta
 * —agosto puede estar cerrado con julio abierto, que se cierra fuera de orden
 * más a menudo de lo que se admite—.
 */
async function periodoAnteriorA(
  entityId: string,
  desde: string
): Promise<{ period_name: string; status: string } | null> {
  const r = await query<{ period_name: string; status: string }>(
    `SELECT period_name, status
       FROM fiscal_periods
      WHERE entity_id = $1 AND end_date < $2
      ORDER BY end_date DESC, start_date DESC
      LIMIT 1`,
    [entityId, desde]
  );
  return r.rows[0] ?? null;
}

/** Criterio efectivo del panel para el origen del saldo inicial. */
async function criterioDeSaldoInicial(entityId: string): Promise<string> {
  const tenantId = currentTenant() ?? (await inquilinoDeLaEntidad(entityId));
  if (!tenantId) return SALDO_INICIAL_POR_OMISION;
  return (await getPolicy({ tenantId, entityId }, 'anexo24_balanza_saldo_inicial')).value;
}

async function inquilinoDeLaEntidad(entityId: string): Promise<string | undefined> {
  const r = await query<{ tenant_id: string }>(
    'SELECT tenant_id FROM legal_entities WHERE id = $1',
    [entityId]
  );
  return r.rows[0]?.tenant_id;
}

/** Lo que el cierre DURO dejó sembrado como inicial del periodo. */
async function saldosSembradosPorElCierre(
  entityId: string,
  fiscalPeriodId: string
): Promise<AccumulatedBalanceRow[]> {
  const r = await query<AccumulatedBalanceRow>(
    `SELECT account_id, beginning_balance::text AS balance
       FROM account_balances
      WHERE entity_id = $1 AND fiscal_period_id = $2`,
    [entityId, fiscalPeriodId]
  );
  return r.rows;
}

/** Una cuenta donde el recálculo del SAT no daría el saldo final declarado. */
export interface DescuadreDeCuenta {
  account_id: string;
  account_code: string;
  /** SaldoIni + Debe − Haber, que es lo que la autoridad recalcula. */
  esperado: string;
  /** El acumulado del mayor al corte, pedido aparte. */
  obtenido: string;
  /** esperado − obtenido. Nunca se absorbe: se publica. */
  diferencia: string;
}

/** La nota y la procedencia del saldo inicial de una balanza. */
export interface AvisoDeSaldoInicial {
  /** Valor efectivo de 'anexo24_balanza_saldo_inicial'. */
  criterio: string;
  /** De dónde salió la cifra de cada cuenta. */
  origen: 'mayor' | 'arrastre_del_cierre';
  /** El inicial es todo lo posteado ANTES de esta fecha. */
  desde: string;
  /**
   * La cifra ya no puede cambiar. CALCULABLE siempre lo es —si no lo fuera,
   * esta balanza no existiría—; FIRME sólo cuando el periodo ANTERIOR está
   * cerrado en duro o bloqueado, porque hasta entonces todavía se puede
   * postear ahí y el inicial de mañana sería otro.
   */
  firme: boolean;
  periodo_anterior: { period_name: string; status: string } | null;
  /** Cuentas donde SaldoIni + Debe − Haber ≠ SaldoFin. Vacío = pasa el recálculo. */
  descuadres: DescuadreDeCuenta[];
  /** Texto listo para imprimir, en el idioma del informe. */
  note: string;
}

/** Fila de balanza con las dos columnas que el Anexo 24 añade. */
export interface TrialBalanceReportRow extends TrialBalanceQueryRow {
  /**
   * SaldoIni. Presente sólo cuando la balanza tiene un ANTES —un periodo o un
   * rango con fecha de inicio—; ausente en la acumulada y en la historia
   * completa, donde no hay nada anterior que arrastrar.
   */
  beginning_balance?: string;
  /** SaldoFin: el acumulado del mayor al corte, calculado aparte del inicial. */
  final_balance?: string;
  /** SaldoIni + Debe − Haber = SaldoFin para ESTA cuenta. */
  cuadra?: boolean;
}

/** The rows where SaldoIni + Debe − Haber ≠ SaldoFin, with the difference named. */
function unbalancedRows(rows: readonly TrialBalanceReportRow[]): DescuadreDeCuenta[] {
  return rows
    .filter((r) => r.cuadra === false)
    .map((r) => {
      const esperado = new Decimal(r.beginning_balance ?? 0).plus(r.debit_total).minus(r.credit_total);
      const fin = new Decimal(r.final_balance ?? 0);
      return {
        account_id: r.account_id,
        account_code: r.account_code,
        esperado: esperado.toFixed(LEDGER_SCALE),
        obtenido: fin.toFixed(LEDGER_SCALE),
        diferencia: esperado.minus(fin).toFixed(LEDGER_SCALE),
      };
    });
}

/**
 * Añade a cada fila su SaldoIni y su SaldoFin, y comprueba el invariante que
 * el SAT recalcula. Devuelve null cuando la balanza no tiene un ANTES.
 */
async function conSaldoInicial(
  entityId: string,
  opts: TrialBalanceOptions,
  filas: TrialBalanceQueryRow[]
): Promise<{ rows: TrialBalanceReportRow[]; inicial: AvisoDeSaldoInicial } | null> {
  const rango = await rangoDeLaBalanza(entityId, opts);
  if (!rango) return null;

  const criterio = await criterioDeSaldoInicial(entityId);
  const previo = await periodoAnteriorA(entityId, rango.desde);
  const firme = previo !== null && (previo.status === 'hard_close' || previo.status === 'locked');

  let origen: AvisoDeSaldoInicial['origen'];
  let iniciales: Map<string, Decimal>;
  if (criterio === 'exigir_cierre_duro') {
    // EL CRITERIO QUE SE NIEGA. Quien lo eligió pidió exactamente esto: sin
    // arrastre sembrado no hay balanza, en vez de una balanza con ceros que
    // se firma igual. El mensaje dice las dos salidas que tiene.
    origen = 'arrastre_del_cierre';
    const sembrados = rango.fiscal_period_id
      ? await saldosSembradosPorElCierre(entityId, rango.fiscal_period_id)
      : [];
    if (sembrados.length === 0) {
      throw new ValidationError(
        `La balanza desde ${rango.desde} no tiene saldo inicial arrastrado y la política ` +
          `'anexo24_balanza_saldo_inicial' está en 'exigir_cierre_duro'` +
          (previo ? `: ${previo.period_name} está en '${previo.status}'` : ': no hay periodo anterior') +
          `. Cierre en duro el periodo anterior o cambie el criterio a 'derivar_del_mayor'.`
      );
    }
    iniciales = indiceDeSaldos(sembrados);
  } else {
    origen = 'mayor';
    iniciales = indiceDeSaldos(
      await queryAccumulatedBalances(
        entityId,
        { date: rango.desde, inclusive: false, periodId: rango.fiscal_period_id },
        opts
      )
    );
  }

  const finales = indiceDeSaldos(
    await queryAccumulatedBalances(
      entityId,
      { date: rango.hasta, inclusive: true, periodId: rango.fiscal_period_id },
      opts
    )
  );

  const cero = new Decimal(0);
  const rows: TrialBalanceReportRow[] = filas.map((r) => {
    const ini = iniciales.get(r.account_id) ?? cero;
    const fin = finales.get(r.account_id) ?? cero;
    // Sin tolerancia: las cuatro columnas son DECIMAL(19,4) exactas y el SAT
    // rehace la resta con las mismas cifras. Un céntimo aquí no es redondeo.
    const cuadra = ini.plus(r.debit_total).minus(r.credit_total).equals(fin);
    return {
      ...r,
      // Las cuatro columnas salen a la escala del mayor, no a la de la nota al
      // pie: son cifras del libro, y mezclar escalas dentro de una fila es
      // como se pierde un céntimo entre columnas.
      beginning_balance: ini.toFixed(LEDGER_SCALE),
      final_balance: fin.toFixed(LEDGER_SCALE),
      cuadra,
    };
  });

  const descuadres = unbalancedRows(rows);
  const conArrastre = [...iniciales.values()].filter((v) => !v.isZero()).length;
  const partes: string[] = [];
  if (origen === 'mayor') {
    partes.push(`Opening balance derived from the ledger: everything posted before ${rango.desde}.`);
  } else {
    partes.push(
      `Opening balance carried forward by the hard close of ` +
        `${previo?.period_name ?? 'the previous period'}.`
    );
  }
  if (firme) {
    // `firme` sólo es cierto con `previo` no nulo, y TS lo sabe por el alias.
    partes.push(`Firm: ${previo.period_name} is ${previo.status}.`);
  } else if (previo) {
    partes.push(
      `Computable but NOT firm: ${previo.period_name} is '${previo.status}', so an entry ` +
        `posted there would change it.`
    );
  } else {
    partes.push(
      `No earlier fiscal period, so it should be zero` +
        (conArrastre > 0
          ? ` — and ${conArrastre} account(s) already carry a balance before ${rango.desde}.`
          : '.')
    );
  }
  if (descuadres.length > 0) {
    partes.push(
      `${descuadres.length} account(s) fail SaldoIni + Debe − Haber = SaldoFin; see descuadres.`
    );
  }

  return {
    rows,
    inicial: {
      criterio,
      origen,
      desde: rango.desde,
      firme,
      periodo_anterior: previo,
      descuadres,
      note: partes.join(' '),
    },
  };
}

export interface TrialBalanceReport {
  entity_id: string;
  /**
   * Las filas llevan SaldoIni y SaldoFin ADEMÁS de lo de siempre, nunca en su
   * lugar: `ending_balance` conserva exactamente el significado y el valor que
   * publican hoy la CLI, el REST y las herramientas del agente.
   */
  rows: TrialBalanceReportRow[];
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
  /**
   * Presente sólo cuando la balanza tiene un ANTES —un periodo o un rango con
   * fecha de inicio—, que es cuando existe un saldo inicial que declarar.
   */
  inicial?: AvisoDeSaldoInicial;
}

export interface TrialBalanceOptions extends TrialBalanceFilters {
  /** Drop accounts whose ending balance is exactly zero. */
  excludeZero?: boolean;
  limit?: number;
  offset?: number;
  scale?: number;
  /**
   * Each account carries its own figures PLUS those of its whole subtree
   * (`accounts.parent_id`). The Anexo 24 trial balance needs it: the SAT
   * reads a ledger account as the sum of its subaccounts, and declaring it at
   * zero is accepted and wrong (#323).
   */
  rollUp?: boolean;
  /**
   * Show accounts down to this level, and IMPLIES `rollUp` (#100): the cut
   * happens after each subtree has been summed into its ancestors. As a plain
   * SQL filter it printed 1110 at zero with 1111/1112 gone, and the footing
   * OUT OF BALANCE, so there is no un-rolled way to ask for it.
   */
  maxLevel?: number;
}

/** Account id → the ids of all its ancestors, and the account's level. */
export interface AccountAncestry {
  level: number;
  ancestors: readonly string[];
}

/**
 * Every account of the entity with ALL its ancestors, from one recursive CTE.
 * `UNION` (not `UNION ALL`) is what ends the recursion on a hand-edited
 * `parent_id` cycle: the pair repeats and the working set empties.
 */
export async function queryAccountAncestry(entityId: string): Promise<Map<string, AccountAncestry>> {
  const r = await query<{ account_id: string; account_level: number; ancestors: string[] }>(
    `WITH RECURSIVE up AS (
       SELECT a.id AS account_id, a.parent_id AS ancestor_id
         FROM accounts a
        WHERE a.entity_id = $1 AND a.parent_id IS NOT NULL
       UNION
       SELECT up.account_id, p.parent_id
         FROM up JOIN accounts p ON p.id = up.ancestor_id AND p.entity_id = $1
        WHERE p.parent_id IS NOT NULL
     )
     SELECT a.id AS account_id, a.account_level,
            COALESCE(array_agg(up.ancestor_id::text) FILTER (WHERE up.ancestor_id IS NOT NULL),
                     '{}'::text[]) AS ancestors
       FROM accounts a LEFT JOIN up ON up.account_id = a.id
      WHERE a.entity_id = $1
      GROUP BY a.id, a.account_level`,
    [entityId]
  );
  return new Map(
    r.rows.map((x) => [x.account_id, { level: Number(x.account_level), ancestors: x.ancestors }])
  );
}

export interface LedgerNetRow {
  id: string;
  code: string;
  parent_code: string | null;
  normal_balance: string;
  codigo_agrupador_sat: string | null;
  /** Debit-positive net (debit − credit) of the posted entries at the cut. */
  net: string;
}

/**
 * Every account of the entity with its parent's code and its net at a cut,
 * reversal pairs left out on both sides: the reversed entry
 * (`reversed_by_entry_id`) and its mirror (`reverses_entry_id`). It is the
 * ledger side of `opening-balance check` (`checkOpeningBalance`,
 * MNE-001-616): a reversed opening stays posted on the opening day while its
 * mirror is dated the day it was voided, so counting the original "as of" the
 * opening day would double every balance right after a reload (087).
 *
 * LEFT JOINs, with the entry's predicates inside its ON, so an account with
 * no line (or only lines of a draft, a later or a reversed entry) comes back
 * at zero instead of dropping out. No closing policy is read: the check
 * compares facts of the ledger with the source's SaldoFin.
 */
export async function queryLedgerNetsWithoutReversalPairs(entityId: string, asOf: string): Promise<LedgerNetRow[]> {
  const r = await query<LedgerNetRow>(
    `SELECT a.id, a.code, p.code AS parent_code, a.normal_balance, a.codigo_agrupador_sat,
            COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))
                       FILTER (WHERE e.id IS NOT NULL), 0)::text AS net
       FROM accounts a
       LEFT JOIN accounts p ON p.id = a.parent_id AND p.entity_id = a.entity_id
       LEFT JOIN journal_entry_lines l ON l.account_id = a.id
       LEFT JOIN journal_entries e
              ON e.id = l.journal_entry_id AND e.entity_id = a.entity_id
             AND e.status = 'posted' AND e.entry_date <= $2::date
             AND e.reversed_by_entry_id IS NULL AND e.reverses_entry_id IS NULL
      WHERE a.entity_id = $1
      GROUP BY a.id, a.code, p.code, a.normal_balance, a.codigo_agrupador_sat`,
    [entityId, asOf]
  );
  return r.rows;
}

const ROLLED_COLUMNS = ['debit_total', 'credit_total', 'ending_balance', 'beginning_balance', 'final_balance'] as const;

/**
 * THE roll-up: each row gets its own figures plus those of every row below it.
 *
 * Pure, and the only one: the Anexo 24 balanza and `trial-balance --level`
 * (#100) both come through here, so there is no second place where a subtree
 * can be summed differently. Every column is debit-positive or a plain sum of
 * amounts, so a credit-nature child (accumulated depreciation under fixed
 * assets) nets against its parent instead of adding to it. `cuadra` is
 * recomputed on the rolled figures, because that is the row the SAT redoes.
 */
export function rollUpTrialBalanceRows(
  rows: readonly TrialBalanceReportRow[],
  ancestry: ReadonlyMap<string, AccountAncestry>
): TrialBalanceReportRow[] {
  const sums = new Map(
    rows.map((r) => [r.account_id, ROLLED_COLUMNS.map((c) => new Decimal(r[c] ?? 0))])
  );
  for (const r of rows) {
    const own = ROLLED_COLUMNS.map((c) => new Decimal(r[c] ?? 0));
    for (const a of ancestry.get(r.account_id)?.ancestors ?? []) {
      const acc = a === r.account_id ? undefined : sums.get(a);
      if (acc) own.forEach((v, i) => (acc[i] = acc[i].plus(v)));
    }
  }
  return rows.map((r) => {
    const s = sums.get(r.account_id)!;
    const out: TrialBalanceReportRow = { ...r };
    ROLLED_COLUMNS.forEach((c, i) => {
      if (r[c] !== undefined) out[c] = s[i].toFixed(LEDGER_SCALE);
    });
    if (r.cuadra !== undefined) out.cuadra = s[3].plus(s[0]).minus(s[1]).equals(s[4]);
    return out;
  });
}

export async function getTrialBalance(
  entityId: string,
  opts: TrialBalanceOptions = {}
): Promise<TrialBalanceReport> {
  // The level cut happens AFTER summing: in SQL it would drop the deeper
  // levels' money before anyone could add it to their parents.
  const { maxLevel, ...queryOpts } = opts;
  const rollUp = opts.rollUp === true || maxLevel !== undefined;
  const all = await queryTrialBalanceRows(entityId, queryOpts);

  // El saldo inicial se resuelve ANTES de recortar: `--exclude-zero` tiene que
  // poder mirar las cuatro columnas. Una cuenta sin movimiento en el mes pero
  // con saldo arrastrado es exactamente la que el Anexo 24 necesita —el SAT
  // recalcula sobre su SaldoIni— y la que la versión anterior del filtro
  // dejaba fuera por tener el movimiento en cero.
  const cuatroColumnas = await conSaldoInicial(entityId, queryOpts, all);
  let filas: TrialBalanceReportRow[] = cuatroColumnas?.rows ?? all;
  // Footed over the OWN figures: rolled rows would count each amount once
  // per level of the tree.
  const footing = rollUp ? totalTrialBalance(filas, opts.scale ?? LEDGER_SCALE) : null;
  if (rollUp) {
    const ancestry = await queryAccountAncestry(entityId);
    filas = rollUpTrialBalanceRows(filas, ancestry).filter(
      (r) => maxLevel === undefined || (ancestry.get(r.account_id)?.level ?? 1) <= maxLevel
    );
    if (cuatroColumnas) cuatroColumnas.inicial.descuadres = unbalancedRows(filas);
  }
  const matched = opts.excludeZero
    ? filas.filter(
        (r) =>
          !new Decimal(r.ending_balance).isZero() ||
          !new Decimal(r.beginning_balance ?? 0).isZero() ||
          !new Decimal(r.final_balance ?? 0).isZero()
      )
    : filas;

  // Footing happens here, over every matched row, BEFORE the page is cut.
  const totals = footing ?? totalTrialBalance(matched, opts.scale ?? LEDGER_SCALE);
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
    ...(cuatroColumnas ? { inicial: cuatroColumnas.inicial } : {}),
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
  /**
   * The section's stable key and its human label. Two fields and not one
   * derived from the other (I11 · issue #153): the label is going to be
   * translated, and a key computed from a translated label would change with
   * the reader's language — which is exactly what the agent and the scripts
   * must not depend on.
   */
  section: { key: string; name: string },
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
    // The `fs_category` as stored, untouched: the label below is the one that
    // gets prettified, and later translated.
    key: cat,
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
    key: section.key,
    name: section.name,
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

// CONTRIBUTED CAPITAL, THEN EARNED CAPITAL (MNE-001-652 · #597)
//
// NIF B-6 presents equity as contributed capital plus earned
// capital, and NIF C-11 (migration 346's header) puts the reserves, the
// accumulated results and the ORI in earned capital. The result of the period
// is an accumulated result not yet swept, so it is earned capital as well. One
// rule, not a choice: no panel key (#597, comment of 24 Nov).
//
// `equity` is contributed capital (346's COMMENT). Earned capital spans three
// subsections, so it gets its own total, `BalanceSheetReport.earned_capital`.
// Inside it the order follows the chart's numbering: reserves and results
// (3150-3300), the unswept result, ORI (3600). Ordered by key, never by an
// account code: a chart that numbers ORI first must still print it last.

/** Equity's subsections, in the order the statement presents them. */
const EQUITY_ORDER = ['equity', 'earned_capital', 'result_of_the_period', 'ori'] as const;

/** The subsections that NIF C-11 counts as earned capital. */
export const EARNED_CAPITAL_SUBSECTIONS: readonly string[] = EQUITY_ORDER.slice(1);

/** Earned capital: its total, and the keys of the subsections it groups, in order. */
export interface EarnedCapital {
  key: 'earned_capital';
  total: string;
  subsections: string[];
}

export interface BalanceSheetReport {
  entity_id: string;
  as_of_date: string;
  assets: BalanceSheetSection;
  liabilities: BalanceSheetSection;
  equity: BalanceSheetSection;
  /** Reserves, accumulated results, the result of the period and ORI (NIF C-11). */
  earned_capital: EarnedCapital;
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

  const assets = buildBalanceSheetSection(rows, ['asset', 'contra_asset'], { key: 'assets', name: 'Assets' }, 1, scale);
  const liabilities = buildBalanceSheetSection(rows, ['liability', 'contra_liability'], { key: 'liabilities', name: 'Liabilities' }, -1, scale);
  const equity = buildBalanceSheetSection(rows, ['equity', 'contra_equity'], { key: 'equity', name: 'Equity' }, -1, scale);

  // The result of the period belongs to the owners, so it is presented inside
  // equity. Without it the statement is short by exactly the unclosed result
  // and cannot foot — which is what it did before this line existed.
  const unclosed = await queryUnclosedEarnings(entityId, opts.asOfDate);
  const earnings = new Decimal(unclosed).times(-1); // debit-positive → equity's natural sign
  if (!earnings.isZero()) {
    equity.subsections.push({
      key: 'result_of_the_period',
      name: 'Result Of The Period',
      total: earnings.toFixed(scale),
      accounts: [],
    });
    equity.total = new Decimal(equity.total).plus(earnings).toFixed(scale);
  }

  // A stable sort: a category outside both components keeps its code order,
  // after them.
  const rank = (key: string): number => {
    const at = (EQUITY_ORDER as readonly string[]).indexOf(key);
    return at === -1 ? EQUITY_ORDER.length : at;
  };
  equity.subsections.sort((a, b) => rank(a.key) - rank(b.key));
  const earned = equity.subsections.filter((s) => EARNED_CAPITAL_SUBSECTIONS.includes(s.key));

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
    earned_capital: {
      key: 'earned_capital',
      total: earned.reduce((sum, s) => sum.plus(s.total), new Decimal(0)).toFixed(scale),
      subsections: earned.map((s) => s.key),
    },
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

  // Y NO hay criterio del panel sobre cuentas archivadas AQUÍ: el estado de
  // resultados ya incluye exactamente a las cuentas con actividad en el rango
  // —eso es lo que decide su HAVING—, así que no queda nada que un despacho
  // pueda preferir. La bifurcación existe sólo en la balanza, que es el
  // informe que conserva a propósito las cuentas sin movimiento.

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
    -- SIN el filtro por is_active. Este HAVING ya deja fuera a la cuenta
    -- que no se movió en el rango, así que aquel filtro sólo podía borrar
    -- una que SÍ se movió: un ejercicio cerrado imprimía Revenue 0.0000
    -- porque alguien archivó la 4100 después. Ver criterio-archivadas.ts.
    WHERE a.entity_id = $1
      AND a.account_type IN ('revenue', 'expense')
    GROUP BY a.id, a.account_type, a.fs_category, a.code, a.name
    ${having}
    ORDER BY a.code`,
    [entityId, opts.startDate, opts.endDate]
  );
  return result.rows;
}

/**
 * WHAT THE PERIOD MOVED, BY ACCOUNT TYPE, with each SECTION's natural sign and
 * the panel's closing-entry policy (X0, #118).
 *
 * It exists because the publisher of public figures carried its own query over
 * the ledger, and disagreed with the same firm's income statement on two
 * counts, both measured against Postgres:
 *
 *  · It flipped the sign PER ACCOUNT, so a contra-natural account added to its
 *    section: 10,000 of sales with 2,000 of returns published as 12,000 rather
 *    than 8,000. The sign belongs to the SECTION — the same reason
 *    `buildIncomeStatementSection` already has written down — because abs() or
 *    a per-account sign inflates precisely the contra-natural row.
 *  · It never asked about closing entries, and the year-end close sweeps the
 *    WHOLE year into the period that closes it: the last month published
 *    revenue of −8,000. Whether to exclude them is the firm's own criterion
 *    (`informes_asientos_de_cierre`), with one switch for the income statement
 *    and another for the trial balance, and both are honoured here.
 *
 * `transaction_count` counts ENTRIES, not lines: it feeds the panel's privacy
 * threshold, and counting lines inflates the crowd behind the figure.
 */
export interface AccountTypeMovement {
  account_type: string;
  /** Natural sign of the section, at LEDGER_SCALE. */
  total: string;
  transaction_count: number;
  currency_code: string | null;
}

const CREDIT_NATURAL_TYPES = new Set(['liability', 'equity', 'revenue']);

export async function getPeriodMovementByAccountType(
  entityId: string,
  fiscalPeriodId: string
): Promise<AccountTypeMovement[]> {
  const closingPolicy = await criterioDeCierreEnInformes(entityId);
  const includeClosingIn: string[] = [];
  if (closingPolicy.enEstadoDeResultados) includeClosingIn.push('revenue', 'expense');
  if (closingPolicy.enBalanza) includeClosingIn.push('asset', 'liability', 'equity');

  const result = await query<{
    account_type: string;
    debit_total: string;
    credit_total: string;
    transaction_count: string;
    currency_code: string | null;
  }>(
    `SELECT a.account_type,
            COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0)::text AS debit_total,
            COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0)::text AS credit_total,
            COUNT(DISTINCT je.id)::text AS transaction_count,
            MAX(le.functional_currency) AS currency_code
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id
       JOIN legal_entities le ON le.id = je.entity_id
      WHERE je.entity_id = $1 AND je.fiscal_period_id = $2 AND je.status = 'posted'
        AND (a.account_type = ANY($3::text[]) OR NOT ${condicionDeCierre('je')})
      GROUP BY a.account_type`,
    [entityId, fiscalPeriodId, includeClosingIn]
  );

  return result.rows.map((row) => {
    const debitPositive = new Decimal(row.debit_total).minus(row.credit_total);
    const natural = CREDIT_NATURAL_TYPES.has(row.account_type) ? debitPositive.negated() : debitPositive;
    return {
      account_type: row.account_type,
      total: natural.toFixed(LEDGER_SCALE),
      transaction_count: Number(row.transaction_count),
      currency_code: row.currency_code,
    };
  });
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
    key: type === 'revenue' ? 'revenue' : 'expenses',
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
// CASH-FLOW STATEMENT READS (MNE-001-052, #101)
//
// The indirect method deduces cash from double entry: Δcash is minus the net
// movement of every account that is not cash. These two reads are the ledger
// side of that statement; cash-flow-service.ts classifies and assembles.
// Both follow the INCOME STATEMENT's closing switch, not the trial balance's,
// because the method's first line is net income and both figures must come
// from the same entries. For the tie-out against cash it makes no difference:
// a closing entry moves results against equity and never touches cash.
// ------------------------------------------------------------

export interface PeriodAccountMovementRow {
  account_id: string;
  code: string;
  name: string;
  account_type: string;
  account_subtype: string | null;
  fs_category: string | null;
  debit_total: string;
  credit_total: string;
}

/**
 * Posted debits and credits of each account in the range, leaving out
 * `excludeAccountIds`, and only the accounts that moved. The inner
 * (jel JOIN je) pair is load-bearing: two chained JOINs let lines of draft
 * entries through. The entity is bound on both sides, the entry's and the
 * account's, as in queryEntryMovementsOnAccount.
 */
export async function queryPeriodMovementByAccount(
  entityId: string,
  opts: { startDate: string; endDate: string; excludeAccountIds: readonly string[] }
): Promise<PeriodAccountMovementRow[]> {
  const closingPolicy = await criterioDeCierreEnInformes(entityId);
  const closingFilter = closingPolicy.enEstadoDeResultados ? '' : predicadoSinCierre();

  const r = await query<PeriodAccountMovementRow>(
    `SELECT a.id AS account_id, a.code, a.name,
            a.account_type, a.account_subtype, a.fs_category,
            COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0)::text AS debit_total,
            COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0)::text AS credit_total
       FROM accounts a
       JOIN (journal_entry_lines jel
             JOIN journal_entries je
               ON je.id = jel.journal_entry_id
              AND je.entity_id = $1
              AND je.status = 'posted'
              AND je.entry_date BETWEEN $2 AND $3
              ${closingFilter})
         ON jel.account_id = a.id
      WHERE a.entity_id = $1
        AND NOT (a.id = ANY($4::uuid[]))
      GROUP BY a.id, a.code, a.name, a.account_type, a.account_subtype, a.fs_category
     HAVING COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0) <> 0
         OR COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0) <> 0
      ORDER BY a.code`,
    [entityId, opts.startDate, opts.endDate, [...opts.excludeAccountIds]]
  );
  return r.rows;
}

export interface EntryAccountMovementRow {
  entry_id: string;
  entry_number: string;
  entry_date: string;
  description: string | null;
  account_id: string;
  code: string;
  name: string;
  debit_total: string;
  credit_total: string;
}

/**
 * Debits and credits per posted entry and account, for the entries in the
 * range that have a line on `withLineOn` and none on `withoutLineOn`: the
 * investing and financing entries that moved no cash, which the statement
 * leaves out and discloses apart (NIF B-2, ASC 230). One statement for the
 * whole set; the caller passes the ids its classifier chose, so the
 * classification rule is not rewritten in SQL.
 */
export async function queryEntryMovementsTouching(
  entityId: string,
  opts: {
    startDate: string;
    endDate: string;
    withLineOn: readonly string[];
    withoutLineOn: readonly string[];
  }
): Promise<EntryAccountMovementRow[]> {
  const closingPolicy = await criterioDeCierreEnInformes(entityId);
  const closingFilter = closingPolicy.enEstadoDeResultados ? '' : predicadoSinCierre();

  const r = await query<EntryAccountMovementRow>(
    `SELECT jel.journal_entry_id AS entry_id, je.entry_number,
            je.entry_date::text AS entry_date, je.description,
            a.id AS account_id, a.code, a.name,
            COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0)::text AS debit_total,
            COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0)::text AS credit_total
       FROM accounts a
       JOIN (journal_entry_lines jel
             JOIN journal_entries je
               ON je.id = jel.journal_entry_id
              AND je.entity_id = $1
              AND je.status = 'posted'
              AND je.entry_date BETWEEN $2 AND $3
              ${closingFilter})
         ON jel.account_id = a.id
      WHERE a.entity_id = $1
        AND EXISTS (SELECT 1 FROM journal_entry_lines t
                     WHERE t.journal_entry_id = jel.journal_entry_id
                       AND t.account_id = ANY($4::uuid[]))
        AND NOT EXISTS (SELECT 1 FROM journal_entry_lines c
                         WHERE c.journal_entry_id = jel.journal_entry_id
                           AND c.account_id = ANY($5::uuid[]))
      GROUP BY jel.journal_entry_id, je.entry_number, je.entry_date, je.description,
               a.id, a.code, a.name
      ORDER BY je.entry_date, je.entry_number, a.code`,
    [entityId, opts.startDate, opts.endDate, [...opts.withLineOn], [...opts.withoutLineOn]]
  );
  return r.rows;
}

export interface OpeningAndMovementRow {
  /** Accumulated posted balance (debit − credit) before `startDate`. */
  opening: string;
  /** Posted movement (debit − credit) from `startDate` to `endDate`. */
  movement: string;
}

/**
 * The opening balance and the movement of a set of accounts, summed over the
 * set: the real cash movement the cash-flow statement is tied out against
 * (`movimientoRealDeEfectivo`, MNE-001-433). ONE statement, so one snapshot:
 * two reads through the pool would take two, and an entry dated before the
 * range that committed between them would show up as a residue that is not
 * there. The opening is accumulated from the ledger, not read from
 * `account_balances.beginning_balance`, which only a hard close seeds.
 *
 * Closing entries count, and no closing policy is read: a closing entry
 * sweeps results against equity and never touches cash, and the tie-out
 * compares facts of the ledger, not a presentation. A range that ends before
 * it starts goes to Postgres as given: the opening is the balance at
 * `endDate` and the movement is zero. The inner (jel JOIN je) pair, with the
 * date cut inside the JOIN, keeps draft and void lines out; the entity is
 * bound on the entry's side and the account's.
 */
export async function queryOpeningAndMovement(
  entityId: string,
  opts: { accountIds: readonly string[]; startDate: string; endDate: string }
): Promise<OpeningAndMovementRow> {
  const r = await query<OpeningAndMovementRow>(
    `SELECT
       COALESCE(SUM(CASE WHEN je.entry_date < $2
                    THEN COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)
                    ELSE 0 END), 0)::text AS opening,
       COALESCE(SUM(CASE WHEN je.entry_date BETWEEN $2 AND $3
                    THEN COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)
                    ELSE 0 END), 0)::text AS movement
       FROM (journal_entry_lines jel
        JOIN journal_entries je
          ON je.id = jel.journal_entry_id
         AND je.status = 'posted'
         AND je.entity_id = $1
         AND je.entry_date <= $3)
       JOIN accounts a ON a.id = jel.account_id AND a.entity_id = $1
      WHERE jel.account_id = ANY($4::uuid[])`,
    [entityId, opts.startDate, opts.endDate, [...opts.accountIds]]
  );
  return r.rows[0] ?? { opening: '0', movement: '0' };
}

export interface EntryEffectByCounterpartRow {
  entry_number: string;
  /**
   * Text from Postgres (`::text`), never a Date: `pg` hands a DATE over as
   * local midnight, and turning it back to ISO west of UTC moves it back a
   * day (an entry of the 25th printed as of the 24th).
   */
  entry_date: string;
  description: string | null;
  /** The entry's share of its net on cash for this counterpart, unrounded numeric as text. Positive = cash came in. */
  effect: string;
  counterpart_code: string;
  counterpart_name: string;
  counterpart_type: string;
  counterpart_subtype: string | null;
  counterpart_fs: string | null;
  counterpart_role: string | null;
}

/**
 * The effect on cash of each posted entry in the range, by counterpart: the
 * rows the tie-out's residue suspects are picked from (`sospechososDelResiduo`,
 * MNE-001-434). ONE statement for the whole set, with the cash ids as one
 * array, never one read per entry or account.
 *
 * `cash` is each entry's net (debit − credit) on `accountIds`, only for the
 * entries that moved cash. `counterparts` spreads that net over the entry's
 * other lines in proportion to their amount (debit + credit): an entry with
 * one bank payment and three different charges cannot lay the whole payment
 * on each of them. The split stays in SQL numeric, so the caller rounds once
 * and the rounding is the one it always had.
 *
 * Closing entries count and no closing policy is read, as in
 * queryOpeningAndMovement: a closing entry never touches cash. The inner
 * (jel JOIN je) pair, with the range inside the JOIN, keeps draft and void
 * lines out; the entity is bound on the entry's side, the account's and the
 * role's. The tie-break orders by `entry_date::text`, the same expression the
 * GROUP BY holds: Postgres rejects a bare `entry_date` there. `limit` is the
 * row limit as given; the caller filters the rows and asks for more than it
 * keeps.
 */
export async function queryEntryEffectByCounterpart(
  entityId: string,
  opts: { accountIds: readonly string[]; startDate: string; endDate: string; limit: number }
): Promise<EntryEffectByCounterpartRow[]> {
  const r = await query<EntryEffectByCounterpartRow>(
    `WITH cash AS (
       SELECT jel.journal_entry_id AS je_id,
              SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)) AS effect
         FROM (journal_entry_lines jel
          JOIN journal_entries je
            ON je.id = jel.journal_entry_id
           AND je.status = 'posted'
           AND je.entity_id = $1
           AND je.entry_date BETWEEN $2 AND $3)
        WHERE jel.account_id = ANY($4::uuid[])
        GROUP BY jel.journal_entry_id
       HAVING SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)) <> 0
     ),
     counterparts AS (
       SELECT e.je_id,
              jel.account_id,
              e.effect * (COALESCE(jel.debit_amount, 0) + COALESCE(jel.credit_amount, 0))
                / NULLIF(SUM(COALESCE(jel.debit_amount, 0) + COALESCE(jel.credit_amount, 0))
                         OVER (PARTITION BY e.je_id), 0) AS effect
         FROM cash e
         JOIN journal_entry_lines jel ON jel.journal_entry_id = e.je_id
        WHERE NOT (jel.account_id = ANY($4::uuid[]))
     )
     SELECT je.entry_number,
            je.entry_date::text AS entry_date,
            je.description,
            SUM(c.effect)::text AS effect,
            a.code AS counterpart_code,
            a.name AS counterpart_name,
            a.account_type AS counterpart_type,
            a.account_subtype AS counterpart_subtype,
            a.fs_category AS counterpart_fs,
            MIN(ar.role) AS counterpart_role
       FROM counterparts c
       JOIN journal_entries je ON je.id = c.je_id AND je.entity_id = $1
       JOIN accounts a ON a.id = c.account_id AND a.entity_id = $1
       LEFT JOIN account_roles ar ON ar.account_id = a.id AND ar.entity_id = $1
      GROUP BY je.entry_number, je.entry_date::text, je.description,
               a.code, a.name, a.account_type, a.account_subtype, a.fs_category
      ORDER BY ABS(SUM(c.effect)) DESC, je.entry_date::text, je.entry_number
      LIMIT $5`,
    [entityId, opts.startDate, opts.endDate, [...opts.accountIds], opts.limit]
  );
  return r.rows;
}

// ------------------------------------------------------------
// FX REVALUATION READS (MNE-001-617, #101)
//
// The two sums the closing revaluation (`revalueForeignBalances`,
// fx-revaluation.ts) reads from the ledger before it posts, on the caller's
// transaction client: the run holds its period FOR UPDATE, and a reading taken
// outside that transaction would not be serialised with a second run of the
// same period. Neither reads a policy, so nothing here leaves the transaction.
// Each keeps inside the statement what decides WHICH lines are summed (the
// receivable, payable and bank scope; the gain and loss accounts left out):
// taking it out would cost a second query.
// ------------------------------------------------------------

export interface ForeignBalanceRow {
  account_id: string;
  code: string;
  currency: string;
  /** Foreign balance, debit positive. */
  foreign: string;
  /** Its functional value in the books, debit positive. */
  book: string;
}

/**
 * The foreign balances of receivables, payables and banks at the period's last
 * day, per account and currency (MNE-001-083): the lines of the entity's
 * receivable, payable and bank role accounts and of every bank account's GL
 * account, tagged with a currency other than the functional one, on posted
 * entries dated up to the cut. The FX columns give the foreign balance and the
 * functional ones its book value.
 */
export async function queryForeignBalancesByAccount(
  entityId: string,
  closingDate: string,
  functional: string,
  client?: pg.PoolClient
): Promise<ForeignBalanceRow[]> {
  const text = `WITH scope AS (
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
      ORDER BY a.code, l.currency_code`;
  const values = [entityId, closingDate, functional];
  const r = client
    ? await client.query<ForeignBalanceRow>(text, values)
    : await query<ForeignBalanceRow>(text, values);
  return r.rows;
}

export interface RevaluationNetRow {
  account_id: string;
  /** Debit-positive net (debit − credit) of the given entries on the account. */
  net: string;
}

/**
 * Per account, the net the given entries left, leaving out the entity's
 * exchange gain and loss role accounts: those lines are the counterpart, not
 * a revalued balance. It is the ledger side of
 * the revaluation's marker check (`assertMarkerMatchesLedger`, MNE-001-083):
 * the period's `fx_revaluation` entries, read by id from an entity-bound read,
 * must net per account what the marker rows say.
 */
export async function queryRevaluationNetByAccount(
  entityId: string,
  entryIds: readonly string[],
  client?: pg.PoolClient
): Promise<RevaluationNetRow[]> {
  const text = `SELECT account_id, SUM(COALESCE(debit_amount, 0) - COALESCE(credit_amount, 0))::text AS net
         FROM journal_entry_lines
        WHERE journal_entry_id = ANY($1::uuid[])
          AND account_id NOT IN (SELECT account_id FROM account_roles
                                  WHERE entity_id = $2 AND role IN ('utilidad_cambiaria', 'perdida_cambiaria'))
        GROUP BY account_id`;
  const values = [[...entryIds], entityId];
  const r = client
    ? await client.query<RevaluationNetRow>(text, values)
    : await query<RevaluationNetRow>(text, values);
  return r.rows;
}

// ------------------------------------------------------------
// IEPS CASH-BASIS READS (MNE-001-618, #101)
//
// The four sums the IEPS on cash basis (ieps-cash-basis.ts, LIEPS art. 10)
// reads back from the ledger, on the caller's transaction client: a collection,
// an unapply or a cashing reads what the lines it is about to post depend on,
// and a reading taken outside that transaction would not see the lines it has
// just written, nor be held by its locks. None reads a policy, so nothing here
// leaves the transaction. Each keeps inside the statement what decides WHICH
// lines are summed (the role join, the tag under `IEPS_MOVE_TAG`, the posted
// and unreversed entries): taking it out would cost a second query. The tag
// and the roles come from the leaf ieps-roles.ts, which ieps-cash-basis.ts
// re-exports, so the strings are the same and no import cycle is made.
// ------------------------------------------------------------

/**
 * The IEPS the invoice's own posted, unreversed entry parked in the
 * uncollected role (2181), credit − debit, in the functional currency
 * (`iepsParkedByInvoice`, MNE-001-504). '0' when no line was parked; the
 * caller never lets it below zero.
 */
export async function queryIepsParkedByInvoice(
  entityId: string,
  invoiceId: string,
  client?: pg.PoolClient
): Promise<string> {
  const text = `SELECT COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::text AS ieps_parked
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN account_roles ar ON ar.account_id = l.account_id
                            AND ar.entity_id = je.entity_id AND ar.qualifier IS NULL
      WHERE je.entity_id = $1 AND je.source_type = 'invoice' AND je.source_id = $2
        AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL
        AND ar.role = $3`;
  const values = [entityId, invoiceId, IEPS_UNCOLLECTED_ROLE];
  const r = client
    ? await client.query<{ ieps_parked: string }>(text, values)
    : await query<{ ieps_parked: string }>(text, values);
  return r.rows[0]?.ieps_parked ?? '0';
}

/**
 * The net IEPS moved out of the uncollected role for an invoice, debit −
 * credit, by every receipt (`paymentId` null) or by one (`iepsMovedForInvoice`):
 * the lines tagged with the invoice on posted entries that are neither
 * reversed nor reversals, so a reversed event moved nothing. Signed as read.
 */
export async function queryIepsMovedForInvoice(
  entityId: string,
  invoiceId: string,
  paymentId: string | null,
  client?: pg.PoolClient
): Promise<string> {
  const text = `SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::text AS moved
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN account_roles ar ON ar.account_id = l.account_id
                            AND ar.entity_id = je.entity_id AND ar.qualifier IS NULL
      WHERE je.entity_id = $1 AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL
        AND je.is_reversal = false
        AND ar.role = $2
        AND l.tags -> '${IEPS_MOVE_TAG}' ->> 'invoice_id' = $3
        AND ($4::text IS NULL OR l.tags -> '${IEPS_MOVE_TAG}' ->> 'payment_id' = $4::text)`;
  const values = [entityId, IEPS_UNCOLLECTED_ROLE, invoiceId, paymentId];
  const r = client
    ? await client.query<{ moved: string }>(text, values)
    : await query<{ moved: string }>(text, values);
  return r.rows[0]?.moved ?? '0';
}

/**
 * The IEPS a receipt's cash on account carries, caused when it was collected
 * (`iepsKeptOnAccount`, MNE-001-590): credit − debit over both IEPS roles on
 * the receipt's tagged lines of posted entries that are neither reversed nor
 * reversals. '0' when none; the caller never lets it below zero.
 */
export async function queryIepsKeptOnAccount(
  entityId: string,
  paymentId: string,
  client?: pg.PoolClient
): Promise<string> {
  const text = `SELECT COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::text AS kept
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN account_roles ar ON ar.account_id = l.account_id
                            AND ar.entity_id = je.entity_id AND ar.qualifier IS NULL
      WHERE je.entity_id = $1 AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL
        AND je.is_reversal = false
        AND ar.role = ANY($2::text[])
        AND l.tags -> '${IEPS_MOVE_TAG}' ->> 'payment_id' = $3`;
  const values = [entityId, [IEPS_UNCOLLECTED_ROLE, IEPS_DUE_ROLE], paymentId];
  const r = client
    ? await client.query<{ kept: string }>(text, values)
    : await query<{ kept: string }>(text, values);
  return r.rows[0]?.kept ?? '0';
}

export interface IepsTakenRow {
  allocation_id: string;
  /** The invoice's share the row's application moved out of 2181, debit − credit. */
  released: string;
  /** Debit − credit over both IEPS roles: the IEPS it took from the cash on account. */
  taken: string;
}

/**
 * Per allocation row, what its application moved, read back from the lines
 * tagged with its `allocation_id` (`iepsTakenByRows`, MNE-001-604): one
 * statement for every row asked, on posted entries that are neither reversed
 * nor reversals. A row written before the tag existed is absent.
 */
export async function queryIepsTakenByRows(
  entityId: string,
  allocationIds: readonly string[],
  client?: pg.PoolClient
): Promise<IepsTakenRow[]> {
  const text = `SELECT l.tags -> '${IEPS_MOVE_TAG}' ->> 'allocation_id' AS allocation_id,
            SUM(CASE WHEN ar.role = $2 THEN COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0) ELSE 0 END)::text AS released,
            SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))::text AS taken
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN account_roles ar ON ar.account_id = l.account_id
                            AND ar.entity_id = je.entity_id AND ar.qualifier IS NULL
      WHERE je.entity_id = $1 AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL
        AND je.is_reversal = false
        AND ar.role = ANY($3::text[])
        AND l.tags -> '${IEPS_MOVE_TAG}' ->> 'allocation_id' = ANY($4::text[])
      GROUP BY 1`;
  const values = [entityId, IEPS_UNCOLLECTED_ROLE, [IEPS_UNCOLLECTED_ROLE, IEPS_DUE_ROLE], [...allocationIds]];
  const r = client ? await client.query<IepsTakenRow>(text, values) : await query<IepsTakenRow>(text, values);
  return r.rows;
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

/**
 * SQL: the book value of a document's open balance in the functional
 * currency. `alias` is the document table's alias, `entityParam` the
 * placeholder of the entity id (the functional currency is read in the SQL).
 *
 * The control account carries an open foreign document at the rate it was
 * born with, because payments book the realised difference against that same
 * rate (MNE-001-112; the why is in fx-revaluation.ts). It lives here so the
 * aging and the reconciliations read one expression.
 *
 * `amountSql` is the balance to weigh: the maintained one unless the caller
 * read the balance of a past day (MNE-001-648), which keeps the same rate.
 */
export function bookAmountDueSql(alias: string, entityParam: string, amountSql = `${alias}.amount_due`): string {
  return (
    `CASE WHEN ${alias}.currency_code IS NULL OR ${alias}.currency_code = ` +
    `(SELECT functional_currency FROM legal_entities WHERE id = ${entityParam}) ` +
    `THEN ${amountSql} ELSE ROUND(${amountSql} * ${alias}.exchange_rate, 4) END`
  );
}

export interface AgedReceivableRow {
  customer_id: string;
  customer_name: string;
  customer_number: string;
  invoice_id: string;
  invoice_number: string;
  invoice_date: Date | string;
  due_date: Date | string;
  /** The document's currency: `total_amount` and `amount_due` are in it. */
  currency_code: string;
  total_amount: string;
  amount_due: string;
  /** `amount_due` in the functional currency, at the rate the document was posted at (NIF B-15). */
  book_amount_due: string;
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
  currency_code: string;
  total_amount: string;
  amount_due: string;
  book_amount_due: string;
  days_overdue: number;
}

/** Which order the caller publishes. Both were already in use; neither wins by default. */
export type AgingOrder = 'party' | 'overdue';

export const RECEIVABLE_OPEN_STATUSES = ['sent', 'viewed', 'partially_paid', 'overdue'] as const;
export const PAYABLE_OPEN_STATUSES = ['approved', 'posted', 'partially_paid'] as const;

/**
 * Two readings, and the report says which it gave (`balance_basis`):
 *
 *   CURRENT reads `amount_due` AS IT IS NOW, over the documents open now. The
 *   cutoff only ages the due date: fine for a collections call.
 *
 *   AS OF THE CUTOFF (`reconstruct`, MNE-001-648) reads what each invoice
 *   issued on or before it still owed at the end of that day, by the one
 *   definition `customer show --as-of` binds (`amountDueAsOfSql`), in one
 *   statement. A document voided after the cutoff was a receivable that day
 *   (`voidedAfterSql`). Payables still read CURRENT only (MNE-001-649).
 *
 * MNE-001-647: a row is in its document's currency and says which, and
 * `book_amount_due` is that balance in the functional currency, at the rate
 * the document was posted at, in this same statement. Nothing is revalued.
 */
export async function queryAgedReceivableRows(
  entityId: string,
  opts: { asOfDate: string; order?: AgingOrder; reconstruct?: boolean }
): Promise<AgedReceivableRow[]> {
  const orderBy = opts.order === 'overdue' ? 'days_overdue DESC, c.company_name' : 'c.company_name, i.due_date';
  const columns = `c.id as customer_id, c.company_name as customer_name, c.customer_number,
      i.id as invoice_id, i.invoice_number, i.invoice_date, i.due_date,
      i.currency_code, i.total_amount`;
  if (opts.reconstruct) {
    // OFFSET 0 keeps the balance of the day from being inlined into the
    // filter, the column and the book value: its subqueries run once per invoice.
    const dated = await query<AgedReceivableRow>(
      `SELECT
      ${columns}, d.amount_due,
      ${bookAmountDueSql('i', '$1', 'd.amount_due')} as book_amount_due,
      ($2::date - i.due_date) as days_overdue
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    CROSS JOIN LATERAL (SELECT ${amountDueAsOfSql('$2')} AS amount_due OFFSET 0) d
    WHERE i.entity_id = $1 AND i.invoice_date <= $2::date
      AND (i.status <> ALL($3::text[]) OR (i.status = 'void' AND ${voidedAfterSql('$2')}))
      AND d.amount_due > 0
    ORDER BY ${orderBy}`,
      [entityId, opts.asOfDate, [...NEVER_RECEIVABLE_STATUSES]]
    );
    return dated.rows;
  }
  const result = await query<AgedReceivableRow>(
    `SELECT
      ${columns}, i.amount_due,
      ${bookAmountDueSql('i', '$1')} as book_amount_due,
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
      b.currency_code, b.total_amount, b.amount_due,
      ${bookAmountDueSql('b', '$1')} as book_amount_due,
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
  /** Which balances the rows carry: those of `as_of_date`, or today's aged against it. */
  balance_basis: 'as_of_date' | 'current';
  rows: Row[];
  /** Open documents matched, before limit/offset. */
  total: number;
  /** Per currency, over every matched document, never over the page. */
  totals_by_currency: AgingCurrencyTotal[];
  /** Σ book_amount_due: the whole listing in the functional currency. */
  total_book_amount_due: string;
}

export interface AgingCurrencyTotal {
  currency_code: string;
  documents: number;
  /** In `currency_code`. Balances of different currencies are never added. */
  amount_due: string;
  /** In the functional currency. */
  book_amount_due: string;
}

/**
 * The totals of an aged listing (MNE-001-647): what is due in each currency,
 * and the book value of it all in the functional one. One pass over rows
 * already in memory.
 */
export function totalAging(
  rows: Array<Pick<AgedReceivableRow, 'currency_code' | 'amount_due' | 'book_amount_due'>>,
  scale: number = LEDGER_SCALE
): Pick<AgingReport<unknown>, 'totals_by_currency' | 'total_book_amount_due'> {
  const byCurrency = new Map<string, { documents: number; due: Decimal; book: Decimal }>();
  let book = new Decimal(0);
  for (const r of rows) {
    const sum = byCurrency.get(r.currency_code) ?? { documents: 0, due: new Decimal(0), book: new Decimal(0) };
    sum.documents += 1;
    sum.due = sum.due.plus(r.amount_due);
    sum.book = sum.book.plus(r.book_amount_due);
    byCurrency.set(r.currency_code, sum);
    book = book.plus(r.book_amount_due);
  }
  return {
    totals_by_currency: [...byCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency_code, sum]) => ({
        currency_code,
        documents: sum.documents,
        amount_due: sum.due.toFixed(scale),
        book_amount_due: sum.book.toFixed(scale),
      })),
    total_book_amount_due: book.toFixed(scale),
  };
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
  /** `reconstruct`: read the balances of `asOfDate`; a surface asks for it when its caller stated the date. */
  opts: AgingOptions & { reconstruct?: boolean }
): Promise<AgingReport<AgedReceivableRow>> {
  const all = await queryAgedReceivableRows(entityId, opts);
  return {
    entity_id: entityId,
    as_of_date: opts.asOfDate,
    balance_basis: opts.reconstruct ? 'as_of_date' : 'current',
    rows: paginate(all, opts.limit, opts.offset),
    total: all.length,
    ...totalAging(all, opts.scale),
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
    balance_basis: 'current',
    rows: paginate(all, opts.limit, opts.offset),
    total: all.length,
    ...totalAging(all, opts.scale),
  };
}

// ------------------------------------------------------------
// RECEIVABLE POSTING READS (MNE-001-616, #101)
//
// Two sums the AR posting reads from the ledger before it writes, on the
// caller's transaction client: a reading taken outside the transaction would
// not see the lines it has just written, nor be held by its locks. Neither
// reads a policy, so nothing here leaves the transaction. Each one keeps the
// join to its document table inside the statement: the join decides which
// lines are summed, and taking it out would cost a second query.
// ------------------------------------------------------------

/**
 * The net the invoice's own entry left on one account: the debit its
 * receivable was born with (the sum of its rounded lines, MNE-001-081), read
 * by the tranche that collects a foreign invoice in full (`receivableCredit`,
 * ar-ap-posting.ts) so the receivable ends at exactly zero. The invoice is
 * bound to the entity; its entry is read whatever its status, as it always
 * was. Null when the entry has no line on the account.
 */
export async function queryInvoiceEntryNetOnAccount(
  entityId: string,
  invoiceId: string,
  accountId: string,
  client?: pg.PoolClient
): Promise<string | null> {
  const text = `SELECT SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))::text AS born
         FROM invoices i
         JOIN journal_entry_lines l ON l.journal_entry_id = i.journal_entry_id
        WHERE i.id = $1 AND i.entity_id = $2 AND l.account_id = $3`;
  const values = [invoiceId, entityId, accountId];
  const r = client
    ? await client.query<{ born: string | null }>(text, values)
    : await query<{ born: string | null }>(text, values);
  return r.rows[0]?.born ?? null;
}

export interface HeldNoteIvaRow {
  payment_id: string;
  payment_number: string;
  invoice_id: string;
  /** What the note's `held_restitution` lines for this receipt took from 2125. */
  iva: string;
  /** The mirror's day, or the cashing's when the mirror is dated before it. */
  day: string;
}

/**
 * Per receipt the bank has cashed, the IVA a reversed credit note took from
 * 2125 on its `held_restitution` lines (`followNoteReversal`, MNE-001-612):
 * the note's entry and its mirror bound to the entity, the receipt completed
 * and cashed, and a live posted cashing entry standing. One statement for
 * the whole note, ordered by receipt number.
 */
export async function queryHeldNoteIvaByCashedReceipt(
  entityId: string,
  entries: { noteEntryId: string; mirrorEntryId: string },
  client?: pg.PoolClient
): Promise<HeldNoteIvaRow[]> {
  const text = `SELECT cp.id::text AS payment_id, cp.payment_number, l.tags -> '${HELD_RESTITUTION_TAG}' ->> 'invoice_id' AS invoice_id,
            SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))::text AS iva,
            GREATEST(m.entry_date, cp.check_cashed_date)::text AS day
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id AND je.id = $2 AND je.entity_id = $1
       JOIN journal_entries m ON m.id = $3 AND m.entity_id = $1
       JOIN customer_payments cp ON cp.id::text = l.tags -> '${HELD_RESTITUTION_TAG}' ->> 'payment_id' AND cp.entity_id = $1
                                AND cp.status = 'completed' AND cp.check_cashed_tx_id IS NOT NULL
      WHERE l.tags ? '${HELD_RESTITUTION_TAG}'
        -- MNE-001-794: a cashing may post one entry per day, so it is asked for, not joined (a join would sum
        -- the note's lines once per entry), and the day is the bank's, the one every entry of it once carried.
        AND EXISTS (SELECT 1 FROM journal_entries c
                     WHERE c.entity_id = $1 AND c.source_type = 'customer_cheque_cashing' AND c.source_id = cp.id
                       AND c.status = 'posted' AND c.reversed_by_entry_id IS NULL AND c.is_reversal = false)
      GROUP BY cp.id, cp.payment_number, l.tags -> '${HELD_RESTITUTION_TAG}' ->> 'invoice_id', m.entry_date, cp.check_cashed_date
      ORDER BY cp.payment_number`;
  const values = [entityId, entries.noteEntryId, entries.mirrorEntryId];
  const r = client ? await client.query<HeldNoteIvaRow>(text, values) : await query<HeldNoteIvaRow>(text, values);
  return r.rows;
}

// ------------------------------------------------------------
// IVA CASH-BASIS AND OVER-CREDIT READS (MNE-001-619, #101)
//
// Two sums the IVA cash basis reads from the ledger, on the caller's
// transaction client: what an issued invoice's credit notes took from 2125
// (`issuedVatStillParked`, iva-cash-basis.ts), read by the note or the unapply
// that is about to post, and what correction entries already put back in 1135
// for a bill (the over-credit census, vat-overcredit.ts), read again under the
// bill's lock before a correction posts. Neither reads a policy, so nothing
// here leaves the transaction. Each sum is a column of a statement that reads
// the document's other figures, and moves with it: a read of its own would
// cost a query per document, or a second one per run. The sources and roles
// are the callers' parameters, as they always were: importing them here would
// close a cycle back to those modules.
// ------------------------------------------------------------

export interface IssuedInvoiceVatTakenRow {
  /** What the invoice's live collections stored as released from 2125. */
  released: string;
  /** The cash and withholdings of the live collections that stored no release. */
  unknown: string;
  /** Debit-positive net its posted, unreversed credit notes left on the parked-IVA account. */
  notes: string;
  tax: string;
  total: string;
}

/**
 * What an issued invoice's collections and credit notes took from 2125
 * (MNE-001-575): the releases its live allocations stored, the cash of those
 * that stored none (written before MNE-001-459, counted at their pro rata by
 * the caller), and the net its posted, unreversed credit notes left on the
 * entity's parked-IVA role account (`parkedRole`), with the invoice's tax and
 * total. The invoice, the collections and the role are bound to the entity.
 * Undefined when the entity has no such invoice.
 */
export async function queryIssuedInvoiceVatTaken(
  entityId: string,
  invoiceId: string,
  parkedRole: string,
  client?: pg.PoolClient
): Promise<IssuedInvoiceVatTakenRow | undefined> {
  const text = `SELECT COALESCE((SELECT SUM(pa.iva_reclass_amount) FROM payment_allocations pa
                        JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
                       WHERE pa.invoice_id = i.id AND pa.unapplied_at IS NULL), 0)::text AS released,
            COALESCE((SELECT SUM(pa.amount_applied + pa.withholding_isr_amount + pa.withholding_iva_amount)
                        FROM payment_allocations pa
                        JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
                       WHERE pa.invoice_id = i.id AND pa.unapplied_at IS NULL
                         AND pa.iva_reclass_amount IS NULL), 0)::text AS unknown,
            COALESCE((SELECT SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))
                        FROM credit_notes cn
                        JOIN journal_entries je ON je.entity_id = $1 AND je.source_type = 'credit_note'
                                               AND je.source_id = cn.id AND je.status = 'posted'
                                               AND je.reversed_by_entry_id IS NULL
                        JOIN journal_entry_lines l ON l.journal_entry_id = je.id
                        JOIN account_roles ar ON ar.account_id = l.account_id AND ar.entity_id = $1
                                             AND ar.role = $3 AND ar.qualifier IS NULL
                       WHERE cn.entity_id = $1 AND cn.invoice_id = i.id), 0)::text AS notes,
            i.tax_amount::text AS tax, i.total_amount::text AS total
       FROM invoices i
      WHERE i.id = $2 AND i.entity_id = $1`;
  const values = [entityId, invoiceId, parkedRole];
  const r = client
    ? await client.query<IssuedInvoiceVatTakenRow>(text, values)
    : await query<IssuedInvoiceVatTakenRow>(text, values);
  return r.rows[0];
}

export interface VatOvercreditBillRow {
  tenant_id: string;
  bill_id: string;
  entity_id: string;
  entity_name: string;
  bill_number: string;
  cfdi_uuid: string | null;
  header: string;
  total: string;
  amount_due: string;
  currency_code: string;
  functional_currency: string | null;
  xml_taxes: string;
  tax_breakdown: unknown;
  has_note: boolean;
  /** Debit-positive net the bill's posted, unreversed corrections left on the pending-VAT account. */
  corrected: string;
  correction_entries: string | null;
  roles: number;
}

/**
 * The bills of the VAT over-credit census (MNE-001-562): per bill made from a
 * received CFDI that transfers a tax other than VAT, of the tenant (one entity
 * and one bill when named), on Mexican books and not void or cancelled, its
 * header and totals, whether a received credit note stands (`noteSource`),
 * what its posted, unreversed corrections (`correctionSource`) put back on the
 * pending-VAT role account (`pendingRole`) and their numbers, and how many of
 * the two roles the correction moves between the entity has.
 *
 * The bill's oldest xml_cfdi pre-registration of its own entity, as migration
 * 328 and the REP linkage read it, and only when its summary lists a transfer
 * that is not VAT: a CFDI with VAT alone and a bill with no CFDI never enter.
 */
export async function queryVatOvercreditBills(
  tenantId: string,
  scope: { entityId: string | null; billId: string | null },
  keys: { noteSource: string; correctionSource: string; pendingRole: string; creditableRole: string },
  client?: pg.PoolClient
): Promise<VatOvercreditBillRow[]> {
  const text = `
SELECT le.tenant_id, b.id AS bill_id, b.entity_id, le.name AS entity_name, b.bill_number, b.cfdi_uuid,
       b.tax_amount::text AS header, b.total_amount::text AS total, b.amount_due::text AS amount_due,
       b.currency_code, le.functional_currency, c.xml_taxes::text AS xml_taxes, c.tax_breakdown,
       EXISTS (SELECT 1 FROM journal_entries n
                WHERE n.entity_id = b.entity_id AND n.source_type = $3 AND n.source_id = b.id
                  AND n.status = 'posted' AND n.reversed_by_entry_id IS NULL) AS has_note,
       COALESCE((SELECT SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))
                   FROM journal_entries k
                   JOIN journal_entry_lines l ON l.journal_entry_id = k.id
                   JOIN account_roles ar ON ar.account_id = l.account_id AND ar.entity_id = b.entity_id
                                        AND ar.role = $5 AND ar.qualifier IS NULL
                  WHERE k.entity_id = b.entity_id AND k.source_type = $4 AND k.source_id = b.id
                    AND k.status = 'posted' AND k.reversed_by_entry_id IS NULL), 0)::text AS corrected,
       (SELECT string_agg(k.entry_number, ', ' ORDER BY k.entry_date, k.entry_number) FROM journal_entries k
         WHERE k.entity_id = b.entity_id AND k.source_type = $4 AND k.source_id = b.id
           AND k.status = 'posted' AND k.reversed_by_entry_id IS NULL) AS correction_entries,
       (SELECT count(DISTINCT ar.role)::int FROM account_roles ar
         WHERE ar.entity_id = b.entity_id AND ar.qualifier IS NULL AND ar.role IN ($5, $6)) AS roles
  FROM (SELECT DISTINCT ON (p.bill_id) p.bill_id, p.entity_id, p.tax_amount AS xml_taxes, p.tax_breakdown
          FROM pre_registrations p
         WHERE p.source_type = 'xml_cfdi' AND p.bill_id IS NOT NULL
         ORDER BY p.bill_id, p.created_at, p.id) c
  JOIN bills b ON b.id = c.bill_id AND b.entity_id = c.entity_id
  JOIN legal_entities le ON le.id = b.entity_id
 WHERE le.tenant_id = $1
   AND ($2::uuid IS NULL OR le.id = $2::uuid)
   AND ($7::uuid IS NULL OR b.id = $7::uuid)
   AND ${sqlKeepsMexicanBooks('le')}
   AND b.status NOT IN ('void', 'cancelled')
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.tax_breakdown->'traslados') = 'array'
                                                       THEN c.tax_breakdown->'traslados' ELSE '[]'::jsonb END) x
                WHERE lpad(COALESCE(x->>'impuesto', ''), 3, '0') <> '002')
 ORDER BY le.name, b.bill_number, b.id`;
  const values = [
    tenantId, scope.entityId, keys.noteSource, keys.correctionSource, keys.pendingRole, keys.creditableRole, scope.billId,
  ];
  const r = client
    ? await client.query<VatOvercreditBillRow>(text, values)
    : await query<VatOvercreditBillRow>(text, values);
  return r.rows;
}

// ------------------------------------------------------------
// BANK ACCOUNT BOOK BALANCE READS (MNE-001-620, #101)
//
// Two sums bank-account-service.ts reads from the ledger: the book balance
// of each bank account its projection lists (`bank account show` and `list`,
// and the re-read of `create`, `edit` and `set` inside their transaction),
// and the posted lines the remap guard of `bank account set` counts on its
// transaction client. The book balance is a correlated subquery the
// projection composes per row, as `bookAmountDueSql` is: a reader of its own
// would cost a query per listed account, and the projection, whose masked
// columns are that module's control, stays there. Neither reads a policy.
// ------------------------------------------------------------

/**
 * SQL: the lifetime posted balance of one account, debit-positive, closing
 * entries included, as a subquery of one column, which the bank account
 * projection reads by the alias it had there. `accountSql` and `entitySql` are
 * the caller's expressions for the account and the entity the entries belong
 * to (for that projection, `b.gl_account_id` and `b.entity_id`). An account
 * without posted lines reads as zero.
 *
 * COALESCE per side, not over the difference: migration 001 makes
 * `debit_amount` and `credit_amount` mutually exclusive by CHECK, so a credit
 * line has a NULL debit, and `debit − credit` over it is NULL, which SUM
 * skips. Subtracting that way read zero for any account with movements, the
 * worst way to be wrong: it looks like a balance.
 */
export function postedBalanceOnAccountSql(accountSql: string, entitySql: string): string {
  return `SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0) AS saldo
        FROM journal_entry_lines l
        JOIN journal_entries j ON j.id = l.journal_entry_id
       WHERE l.account_id = ${accountSql}
         AND j.entity_id = ${entitySql}
         AND j.status = 'posted'`;
}

export interface PostedLinesOnAccountRow {
  /** How many posted lines the account carries. */
  lines: string;
  /** Their debit-positive net, as `postedBalanceOnAccountSql` reads it. */
  balance: string;
}

/**
 * The posted lines of one account and their debit-positive net, closing
 * entries included, bound to the entity the entries belong to: what the
 * remap guard of `bank account set` counts before it moves a bank account to
 * another GL account (`movimientosPosteados`, bank-account-service.ts). Same
 * COALESCE per side as `postedBalanceOnAccountSql`, for the same reason. The
 * two column aliases are English, as new identifiers are; the expressions,
 * joins, predicates and parameters are the ones the guard always read.
 */
export async function queryPostedLinesOnAccount(
  entityId: string,
  accountId: string,
  client?: pg.PoolClient
): Promise<PostedLinesOnAccountRow> {
  const text = `SELECT COUNT(*)::text AS lines,
            COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::text AS balance
       FROM journal_entry_lines l
       JOIN journal_entries j ON j.id = l.journal_entry_id
      WHERE l.account_id = $1 AND j.entity_id = $2 AND j.status = 'posted'`;
  const values = [accountId, entityId];
  const r = client
    ? await client.query<PostedLinesOnAccountRow>(text, values)
    : await query<PostedLinesOnAccountRow>(text, values);
  return r.rows[0];
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
//
// F07a arregló ESTO en la BALANZA y no aquí: el inicial de la balanza se
// deriva del mayor (ver `conSaldoInicial`), así que hay cifra en cualquier
// estado del periodo, y `firme` sustituye a la pregunta que
// `inicial_confiable` contesta —allí el cero podía ser ausencia de arrastre;
// aquí todavía puede serlo—. El auxiliar es el XC del Anexo 24 y sigue
// leyendo `account_balances`: la misma derivación se le puede aplicar con
// `queryAccumulatedBalances`, y es trabajo con nombre, no un cambio de paso.
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

  // The house resolver (#327): uuid, YYYY-MM, or an unambiguous part of the
  // name, refusing an ambiguous one. The dates are re-read as text because
  // the driver turns a DATE column into a local-zone Date.
  const { id: periodId } = await resolvePeriod(entityId, periodName);
  const periodos = await query<{ id: string; period_name: string; status: string; start_date: string; end_date: string }>(
    `SELECT id, period_name, status, start_date::text AS start_date, end_date::text AS end_date
       FROM fiscal_periods WHERE entity_id = $1 AND id = $2`,
    [entityId, periodId]
  );
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
