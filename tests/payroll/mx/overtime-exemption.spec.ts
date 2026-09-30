import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ============================================================
// OVERTIME IS EXEMPT BY LISR ART. 93 FR. I (#297, MNE-001-110)
//
// Overtime was taxed whole. Fraction I exempts 50 % of the double-paid hours
// within the LFT limit, up to 5 daily UMA per week of service, with the UMA
// of the payment date: 5 × 117.31 = 586.55 a week from February 2026. The
// panel key `overtime_isr_exemption` decides whether the firm applies it.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));

import {
  OVERTIME_EXEMPT_CAP_KEY,
  OVERTIME_EXEMPT_SHARE_KEY,
  OVERTIME_POLICY_KEY,
  OVERTIME_WEEKLY_HOURS_KEY,
  isrPartsOf,
} from '../../../src/services/payroll/mx/isr-exemption.js';
import { query } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';

const mockQuery = query as unknown as Mock;
const mockPolicy = getPolicy as unknown as Mock;

/** The law as migration 164 seeds it; the LFT limit is dated by the reform of DOF 01-05-2026. */
function law(policy = 'exempt_by_law'): void {
  mockPolicy.mockResolvedValue({ key: OVERTIME_POLICY_KEY, value: policy });
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    if (/FROM legal_parameters/.test(sql)) {
      const key = String(params[1]);
      const onDate = String(params[2]);
      const value =
        key === OVERTIME_EXEMPT_SHARE_KEY ? '0.5000'
        : key === OVERTIME_EXEMPT_CAP_KEY ? '5.0000'
        : key === OVERTIME_WEEKLY_HOURS_KEY ? (onDate >= '2028-01-01' ? '10.0000' : '9.0000')
        : null;
      if (value === null) return { rows: [] };
      return {
        rows: [{
          jurisdiction: 'MX', key, value, unit: 'x', effectiveFrom: '2016-01-28',
          sourceUrl: 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf', sourceNote: null,
        }],
      };
    }
    if (/FROM tax_parameters/.test(sql)) return { rows: [{ params: { uma_daily: '117.31' } }] };
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  });
}

const WEEK = { tenantId: 't-1', employeeId: 'e-1', payRunId: 'r-1', payDate: '2026-07-15', entityId: 'n-1', periodDays: 7 };

beforeEach(() => {
  mockQuery.mockReset();
  mockPolicy.mockReset();
});

describe('isrPartsOf: overtime (LISR art. 93 fr. I)', () => {
  it('ACCEPTANCE (#297): half of the overtime is exempt, and only the other half is taxed', async () => {
    law();
    const [p] = await isrPartsOf([{ earning_type: 'overtime', amount: 1000 }], WEEK);
    expect(p.exempt.toFixed(2)).toBe('500.00');
    expect(p.taxable.toFixed(2)).toBe('500.00');
    expect(mockPolicy).toHaveBeenCalledWith({ tenantId: 't-1', entityId: 'n-1' }, OVERTIME_POLICY_KEY);
  });

  it('the half is capped at 5 UMA of the payment date per week: 586.55 in a weekly period', async () => {
    law();
    const [p] = await isrPartsOf([{ earning_type: 'overtime', amount: 2000 }], WEEK);
    expect(p.exempt.toFixed(2)).toBe('586.55');
    expect(p.taxable.toFixed(2)).toBe('1413.45');
  });

  it('a 15-day period has 15/7 weeks of service: 5 × 117.31 × 15/7 = 1 256.89', async () => {
    law();
    const [p] = await isrPartsOf([{ earning_type: 'overtime', amount: 3000 }], { ...WEEK, periodDays: 15 });
    expect(p.exempt.toFixed(2)).toBe('1256.89');
    expect(p.taxable.toFixed(2)).toBe('1743.11');
  });

  it('two overtime lines of one paycheck share the period cap', async () => {
    law();
    const parts = await isrPartsOf(
      [{ earning_type: 'overtime', amount: 800 }, { earning_type: 'overtime', amount: 800 }],
      WEEK
    );
    expect(parts.map((p) => p.exempt.toFixed(2))).toEqual(['400.00', '186.55']);
    expect(mockPolicy).toHaveBeenCalledTimes(1);
  });

  it('triple-paid hours, in an earning of their own, are taxed whole', async () => {
    law();
    const [p] = await isrPartsOf([{ earning_type: 'overtime_triple', amount: 900 }], WEEK);
    expect(p.exempt.toFixed(2)).toBe('0.00');
    expect(mockPolicy).not.toHaveBeenCalled();
  });

  it('an overtime line beyond the LFT weekly limit fails closed instead of exempting triple pay', async () => {
    law();
    await expect(
      isrPartsOf([{ earning_type: 'overtime', amount: 1000, hours: 10 }], WEEK)
    ).rejects.toThrow(/labour limit for this period is 9/);
    const [p] = await isrPartsOf([{ earning_type: 'overtime', amount: 900, hours: 9 }], WEEK);
    expect(p.exempt.toFixed(2)).toBe('450.00');
  });

  it('the limit is read on the payment date: 10 hours a week are within it in 2028', async () => {
    law();
    const [p] = await isrPartsOf(
      [{ earning_type: 'overtime', amount: 1000, hours: 10 }],
      { ...WEEK, payDate: '2028-03-15' }
    );
    expect(p.exempt.toFixed(2)).toBe('500.00');
  });

  it('overtime_isr_exemption=taxed_in_full taxes it whole and reads no law', async () => {
    law('taxed_in_full');
    const [p] = await isrPartsOf([{ earning_type: 'overtime', amount: 1000, hours: 20 }], WEEK);
    expect(p.exempt.toFixed(2)).toBe('0.00');
    expect(p.taxable.toFixed(2)).toBe('1000.00');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('an answer the reader does not know fails closed', async () => {
    law('something_else');
    await expect(isrPartsOf([{ earning_type: 'overtime', amount: 1000 }], WEEK)).rejects.toThrow(
      /overtime_isr_exemption/
    );
  });

  it('outside Mexico, overtime keeps the all-or-nothing flag and reads no policy', async () => {
    law();
    const [p] = await isrPartsOf([{ earning_type: 'overtime', amount: 1000 }], null);
    expect(p.taxable.toFixed(2)).toBe('1000.00');
    expect(mockPolicy).not.toHaveBeenCalled();
  });
});
