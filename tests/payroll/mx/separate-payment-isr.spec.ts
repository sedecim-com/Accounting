import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));

import { isrOfPaycheckInPeriod } from '../../../src/services/payroll/mx/separate-payment-isr.js';
import { getPolicySpec } from '../../../src/services/policy/policy-service.js';

// MNE-001-739 (#601). The figures of the integration spec, worked by hand from
// the 2026 quincenal tariff: the fortnight of 10 000.00 caused 1 204.26; an
// aguinaldo with 6 480.70 taxed gives 541.53 on its own base and, with the
// fortnight, 2 588.54 for the period.
const FORTNIGHT = '1204.26';
const OWN = '541.53';
const PERIOD = '2588.54';

describe('isrOfPaycheckInPeriod, one hand figure per option', () => {
  const args = { separate: true, otherPaychecks: 1, ownBase: OWN, onCombinedBase: PERIOD, alreadyCaused: FORTNIGHT };

  it('period_accumulated_base: 2 588.54 − 1 204.26 = 1 384.28', () => {
    expect(isrOfPaycheckInPeriod({ ...args, treatment: 'period_accumulated_base' }).toFixed(2)).toBe('1384.28');
  });

  it('period_accumulated_base never goes below zero, and with no other paycheck keeps its own base', () => {
    expect(isrOfPaycheckInPeriod({ ...args, treatment: 'period_accumulated_base', alreadyCaused: '3000' }).toFixed(2))
      .toBe('0.00');
    expect(isrOfPaycheckInPeriod({
      ...args, treatment: 'period_accumulated_base', otherPaychecks: 0, onCombinedBase: null, alreadyCaused: 0,
    }).toFixed(2)).toBe(OWN);
  });

  it('own_paycheck_base: 541.53, what the engine withheld before', () => {
    expect(isrOfPaycheckInPeriod({ ...args, treatment: 'own_paycheck_base' }).toFixed(2)).toBe(OWN);
  });

  it('regulation_optional_procedure: the separate paycheck is refused by key; one that is not keeps its own base', () => {
    expect(() => isrOfPaycheckInPeriod({ ...args, treatment: 'regulation_optional_procedure' })).toThrow(
      expect.objectContaining({
        messageKey: {
          key: 'payroll.separate_payment_isr.regulation_procedure_not_in_corpus',
          params: { key: 'separate_payment_isr' },
        },
      })
    );
    expect(isrOfPaycheckInPeriod({ ...args, treatment: 'regulation_optional_procedure', separate: false }).toFixed(2))
      .toBe(OWN);
  });

  it('the catalogue offers the three options, and the default is the accumulated base', () => {
    const spec = getPolicySpec('separate_payment_isr');
    expect(spec?.options.map((o) => o.value)).toEqual([
      'period_accumulated_base', 'regulation_optional_procedure', 'own_paycheck_base',
    ]);
    expect(spec?.defaultValue).toBe('period_accumulated_base');
  });
});
