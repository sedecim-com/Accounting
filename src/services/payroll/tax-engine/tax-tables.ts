import { query } from '../../../database/connection.js';
import type { PayFrequency, FilingStatus } from './tax-engine.interface.js';

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
 * `effectiveDate` is the date OF THE ACT — the day of the payslip — not today:
 * a January 15th payslip recomputed in March must still use January. It
 * defaults to today because the engines that do not yet receive it compute the
 * current period; threading it down to each one is T4b's work, and until then
 * the omission is explicit rather than tacit.
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
  const today = new Date().toISOString().slice(0, 10);
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

export function clearCache(): void {
  bracketCache.clear();
  paramCache.clear();
}
