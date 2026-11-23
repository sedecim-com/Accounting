import { describe, expect, it } from 'vitest';
import { splitDiscountVat } from '../../src/services/accounting/discount-vat-correction.js';

// MNE-001-599 · #831, part 2 of 2: the VAT a discount posted before migration
// 341 left in 1135. Hand figures, bill B-1: 1,000.00 + 160.00 = 1,160.00.
// A discount's VAT is discount × 160 / 1,160, capped by what is still parked.

const B1 = { taxAmount: '160.00', totalAmount: '1160.00' };

describe('splitDiscountVat', () => {
  it('paid 1,102 + 58: the 8.0000 left in 1135 is the discount\'s', () => {
    expect(splitDiscountVat({ ...B1, parked: '8.0000', paid: true, discounts: ['58.00'] })).toEqual(['8.0000']);
  });

  it('980 + 20 then 160: 2.7586 is left, after 135.1724 and 22.0690 were released', () => {
    expect(splitDiscountVat({ ...B1, parked: '2.7586', paid: true, discounts: ['20.00'] })).toEqual(['2.7586']);
  });

  it('an open bill: 160 − 135.1724 = 24.8276 parked, only the 2.7586 of the discount leaves', () => {
    expect(splitDiscountVat({ ...B1, parked: '24.8276', paid: false, discounts: ['20.00'] })).toEqual(['2.7586']);
  });

  it('two discounts on one bill each take their share, in order', () => {
    expect(splitDiscountVat({ ...B1, parked: '5.5172', paid: true, discounts: ['20.00', '20.00'] }))
      .toEqual(['2.7586', '2.7586']);
  });

  it('on a paid bill a gap of a cent or less is the releases\' rounding, and goes with the last discount', () => {
    expect(splitDiscountVat({ ...B1, parked: '8.0001', paid: true, discounts: ['58.00'] })).toEqual(['8.0001']);
    expect(splitDiscountVat({ ...B1, parked: '8.0001', paid: false, discounts: ['58.00'] })).toEqual(['8.0000']);
  });

  it('a larger gap is something else parked, such as a held cheque\'s cash: only the share leaves', () => {
    expect(splitDiscountVat({ ...B1, parked: '160.0000', paid: true, discounts: ['58.00'] })).toEqual(['8.0000']);
  });

  it('never more than is parked', () => {
    expect(splitDiscountVat({ ...B1, parked: '5.0000', paid: true, discounts: ['58.00', '20.00'] }))
      .toEqual(['5.0000', '0.0000']);
  });

  it('in another currency the share is at the bill\'s rate: USD 5.80 × 16 / 116 × 20 = 16.0000', () => {
    expect(splitDiscountVat({
      taxAmount: '16.00', totalAmount: '116.00', rate: '20', parked: '16.0000', paid: true, discounts: ['5.80'],
    })).toEqual(['16.0000']);
  });
});
