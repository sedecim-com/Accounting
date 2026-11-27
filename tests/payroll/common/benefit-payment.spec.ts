import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));

import { chargeToProvision } from '../../../src/services/payroll/common/benefit-payment.js';

// MNE-001-878 (#111). What a provision takes of a benefit paid, by hand: one
// worker at 1,000.00 a day and 15 days of aguinaldo accrues 15,000.0000 in a
// year and 1,000 × 15 × 334/365 = 13,726.0274 in eleven months.
describe('chargeToProvision: never more than was paid, never more than the provision holds', () => {
  const charge = (paid: string, held: string): string => chargeToProvision(paid, held).toFixed(2);

  it('a payment the provision covers is taken whole, and the provision ends at zero', () => {
    expect(charge('15000.00', '15000.0000')).toBe('15000.00');
  });

  it('a payment over the provision takes what it holds: the excess, 1,273.97, is expense', () => {
    expect(charge('15000.00', '13726.0274')).toBe('13726.03');
  });

  it('a payment under the provision takes only what was paid: the rest stays accrued', () => {
    expect(charge('2000.00', '14641.0959')).toBe('2000.00');
  });

  it('what the provision holds is taken to its nearest cent, as the entry posts cents', () => {
    // 8,219.1780 accrued (547.9452 a day × 15) and 8,219.18 paid: no stray cent to expense.
    expect(charge('8219.18', '8219.1780')).toBe('8219.18');
    expect(charge('100.00', '0.0049')).toBe('0.00');
    expect(charge('100.00', '0.0050')).toBe('0.01');
  });

  it('an empty or overdrawn provision gives nothing, and a negative payment takes nothing', () => {
    expect(charge('15000.00', '0')).toBe('0.00');
    expect(charge('15000.00', '-250.0000')).toBe('0.00');
    expect(charge('-500.00', '15000.0000')).toBe('0.00');
  });
});
