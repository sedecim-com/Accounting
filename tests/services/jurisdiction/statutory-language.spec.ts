import { describe, it, expect } from 'vitest';
import {
  JURISDICTIONS,
  statutoryLanguageOf,
  type JurisdictionCode,
} from '../../../src/services/jurisdiction/jurisdiction.js';

describe('JURISDICTIONS.statutoryLanguage', () => {
  it('declares es-MX for MX and en-US for US', () => {
    expect(JURISDICTIONS.MX.statutoryLanguage).toBe('es-MX');
    expect(JURISDICTIONS.US.statutoryLanguage).toBe('en-US');
  });

  it('covers exactly the supported fiscal authorities, each with a BCP 47 tag', () => {
    const codes: JurisdictionCode[] = ['MX', 'US'];
    expect(Object.keys(JURISDICTIONS).sort()).toEqual(codes);
    for (const code of codes) {
      expect(JURISDICTIONS[code].statutoryLanguage).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });

  it('is frozen so a consumer cannot rewrite a package', () => {
    expect(Object.isFrozen(JURISDICTIONS)).toBe(true);
    expect(Object.isFrozen(JURISDICTIONS.MX)).toBe(true);
  });
});

describe('statutoryLanguageOf', () => {
  it('follows the fiscal authority, not the accounting norm', () => {
    expect(statutoryLanguageOf({ incorporation_country: 'MX', accounting_standard: 'us_gaap' })).toBe('es-MX');
    expect(statutoryLanguageOf({ incorporation_country: 'US', accounting_standard: 'mx_nif' })).toBe('en-US');
  });

  it('defaults to es-MX when the country is absent or not modelled (house rule)', () => {
    expect(statutoryLanguageOf({})).toBe('es-MX');
    expect(statutoryLanguageOf({ incorporation_country: 'CA' })).toBe('es-MX');
  });

  it('accepts the USA alias like jurisdictionOf', () => {
    expect(statutoryLanguageOf({ incorporation_country: 'usa' })).toBe('en-US');
  });
});
