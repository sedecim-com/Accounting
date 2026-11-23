import { describe, expect, it } from 'vitest';
import { getPolicySpec } from '../../../src/services/policy/pending-catalog.js';
import { ES } from '../../../src/i18n/es.js';
import { EN } from '../../../src/i18n/en.js';

// MNE-001-599 · #831, part 2 of 2: where the correction of the VAT an
// early-payment discount left in 1135 before migration 341 is dated.

describe('discount_vat_correction_period', () => {
  const spec = getPolicySpec('discount_vat_correction_period');

  it('offers asking, the current period and each discount\'s month, and asks by default', () => {
    expect(spec?.options.map((o) => o.value)).toEqual(['ask', 'current_period', 'payment_month']);
    expect(spec?.defaultValue).toBe('ask');
    expect(spec?.category).toBe('contable');
  });

  it('its default rationale names its sources, and says the VAT declared does not change', () => {
    for (const source of ['LIVA art. 7', 'LISR', 'NIF B-1', 'ADR-0006']) {
      expect(spec?.defaultRationale).toContain(source);
    }
    expect(spec?.impact).toContain('npm run correct:discount-vat');
  });

  it('speaks both languages', () => {
    for (const dict of [ES, EN] as Array<Record<string, string>>) {
      for (const part of ['question', 'impact', 'rationale', 'why', 'what', 'if_skipped', 'option.ask', 'option.current_period', 'option.payment_month']) {
        expect(dict[`policy.discount_vat_correction_period.${part}`], part).toBeTruthy();
      }
    }
  });
});
