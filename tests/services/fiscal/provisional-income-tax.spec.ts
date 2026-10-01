import { describe, it, expect } from 'vitest';
import {
  applyUpdateFactor,
  lossesUpdateTarget,
  ptuDeductibleIn,
  settleProvisionalIncomeTax,
  type ProvisionalIncomeTaxFigures,
} from '../../../src/services/fiscal/provisional-income-tax.js';

// MNE-001-059 · the provisional ISR of a legal entity (LISR art. 14), by hand.
//
// August: nominal income 1 225 802.45, coefficient 0.0875, PTU 24 000 paid
// (4/8 deductible = 12 000), losses 30 600 updated, rate 30 %, prior payments
// 15 000.40, withheld 123.45.
//
//   cents: profit 107 257.71 · after PTU 95 257.71 · base 64 657.71
//          tax 19 397.31 · payable 4 273.46 → solo_el_pago 4 273
//   whole: income 1 225 802 · profit 107 258 (107 257.675) · base 64 658
//          tax 19 397 · payable 19 397 − 15 000 − 123 = 4 274 (cada_renglon)
const august: ProvisionalIncomeTaxFigures = {
  nominalIncome: '1225802.4500',
  profitCoefficient: '0.0875',
  ptuDeductible: '12000.0000',
  pendingLosses: '30600.0000',
  rate: '0.3000',
  priorProvisionalPayments: '15000.4000',
  withheldIncomeTax: '123.4500',
};

const line = (s: ReturnType<typeof settleProvisionalIncomeTax>, key: string) =>
  s.lines.find((l) => l.key === key);

describe('settleProvisionalIncomeTax', () => {
  it('cada_renglon adjusts every line to pesos and continues in whole numbers', () => {
    const s = settleProvisionalIncomeTax(august, 'cada_renglon');
    expect(line(s, 'nominal_income')).toEqual({ key: 'nominal_income', cents: '1225802.45', whole: '1225802' });
    expect(line(s, 'estimated_profit')).toEqual({ key: 'estimated_profit', cents: '107257.71', whole: '107258' });
    expect(line(s, 'pending_losses_applied')?.whole).toBe('30600');
    expect(line(s, 'taxable_base')).toEqual({ key: 'taxable_base', cents: '64657.71', whole: '64658' });
    expect(line(s, 'tax_caused')).toEqual({ key: 'tax_caused', cents: '19397.31', whole: '19397' });
    expect(line(s, 'withheld_income_tax')?.whole).toBe('123');
    expect(s.resultCents).toBe('4273.46');
    expect(s.resultWhole).toBe('4274');
  });

  it('solo_el_pago runs the chain in cents and adjusts only the payment', () => {
    const s = settleProvisionalIncomeTax(august, 'solo_el_pago');
    expect(s.resultCents).toBe('4273.46');
    expect(s.resultWhole).toBe('4273');
    // One payment on the paper: every line's pesos come from its own cents.
    expect(line(s, 'payable')?.whole).toBe(s.resultWhole);
    expect(line(s, 'estimated_profit')?.whole).toBe('107258');
    expect(line(s, 'tax_caused')?.whole).toBe('19397');
  });

  it('losses never exceed the profit left, and a payment is never negative', () => {
    const s = settleProvisionalIncomeTax({ ...august, pendingLosses: '999999' }, 'cada_renglon');
    expect(line(s, 'pending_losses_applied')?.whole).toBe('95258');
    expect(line(s, 'taxable_base')?.whole).toBe('0');
    expect(s.resultCents).toBe('0.00');
    expect(s.resultWhole).toBe('0');
  });

  it('a PTU larger than the profit leaves a zero base, not a negative one', () => {
    const s = settleProvisionalIncomeTax({ ...august, ptuDeductible: '200000', pendingLosses: '0' }, 'solo_el_pago');
    expect(line(s, 'taxable_base')?.cents).toBe('0.00');
  });
});

describe('the PTU deducted by month (LISR art. 14 fr. II)', () => {
  it('nothing until April, then one eighth more each month through December', () => {
    expect(ptuDeductibleIn(4, '24000').toFixed(2)).toBe('0.00');
    expect(ptuDeductibleIn(5, '24000').toFixed(2)).toBe('3000.00');
    expect(ptuDeductibleIn(8, '24000').toFixed(2)).toBe('12000.00');
    expect(ptuDeductibleIn(12, '24000').toFixed(2)).toBe('24000.00');
  });
});

describe('the update of pending losses (LISR art. 57, CFF art. 17-A)', () => {
  it('July to December update to June of the year; January to June to the previous December', () => {
    expect(lossesUpdateTarget(2026, 7)).toEqual({ anio: 2026, mes: 6 });
    expect(lossesUpdateTarget(2026, 12)).toEqual({ anio: 2026, mes: 6 });
    expect(lossesUpdateTarget(2026, 6)).toEqual({ anio: 2025, mes: 12 });
    expect(lossesUpdateTarget(2026, 1)).toEqual({ anio: 2025, mes: 12 });
  });

  it('a factor below 1 is taken as 1', () => {
    expect(applyUpdateFactor('30000', '1.0200').toFixed(2)).toBe('30600.00');
    expect(applyUpdateFactor('30000', '0.9950').toFixed(2)).toBe('30000.00');
  });
});
