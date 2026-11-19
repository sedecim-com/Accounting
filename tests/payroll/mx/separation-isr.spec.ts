import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(),
}));
vi.mock('../../../src/services/jurisdiction/legal-parameters.js', async (original) => {
  const actual = await original<typeof import('../../../src/services/jurisdiction/legal-parameters.js')>();
  return { ...actual, legalParameterAt: vi.fn() };
});
vi.mock('../../../src/services/payroll/tax-engine/tax-tables.js', async (original) => {
  const actual = await original<typeof import('../../../src/services/payroll/tax-engine/tax-tables.js')>();
  return { ...actual, getTaxParameters: vi.fn(), getBrackets: vi.fn() };
});

import {
  calculateSeparationIsr,
  readSeparationIsrUsmoComparison,
  SEPARATION_EXEMPT_CAP_KEY,
  SEPARATION_ISR_USMO_COMPARISON_POLICY,
  type SeparationIsrInput,
} from '../../../src/services/payroll/mx/separation-isr.js';
import {
  legalParameterAt,
  LegalParameterUnavailableError,
} from '../../../src/services/jurisdiction/legal-parameters.js';
import { getBrackets, getTaxParameters, type TaxBracket } from '../../../src/services/payroll/tax-engine/tax-tables.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';

const mockLaw = legalParameterAt as unknown as Mock;
const mockParams = getTaxParameters as unknown as Mock;
const mockBrackets = getBrackets as unknown as Mock;
const mockPolicy = getPolicy as unknown as Mock;

// MNE-001-375 (part A, the exemption) and MNE-001-579 (part B, the
// withholding) · #194. The shell reads the law and the panel; the arithmetic
// is in separation-isr-math.spec.ts and, against the real tables, in
// tests/integration/separation-isr.int.spec.ts.

/** Anexo 8 RMF 2026, monthly tariff (migration 073). */
const MONTHLY_2026: [number, number | null, number, number][] = [
  [0.01, 844.59, 0.0192, 0], [844.6, 7168.51, 0.064, 16.22], [7168.52, 12598.02, 0.1088, 420.95],
  [12598.03, 14644.64, 0.16, 1011.68], [14644.65, 17533.64, 0.1792, 1339.14],
  [17533.65, 35362.83, 0.2136, 1856.84], [35362.84, 55736.68, 0.2352, 5665.16],
  [55736.69, 106410.5, 0.3, 10457.09], [106410.51, 141880.66, 0.32, 25659.23],
  [141880.67, 425641.99, 0.34, 37009.69], [425642.0, null, 0.35, 133488.54],
];
const BRACKETS: TaxBracket[] = MONTHLY_2026.map(([low, high, rate, base], i) => ({
  bracket_order: i + 1, bracket_low: low, bracket_high: high, rate, base_tax: base, data: {},
}));

const LAW: Record<string, { value: string; unit: string }> = {
  [SEPARATION_EXEMPT_CAP_KEY]: { value: '90.0000', unit: 'UMA' },
  'uma.monthly': { value: '3566.2200', unit: 'MXN' },
  'employment_subsidy.uma_monthly_rate': { value: '0.1502', unit: 'rate' },
  'employment_subsidy.monthly_income_cap': { value: '11492.6600', unit: 'MXN' },
};

const PANEL = { tenantId: 't1', entityId: 'e1' };

function inForce(answers: Record<string, string> = {}): void {
  mockLaw.mockImplementation((_j: string, key: string) =>
    Promise.resolve({ ...LAW[key], effectiveFrom: '2016-01-28', key })
  );
  mockParams.mockResolvedValue({ uma_daily: 117.31 });
  // THE MONTHLY TARIFF, AND ONLY IT: a call with the period's tariff (the
  // mutant of #194) finds no table and fails.
  mockBrackets.mockImplementation((_j: string, _t: string, _y: number, _f: unknown, freq: string) =>
    Promise.resolve(freq === 'monthly' ? BRACKETS : [])
  );
  const values: Record<string, string> = {
    separation_isr_usmo_comparison: 'total_payments',
    subsidio_al_empleo_redondeo: 'producto_al_centavo',
    ...answers,
  };
  mockPolicy.mockImplementation((_ctx: unknown, key: string) => Promise.resolve({ key, value: values[key] }));
}

