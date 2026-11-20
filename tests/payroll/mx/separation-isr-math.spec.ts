import { describe, expect, it } from 'vitest';
import {
  separationExemption,
  separationYearsOfService,
} from '../../../src/services/payroll/mx/separation-isr-math.js';

// MNE-001-375 · #194: the exemption of LISR art. 93 fr. XIII. Every figure
// below was worked by hand before the module existed (the plan on #194).

describe('separationYearsOfService — completed years, plus one for more than six months', () => {
  it('fifteen years to the day are fifteen', () => {
    expect(separationYearsOfService('2011-06-30', '2026-06-30')).toBe(15);
  });

  it('exactly six months more is not MORE than six months', () => {
    // anniversary 2026-01-02, + 6 months = 2026-07-02: not after it
    expect(separationYearsOfService('2011-01-02', '2026-07-02')).toBe(15);
  });

  it('one day past six months counts the year', () => {
    // anniversary 2026-01-01, + 6 months = 2026-07-01: 2026-07-02 is after it
    expect(separationYearsOfService('2011-01-01', '2026-07-02')).toBe(16);
  });

  it('under six months of service is zero years, and over six is one', () => {
    expect(separationYearsOfService('2026-01-10', '2026-06-30')).toBe(0);
    expect(separationYearsOfService('2025-12-01', '2026-06-30')).toBe(1);
  });

  it('six months from the 31st of August ends on the last day of February', () => {
    expect(separationYearsOfService('2025-08-31', '2026-02-28')).toBe(0);
    expect(separationYearsOfService('2025-08-31', '2026-03-01')).toBe(1);
  });

  it('the six months run from the hire date, not from a clamped anniversary', () => {
    // hired 2024-02-29, one completed year: 2024-02-29 + 18 months = 2025-08-29
    expect(separationYearsOfService('2024-02-29', '2025-08-29')).toBe(1);
    expect(separationYearsOfService('2024-02-29', '2025-08-30')).toBe(2);
  });

  it('a termination before the hire date is zero, never negative', () => {
    expect(separationYearsOfService('2026-06-30', '2026-01-01')).toBe(0);
  });

  it('accepts the Date the database driver returns', () => {
    expect(separationYearsOfService(new Date(2011, 5, 30), '2026-06-30')).toBe(15);
  });
});

describe('separationExemption — 90 UMA per year of service, the rest taxed', () => {
  const LAW = { umaDaily: '117.31', capUmaPerYear: '90.0000' };

  it('fifteen years, daily wage 1 000: the premium of 113 414.40 is exempt in full', () => {
    // 90 × 117.31 = 10 557.90 a year; × 15 = 158 368.50
    const x = separationExemption({ ...LAW, payments: '113414.4000', years: 15 });
    expect(x).toEqual({ cap: '158368.5000', exempt: '113414.4000', taxable: '0.0000' });
  });

  it('what is over the cap is taxed: 358 368.50 leaves 200 000.00', () => {
    const x = separationExemption({ ...LAW, payments: '358368.5000', years: 15 });
    expect(x).toEqual({ cap: '158368.5000', exempt: '158368.5000', taxable: '200000.0000' });
  });

  it('the cap counts the rounded-up year: sixteen years exempt 168 926.40, not 158 368.50', () => {
    const x = separationExemption({ ...LAW, payments: '358368.5000', years: 16 });
    expect(x.cap).toBe('168926.4000');
    expect(x.taxable).toBe('189442.1000');
  });

  it('the cap is rounded to the cent, as the payslip caps are', () => {
    // 90 × 113.14 × 15 = 152 739.00; 90 × 117.3149 × 1 = 10 558.341 → 10 558.34
    expect(separationExemption({ payments: '0', years: 15, umaDaily: '113.14', capUmaPerYear: '90' }).cap)
      .toBe('152739.0000');
    expect(separationExemption({ payments: '0', years: 1, umaDaily: '117.3149', capUmaPerYear: '90' }).cap)
      .toBe('10558.3400');
  });

  it('nothing paid is nothing exempt and nothing taxed', () => {
    expect(separationExemption({ ...LAW, payments: '0.0000', years: 15 })).toEqual({
      cap: '158368.5000', exempt: '0.0000', taxable: '0.0000',
    });
  });

  it('zero years exempt nothing', () => {
    expect(separationExemption({ ...LAW, payments: '8000.0000', years: 0 })).toEqual({
      cap: '0.0000', exempt: '0.0000', taxable: '8000.0000',
    });
  });
});
