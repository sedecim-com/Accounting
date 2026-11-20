import { describe, expect, it } from 'vitest';
import {
  separationExemption,
  separationRoute,
  separationYearsOfService,
  withholdingAtUsmoRate,
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

// MNE-001-579 · #194, part B: LISR art. 96, the paragraph on the payments of
// art. 95 (third from the end): «efectuarán la retención aplicando al ingreso
// total por este concepto, una tasa que se calculará dividiendo el impuesto
// correspondiente al último sueldo mensual ordinario, entre dicho sueldo [...].
// Cuando los pagos por estos conceptos sean inferiores al último sueldo
// mensual ordinario, la retención se calculará aplicándoles la tarifa
// establecida en este artículo.»

describe('separationRoute — the tariff below the USMO, the USMO rate otherwise', () => {
  const USMO = '9000.0000';

  it('nothing taxed is the exempt route, whatever the comparison', () => {
    for (const comparison of ['total_payments', 'taxable_payments'] as const) {
      expect(separationRoute({ payments: '113414.4000', taxable: '0.0000', usmo: USMO, comparison })).toBe('exempt');
    }
  });

  it('a large taxable part goes at the rate under both readings', () => {
    for (const comparison of ['total_payments', 'taxable_payments'] as const) {
      expect(separationRoute({ payments: '358368.5000', taxable: '200000.0000', usmo: USMO, comparison }))
        .toBe('effective_rate');
    }
  });

  it('taxable 5 000 of a total 163 368.50: the total is not below the USMO, the taxable part is', () => {
    const args = { payments: '163368.5000', taxable: '5000.0000', usmo: USMO };
    expect(separationRoute({ ...args, comparison: 'total_payments' })).toBe('effective_rate');
    expect(separationRoute({ ...args, comparison: 'taxable_payments' })).toBe('tariff');
  });

  it('a total of 8 000 below a USMO of 9 000 goes by the tariff under both readings', () => {
    for (const comparison of ['total_payments', 'taxable_payments'] as const) {
      expect(separationRoute({ payments: '8000.0000', taxable: '8000.0000', usmo: USMO, comparison })).toBe('tariff');
    }
  });

  it('«inferiores» is strict: payments equal to the USMO go at the rate', () => {
    expect(separationRoute({ payments: USMO, taxable: USMO, usmo: USMO, comparison: 'taxable_payments' }))
      .toBe('effective_rate');
  });

  it('a USMO of zero has no rate to divide by, and is said so', () => {
    expect(separationRoute({ payments: '100.0000', taxable: '100.0000', usmo: '0.0000', comparison: 'total_payments' }))
      .toBe('no_usmo');
  });
});

describe('withholdingAtUsmoRate — taxable × ISR(USMO) / USMO, the rate never rounded', () => {
  it('USMO 9 000, gross of the tariff: ISR 620.22, rate 6.8913 %, 13 782.67 on 200 000', () => {
    // 420.95 + (9 000 − 7 168.52) × 0.1088 = 620.215024 → 620.22
    // 200 000 × 620.22 / 9 000 = 13 782.666… → 13 782.67
    expect(withholdingAtUsmoRate({ taxable: '200000.0000', usmo: '9000.0000', isrOfUsmo: '620.22', subsidyOfUsmo: null }))
      .toEqual({ ratePercent: '6.8913', withholding: '13782.6700' });
  });

  it('net of the subsidy 535.65: 84.57, rate 0.9397 %, 1 879.33 on 200 000', () => {
    // 200 000 × 84.57 / 9 000 = 1 879.333… → 1 879.33
    expect(withholdingAtUsmoRate({ taxable: '200000.0000', usmo: '9000.0000', isrOfUsmo: '620.22', subsidyOfUsmo: '535.65' }))
      .toEqual({ ratePercent: '0.9397', withholding: '1879.3300' });
  });

  it('the rate is applied unrounded: rounding it to 6.8913 % first would give 13 782.60', () => {
    expect(withholdingAtUsmoRate({ taxable: '200000.0000', usmo: '9000.0000', isrOfUsmo: '620.22', subsidyOfUsmo: null })
      .withholding).not.toBe('13782.6000');
  });

  it('a subsidy larger than the ISR floors the rate at zero, never a negative withholding', () => {
    expect(withholdingAtUsmoRate({ taxable: '5000.0000', usmo: '5000.0000', isrOfUsmo: '300.00', subsidyOfUsmo: '535.65' }))
      .toEqual({ ratePercent: '0.0000', withholding: '0.0000' });
  });

  it('taxable 5 000 at the rate of a 9 000 USMO is 344.57', () => {
    // 5 000 × 620.22 / 9 000 = 344.566… → 344.57
    expect(withholdingAtUsmoRate({ taxable: '5000.0000', usmo: '9000.0000', isrOfUsmo: '620.22', subsidyOfUsmo: null })
      .withholding).toBe('344.5700');
  });

  it('northern border, 15 years, daily wage 1 000: 344.70 taxable at the rate of a 30 000 USMO is 51.93', () => {
    // premium 180 × 2 × 440.87 = 158 713.20; − 158 368.50 = 344.70
    // ISR(30 000) = 1 856.84 + (30 000 − 17 533.65) × 0.2136 = 4 519.6524 → 4 519.65
    // 344.70 × 4 519.65 / 30 000 = 51.93 (51.9307…)
    expect(separationExemption({ payments: '158713.2000', years: 15, umaDaily: '117.31', capUmaPerYear: '90' }).taxable)
      .toBe('344.7000');
    expect(withholdingAtUsmoRate({ taxable: '344.7000', usmo: '30000.0000', isrOfUsmo: '4519.65', subsidyOfUsmo: null }))
      .toEqual({ ratePercent: '15.0655', withholding: '51.9300' });
  });
});
