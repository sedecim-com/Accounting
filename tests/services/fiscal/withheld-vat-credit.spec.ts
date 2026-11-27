import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));

import { checkedRemittance, splitWithheld } from '../../../src/services/fiscal/withheld-vat-credit.js';
import { desgloseCero, ivaDelDesglose, type Desglose } from '../../../src/services/sat/diot/index.js';
import { ValidationError } from '../../../src/utils/errors.js';

// ============================================================
// MNE-001-909 (#1075) · THE WITHHELD PART OF A PAID BILL'S IVA, BY HAND
//
// `splitWithheld` takes the IVA withheld to the vendor out of what a month
// paid, by rate; `checkedRemittance` is the door of a person's statement.
// ============================================================

const split = (boxes: Partial<Record<'tasa16' | 'tasa8', [string, string]>>): Desglose => {
  const d = desgloseCero();
  for (const [k, [base, iva]] of Object.entries(boxes) as Array<['tasa16' | 'tasa8', [string, string]]>) d[k] = { base, iva };
  return d;
};
const ivas = (d: Desglose): string[] => [d.tasa16.iva, d.tasa8.iva];

describe('splitWithheld', () => {
  it('fees of 10,000.00 + 1,600.00 with 1,066.67 withheld: 533.33 paid to the vendor, and the base stays with the payment', () => {
    const r = splitWithheld({ ivaPagado: '1600.0000', ivaRetenido: '1066.6700' }, split({ tasa16: ['10000.0000', '1600.0000'] }));
    expect([r.paid.tasa16, r.withheld.tasa16]).toEqual([{ base: '10000.0000', iva: '533.3300' }, { base: '0.0000', iva: '1066.6700' }]);
  });

  it('two rates share the withheld IVA in the proportion of their IVA, and the two parts add up to the cent', () => {
    // 1,200.00 at 16 % and 400.00 at 8 %, half withheld: 600.00 and 200.00.
    const even = splitWithheld({ ivaPagado: '1600.0000', ivaRetenido: '800.0000' }, split({ tasa16: ['7500.0000', '1200.0000'], tasa8: ['5000.0000', '400.0000'] }));
    expect([ivas(even.paid), ivas(even.withheld)]).toEqual([['600.0000', '200.0000'], ['600.0000', '200.0000']]);
    // 100.00 and 0.01 with 33.33 withheld: 100 × 33.33 / 100.01 = 33.3267 and 0.01 × 33.33 / 100.01 = 0.0033.
    const odd = splitWithheld({ ivaPagado: '100.0100', ivaRetenido: '33.3300' }, split({ tasa16: ['625.0000', '100.0000'], tasa8: ['0.1250', '0.0100'] }));
    expect([ivas(odd.withheld), ivas(odd.paid)]).toEqual([['33.3267', '0.0033'], ['66.6733', '0.0067']]);
    expect([ivaDelDesglose(odd.withheld), ivaDelDesglose(odd.paid)]).toEqual(['33.3300', '66.6800']);
  });

  it('never holds back more than the month counted, and nothing of an undo', () => {
    const whole = split({ tasa16: ['10000.0000', '600.0000'] });
    expect(ivas(splitWithheld({ ivaPagado: '600.0000', ivaRetenido: '1066.6700' }, whole).paid)).toEqual(['0.0000', '0.0000']);
    const legacy = split({ tasa16: ['10000.0000', '0.0000'] });
    expect(splitWithheld({ ivaPagado: '0.0000', ivaRetenido: '1066.6700' }, legacy).paid).toBe(legacy);
    const undo = split({ tasa16: ['-10000.0000', '-1600.0000'] });
    const r = splitWithheld({ ivaPagado: '-1600.0000', ivaRetenido: '-1066.6700' }, undo);
    expect([r.paid, ivaDelDesglose(r.withheld)]).toEqual([undo, '0.0000']);
  });
});

describe('checkedRemittance', () => {
  const key = (run: () => unknown): string => {
    try { run(); } catch (e) { return e instanceof ValidationError ? e.messageKey?.key ?? '' : String(e); }
    return 'accepted';
  };
  const MARCH = { year: 2026, month: 3 };
  const A = { acknowledgement: 'A' };

  it('takes the month before the paper\'s, trimmed and as typed; December for January\'s paper; repeated, it is one statement', () => {
    expect(checkedRemittance([{ period: ' 2026-02 ', acknowledgement: ' acuse 1/x ' }], MARCH, 'after_remittance'))
      .toEqual({ period: '2026-02', acknowledgement: 'acuse 1/x' });
    expect(checkedRemittance([{ period: '2026-12', ...A }], { year: 2027, month: 1 }, 'after_remittance')).toEqual({ period: '2026-12', ...A });
    expect(checkedRemittance([{ period: '2026-02', ...A }, { period: '2026-02', ...A }], MARCH, 'after_remittance')).toEqual({ period: '2026-02', ...A });
    expect([checkedRemittance(undefined, MARCH, 'payment_month'), checkedRemittance([], MARCH, 'after_remittance')]).toEqual([null, null]);
  });

  it('refuses any other month, naming the paper it belongs on; a blank acuse; two acuses; and any statement under payment_month', () => {
    const OTHER = 'filing.workpaper.withheld_vat.remittance_other_month';
    for (const period of ['2026-01', '2026-03', '2026-04', '2025-02']) {
      expect(key(() => checkedRemittance([{ period, ...A }], MARCH, 'after_remittance')), period).toBe(OTHER);
    }
    try {
      checkedRemittance([{ period: '2025-12', ...A }], MARCH, 'after_remittance');
    } catch (e) {
      expect((e as ValidationError).messageKey?.params).toEqual({ period: '2025-12', belongs: '2026-01', month: '2026-03', before: '2026-02' });
    }
    const INVALID = 'filing.workpaper.withheld_vat.remittance_invalid';
    expect(key(() => checkedRemittance([{ period: '2026-02', acknowledgement: '' }], MARCH, 'after_remittance'))).toBe(INVALID);
    expect(key(() => checkedRemittance([{ period: '2026-13', ...A }], MARCH, 'after_remittance'))).toBe(INVALID);
    expect(key(() => checkedRemittance([{ period: '2026-02', ...A }, { period: '2026-02', acknowledgement: 'B' }], MARCH, 'after_remittance'))).toBe(INVALID);
    expect(key(() => checkedRemittance([{ period: '2026-02', ...A }], MARCH, 'payment_month'))).toBe('filing.workpaper.withheld_vat.remittance_not_asked');
  });
});
