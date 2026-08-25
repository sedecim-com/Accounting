import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/payroll/tax-engine/tax-tables.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/payroll/tax-engine/tax-tables.js')>(
    '../../../src/services/payroll/tax-engine/tax-tables.js'
  );
  return {
    ...actual,
    getTaxParameters: vi.fn(async () => ({
      ss_wage_base: 168600,
      ss_rate_employee: 0.062,
      ss_rate_employer: 0.062,
      medicare_rate_employee: 0.0145,
      medicare_rate_employer: 0.0145,
      additional_medicare_rate: 0.009,
      additional_medicare_threshold_single: 200000,
    })),
  };
});

import {
  UsFicaSocialSecurityCalculator,
  UsFicaMedicareCalculator,
  UsAdditionalMedicareCalculator,
  UsFicaSocialSecurityEmployerCalculator,
} from '../../../src/services/payroll/usa/federal/fica-calculator.js';

const baseInput = {
  pay_frequency: 'biweekly' as const,
  tax_year: 2026,
};

describe('FICA Social Security (employee)', () => {
  const calc = new UsFicaSocialSecurityCalculator();

  it('charges 6.2% under cap', async () => {
    const r = await calc.calculate({ ...baseInput, taxable_wages: 5000, ytd_wages: 0 });
    expect(r.tax_amount).toBeCloseTo(310, 2);
  });

  it('caps at SS wage base', async () => {
    // YTD 165000, new 5000, cap 168600 → only 3600 taxable → 3600 × 6.2% = 223.20
    const r = await calc.calculate({ ...baseInput, taxable_wages: 5000, ytd_wages: 165000 });
    expect(r.tax_amount).toBeCloseTo(223.2, 2);
  });

  it('returns 0 when YTD already at cap', async () => {
    const r = await calc.calculate({ ...baseInput, taxable_wages: 5000, ytd_wages: 168600 });
    expect(r.tax_amount).toBe(0);
  });
});

describe('FICA Medicare (employee, uncapped)', () => {
  const calc = new UsFicaMedicareCalculator();
  it('charges 1.45% on every dollar', async () => {
    const r = await calc.calculate({ ...baseInput, taxable_wages: 10000 });
    expect(r.tax_amount).toBeCloseTo(145, 2);
  });
});

describe('Additional Medicare 0.9% (employer threshold $200k)', () => {
  const calc = new UsAdditionalMedicareCalculator();

  it('returns 0 when YTD + new is under threshold', async () => {
    const r = await calc.calculate({ ...baseInput, taxable_wages: 5000, ytd_wages: 100000 });
    expect(r.tax_amount).toBe(0);
  });

  it('charges 0.9% on portion over threshold (crossing)', async () => {
    // YTD 198000, new 5000 → 3000 over threshold → 0.9% × 3000 = 27
    const r = await calc.calculate({ ...baseInput, taxable_wages: 5000, ytd_wages: 198000 });
    expect(r.tax_amount).toBeCloseTo(27, 2);
  });

  it('charges 0.9% on full new wages once already over threshold', async () => {
    const r = await calc.calculate({ ...baseInput, taxable_wages: 5000, ytd_wages: 250000 });
    expect(r.tax_amount).toBeCloseTo(45, 2);
  });
});

describe('SS Employer mirrors employee rate', () => {
  it('matches employee SS exactly under cap', async () => {
    const ee = await new UsFicaSocialSecurityCalculator().calculate({ ...baseInput, taxable_wages: 5000, ytd_wages: 0 });
    const er = await new UsFicaSocialSecurityEmployerCalculator().calculate({ ...baseInput, taxable_wages: 5000, ytd_wages: 0 });
    expect(er.tax_amount).toBe(ee.tax_amount);
  });
});