/** Fifteen years on 30-jun-2026, a USMO of 9 000, gross of the tariff. */
function input(payments: string | null, over: Partial<SeparationIsrInput> = {}): SeparationIsrInput {
  return {
    payments,
    hireDate: '2011-03-01',
    terminationDate: '2026-06-30',
    usmo: '9000.0000',
    usmoIsrSubsidy: 'gross_of_tariff',
    panel: PANEL,
    ...over,
  };
}

beforeEach(() => {
  mockLaw.mockReset();
  mockParams.mockReset();
  mockBrackets.mockReset();
  mockPolicy.mockReset();
});

describe('calculateSeparationIsr — the exemption (part A)', () => {
  it('the 15-year case: the premium is exempt in full and the withholding is 0.00', async () => {
    inForce();
    const r = await calculateSeparationIsr(input('113414.4000'));
    expect(r).toMatchObject({
      payments: '113414.4000',
      exemption_years_of_service: 15,
      uma_daily: '117.3100',
      exempt_cap: '158368.5000',
      exempt: '113414.4000',
      taxable: '0.0000',
      route: 'exempt',
      withholding: '0.0000',
    });
    expect(r.note).toMatch(/LISR art\. 93 fr\. XIII/);
  });

  it('reads the cap and the UMA at the termination date, and no tariff when nothing is taxed', async () => {
    inForce();
    await calculateSeparationIsr(input('113414.4000'));
    expect(mockLaw).toHaveBeenCalledWith('MX', SEPARATION_EXEMPT_CAP_KEY, '2026-06-30');
    expect(mockParams).toHaveBeenCalledWith('MX', 2026, '2026-06-30');
    expect(mockBrackets).not.toHaveBeenCalled();
    expect(mockPolicy).not.toHaveBeenCalled();
    expect(SEPARATION_EXEMPT_CAP_KEY).toBe('income_tax.exempt_cap.separation_uma_per_year_of_service');
  });

  it('nothing paid reads no law at all', async () => {
    const r = await calculateSeparationIsr(input('0.0000'));
    expect(mockLaw).not.toHaveBeenCalled();
    expect(mockParams).not.toHaveBeenCalled();
    expect(r).toMatchObject({ route: 'none', withholding: '0.0000', exempt_cap: null, taxable: '0.0000' });
  });

  it('a premium that could not be calculated leaves the separation ISR uncalculated too', async () => {
    const r = await calculateSeparationIsr(input(null));
    expect(mockLaw).not.toHaveBeenCalled();
    expect(r).toMatchObject({ payments: null, route: 'not_calculated', withholding: null, taxable: null });
    expect(r.note).toMatch(/seniority premium/);
  });

  it('without the 90 UMA row the settlement still answers, and names the missing row, never a figure', async () => {
    inForce();
    mockLaw.mockRejectedValue(
      new LegalParameterUnavailableError('MX', SEPARATION_EXEMPT_CAP_KEY, '2026-06-30', 'never_loaded', 'no row')
    );
    const r = await calculateSeparationIsr(input('358368.5000'));
    expect(r).toMatchObject({ route: 'not_calculated', withholding: null, exempt: null, taxable: null });
    expect(r.note).toContain(SEPARATION_EXEMPT_CAP_KEY);
    expect(r.note).toContain('never_loaded');
  });

  it('any other failure of the law is not swallowed', async () => {
    mockLaw.mockRejectedValue(new Error('connection lost'));
    await expect(calculateSeparationIsr(input('113414.4000'))).rejects.toThrow('connection lost');
  });

  it('a cap that is not in UMA is refused: 90 pesos is not 90 UMA', async () => {
    inForce();
    mockLaw.mockResolvedValue({ value: '90.0000', unit: 'MXN', effectiveFrom: '2016-01-28' });
    await expect(calculateSeparationIsr(input('113414.4000'))).rejects.toThrow(/UMA/);
  });

  it('a missing UMA fails closed, as every reader of the UMA does', async () => {
    inForce();
    mockParams.mockResolvedValue({});
    await expect(calculateSeparationIsr(input('113414.4000'))).rejects.toThrow(/uma_daily/);
  });
});

