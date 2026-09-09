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
 * Tax parameters for a jurisdiction, optionally AS OF A DATE.
 *
 * THE READER THE VALIDITY COLUMNS DID NOT HAVE (J0.2, #123). Migration 080 added
 * `effective_from`/`effective_to` and backfilled them, but nothing read them: a
 * column with no reader is a schema promise no code path keeps, and the issue
 * asks for a "column WITH a reader".
 *
 * Without `asOf` it answers as before — by tax year — which is what today's
 * eight callers do. With `asOf`, the row answers only if that date falls INSIDE
 * its validity window; outside it, there are no parameters.
 *
 * `ORDER BY effective_from DESC LIMIT 1` even though `UNIQUE(jurisdiction,
 * tax_year)` guarantees a single row today: once J0.4 retires that constraint
 * and two windows fit in one year, this query already returns the LATEST one in
 * force rather than an arbitrary one.
 *
 * STILL J0.4's: making a missing row FAIL instead of returning `{}`. That open
 * failure — the one that leaves IMSS rates at zero — is closed by J0.4 with
 * `PARAMETRO_LEGAL_SIN_VIGENCIA`; changing it here would redden callers this
 * tramo does not touch.
 */
export async function getTaxParameters(
  jurisdiction: string,
  taxYear: number,
  asOf?: Date
): Promise<Record<string, unknown>> {
  // The date goes into the cache key: without it, the first lookup for a year
  // would answer every later date too, validity window included.
  const day = asOf === undefined ? undefined : asOf.toISOString().slice(0, 10);
  const key = `${jurisdiction}|${taxYear}|${day ?? '*'}`;
  const cached = paramCache.get(key);
  if (cached) return cached;

  const result = await query<{ params: Record<string, unknown> }>(
    `SELECT params FROM tax_parameters
      WHERE jurisdiction = $1 AND tax_year = $2
        AND ($3::date IS NULL
             OR (effective_from <= $3::date
                 AND (effective_to IS NULL OR $3::date <= effective_to)))
      ORDER BY effective_from DESC
      LIMIT 1`,
    [jurisdiction, taxYear, day ?? null]
  );

  const params = result.rows[0]?.params || {};
  paramCache.set(key, params);
  return params;
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
