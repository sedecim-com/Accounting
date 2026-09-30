import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(),
}));

import { query } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';
import { MexicoSubsidioEmpleoCalculator } from '../../../src/services/payroll/mx/isr-calculator.js';
import {
  EMPLOYMENT_SUBSIDY_ROUNDING_POLICY,
  EMPLOYMENT_SUBSIDY_SEPARATE_RUN_POLICY,
  employmentSubsidyForPeriod,
  readEmploymentSubsidyRounding,
  readEmploymentSubsidySeparateRun,
  subsidyOfLaterPaycheck,
  subsidyOfOtherRunsInPeriod,
  subsidyDaysInPeriod,
  type EmploymentSubsidyRounding,
} from '../../../src/services/payroll/mx/employment-subsidy.js';
import { POLICY_CATALOG } from '../../../src/services/policy/pending-catalog.js';
import type { PayFrequency, TaxInput } from '../../../src/services/payroll/tax-engine/tax-engine.interface.js';

/**
 * THE 2026 EMPLOYMENT SUBSIDY (#298, MNE-001-064).
 *
 * Since the decree of 1 May 2024 the subsidy is a share of the MONTHLY UMA,
 * not the bracket table migration 009 seeded. For 2026 (DOF 31-12-2025) it is
 * 15.59 % of the 2025 UMA in January and 15.02 % of the 2026 UMA from
 * February; a period shorter than a month gets the monthly amount / 30.4 ×
 * its days. The decree does not say how to round, so that is a policy
 * (`subsidio_al_empleo_redondeo`), and the figures below are the ones the
 * owner fixed when deciding it (MNE-001-004).
 */

const mockQuery = query as unknown as Mock;
const mockGetPolicy = getPolicy as unknown as Mock;

/** The rows migration 095 loads, as `legal_parameters` returns them. */
const LAW: Array<{ key: string; from: string; value: string }> = [
  { key: 'uma.monthly', from: '2025-02-01', value: '3439.4600' },
  { key: 'uma.monthly', from: '2026-02-01', value: '3566.2200' },
  { key: 'employment_subsidy.uma_monthly_rate', from: '2026-01-01', value: '0.1559' },
  { key: 'employment_subsidy.uma_monthly_rate', from: '2026-02-01', value: '0.1502' },
  { key: 'employment_subsidy.monthly_income_cap', from: '2026-01-01', value: '11492.6600' },
];

