import { describe, expect, it } from 'vitest';
import { getPolicySpec } from '../../../src/services/policy/pending-catalog.js';

// MNE-001-562 · #725, part 2 of 2: where the correction of the VAT released
// above a CFDI's VAT is dated.

describe('vat_overcredit_correction_period', () => {
  const spec = getPolicySpec('vat_overcredit_correction_period');

  it('offers asking, the current period and each payment\'s month, and asks by default', () => {
    expect(spec?.options.map((o) => o.value)).toEqual(['ask', 'current_period', 'payment_month']);
    expect(spec?.defaultValue).toBe('ask');
    expect(spec?.category).toBe('contable');
  });

  it('its default rationale names its sources', () => {
    for (const source of ['LIVA art. 5', 'CFF art. 32', 'NIF B-1', 'ADR-0006']) {
      expect(spec?.defaultRationale).toContain(source);
    }
  });
});
