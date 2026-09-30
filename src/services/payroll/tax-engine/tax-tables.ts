import Decimal from 'decimal.js';
import { query } from '../../../database/connection.js';
import type { PayFrequency, FilingStatus, TaxInput } from './tax-engine.interface.js';
import { daysBetween, toCalendarDate } from '../../../utils/calendar-date.js';
import { todayFor } from '../../policy/today.js';

// ============================================================
// TAX TABLE LOOKUP SERVICE
// Caches brackets + params by (jurisdiction, tax_type, year)
// ============================================================

export interface TaxBracket {
  bracket_order: number;
  bracket_low: number;
  bracket_high: number | null;
  rate: number;
  base_tax: number;
  data: Record<string, unknown>;
}

const bracketCache = new Map<string, TaxBracket[]>();
const paramCache = new Map<string, Record<string, unknown>>();

function cacheKey(jurisdiction: string, taxType: string, year: number, filingStatus?: string | null, payFrequency?: string | null): string {
  return `${jurisdiction}|${taxType}|${year}|${filingStatus || '-'}|${payFrequency || '-'}`;
}

export async function getBrackets(
  jurisdiction: string,
  taxType: string,
  taxYear: number,
  filingStatus: FilingStatus | null,
  payFrequency: PayFrequency | null
): Promise<TaxBracket[]> {
  const key = cacheKey(jurisdiction, taxType, taxYear, filingStatus, payFrequency);
  const cached = bracketCache.get(key);
  if (cached) return cached;

  const result = await query<{
    bracket_order: number;
    bracket_low: string;
    bracket_high: string | null;
    rate: string;
    base_tax: string;
    data: Record<string, unknown>;
  }>(
    `SELECT bracket_order, bracket_low, bracket_high, rate, base_tax, data
     FROM tax_tables
     WHERE jurisdiction = $1 AND tax_type = $2 AND tax_year = $3
       AND (filing_status = $4 OR (filing_status IS NULL AND $4 IS NULL))
       AND (pay_frequency = $5 OR (pay_frequency IS NULL AND $5 IS NULL))
     ORDER BY bracket_order ASC`,
    [jurisdiction, taxType, taxYear, filingStatus, payFrequency]
  );

  const brackets: TaxBracket[] = result.rows.map((r) => ({
    bracket_order: r.bracket_order,
    bracket_low: parseFloat(r.bracket_low),
    bracket_high: r.bracket_high ? parseFloat(r.bracket_high) : null,
    rate: parseFloat(r.rate),
    base_tax: parseFloat(r.base_tax),
    data: r.data,
  }));

  bracketCache.set(key, brackets);
  return brackets;
}

/**
 * The legal parameters in force on a given DATE.
 *
 * Two changes over what was here before, both for the same reason.
 *
 * 1. THE DATE, not the tax year. Since migration 073, `tax_parameters` has a
 *    validity window, because one year can hold two sets: the UMA takes effect
 *    on FEBRUARY 1st, so 2026 is 113.14 in January and 117.31 from February.
 *    Asking by YEAR would return one of the two rows at random.
 *
 * 2. IT THROWS instead of returning `{}`. Before, an unseeded year yielded an
 *    empty object in silence and each engine filled the gap its own way:
 *    `isr-calculator` threw, `imss-calculator` used `uma_daily || 113.14` and
 *    `infonavit-calculator` `|| 0.05`. The SAME missing datum produced an error
 *    in one engine and an invented figure in the other two — and the invented
 *    one reaches the payslip, the payroll CFDI and the IMSS payment line. A tax
 *    parameter that cannot be read is named, not substituted (the F08a rule).
 *
 * `effectiveDate` is the date OF THE ACT, not today, and the law fixes which
 * act (#242): each contribution day for IMSS and INFONAVIT
 * (`contributionMonths`); the ISR and subsidy tables go by the payment year
 * (`paymentYear`). It still defaults to today for the callers that do not pass
 * it: the US engines, and a TaxInput without the period's range.
 *
 * Y CONVIVE CON J0.2 (#199), que llegó por otro camino al mismo sitio. Su
 * migración 080 añade estas dos columnas y las rellena con el 1 de enero y el
 * 31 de diciembre del ejercicio — con `COALESCE` y `WHERE ... IS NULL`, así que
 * sobre las ventanas que siembra la 073 no toca nada. Lo que J0.2 dejaba para
 * J0.4 —que una fila ausente FALLE en vez de devolver `{}`— se adelanta aquí,
 * porque es la regla F08a y porque el hueco está vivo: los trece llamadores de
 * producción llaman sin fecha, y con `{}` cada motor rellenaba a su manera.
 */
