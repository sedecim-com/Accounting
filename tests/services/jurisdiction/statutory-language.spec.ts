import { describe, it, expect } from 'vitest';
import { JURISDICTIONS, type JurisdictionCode } from '../../../src/services/jurisdiction/jurisdiction.js';
import { LOCALES } from '../../../src/i18n/locale.js';

describe('JURISDICTIONS.statutoryLanguage', () => {
  it('declares es-MX for MX and en-US for US', () => {
    expect(JURISDICTIONS.MX.statutoryLanguage).toBe('es-MX');
    expect(JURISDICTIONS.US.statutoryLanguage).toBe('en-US');
  });

  it('covers exactly the supported fiscal authorities, each with a supported locale', () => {
    const codes: JurisdictionCode[] = ['MX', 'US'];
    expect(Object.keys(JURISDICTIONS).sort()).toEqual(codes);
    for (const code of codes) {
      expect(LOCALES).toContain(JURISDICTIONS[code].statutoryLanguage);
    }
  });

  it('is frozen, table and every entry, so a consumer cannot rewrite a package', () => {
    expect(Object.isFrozen(JURISDICTIONS)).toBe(true);
    expect(Object.isFrozen(JURISDICTIONS.MX)).toBe(true);
    expect(Object.isFrozen(JURISDICTIONS.US)).toBe(true);
  });

  it('rejects reassigning a language both at compile time and at run time', () => {
    expect(() => {
      // @ts-expect-error statutoryLanguage is readonly
      JURISDICTIONS.US.statutoryLanguage = 'es-MX';
    }).toThrow(TypeError);
    expect(JURISDICTIONS.US.statutoryLanguage).toBe('en-US');
  });
});
