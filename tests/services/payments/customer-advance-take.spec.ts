import { describe, it, expect } from 'vitest';
import { iepsTakeOf, takeFromAdvance } from '../../../src/services/payments/customer-advance.js';

// MNE-001-422 (#623) · what one allocation takes from a receipt's advance, by hand.
const advance = { total: '1160.00', iva: '160.00', consumed: '0', cancelled: '0', plain: '0' };

describe('takeFromAdvance', () => {
  it('in full: the base and the whole IVA', () => {
    expect(takeFromAdvance({ ...advance, applied: '1160.00' })).toEqual({ plain: '0.0000', base: '1000.0000', iva: '160.0000' });
  });

  it('in three parts the cumulative target leaves no cent: 53.3338, 53.3338 and 53.3324', () => {
    const first = takeFromAdvance({ ...advance, applied: '386.67' });
    const second = takeFromAdvance({ ...advance, consumed: '386.67', cancelled: first.iva, applied: '386.67' });
    const third = takeFromAdvance({ ...advance, consumed: '773.34', cancelled: '106.6676', applied: '386.66' });
    expect([first.iva, second.iva, third.iva]).toEqual(['53.3338', '53.3338', '53.3324']);
    expect([first.base, second.base, third.base]).toEqual(['333.3362', '333.3362', '333.3276']);
  });

  it('takes the cash that carries no advance IVA first, and the advance after it', () => {
    // 1,160.00 of plain cash on account beside an advance of 1,160.00.
    expect(takeFromAdvance({ ...advance, plain: '1160.00', applied: '1160.00' }))
      .toEqual({ plain: '1160.0000', base: '0.0000', iva: '0.0000' });
    expect(takeFromAdvance({ ...advance, plain: '1000.00', applied: '1160.00' }))
      .toEqual({ plain: '1000.0000', base: '137.9310', iva: '22.0690' });
  });

  it('an exempt advance takes its base and cancels nothing', () => {
    expect(takeFromAdvance({ ...advance, iva: '0', applied: '500.00' })).toEqual({ plain: '0.0000', base: '500.0000', iva: '0.0000' });
  });
});

// MNE-001-590 (#792) · the IEPS one allocation takes from the cash on account, by hand.
describe('iepsTakeOf', () => {
  it('at the pool\'s own ratio, half up: 80 × 1,160 / 1,252.80 = 74.0741, and 80 × 626.40 / 1,252.80 = 40.0000', () => {
    expect(iepsTakeOf({ left: '80.0000', cashLeft: '1252.80', fromAdvance: '1160.00' })).toBe('74.0741');
    expect(iepsTakeOf({ left: '80.0000', cashLeft: '1252.80', fromAdvance: '626.40' })).toBe('40.0000');
  });

  it('the take that empties the pool gets the exact remainder: 5.9259 on the last 92.80', () => {
    expect(iepsTakeOf({ left: '5.9259', cashLeft: '92.80', fromAdvance: '92.80' })).toBe('5.9259');
    expect(iepsTakeOf({ left: '40.0000', cashLeft: '626.40', fromAdvance: '700.00' })).toBe('40.0000');
  });

  it('nothing when the cash takes nothing from the pool or the pool carries no IEPS, and the rest when no cash is left', () => {
    expect(iepsTakeOf({ left: '80.0000', cashLeft: '1252.80', fromAdvance: '0' })).toBe('0.0000');
    expect(iepsTakeOf({ left: '0', cashLeft: '1252.80', fromAdvance: '500.00' })).toBe('0.0000');
    expect(iepsTakeOf({ left: '-1.0000', cashLeft: '1252.80', fromAdvance: '500.00' })).toBe('0.0000');
    expect(iepsTakeOf({ left: '3.0000', cashLeft: '0', fromAdvance: '0.01' })).toBe('3.0000');
  });
});