export async function getTaxParameters(
  jurisdiction: string,
  taxYear: number,
  effectiveDate?: string | Date
): Promise<Record<string, unknown>> {
  // THE YEAR IS NOT DECORATION (WIT-03). The window is what selects the row,
  // but `taxYear` is what the CALLER asked for, and dropping it opened two
  // holes: a 2025 recomputation handed a 2026 date got 2026 parameters, and an
  // omitted date fell back to TODAY — so recomputing a 2025 payslip in 2026
  // silently used this year's UMA.
  //
  // So: the cache key carries the year, and when no date is given the default
  // stays INSIDE the requested year — today if today belongs to it, and its
  // last day otherwise. A historical exercise never borrows the present.
  // The date arrives as a string or as a Date: J0.2 builds it with
  // `new Date(Date.UTC(...))` and the rest of the subsystem speaks
  // `YYYY-MM-DD`. It is normalised here rather than at every call site, which
  // is how timezone conversions creep in.
  const requested =
    effectiveDate instanceof Date ? effectiveDate.toISOString().slice(0, 10) : effectiveDate;
  // #242: "today" is the day in the `zona_horaria` default, not the UTC day —
  // no entity is in hand here, so the panel's declared default answers.
  const today = await todayFor(null);
  const day = requested ?? (today.startsWith(`${taxYear}-`) ? today : `${taxYear}-12-31`);

  // AND THE TWO ARGUMENTS MUST AGREE (WIT-04).
  //
  // The window is what selects the row, and it is NOT filtered by `tax_year`
  // on purpose: `tax_year` labels the exercise a row was seeded for, and a
  // window legitimately crosses the calendar — the 2026 UMA runs from
  // 1 February 2026 to 31 January 2027, so a January-2027 date is correctly
  // served by a row labelled 2026. Adding `AND tax_year = $3` would break that.
  //
  // What must NOT happen is the caller asking for one exercise and handing a
  // date from another: `getTaxParameters('MX', 2025, '2026-03-15')` used to
  // answer with the 2026 row. That is not a lookup, it is a contradiction, and
  // neither answer is right — so it is refused instead of resolved.
  if (!day.startsWith(`${taxYear}-`)) {
    throw new Error(
      `Se pidieron los parámetros de ${jurisdiction} para el ejercicio ${taxYear} con una fecha de ` +
      `otro año (${day}): el ejercicio y la fecha del acto tienen que ser el mismo, o el recálculo ` +
      'de un recibo viejo tomaría los parámetros de hoy.'
    );
  }

  const key = `${jurisdiction}|${taxYear}|${day}`;
  const cached = paramCache.get(key);
  if (cached) return cached;

  const result = await query<{ params: Record<string, unknown> }>(
    `SELECT params FROM tax_parameters
      WHERE jurisdiction = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [jurisdiction, day]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `No hay parámetros fiscales de ${jurisdiction} vigentes el ${day} (ejercicio ${taxYear}): ` +
      'siembra la fila en tax_parameters antes de calcular. Sin ella no se puede retener, ' +
      'y una cifra inventada sale en el recibo, en el CFDI y en la línea de captura.'
    );
  }
  paramCache.set(key, row.params);
  return row.params;
}

/**
 * The exercise whose tables a withholding uses: the year of the PAYMENT.
 *
 * ISR and the employment subsidy are caused when the wage is paid (LISR 94 and
 * 96), and the payroll CFDI states that day as `FechaPago`. `tax_year` is the
 * period's label, and a period that closes on December 31st and is paid on
 * January 5th belongs, for ISR, to the new year. Without a payment date — a
 * caller that does not thread it yet — the label is all there is.
 */
export function paymentYear(input: Pick<TaxInput, 'tax_year' | 'pay_date'>): number {
  return input.pay_date ? Number(toCalendarDate(input.pay_date).slice(0, 4)) : input.tax_year;
}

export interface ContributionMonth {
  tax_year: number;
  /** First contribution day of the stretch: the date of the act for its parameters. */
  date?: string;
  days: number;
}

/**
 * The contribution days of a period, one stretch per calendar month.
 *
 * IMSS contributions are caused by elapsed months (LSS art. 39) and INFONAVIT
 * is paid on the same contribution days: each day contributes with the UMA and minimum wage in force THAT day, never
 * with those of the payment date. A week from January 29th to February 4th is
 * three days at January's UMA and four at February's — the UMA changes on
 * February 1st. The legal parameters only change on the first of a month, so
 * reading them once per stretch, at its first day, is reading them per day.
 *
 * Without the range, the period is a single stretch of `days_in_period` under
 * `tax_year` and no date — what every caller got before (#242).
 */
export function contributionMonths(
  input: Pick<TaxInput, 'tax_year' | 'days_in_period' | 'period_start' | 'period_end'>,
  defaultDays: number
): ContributionMonth[] {
  if (!input.period_start || !input.period_end) {
    return [{ tax_year: input.tax_year, days: input.days_in_period ?? defaultDays }];
  }
  const end = toCalendarDate(input.period_end);
  let first = toCalendarDate(input.period_start);
  if (first > end) {
    throw new Error(`The period starts on ${first}, after it ends on ${end}: it has no contribution days.`);
  }
  const stretches: ContributionMonth[] = [];
  for (;;) {
    const [y, m] = first.split('-').map(Number);
    const monthEnd = toCalendarDate(new Date(y, m, 0));
    const last = end < monthEnd ? end : monthEnd;
    stretches.push({ tax_year: y, date: first, days: daysBetween(first, last) + 1 });
    if (last === end) return stretches;
    first = toCalendarDate(new Date(y, m, 1));
  }
}

export interface MonthShare {
  /** First and last contribution day of the stretch, 'YYYY-MM-DD'. */
  start: string;
  end: string;
  days: number;
  /** The stretch's part of the amount, to the cent. */
  amount: Decimal;
}

/**
 * One payslip amount, split across the calendar months its period spans by
 * the contribution days of each month (#231, owner decision MNE-001-131).
 *
 * The law fixes this, so it is not a panel key: IMSS contributions are caused
 * by elapsed months (LSS art. 39) and INFONAVIT rides on the same contribution
 * days, so a week from February 25th to March 3rd is four days of February and
 * three of March. The SUA file and the employer liability BOTH attribute
 * through this one function: two readers with two rules is how that week ended
 * up declared in no month while the books carried it in March.
 *
 * Each stretch but the last is rounded half-up to the cent and the last takes
 * the remainder, so the shares always add back to the payslip exactly. A
 * period inside one month is a single stretch carrying the whole amount.
 */
export function splitByContributionMonth(
  periodStart: string,
  periodEnd: string,
  amount: Decimal.Value
): MonthShare[] {
  const stretches = contributionMonths(
    { tax_year: 0, period_start: periodStart, period_end: periodEnd },
    0
  );
  const total = new Decimal(amount);
  const totalDays = stretches.reduce((sum, s) => sum + s.days, 0);
  let assigned = new Decimal(0);
  return stretches.map((s, i) => {
    const share =
      i === stretches.length - 1
        ? total.minus(assigned)
        : total.times(s.days).dividedBy(totalDays).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    assigned = assigned.plus(share);
    const start = s.date as string;
    const [y, m, d] = start.split('-').map(Number);
    const end = new Date(Date.UTC(y, m - 1, d + s.days - 1)).toISOString().slice(0, 10);
    return { start, end, days: s.days, amount: share };
  });
}

/**
 * A legal parameter that MUST be there, or the calculation stops.
 *
 * THE DEFECT THIS CLOSES (T20 point 1 · #127): `getTaxParameters` returns `{}`
 * when the year has no row, and each engine filled the gap its own way —
 * `isr-calculator` threw, `imss-calculator` used `uma_daily || 113.14` and the
 * rates `|| 0`, `infonavit-calculator` `|| 0.05`. The SAME missing datum
 * produced an error in one engine and an INVENTED FIGURE in the other two, and
 * the invented one reaches the payslip, the payroll CFDI and the IMSS payment
 * line with the right `days_worked` — which is what makes it credible.
 *
 * The rule of this repository, already applied to the ISN in F08a: a tax that
 * cannot be computed is NAMED, not zeroed.
 */
export function requiredParameter(
  params: Record<string, unknown>,
  key: string,
  jurisdiction: string,
  taxYear: number
): number {
  const raw = params[key];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN;
  if (!Number.isFinite(value)) {
    throw new Error(
      `Falta el parámetro fiscal «${key}» de ${jurisdiction} para ${taxYear}: sin él no se puede ` +
      'calcular la cuota. Antes se sustituía por un valor quemado y la cifra inventada salía en ' +
      'el recibo, en el CFDI de nómina y en la línea de captura.'
    );
  }
  return value;
}


/**
 * A block of rates that must be complete, with the missing one NAMED.
 *
 * `params.imss_employee` used to be read as `|| {}` and every rate as `|| 0`,
 * so an unseeded year produced a contribution of ZERO with the right
 * `days_worked` — a payslip that is credible and false. Naming which rate is
 * missing is the difference between a fixable error and a silent one.
 */
export function requiredRates(
  params: Record<string, unknown>,
  block: string,
  keys: readonly string[],
  taxYear: number
): Record<string, number> {
  const raw = params[block];
  if (!raw || typeof raw !== 'object') {
    throw new Error(
      `Falta el bloque de tasas «${block}» de MX para ${taxYear}: sin él la cuota saldría en cero ` +
      'con los días cotizados correctos, que es un recibo creíble y falso.'
    );
  }
  const source = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  const missing: string[] = [];
  for (const k of keys) {
    const v = source[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
    if (!Number.isFinite(n)) missing.push(k);
    else out[k] = n;
  }
  if (missing.length > 0) {
    throw new Error(
      `Faltan tasas en «${block}» de MX para ${taxYear}: ${missing.join(', ')}. ` +
      'Una tasa ausente no es una tasa de cero.'
    );
  }
  return out;
}

/**
 * Apply a progressive tax bracket table.
 * Returns tax owed on the given taxable wages.
 */
export function applyBrackets(brackets: TaxBracket[], taxableWages: number): { tax: number; rate: number } {
  if (taxableWages <= 0) return { tax: 0, rate: 0 };

  for (const b of brackets) {
    const upper = b.bracket_high ?? Infinity;
    if (taxableWages >= b.bracket_low && taxableWages <= upper) {
      const taxOverLow = (taxableWages - b.bracket_low) * b.rate;
      return { tax: b.base_tax + taxOverLow, rate: b.rate };
    }
  }
  // Fallback to top bracket
  const top = brackets[brackets.length - 1];
  if (!top) return { tax: 0, rate: 0 };
  const taxOverLow = (taxableWages - top.bracket_low) * top.rate;
  return { tax: top.base_tax + taxOverLow, rate: top.rate };
}

/**
 * Periods per year for annualization.
 */
export function periodsPerYear(freq: PayFrequency): number {
  switch (freq) {
    case 'weekly': return 52;
    case 'biweekly': return 26;
    case 'semimonthly': return 24;
    case 'monthly': return 12;
    case 'quincenal': return 24;
    case 'annual': return 1;
  }
}