beforeEach(() => {
  mockQuery.mockReset();
  mockGetPolicy.mockReset();
  mockQuery.mockImplementation(async (sql: string, args: unknown[]) => {
    // Restoring the migration 009 bracket table is the defect this slice
    // closes: any read of it fails the test outright.
    if (sql.includes('tax_tables')) throw new Error('the subsidy read the repealed 009 table');
    if (sql.includes('FROM legal_parameters')) {
      const [, key, onDate] = args as [string, string, string | undefined];
      const rows = LAW.filter((r) => r.key === key).sort((a, b) => (a.from < b.from ? 1 : -1));
      // The second read `legalParameterAt` makes only after a miss: the
      // earliest entry into force of the key, to word the error.
      if (onDate === undefined) return { rows: [{ effectiveFrom: rows.at(-1)?.from ?? null }] };
      const row = rows.find((r) => r.from <= onDate);
      return {
        rows: row
          ? [{
              jurisdiction: 'MX', key, value: row.value, unit: 'rate', effectiveFrom: row.from,
              sourceUrl: 'https://dof.gob.mx/', sourceNote: null,
            }]
          : [],
      };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  });
});

function input(
  wages: number,
  freq: PayFrequency,
  payDate: string,
  rounding: EmploymentSubsidyRounding = 'producto_al_centavo'
): TaxInput {
  return {
    taxable_wages: wages,
    pay_frequency: freq,
    tax_year: 2026,
    pay_date: payDate,
    employment_subsidy_rounding: rounding,
  };
}

const calc = new MexicoSubsidioEmpleoCalculator();

describe('the arithmetic of the two rounding modes', () => {
  const FEB = { umaMonthly: '3566.22', rate: '0.1502' };
  const JAN = { umaMonthly: '3439.46', rate: '0.1559' };

  const cases: Array<[string, typeof FEB, EmploymentSubsidyRounding, number | null, string]> = [
    ['producto, February to December, month', FEB, 'producto_al_centavo', null, '535.65'],
    ['producto, February to December, quincena', FEB, 'producto_al_centavo', 15, '264.30'],
    ['producto, February to December, week', FEB, 'producto_al_centavo', 7, '123.34'],
    ['producto, January, month', JAN, 'producto_al_centavo', null, '536.21'],
    ['producto, January, quincena', JAN, 'producto_al_centavo', 15, '264.58'],
    ['producto, January, week', JAN, 'producto_al_centavo', 7, '123.47'],
    ['diario, January, quincena', JAN, 'diario_al_centavo', 15, '264.60'],
    ['diario, February to December, quincena', FEB, 'diario_al_centavo', 15, '264.30'],
  ];
  for (const [name, law, rounding, days, expected] of cases) {
    it(`${name}: ${expected}`, () => {
      const r = employmentSubsidyForPeriod({ ...law, days, rounding });
      expect(r.period.toFixed(2)).toBe(expected);
    });
  }

  it('536.22 comes out of no mode: it is a rejected option, not a rounding', () => {
    for (const rounding of ['producto_al_centavo', 'diario_al_centavo'] as const) {
      expect(employmentSubsidyForPeriod({ ...JAN, days: null, rounding }).monthly.toFixed(2)).toBe('536.21');
      expect(employmentSubsidyForPeriod({ ...FEB, days: null, rounding }).monthly.toFixed(2)).toBe('535.65');
    }
  });

  it('the period derives from the ALREADY-ROUNDED monthly amount', () => {
    // A monthly figure on the half cent: 1000 × 0.100045 = 100.045, which
    // rounds half up to 100.05. Prorated from the unrounded 100.045 the
    // quincena would be 49.36; from the rounded 100.05 it is 49.37.
    const r = employmentSubsidyForPeriod({ umaMonthly: '1000', rate: '0.100045', days: 15, rounding: 'producto_al_centavo' });
    expect(r.monthly.toFixed(4)).toBe('100.0500');
    expect(r.period.toFixed(2)).toBe('49.37');
  });

  it('a monthly period is the monthly amount in both modes', () => {
    const d = employmentSubsidyForPeriod({ ...JAN, days: null, rounding: 'diario_al_centavo' });
    expect(d.period.toFixed(2)).toBe('536.21');
  });
});

describe('the days of each pay period', () => {
  it('seven for a week, fifteen for a quincena, none for a month', () => {
    expect(subsidyDaysInPeriod('weekly')).toBe(7);
    expect(subsidyDaysInPeriod('quincenal')).toBe(15);
    expect(subsidyDaysInPeriod('monthly')).toBeNull();
  });

  it('a period with no ISR tariff has no subsidy either: it is refused, not guessed', () => {
    for (const f of ['biweekly', 'semimonthly', 'annual'] as const) {
      expect(() => subsidyDaysInPeriod(f)).toThrow(/subsidio al empleo/i);
    }
  });
});

describe('the calculator reads the law of the payment date, not the 009 table', () => {
  it('a wage under the cap paid in MARCH 2026 uses the UMA in force since February 1st', async () => {
    const q = await calc.calculate(input(3000, 'quincenal', '2026-03-13'));
    expect(q.tax_amount).toBe(264.3);
    expect(q.is_credit).toBe(true);
    expect((await calc.calculate(input(1500, 'weekly', '2026-03-13'))).tax_amount).toBe(123.34);
    expect((await calc.calculate(input(6000, 'monthly', '2026-03-31'))).tax_amount).toBe(535.65);
  });

  it('the same wage paid in JANUARY 2026 uses the 2025 UMA and the January rate', async () => {
    expect((await calc.calculate(input(3000, 'quincenal', '2026-01-15'))).tax_amount).toBe(264.58);
    expect((await calc.calculate(input(1500, 'weekly', '2026-01-16'))).tax_amount).toBe(123.47);
    expect((await calc.calculate(input(6000, 'monthly', '2026-01-31'))).tax_amount).toBe(536.21);
  });

  it('diario_al_centavo gives 264.60 for the January quincena', async () => {
    const q = await calc.calculate(input(3000, 'quincenal', '2026-01-15', 'diario_al_centavo'));
    expect(q.tax_amount).toBe(264.6);
  });

  it('the note says which law and which rounding produced the figure', async () => {
    const q = await calc.calculate(input(3000, 'quincenal', '2026-01-15'));
    expect(q.notes).toMatch(/0\.1559/);
    expect(q.notes).toMatch(/3439\.46/);
    expect(q.notes).toMatch(/producto_al_centavo/);
  });

  it('above the monthly income cap there is no subsidy', async () => {
    // 5 800 a quincena is 11 600 a month, over 11 492.66.
    expect((await calc.calculate(input(5800, 'quincenal', '2026-03-13'))).tax_amount).toBe(0);
    // And exactly on the cap still receives it: the decree says «no exceda».
    expect((await calc.calculate(input(11492.66, 'monthly', '2026-03-31'))).tax_amount).toBe(535.65);
  });

  it('without a payment date or a rounding it refuses instead of assuming one', async () => {
    await expect(calc.calculate({ taxable_wages: 3000, pay_frequency: 'quincenal', tax_year: 2026,
      employment_subsidy_rounding: 'producto_al_centavo' })).rejects.toThrow(/fecha de pago/);
    await expect(calc.calculate({ taxable_wages: 3000, pay_frequency: 'quincenal', tax_year: 2026,
      pay_date: '2026-03-13' })).rejects.toThrow(/subsidio_al_empleo_redondeo/);
  });

  it('a payment date before the 2026 law was loaded fails closed', async () => {
    await expect(calc.calculate(input(3000, 'quincenal', '2025-12-15'))).rejects.toThrow(/no regía/);
  });
});

describe('the policy and its reader', () => {
  it('the catalog declares the key with its two values and producto_al_centavo as default', () => {
    const spec = POLICY_CATALOG.find((p) => p.key === EMPLOYMENT_SUBSIDY_ROUNDING_POLICY);
    expect(spec?.options.map((o) => o.value)).toEqual(['producto_al_centavo', 'diario_al_centavo']);
    expect(spec?.defaultValue).toBe('producto_al_centavo');
  });

  it('reads the value of the entity', async () => {
    mockGetPolicy.mockResolvedValue({ key: EMPLOYMENT_SUBSIDY_ROUNDING_POLICY, value: 'diario_al_centavo', defined: true });
    await expect(readEmploymentSubsidyRounding({ tenantId: 't', entityId: 'e' })).resolves.toBe('diario_al_centavo');
    expect(mockGetPolicy).toHaveBeenCalledWith({ tenantId: 't', entityId: 'e' }, EMPLOYMENT_SUBSIDY_ROUNDING_POLICY, undefined);
  });

  it('an unknown value is named, not replaced by the first option', async () => {
    mockGetPolicy.mockResolvedValue({ key: EMPLOYMENT_SUBSIDY_ROUNDING_POLICY, value: 'truncar', defined: true });
    await expect(readEmploymentSubsidyRounding({ tenantId: 't' })).rejects.toThrow(/truncar/);
  });
});

// #430 · MNE-001-398: one subsidy per pay period, whatever the number of runs.
describe('the subsidy of a later paycheck of the same period', () => {
  it('the catalog declares the key with its two values and the recomputation as default', () => {
    const spec = POLICY_CATALOG.find((p) => p.key === EMPLOYMENT_SUBSIDY_SEPARATE_RUN_POLICY);
    expect(spec?.options.map((o) => o.value)).toEqual(['recompute_on_combined_income', 'none_on_separate_paycheck']);
    expect(spec?.defaultValue).toBe('recompute_on_combined_income');
  });

  it('reads the value of the entity, and names a value it does not know', async () => {
    mockGetPolicy.mockResolvedValue({ key: EMPLOYMENT_SUBSIDY_SEPARATE_RUN_POLICY, value: 'none_on_separate_paycheck' });
    await expect(readEmploymentSubsidySeparateRun({ tenantId: 't', entityId: 'e' })).resolves.toBe('none_on_separate_paycheck');
    expect(mockGetPolicy).toHaveBeenCalledWith({ tenantId: 't', entityId: 'e' }, EMPLOYMENT_SUBSIDY_SEPARATE_RUN_POLICY, undefined);
    mockGetPolicy.mockResolvedValue({ key: EMPLOYMENT_SUBSIDY_SEPARATE_RUN_POLICY, value: 'twice' });
    await expect(readEmploymentSubsidySeparateRun({ tenantId: 't' })).rejects.toThrow(/twice/);
  });

  it('recomputing credits only the difference, never a second subsidy and never below zero', () => {
    const later = (onCombinedIncome: string, alreadyCaused: string): string =>
      subsidyOfLaterPaycheck({ treatment: 'recompute_on_combined_income', onCombinedIncome, alreadyCaused }).toFixed(2);
    expect(later('264.30', '264.30')).toBe('0.00');
    expect(later('264.30', '0')).toBe('264.30');
    expect(later('0', '264.30')).toBe('0.00');
  });

  it('"none_on_separate_paycheck" credits nothing whatever the combined income gives', () => {
    const r = subsidyOfLaterPaycheck({ treatment: 'none_on_separate_paycheck', onCombinedIncome: '264.30', alreadyCaused: '0' });
    expect(r.toFixed(2)).toBe('0.00');
  });

  it('reads the other runs of the period inside the tenant, leaving out the run being calculated', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ paychecks: 1, taxable: '1500.00', subsidy: '264.30' }] });
    const r = await subsidyOfOtherRunsInPeriod({ tenantId: 't', employeeId: 'emp', payRunId: 'run', payPeriodId: 'per' });
    expect([r.paychecks, r.taxableIsr.toFixed(2), r.subsidy.toFixed(2)]).toEqual([1, '1500.00', '264.30']);
    const [sql, args] = mockQuery.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toMatch(/p\.tenant_id = \$1/);
    expect(sql).toMatch(/pr\.id <> \$4/);
    expect(sql).toMatch(/pr\.status IN \('calculated', 'approved', 'paid'\)/);
    expect(args).toEqual(['t', 'emp', 'per', 'run']);
  });
});
