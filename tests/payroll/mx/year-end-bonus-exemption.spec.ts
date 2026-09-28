import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ============================================================
// THE AGUINALDO IS EXEMPT UP TO 30 UMA (LISR art. 93 fr. XIV · #297, MNE-001-062)
//
// Before this, `taxableIsr` treated every earning as all or nothing, so a
// December aguinaldo was taxed whole. The acceptance figure of the issue is
// pinned here: 10 000.00 paid from February 2026 on is taxed on 6 480.70,
// which is 10 000 − 30 × 117.31.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));

import {
  YEAR_END_BONUS_EXEMPT_CAP_KEY,
  isrPartsOf,
  splitAgainstCap,
} from '../../../src/services/payroll/mx/isr-exemption.js';
import { query } from '../../../src/database/connection.js';

const mockQuery = query as unknown as Mock;

/** The law as the database answers it: the cap in UMA and the dated UMA. */
function law(opts: { umaDaily?: string; alreadyExempt?: string } = {}): void {
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    if (/FROM legal_parameters/.test(sql)) {
      expect(params[1]).toBe(YEAR_END_BONUS_EXEMPT_CAP_KEY);
      return {
        rows: [{
          jurisdiction: 'MX', key: YEAR_END_BONUS_EXEMPT_CAP_KEY, value: '30.0000', unit: 'UMA',
          effectiveFrom: '2016-01-28', sourceUrl: 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
          sourceNote: null,
        }],
      };
    }
    if (/FROM tax_parameters/.test(sql)) return { rows: [{ params: { uma_daily: opts.umaDaily ?? '117.31' } }] };
    if (/FROM paycheck_earnings/.test(sql)) return { rows: [{ used: opts.alreadyExempt ?? '0' }] };
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  });
}

const CTX = { tenantId: 't-1', employeeId: 'e-1', payRunId: 'r-1', payDate: '2026-12-15' };

beforeEach(() => {
  mockQuery.mockReset();
});

describe('splitAgainstCap', () => {
  it('exempts up to the room left and taxes the rest', () => {
    const s = splitAgainstCap('10000', '3519.30');
    expect(s.exempt.toFixed(2)).toBe('3519.30');
    expect(s.taxable.toFixed(2)).toBe('6480.70');
  });

  it('exempts the whole amount when it fits under the cap', () => {
    const s = splitAgainstCap('2000', '3519.30');
    expect(s.exempt.toFixed(2)).toBe('2000.00');
    expect(s.taxable.toFixed(2)).toBe('0.00');
  });

  it('exempts nothing when the room is used up or the amount is negative', () => {
    expect(splitAgainstCap('500', '-10').exempt.toFixed(2)).toBe('0.00');
    expect(splitAgainstCap('-500', '3519.30').taxable.toFixed(2)).toBe('-500.00');
  });
});

describe('isrPartsOf: each earning carries its exempt and its taxable part', () => {
  it('ACCEPTANCE (#297): an aguinaldo of 10 000.00 paid from February 2026 is taxed on 6 480.70', async () => {
    law();
    const [p] = await isrPartsOf([{ earning_type: 'aguinaldo', amount: 10000 }], {
      ...CTX,
      payDate: '2026-02-15',
    });
    expect(p.exempt.toFixed(2)).toBe('3519.30');
    expect(p.taxable.toFixed(2)).toBe('6480.70');
  });

  it('reads the UMA in force on the payment date, not a fixed one', async () => {
    // January 2026 is still governed by the 2025 UMA (113.14): 30 × 113.14.
    law({ umaDaily: '113.14' });
    const [p] = await isrPartsOf([{ earning_type: 'aguinaldo', amount: 10000 }], {
      ...CTX,
      payDate: '2026-01-15',
    });
    expect(p.taxable.toFixed(2)).toBe('6605.80');
    const taxParams = mockQuery.mock.calls.find((c) => /FROM tax_parameters/.test(String(c[0])));
    expect(taxParams?.[1]).toEqual(['MX', '2026-01-15']);
  });

  it('the 30 UMA are per calendar year: what earlier payments exempted is not exempted again', async () => {
    law({ alreadyExempt: '3000.00' });
    const [p] = await isrPartsOf([{ earning_type: 'aguinaldo', amount: 10000 }], CTX);
    expect(p.exempt.toFixed(2)).toBe('519.30');
    expect(p.taxable.toFixed(2)).toBe('9480.70');
    const used = mockQuery.mock.calls.find((c) => /FROM paycheck_earnings/.test(String(c[0])));
    // Scoped by tenant and employee, the payment's calendar year, and never the run being calculated.
    expect(used?.[1]).toEqual(['t-1', 'e-1', 2026, '2026-12-15', 'r-1']);
  });

  it('two aguinaldo lines in one paycheck share one cap', async () => {
    law();
    const parts = await isrPartsOf(
      [
        { earning_type: 'aguinaldo', amount: 3000 },
        { earning_type: 'aguinaldo', amount: 3000 },
      ],
      CTX
    );
    expect(parts.map((p) => p.exempt.toFixed(2))).toEqual(['3000.00', '519.30']);
    expect(parts.map((p) => p.taxable.toFixed(2))).toEqual(['0.00', '2480.70']);
  });

  it('other earnings keep the all-or-nothing flag and read no law at all', async () => {
    const parts = await isrPartsOf(
      [
        { earning_type: 'salary', amount: 8000 },
        { earning_type: 'other', amount: 800, is_taxable_isr: false },
      ],
      CTX
    );
    expect(parts.map((p) => [p.exempt.toFixed(2), p.taxable.toFixed(2)])).toEqual([
      ['0.00', '8000.00'],
      ['800.00', '0.00'],
    ]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('without a Mexican context nothing is exempted by art. 93', async () => {
    const [p] = await isrPartsOf([{ earning_type: 'aguinaldo', amount: 10000 }], null);
    expect(p.taxable.toFixed(2)).toBe('10000.00');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a missing cap fails closed instead of taxing or exempting in silence', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/MIN\(effective_from\)/.test(sql)) return { rows: [{ effectiveFrom: null }] };
      if (/FROM legal_parameters/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    await expect(
      isrPartsOf([{ earning_type: 'aguinaldo', amount: 10000 }], CTX)
    ).rejects.toThrow(YEAR_END_BONUS_EXEMPT_CAP_KEY);
  });
});
