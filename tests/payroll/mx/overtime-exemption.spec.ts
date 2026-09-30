import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ============================================================
// OVERTIME IS EXEMPT BY LISR ART. 93 FR. I (#297, MNE-001-110)
//
// Overtime was taxed whole. Fraction I exempts 50 % of the double-paid hours
// within the LFT limit, up to 5 daily UMA per week of service, with the UMA
// of the payment date: 5 × 117.31 = 586.55 a week from February 2026. The
// panel key `overtime_isr_exemption` decides whether the firm applies it, and
// `overtime_exempt_weeks` how a period counts its weeks.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));

import {
  OVERTIME_EXEMPT_CAP_KEY,
  OVERTIME_EXEMPT_SHARE_KEY,
  OVERTIME_POLICY_KEY,
  OVERTIME_WEEKLY_HOURS_KEY,
  OVERTIME_WEEKS_POLICY_KEY,
  isrPartsOf,
} from '../../../src/services/payroll/mx/isr-exemption.js';
import { query } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';

const mockQuery = query as unknown as Mock;
const mockPolicy = getPolicy as unknown as Mock;

interface Law {
  policy?: string;
  weeks?: string;
  /** What other runs of the same pay period already used. */
  used?: { exempt: string; hours: string };
}

/** The law as migration 164 seeds it; the LFT limit is dated by the reform of DOF 01-05-2026. */
function law({ policy = 'exempt_by_law', weeks = 'calendar_days_over_seven', used }: Law = {}): void {
  mockPolicy.mockImplementation(async (_ctx: unknown, key: string) => ({
    key,
    value: key === OVERTIME_POLICY_KEY ? policy : key === OVERTIME_WEEKS_POLICY_KEY ? weeks : null,
  }));
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
    if (/FROM paycheck_earnings/.test(sql)) return { rows: [used ?? { exempt: '0', hours: '0' }] };
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
    const [p] = await isrPartsOf([{ earning_type: 'overtime', amount: 1000, hours: 8 }], WEEK);
    expect(p.exempt.toFixed(2)).toBe('500.00');
    expect(p.taxable.toFixed(2)).toBe('500.00');
    expect(mockPolicy).toHaveBeenCalledWith({ tenantId: 't-1', entityId: 'n-1' }, OVERTIME_POLICY_KEY);
  });

  it('the half is capped at 5 UMA of the payment date per week: 586.55 in a weekly period', async () => {
    law();
    const [p] = await isrPartsOf([{ earning_type: 'overtime', amount: 2000, hours: 9 }], WEEK);
    expect(p.exempt.toFixed(2)).toBe('586.55');
    expect(p.taxable.toFixed(2)).toBe('1413.45');
  });

  it('a 15-day period has 15/7 weeks of service: 5 × 117.31 × 15/7 = 1 256.89', async () => {
    law();
    const [p] = await isrPartsOf([{ earning_type: 'overtime', amount: 3000, hours: 19 }], { ...WEEK, periodDays: 15 });
    expect(p.exempt.toFixed(2)).toBe('1256.89');
    expect(p.taxable.toFixed(2)).toBe('1743.11');
  });

  it('overtime_exempt_weeks=whole_weeks_of_period counts a quincena as 2 weeks: 1 173.10 and 18 hours', async () => {
    law({ weeks: 'whole_weeks_of_period' });
    const quincena = { ...WEEK, periodDays: 15 };
    const [p] = await isrPartsOf([{ earning_type: 'overtime', amount: 3000, hours: 18 }], quincena);
    expect(p.exempt.toFixed(2)).toBe('1173.10');
    await expect(
      isrPartsOf([{ earning_type: 'overtime', amount: 3000, hours: 19 }], quincena)
    ).rejects.toThrow(/limit for this period is 18/);
    expect(mockPolicy).toHaveBeenCalledWith({ tenantId: 't-1', entityId: 'n-1' }, OVERTIME_WEEKS_POLICY_KEY);
  });

  it('an overtime_exempt_weeks answer the reader does not know fails closed as a configuration error', async () => {
    law({ weeks: 'something_else' });
    await expect(
      isrPartsOf([{ earning_type: 'overtime', amount: 1000, hours: 8 }], WEEK)
    ).rejects.toMatchObject({ code: 'OVERTIME_EXEMPT_WEEKS_UNKNOWN', statusCode: 422 });
  });

  it('two overtime lines of one paycheck share the period cap', async () => {
    law();
    const parts = await isrPartsOf(
      [{ earning_type: 'overtime', amount: 800, hours: 4 }, { earning_type: 'overtime', amount: 800, hours: 4 }],
      WEEK
    );
    expect(parts.map((p) => p.exempt.toFixed(2))).toEqual(['400.00', '186.55']);
    expect(mockPolicy).toHaveBeenCalledTimes(2);
  });

  it('the hours of the lines of one paycheck ADD UP against the limit: two lines of 9 h in a week are refused', async () => {
    law();
    await expect(
      isrPartsOf(
        [{ earning_type: 'overtime', amount: 500, hours: 9 }, { earning_type: 'overtime', amount: 500, hours: 9 }],
        WEEK
      )
    ).rejects.toThrow(/pay 18 hours and the labour limit for this period is 9/);
  });

  it('what other runs of the same period used comes off the cap and the hours', async () => {
    law({ used: { exempt: '400.00', hours: '5.00' } });
    const [p] = await isrPartsOf([{ earning_type: 'overtime', amount: 1000, hours: 4 }], WEEK);
    expect(p.exempt.toFixed(2)).toBe('186.55');
    const [sql, params] = mockQuery.mock.calls.find(([s]) => /FROM paycheck_earnings/.test(String(s))) as [string, unknown[]];
    expect(String(sql)).toMatch(/pr\.pay_period_id = \(SELECT pay_period_id FROM pay_runs WHERE id = \$3 AND tenant_id = \$1\)/);
    expect(String(sql)).toMatch(/pr\.id <> \$3/);
    expect(params).toEqual(['t-1', 'e-1', 'r-1']);
    await expect(
      isrPartsOf([{ earning_type: 'overtime', amount: 1000, hours: 5 }], WEEK)
    ).rejects.toThrow(/pay 10 hours/);
  });

  it('an overtime line without valid hours is refused: it cannot be checked against the LFT limit', async () => {
    law();
    for (const hours of [undefined, null, Number.NaN, -1]) {
      await expect(
        isrPartsOf([{ earning_type: 'overtime', amount: 1000, hours: hours as number }], WEEK)
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'hours' });
    }
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

  it('overtime_isr_exemption=taxed_in_full taxes it whole, needs no hours and reads no law', async () => {
    law({ policy: 'taxed_in_full' });
    const [p, q] = await isrPartsOf(
      [{ earning_type: 'overtime', amount: 1000, hours: 20 }, { earning_type: 'overtime', amount: 500 }],
      WEEK
    );
    expect(p.exempt.toFixed(2)).toBe('0.00');
    expect(p.taxable.toFixed(2)).toBe('1000.00');
    expect(q.taxable.toFixed(2)).toBe('500.00');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('an overtime_isr_exemption answer the reader does not know fails closed as a configuration error', async () => {
    law({ policy: 'something_else' });
    await expect(
      isrPartsOf([{ earning_type: 'overtime', amount: 1000, hours: 8 }], WEEK)
    ).rejects.toMatchObject({ code: 'OVERTIME_ISR_EXEMPTION_UNKNOWN', statusCode: 422 });
  });

  it('outside Mexico, overtime keeps the all-or-nothing flag and reads no policy', async () => {
    law();
    const [p] = await isrPartsOf([{ earning_type: 'overtime', amount: 1000 }], null);
    expect(p.taxable.toFixed(2)).toBe('1000.00');
    expect(mockPolicy).not.toHaveBeenCalled();
  });
});
