import { describe, it, expect } from 'vitest';
import {
  JURISDICTIONS,
  keepsMexicanBooks,
  statutoryLanguageOf,
  type JurisdictionCode,
} from '../../../src/services/jurisdiction/jurisdiction.js';
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

  it('is frozen so a consumer cannot rewrite a package', () => {
    expect(Object.isFrozen(JURISDICTIONS)).toBe(true);
    expect(Object.isFrozen(JURISDICTIONS.MX)).toBe(true);
  });
});

describe('statutoryLanguageOf', () => {
  it('follows the fiscal authority when the entity does not keep Mexican books', () => {
    expect(statutoryLanguageOf({ incorporation_country: 'US', accounting_standard: 'us_gaap' })).toBe('en-US');
    expect(statutoryLanguageOf({ incorporation_country: 'US', accounting_standard: 'ifrs' })).toBe('en-US');
    expect(statutoryLanguageOf({ incorporation_country: 'MX', accounting_standard: 'us_gaap' })).toBe('es-MX');
  });

  it('gives a US entity on mx_nif es-MX, because it is seeded the Spanish SAT stratum', () => {
    expect(statutoryLanguageOf({ incorporation_country: 'US', accounting_standard: 'mx_nif' })).toBe('es-MX');
  });

  it('defaults to es-MX when the country is absent or not modelled (house rule)', () => {
    expect(statutoryLanguageOf({})).toBe('es-MX');
    expect(statutoryLanguageOf({ incorporation_country: 'CA' })).toBe('es-MX');
  });

  it('accepts the USA alias like jurisdictionOf', () => {
    expect(statutoryLanguageOf({ incorporation_country: 'usa' })).toBe('en-US');
  });

  it('cannot disagree with the predicate that selects the chart stratum', () => {
    const countries = [undefined, null, '', '  ', 'MX', 'mx', 'US', 'usa', 'CA', 'DE'];
    const standards = [undefined, null, 'mx_nif', 'us_gaap', 'ifrs'];
    for (const incorporation_country of countries) {
      for (const accounting_standard of standards) {
        const e = { incorporation_country, accounting_standard };
        if (keepsMexicanBooks(incorporation_country, accounting_standard)) {
          // SAT stratum (Spanish names) => Spanish statutory language.
          expect(statutoryLanguageOf(e), JSON.stringify(e)).toBe('es-MX');
        }
      }
    }
  });
});
