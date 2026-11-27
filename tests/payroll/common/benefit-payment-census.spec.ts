import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));

import { replayAgainstProvision } from '../../../src/services/payroll/common/benefit-payment-census.js';

// MNE-001-878 (#111), part 3. What each past payment would have debited to
// its provision, oldest first. Figures by hand: a premium of four days at
// 1,000.00 a day accrues 1,000 × 4 × 212/365 = 2,323.2877 in seven months.
describe('replayAgainstProvision: each payment takes what the provision held, less what the earlier ones take', () => {
  const replay = (payments: Array<[string, string]>, heldNow: string): string[] =>
    replayAgainstProvision(payments.map(([notDebited, heldAtMonthEnd]) => ({ notDebited, heldAtMonthEnd })), heldNow)
      .map((a) => a.toFixed(2));

  it('1,500.00 and then 1,000.00 against 2,323.2877: the second finds 823.29 left', () => {
    expect(replay([['1500.00', '2323.2877'], ['1000.00', '2323.2877']], '2323.2877')).toEqual(['1500.00', '823.29']);
  });

  it('never more than the provision holds today: a later entry that consumed 2,000.00 leaves 323.29 for the oldest', () => {
    expect(replay([['1500.00', '2323.2877'], ['1000.00', '2323.2877']], '323.2877')).toEqual(['323.29', '0.00']);
  });

  it('a payment made when the provision held nothing, or was overdrawn, takes nothing', () => {
    expect(replay([['516.44', '0.0016']], '0.0016')).toEqual(['0.00']);
    expect(replay([['516.44', '-250.0000'], ['300.00', '900.0000']], '900.0000')).toEqual(['0.00', '300.00']);
  });
});
