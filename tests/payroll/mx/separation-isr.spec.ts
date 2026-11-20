import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));
vi.mock('../../../src/services/jurisdiction/legal-parameters.js', async (original) => {
  const actual = await original<typeof import('../../../src/services/jurisdiction/legal-parameters.js')>();
  return { ...actual, legalParameterAt: vi.fn() };
});
vi.mock('../../../src/services/payroll/tax-engine/tax-tables.js', async (original) => {
  const actual = await original<typeof import('../../../src/services/payroll/tax-engine/tax-tables.js')>();
  return { ...actual, getTaxParameters: vi.fn() };
});

import {
  calculateSeparationIsr,
  SEPARATION_EXEMPT_CAP_KEY,
} from '../../../src/services/payroll/mx/separation-isr.js';
import {
  legalParameterAt,
  LegalParameterUnavailableError,
} from '../../../src/services/jurisdiction/legal-parameters.js';
import { getTaxParameters } from '../../../src/services/payroll/tax-engine/tax-tables.js';

const mockLaw = legalParameterAt as unknown as Mock;
const mockParams = getTaxParameters as unknown as Mock;

// MNE-001-375 · #194: the shell of the separation ISR, part A. It reads the
// 90 UMA of LISR art. 93 fr. XIII and the UMA of the termination date, and
// says what is exempt and what is taxed. The withholding on a taxable part is
// MNE-001-579; until then it is named, never printed as zero.

const FIFTEEN_YEARS = { hireDate: '2011-06-30', terminationDate: '2026-06-30' };

function lawInForce(): void {
  mockLaw.mockResolvedValue({ value: '90.0000', unit: 'UMA', effectiveFrom: '2016-01-28' });
  mockParams.mockResolvedValue({ uma_daily: 117.31 });
}

beforeEach(() => {
  mockLaw.mockReset();
  mockParams.mockReset();
});

describe('calculateSeparationIsr — part A: the exemption', () => {
  it('the 15-year case: the premium is exempt in full and the withholding is 0.00', async () => {
    lawInForce();
    const r = await calculateSeparationIsr({ payments: '113414.4000', ...FIFTEEN_YEARS });
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

  it('reads the cap and the UMA at the termination date, not today', async () => {
    lawInForce();
    await calculateSeparationIsr({ payments: '113414.4000', ...FIFTEEN_YEARS });
    expect(mockLaw).toHaveBeenCalledWith('MX', SEPARATION_EXEMPT_CAP_KEY, '2026-06-30');
    expect(mockParams).toHaveBeenCalledWith('MX', 2026, '2026-06-30');
    expect(SEPARATION_EXEMPT_CAP_KEY).toBe('income_tax.exempt_cap.separation_uma_per_year_of_service');
  });

  it('a taxable part is NOT withheld yet, and says so instead of printing 0', async () => {
    lawInForce();
    const r = await calculateSeparationIsr({ payments: '358368.5000', ...FIFTEEN_YEARS });
    expect(r.taxable).toBe('200000.0000');
    expect(r.route).toBe('not_calculated');
    expect(r.withholding).toBeNull();
    expect(r.note).toMatch(/NOT WITHHELD/);
    expect(r.note).toMatch(/200000\.0000/);
    expect(r.note).toMatch(/MNE-001-579/);
  });

  it('nothing paid reads no law at all', async () => {
    const r = await calculateSeparationIsr({ payments: '0.0000', ...FIFTEEN_YEARS });
    expect(mockLaw).not.toHaveBeenCalled();
    expect(mockParams).not.toHaveBeenCalled();
    expect(r).toMatchObject({ route: 'none', withholding: '0.0000', exempt_cap: null, taxable: '0.0000' });
  });

  it('a premium that could not be calculated leaves the separation ISR uncalculated too', async () => {
    const r = await calculateSeparationIsr({ payments: null, ...FIFTEEN_YEARS });
    expect(mockLaw).not.toHaveBeenCalled();
    expect(r).toMatchObject({ payments: null, route: 'not_calculated', withholding: null, taxable: null });
    expect(r.note).toMatch(/seniority premium/);
  });

  it('without the 90 UMA row the settlement still answers, and names the missing row', async () => {
    mockLaw.mockRejectedValue(
      new LegalParameterUnavailableError('MX', SEPARATION_EXEMPT_CAP_KEY, '2026-06-30', 'never_loaded', 'no row')
    );
    mockParams.mockResolvedValue({ uma_daily: 117.31 });
    const r = await calculateSeparationIsr({ payments: '113414.4000', ...FIFTEEN_YEARS });
    expect(r).toMatchObject({ route: 'not_calculated', withholding: null, exempt: null, taxable: null });
    expect(r.note).toContain(SEPARATION_EXEMPT_CAP_KEY);
    expect(r.note).toContain('never_loaded');
  });

  it('any other failure of the law is not swallowed', async () => {
    mockLaw.mockRejectedValue(new Error('connection lost'));
    await expect(calculateSeparationIsr({ payments: '113414.4000', ...FIFTEEN_YEARS })).rejects.toThrow(
      'connection lost'
    );
  });

  it('a cap that is not in UMA is refused: 90 pesos is not 90 UMA', async () => {
    mockLaw.mockResolvedValue({ value: '90.0000', unit: 'MXN', effectiveFrom: '2016-01-28' });
    mockParams.mockResolvedValue({ uma_daily: 117.31 });
    await expect(calculateSeparationIsr({ payments: '113414.4000', ...FIFTEEN_YEARS })).rejects.toThrow(
      /UMA/
    );
  });

  it('a missing UMA fails closed, as every reader of the UMA does', async () => {
    mockLaw.mockResolvedValue({ value: '90.0000', unit: 'UMA', effectiveFrom: '2016-01-28' });
    mockParams.mockResolvedValue({});
    await expect(calculateSeparationIsr({ payments: '113414.4000', ...FIFTEEN_YEARS })).rejects.toThrow(
      /uma_daily/
    );
  });
});
