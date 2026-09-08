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
 */
export async function getTaxParameters(
  jurisdiction: string,
  taxYear: number,
  effectiveDate?: string
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
  const today = new Date().toISOString().slice(0, 10);
  const day = effectiveDate ?? (today.startsWith(`${taxYear}-`) ? today : `${taxYear}-12-31`);
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
