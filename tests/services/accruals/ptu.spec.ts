import { describe, it, expect } from 'vitest';
import { ptuAdjustment, ptuBase, ptuForYear, type PtuFigures } from '../../../src/services/accruals/ptu.js';

// ============================================================
// MNE-001-298 (#111) · THE PTU OF THE YEAR, BY HAND
//
// The case of the plan (#111, comment 7193210836), every figure worked on
// paper. A synthetic legal entity, year 2026:
//   ingresos acumulables 5,000,000; deducciones autorizadas 3,800,000 (already
//   net of the 94,000 below); PTU paid in 2026 90,000; tax losses pending
//   400,000; exempt pay 200,000, non-deductible at 0.47 (LISR art. 28
//   fr. XXX) = 94,000.
// ISR:  utilidad fiscal 5,000,000 − 3,800,000 − 90,000 = 1,110,000;
//       resultado fiscal 1,110,000 − 400,000 = 710,000.
// PTU:  5,000,000 − 3,800,000 − 94,000 = 1,106,000 (LISR art. 9, last two
//       paragraphs: no PTU paid, no losses, the fr. XXX part taken off);
//       10 % = 110,600.00.
// ============================================================

const YEAR_2026: PtuFigures = {
  accumulableIncome: '5000000.0000',
  authorizedDeductions: '3800000.0000',
  nonDeductibleExemptPay: '94000.0000',
  source: 'Annual computation 2026, working file v3',
};
const RATE = '0.1000';

describe('ptuBase · LISR art. 9 read with LFT art. 120', () => {
  it('is accumulable income less authorized deductions less the art. 28 fr. XXX part: 1,106,000', () => {
    expect(ptuBase(YEAR_2026).toFixed(4)).toBe('1106000.0000');
  });

  it('gives 110,600.00 of PTU, not the three wrong bases', () => {
    const ptu = ptuForYear(ptuBase(YEAR_2026), RATE).toFixed(2);
    expect(ptu).toBe('110600.00');
    // From the resultado fiscal (losses and PTU paid taken off): 71,000.
    // From the utilidad fiscal (PTU paid taken off): 111,000.
    // Ignoring fr. XXX: 120,000. The base takes none of those inputs.
    expect(['71000.00', '111000.00', '120000.00']).not.toContain(ptu);
  });

  it('a loss of the year gives no PTU, never a negative one', () => {
    const loss = { ...YEAR_2026, authorizedDeductions: '5100000.0000' };
    expect(ptuBase(loss).toFixed(4)).toBe('-194000.0000');
    expect(ptuForYear(ptuBase(loss), RATE).toFixed(2)).toBe('0.00');
  });

  it('rounds the share to the cent, half up: 10 % of 1,234.5650 is 123.46', () => {
    const odd = { ...YEAR_2026, accumulableIncome: '1234.5650', authorizedDeductions: '0', nonDeductibleExemptPay: '0' };
    expect(ptuForYear(ptuBase(odd), RATE).toFixed(2)).toBe('123.46');
  });
});

describe('ptuAdjustment · the PTU less what the year already provisioned', () => {
  it('with nothing provisioned the draft carries the whole 110,600.00', () => {
    expect(ptuAdjustment('110600.00', '0').toFixed(2)).toBe('110600.00');
  });

  it('after 96,000.00 provisioned by the months, the true-up is 14,600.00', () => {
    expect(ptuAdjustment('110600.00', '96000.0000').toFixed(2)).toBe('14600.00');
  });

  it('after 120,000.00 provisioned, it is −9,400.00: the excess is reversed', () => {
    expect(ptuAdjustment('110600.00', '120000.0000').toFixed(2)).toBe('-9400.00');
  });
});
