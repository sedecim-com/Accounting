import { describe, expect, it } from 'vitest';
import { releaseDayOf, reparkSameMonth } from '../../../src/services/payments/customer-advance.js';
import { getPolicySpec } from '../../../src/services/policy/pending-catalog.js';
import { t } from '../../../src/i18n/index.js';

// MNE-001-585 (#792, part 2/3) · The panel key plain_receipt_unapply_iva, and
// which rows of a plain receipt's unapply it re-parks: only those whose IVA
// was released in the calendar month of the unapply. Dates by hand.

describe('releaseDayOf', () => {
  const transfer = { paymentDate: '2026-05-15', paymentMethod: 'spei', checkCashedOn: null };

  it.each([
    ['a row with its own day releases on it', '2026-05-25', transfer, '2026-05-25'],
    ['a row written before 332 releases on the receipt\'s date', null, transfer, '2026-05-15'],
    ['a cheque whose IVA waited for the bank releases on the cashing day', null, { ...transfer, paymentMethod: 'check', checkCashedOn: '2026-06-02' }, '2026-06-02'],
    ['a cheque row applied after the cashing releases on its own day', '2026-06-10', { ...transfer, paymentMethod: 'check', checkCashedOn: '2026-06-02' }, '2026-06-10'],
    ['a cheque with no cashing recorded releases nothing yet, so its own day', null, { ...transfer, paymentMethod: 'check' }, '2026-05-15'],
    ['only a cheque waits: a cashing date on a transfer is ignored', null, { ...transfer, checkCashedOn: '2026-06-02' }, '2026-05-15'],
  ] as const)('%s', (_case, appliedOn, receipt, day) => {
    expect(releaseDayOf(appliedOn, receipt)).toBe(day);
  });
});

describe('reparkSameMonth', () => {
  it('re-parks a row released in the month of the unapply: it keeps 0', () => {
    expect(reparkSameMonth(['160.0000'], ['2026-05-15'], '2026-05-20')).toEqual({ kept: ['0.0000'], laterMonth: false });
  });

  it('keeps caused a row released in an earlier month, and says so', () => {
    expect(reparkSameMonth(['160.0000'], ['2026-05-15'], '2026-06-10')).toEqual({ kept: ['160.0000'], laterMonth: true });
  });

  it('decides each row on its own: one unapply can keep one and re-park another', () => {
    expect(reparkSameMonth(['80.0000', '80.0000'], ['2026-05-15', '2026-06-01'], '2026-06-10')).toEqual({
      kept: ['80.0000', '0.0000'], laterMonth: true,
    });
  });

  it('compares calendar months, not 30 days: 05-31 to 06-01 is a later month', () => {
    expect(reparkSameMonth(['160.0000'], ['2026-05-31'], '2026-06-01').laterMonth).toBe(true);
  });

  it('a row that keeps nothing is neither re-parked nor a later month', () => {
    expect(reparkSameMonth(['0.0000'], ['2026-05-15'], '2026-06-10')).toEqual({ kept: ['0.0000'], laterMonth: false });
  });
});

describe('plain_receipt_unapply_iva', () => {
  const spec = getPolicySpec('plain_receipt_unapply_iva');

  it('is a fiscal key that keeps the IVA caused by default, with LIVA arts. 1-B and 7 in its rationale', () => {
    expect(spec?.category).toBe('fiscal');
    expect(spec?.options.map((o) => o.value)).toEqual(['keep_caused', 'repark_same_month']);
    expect(spec?.defaultValue).toBe('keep_caused');
    expect(spec?.defaultRationale).toContain('LIVA art. 1-B');
    expect(spec?.defaultRationale).toContain('LIVA art. 7');
    expect(spec?.defaultRationale).toContain('ADR-0006');
  });

  it('the later-month text names the key and the month, in both languages', () => {
    for (const lang of ['en', 'es'] as const) {
      const text = t('receipt.unapply.iva_kept_later_month', { iva: '160.0000', key: 'plain_receipt_unapply_iva', month: '2026-06' }, lang);
      for (const part of ['160.0000', 'plain_receipt_unapply_iva', '2026-06', 'LIVA art. 1-B']) expect(text).toContain(part);
    }
  });
});