describe('calculateSeparationIsr — the withholding (part B, LISR art. 96)', () => {
  it('USMO 9 000 and 200 000 taxed, gross of the tariff: rate 6.8913 %, 13 782.67', async () => {
    inForce();
    const r = await calculateSeparationIsr(input('358368.5000'));
    expect(r).toMatchObject({
      taxable: '200000.0000',
      route: 'effective_rate',
      usmo: '9000.0000',
      usmo_comparison: 'total_payments',
      isr_of_usmo: '620.2200',
      employment_subsidy_of_usmo: null,
      rate_percent: '6.8913',
      withholding: '13782.6700',
    });
    expect(r.note).toMatch(/LISR art\. 96/);
  });

  it('the same case net of the subsidy: 535.65 off, rate 0.9397 %, 1 879.33', async () => {
    inForce();
    const r = await calculateSeparationIsr(input('358368.5000', { usmoIsrSubsidy: 'net_of_subsidy' }));
    expect(r).toMatchObject({
      isr_of_usmo: '620.2200',
      employment_subsidy_of_usmo: '535.6500',
      rate_percent: '0.9397',
      withholding: '1879.3300',
    });
  });

  it('the ISR of the USMO is read with the MONTHLY tariff, never the period one', async () => {
    inForce();
    await calculateSeparationIsr(input('358368.5000'));
    const freqs = mockBrackets.mock.calls.map((c: unknown[]) => c[4]);
    expect(freqs.length).toBeGreaterThan(0);
    expect(new Set(freqs)).toEqual(new Set(['monthly']));
  });

  it('the issue\'s error, the tariff applied to the 200 000 itself (56 770.26), is not what comes out', async () => {
    inForce();
    const r = await calculateSeparationIsr(input('358368.5000'));
    expect(r.withholding).not.toBe('56770.2600');
  });

  it('the comparison key decides the route when only the taxable part is below the USMO', async () => {
    inForce();
    const byTotal = await calculateSeparationIsr(input('163368.5000'));
    expect(byTotal).toMatchObject({ taxable: '5000.0000', route: 'effective_rate', withholding: '344.5700' });

    inForce({ separation_isr_usmo_comparison: 'taxable_payments' });
    const byTaxable = await calculateSeparationIsr(input('163368.5000'));
    // 16.22 + (5 000 − 844.60) × 0.064 = 282.1656 → 282.17
    expect(byTaxable).toMatchObject({
      route: 'tariff', usmo_comparison: 'taxable_payments', isr_of_usmo: null, rate_percent: null,
      withholding: '282.1700',
    });
    expect(mockPolicy).toHaveBeenCalledWith(PANEL, SEPARATION_ISR_USMO_COMPARISON_POLICY);
  });

  it('a total below the USMO goes by the monthly tariff: 8 000 with no year of service is 511.42', async () => {
    inForce();
    const r = await calculateSeparationIsr(input('8000.0000', { hireDate: '2026-01-10' }));
    // 420.95 + (8 000 − 7 168.52) × 0.1088 = 511.415024 → 511.42
    expect(r).toMatchObject({ exemption_years_of_service: 0, taxable: '8000.0000', route: 'tariff', withholding: '511.4200' });
  });

  it('a USMO of zero is not divided by: the withholding is named, never invented', async () => {
    inForce();
    const r = await calculateSeparationIsr(input('8000.0000', { hireDate: '2026-01-10', usmo: '0.0000' }));
    expect(r).toMatchObject({ route: 'not_calculated', withholding: null, taxable: '8000.0000' });
    expect(r.note).toMatch(/USMO/);
  });

  it('the subsidy is read only when the panel says net of it', async () => {
    inForce();
    await calculateSeparationIsr(input('358368.5000'));
    expect(mockLaw).not.toHaveBeenCalledWith('MX', 'employment_subsidy.uma_monthly_rate', expect.anything());
  });
});

describe('readSeparationIsrUsmoComparison — closed on declaring', () => {
  it('returns the two values it knows', async () => {
    inForce({ separation_isr_usmo_comparison: 'taxable_payments' });
    await expect(readSeparationIsrUsmoComparison(PANEL)).resolves.toBe('taxable_payments');
  });

  it('refuses anything else, and names it', async () => {
    inForce({ separation_isr_usmo_comparison: 'gravado' });
    await expect(readSeparationIsrUsmoComparison(PANEL)).rejects.toMatchObject({ code: 'POLICY_VALUE_UNKNOWN' });
    await expect(readSeparationIsrUsmoComparison(PANEL)).rejects.toThrow(
      /separation_isr_usmo_comparison = "gravado".*total_payments, taxable_payments/
    );
  });
});
