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

export async function getTaxParameters(
  jurisdiction: string,
  taxYear: number
): Promise<Record<string, unknown>> {
  const key = `${jurisdiction}|${taxYear}`;
  const cached = paramCache.get(key);
  if (cached) return cached;

  const result = await query<{ params: Record<string, unknown> }>(
    `SELECT params FROM tax_parameters WHERE jurisdiction = $1 AND tax_year = $2`,
    [jurisdiction, taxYear]
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
