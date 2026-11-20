import { describe, expect, it } from 'vitest';
import { cancelsUncausedIva } from '../../../src/services/payments/customer-advance.js';
import { getPolicySpec } from '../../../src/services/policy/pending-catalog.js';
import { t } from '../../../src/i18n/index.js';

// MNE-001-572 (#789, part 1/2) · Which application of a held cheque's advance
// would cancel IVA nobody has caused (LIVA art. 1-B, second paragraph), and
// the panel key that governs it. By hand: an advance of 1,160.00 at 16 %,
// whose cash takes 160.00 of IVA.

const at16 = { treatment: '16' as const, assumed: null };

describe('cancelsUncausedIva', () => {
  const held = { held: true, iva: '160.0000', ppd: false, sale: at16, receipt: '16' as const };

  it.each([
    ['a PPD invoice', { ppd: true, sale: null }, true],
    ['a PUE invoice at the receipt\'s own single treatment', {}, false],
    ['a PUE invoice at another treatment', { sale: { treatment: '0' as const, assumed: null } }, true],
    ['a PUE invoice with several treatments', { sale: { treatment: '16' as const, assumed: 'highest' } }, true],
    ['a PUE invoice with no treatment to read', { sale: null }, true],
    ['cash that takes no IVA from the advance (c = 0)', { ppd: true, iva: '0.0000' }, false],
    ['a receipt with no treatment, which takes no advance', { ppd: true, iva: '0', receipt: null }, false],
    ['a cheque already cashed', { ppd: true, held: false }, false],
  ] as const)('%s → %s', (_case, over, refused) => {
    expect(cancelsUncausedIva({ ...held, ...over })).toBe(refused);
  });
});

describe('cheque_advance_before_cashing', () => {
  const spec = getPolicySpec('cheque_advance_before_cashing');

  it('is a fiscal key that refuses by default, and declares the deferral', () => {
    expect(spec?.category).toBe('fiscal');
    expect(spec?.options.map((o) => o.value)).toEqual(['refuse', 'defer_to_cashing']);
    expect(spec?.defaultValue).toBe('refuse');
    expect(spec?.defaultRationale).toContain('LIVA art. 1-B, second paragraph');
    // MNE-001-573: the deferral is built for a PPD invoice, and a PUE one at another treatment stays refused.
    expect(spec?.whatIDo).toContain('PPD invoice');
    expect(spec?.whatIDo).not.toContain('not built');
  });

  it('its refusals name the cashing command and the key, in both languages', () => {
    const params = { receipt: 'PMT-2026-00001', invoice: 'INV-2026-00001', iva: '160.00', key: 'cheque_advance_before_cashing' };
    for (const lang of ['en', 'es'] as const) {
      const refused = t('receipt.apply.cheque_advance_not_cashed', params, lang);
      expect(refused).toContain('mnemosine bank check reconcile --receipt PMT-2026-00001');
      expect(refused).toContain('cheque_advance_before_cashing');
      const deferral = t('receipt.apply.cheque_advance_deferral_ppd_only', params, lang);
      expect(deferral).toContain('defer_to_cashing');
      expect(deferral).toContain('mnemosine bank check reconcile --receipt PMT-2026-00001');
    }
  });
});
