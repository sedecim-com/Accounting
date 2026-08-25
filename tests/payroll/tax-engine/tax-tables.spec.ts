import { describe, it, expect } from 'vitest';
import { applyBrackets, periodsPerYear } from '../../../src/services/payroll/tax-engine/tax-tables.js';
import { cappedTaxableWages } from '../../../src/services/payroll/tax-engine/ytd-service.js';

describe('applyBrackets — progressive tax math', () => {
  // Sample 2026 IRS Pub 15-T single brackets (annual, simplified)
  const brackets = [
    { bracket_low: 0,        bracket_high: 11600,  rate: 0.10, base_tax: 0 },
    { bracket_low: 11600,    bracket_high: 47150,  rate: 0.12, base_tax: 1160 },
    { bracket_low: 47150,    bracket_high: 100525, rate: 0.22, base_tax: 5426 },
    { bracket_low: 100525,   bracket_high: 191950, rate: 0.24, base_tax: 17168.50 },
    { bracket_low: 191950,   bracket_high: null,   rate: 0.32, base_tax: 39110.50 },
  ];

  it('returns 0 for non-positive wages', () => {
    expect(applyBrackets(brackets, 0).tax).toBe(0);
    expect(applyBrackets(brackets, -100).tax).toBe(0);
  });

  it('taxes within first bracket', () => {
    // $5000 → 10% × 5000 = 500
    expect(applyBrackets(brackets, 5000).tax).toBeCloseTo(500, 2);
    expect(applyBrackets(brackets, 5000).rate).toBe(0.10);
  });

  it('taxes mid-bracket (12% bracket)', () => {
    // $30000 → 1160 + (30000 − 11600) × 0.12 = 1160 + 2208 = 3368
    expect(applyBrackets(brackets, 30000).tax).toBeCloseTo(3368, 2);
    expect(applyBrackets(brackets, 30000).rate).toBe(0.12);
  });

  it('taxes top open bracket (32%)', () => {
    // $250000 → 39110.50 + (250000 − 191950) × 0.32 = 39110.50 + 18576 = 57686.50
    expect(applyBrackets(brackets, 250000).tax).toBeCloseTo(57686.5, 2);
    expect(applyBrackets(brackets, 250000).rate).toBe(0.32);
  });

  it('handles empty bracket table', () => {
    expect(applyBrackets([], 50000)).toEqual({ tax: 0, rate: 0 });
  });
});

describe('periodsPerYear', () => {
  it('returns the correct annualization factor', () => {
    expect(periodsPerYear('weekly')).toBe(52);
    expect(periodsPerYear('biweekly')).toBe(26);
    expect(periodsPerYear('semimonthly')).toBe(24);
    expect(periodsPerYear('monthly')).toBe(12);
    expect(periodsPerYear('quincenal')).toBe(24);
    expect(periodsPerYear('annual')).toBe(1);
  });
});

describe('cappedTaxableWages — Social Security cap pattern', () => {
  it('full wages are taxable when YTD is under cap', () => {
    expect(cappedTaxableWages(0, 5000, 168600)).toBe(5000);
    expect(cappedTaxableWages(100000, 5000, 168600)).toBe(5000);
  });

  it('clips to remaining room when YTD + new exceeds cap', () => {
    // YTD 165000, new 5000, cap 168600 → only 3600 taxable
    expect(cappedTaxableWages(165000, 5000, 168600)).toBe(3600);
  });

  it('returns 0 when YTD already at or above cap', () => {
    expect(cappedTaxableWages(168600, 5000, 168600)).toBe(0);
    expect(cappedTaxableWages(200000, 5000, 168600)).toBe(0);
  });

  it('handles FUTA $7000 cap', () => {
    expect(cappedTaxableWages(0, 3000, 7000)).toBe(3000);
    expect(cappedTaxableWages(5000, 3000, 7000)).toBe(2000);
    expect(cappedTaxableWages(7000, 3000, 7000)).toBe(0);
  });
});
