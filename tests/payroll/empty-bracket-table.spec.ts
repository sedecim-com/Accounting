import { describe, it, expect, vi, beforeEach } from 'vitest';

// Only the database is replaced; tax-tables, the FIT and SIT engines are real.
const db = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock('../../src/database/connection.js', () => ({
  // Parameters (no flat_rate => progressive) vs bracket rows, told apart by SQL.
  query: vi.fn(async (sql: string) => ({
    rows: /FROM tax_parameters/.test(sql) ? [{ params: {} }] : db.rows,
  })),
}));
vi.mock('../../src/services/policy/today.js', () => ({ todayFor: vi.fn(async () => '2026-06-01') }));

import { UsFederalFitCalculator } from '../../src/services/payroll/usa/federal/fit-calculator.js';
import { UsStateSitCalculator } from '../../src/services/payroll/usa/state/state-tax-calculator.js';
import { requireBrackets } from '../../src/services/payroll/tax-engine/tax-tables.js';

/**
 * MNE-001-353 (#127): a missing bracket table is an error, not a 0.00
 * withholding. The bracket cache is keyed by year, so each case uses its own.
 */
const input = (tax_year: number, filing_status: 'single' | 'married_separately') => ({
  taxable_wages: 3000, pay_frequency: 'monthly' as const, tax_year, filing_status,
});

beforeEach(() => { db.rows = []; });

describe('requireBrackets', () => {
  it('throws naming the jurisdiction, year and status when the table is empty', () => {
    expect(() => requireBrackets([], 'US-FEDERAL', 'fit', 2031, 'married_separately'))
      .toThrow(/fit brackets for US-FEDERAL, 2031, filing_status «married_separately»/);
  });
  it('returns a non-empty table untouched', () => {
    const t = [{ bracket_order: 1, bracket_low: 0, bracket_high: null, rate: 0.1, base_tax: 0, data: {} }];
    expect(requireBrackets(t, 'US-FEDERAL', 'fit', 2031, 'single')).toBe(t);
  });
});

describe('FIT with no table for the filing_status', () => {
  it('married_separately without rows throws instead of withholding 0.00', async () => {
    await expect(new UsFederalFitCalculator().calculate(input(2032, 'married_separately')))
      .rejects.toThrow(/No fit brackets.*married_separately/s);
  });
  it('a seeded table still computes tax', async () => {
    db.rows = [{ bracket_order: 1, bracket_low: '0', bracket_high: null, rate: '0.10', base_tax: '0', data: {} }];
    const out = await new UsFederalFitCalculator().calculate(input(2033, 'single'));
    expect(out.tax_amount).toBeGreaterThan(0);
  });
});

describe('SIT with no table for the filing_status', () => {
  const calc = () => new UsStateSitCalculator('CA');
  it('throws instead of withholding 0.00 when the progressive table is empty', async () => {
    db.rows = [];
    await expect(calc().calculate(input(2034, 'married_separately')))
      .rejects.toThrow(/No sit brackets for US-CA.*married_separately/s);
  });
  it('an unknown declared status throws instead of falling back to single', async () => {
    await expect(calc().calculate({ ...input(2035, 'single'), filing_status: 'mfs' as never }))
      .rejects.toThrow(/Unknown filing_status/);
  });
});
