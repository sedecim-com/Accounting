import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { splitByContributionMonth } from '../../../src/services/payroll/tax-engine/tax-tables.js';

/**
 * A PERIOD THAT STRADDLES TWO MONTHS IS SPLIT BY CONTRIBUTION DAYS (#231,
 * MNE-001-071, owner decision MNE-001-131). The SUA file and the employer
 * liability both attribute through this one function, so what it returns is
 * what both of them declare.
 */
function plain(periodStart: string, periodEnd: string, amount: string) {
  return splitByContributionMonth(periodStart, periodEnd, amount).map((s) => ({
    start: s.start,
    end: s.end,
    days: s.days,
    amount: s.amount.toFixed(2),
  }));
}

describe('splitByContributionMonth', () => {
  it('splits the week of February 25th to March 3rd four days to three', () => {
    expect(plain('2026-02-25', '2026-03-03', '500.00')).toEqual([
      { start: '2026-02-25', end: '2026-02-28', days: 4, amount: '285.71' },
      { start: '2026-03-01', end: '2026-03-03', days: 3, amount: '214.29' },
    ]);
  });

  it('gives the last month the remainder, so the shares add back to the payslip to the cent', () => {
    for (const amount of ['100.00', '0.01', '333.33', '1234.57']) {
      const total = splitByContributionMonth('2026-02-25', '2026-03-03', amount).reduce(
        (sum, s) => sum + Math.round(s.amount.toNumber() * 100),
        0
      );
      expect(total, amount).toBe(Math.round(Number(amount) * 100));
    }
  });

  it('leaves a period inside one month whole', () => {
    expect(plain('2026-03-01', '2026-03-15', '500.00')).toEqual([
      { start: '2026-03-01', end: '2026-03-15', days: 15, amount: '500.00' },
    ]);
  });

  it('prorates the stored total by days, which drifts by cents from per-stretch figures across a UMA change', () => {
    // Pins the CURRENT approximation (open point for the owner, #231). The
    // engine prices each stretch with its own month's UMA (`contributionMonths`,
    // #242) but the payslip stores only the total, so the split can only
    // prorate it. Say a contribution costs 10.00 a day at January's UMA and
    // 10.50 at February's: the exact stretches are 30.00 and 42.00 (72.00),
    // and the split gives 30.86 and 41.14. The total always ties out; the
    // per-month figures are exact only when both months share the UMA.
    expect(plain('2026-01-29', '2026-02-04', '72.00')).toEqual([
      { start: '2026-01-29', end: '2026-01-31', days: 3, amount: '30.86' },
      { start: '2026-02-01', end: '2026-02-04', days: 4, amount: '41.14' },
    ]);
  });

  it('crosses the year and a leap February', () => {
    expect(plain('2027-12-29', '2028-01-11', '140.00')).toEqual([
      { start: '2027-12-29', end: '2027-12-31', days: 3, amount: '30.00' },
      { start: '2028-01-01', end: '2028-01-11', days: 11, amount: '110.00' },
    ]);
    expect(plain('2028-02-26', '2028-03-03', '70.00')).toEqual([
      { start: '2028-02-26', end: '2028-02-29', days: 4, amount: '40.00' },
      { start: '2028-03-01', end: '2028-03-03', days: 3, amount: '30.00' },
    ]);
  });
});
