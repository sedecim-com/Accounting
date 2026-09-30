import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ============================================================
// THE VACATION PREMIUM IS EXEMPT UP TO 15 UMA (LISR art. 93 fr. XIV · #297, MNE-001-063)
//
// The aguinaldo got its 30 UMA in MNE-001-062; the vacation premium was still
// taxed whole. It has a cap of its own: 15 daily UMA per calendar year, with
// the UMA in force on the payment date. 15 × 117.31 = 1 759.65 from
// February 2026 on.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));

import {
  VACATION_PREMIUM_EXEMPT_CAP_KEY,
  YEAR_END_BONUS_EXEMPT_CAP_KEY,
  isrPartsOf,
} from '../../../src/services/payroll/mx/isr-exemption.js';
import { query } from '../../../src/database/connection.js';

const mockQuery = query as unknown as Mock;

const CAPS: Record<string, string> = {
  [YEAR_END_BONUS_EXEMPT_CAP_KEY]: '30.0000',
  [VACATION_PREMIUM_EXEMPT_CAP_KEY]: '15.0000',
};

/** The law as the database answers it; `used` is what earlier paychecks exempted, per earning type. */
function law(used: Record<string, string> = {}): void {
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    if (/FROM legal_parameters/.test(sql)) {
      const key = String(params[1]);
      if (!(key in CAPS)) return { rows: [] };
      return {
        rows: [{
          jurisdiction: 'MX', key, value: CAPS[key], unit: 'UMA', effectiveFrom: '2016-01-28',
          sourceUrl: 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf', sourceNote: null,
        }],
      };
    }
    if (/FROM tax_parameters/.test(sql)) return { rows: [{ params: { uma_daily: '117.31' } }] };
    if (/FROM paycheck_earnings/.test(sql)) return { rows: [{ used: used[String(params[5])] ?? '0' }] };
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  });
}

const CTX = { tenantId: 't-1', employeeId: 'e-1', payRunId: 'r-1', payDate: '2026-07-15', entityId: 'n-1', periodDays: 15 };

beforeEach(() => {
  mockQuery.mockReset();
});

describe('isrPartsOf: the vacation premium', () => {
  it('ACCEPTANCE (#297): a vacation premium is exempt up to 15 UMA of the payment date', async () => {
    law();
    const [p] = await isrPartsOf([{ earning_type: 'prima_vacacional', amount: 3000 }], CTX);
    expect(p.exempt.toFixed(2)).toBe('1759.65');
    expect(p.taxable.toFixed(2)).toBe('1240.35');
    const cap = mockQuery.mock.calls.find((c) => /FROM legal_parameters/.test(String(c[0])));
    expect(cap?.[1]).toEqual(['MX', VACATION_PREMIUM_EXEMPT_CAP_KEY, '2026-07-15']);
  });

  it('a premium under the cap is exempt whole', async () => {
    law();
    const [p] = await isrPartsOf([{ earning_type: 'prima_vacacional', amount: 1200 }], CTX);
    expect(p.exempt.toFixed(2)).toBe('1200.00');
    expect(p.taxable.toFixed(2)).toBe('0.00');
  });

  it('the 15 UMA are per calendar year, and only premiums of earlier paychecks consume them', async () => {
    law({ prima_vacacional: '1000.00', aguinaldo: '3519.30' });
    const [p] = await isrPartsOf([{ earning_type: 'prima_vacacional', amount: 3000 }], CTX);
    expect(p.exempt.toFixed(2)).toBe('759.65');
    const used = mockQuery.mock.calls.find((c) => /FROM paycheck_earnings/.test(String(c[0])));
    expect(used?.[1]).toEqual(['t-1', 'e-1', 2026, '2026-07-15', 'r-1', 'prima_vacacional']);
  });

  it('the aguinaldo and the premium each have their own cap in the same paycheck', async () => {
    law();
    const parts = await isrPartsOf(
      [
        { earning_type: 'aguinaldo', amount: 10000 },
        { earning_type: 'prima_vacacional', amount: 3000 },
        { earning_type: 'salary', amount: 8000 },
      ],
      CTX
    );
    expect(parts.map((p) => [p.exempt.toFixed(2), p.taxable.toFixed(2)])).toEqual([
      ['3519.30', '6480.70'],
      ['1759.65', '1240.35'],
      ['0.00', '8000.00'],
    ]);
  });

  it('a missing premium cap fails closed', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/MIN\(effective_from\)/.test(sql)) return { rows: [{ effectiveFrom: null }] };
      return { rows: [] };
    });
    await expect(
      isrPartsOf([{ earning_type: 'prima_vacacional', amount: 3000 }], CTX)
    ).rejects.toThrow(VACATION_PREMIUM_EXEMPT_CAP_KEY);
  });
});
