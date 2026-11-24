import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPolicySpec } from '../../../src/services/policy/pending-catalog.js';

// MNE-001-374 · #194: the two readings of the last ordinary monthly salary
// (USMO) that the separation ISR of LISR art. 96 is built on (the paragraph on
// the payments of art. 95, third from the end; not its last paragraph).
// Decided by the owner in MNE-001-373 (#194, comment 6994641593).

const CALCULATOR = path.resolve(__dirname, '../../../src/services/payroll/mx/finiquito-calculator.ts');
const SEPARATION = path.resolve(__dirname, '../../../src/services/payroll/mx/separation-isr.ts');

/** The calculator declares the key in a constant and passes that constant to getPolicy. */
function calculatorReads(key: string, file = CALCULATOR): boolean {
  const src = fs.readFileSync(file, 'utf8');
  const decl = new RegExp(`const\\s+([A-Z_]+)\\s*=\\s*'${key}'`).exec(src);
  return decl !== null && new RegExp(`getPolicy\\s*\\([^)]{0,80}?\\b${decl[1]}\\b`).test(src);
}

describe('usmo_isr_subsidy', () => {
  const spec = getPolicySpec('usmo_isr_subsidy');

  it('offers gross of the tariff and net of the subsidy, gross by default', () => {
    expect(spec?.options.map((o) => o.value)).toEqual(['gross_of_tariff', 'net_of_subsidy']);
    expect(spec?.defaultValue).toBe('gross_of_tariff');
  });

  it('its default rationale names its sources', () => {
    expect(spec?.defaultRationale).toContain('LISR art. 96');
    // MNE-001-579: the separation article of the Regulation is 172. Art. 174
    // is the optional withholding on the aguinaldo and the premiums.
    expect(spec?.defaultRationale).toContain('RLISR art. 172');
    expect(spec?.defaultRationale).not.toContain('174');
    expect(spec?.defaultRationale).toContain('ADR-0006');
  });

  it('names the settlement as its reader, and the settlement reads it', () => {
    expect(spec?.impact).toContain('finiquito-calculator.ts');
    expect(calculatorReads('usmo_isr_subsidy')).toBe(true);
  });
});

describe('usmo_days_per_month', () => {
  const spec = getPolicySpec('usmo_days_per_month');

  it('offers 30 and 30.4 days, 30 by default', () => {
    expect(spec?.options.map((o) => o.value)).toEqual(['30', '30.4']);
    expect(spec?.defaultValue).toBe('30');
  });

  it('its default rationale names its sources', () => {
    expect(spec?.defaultRationale).toContain('LFT art. 89');
    expect(spec?.defaultRationale).toContain('LISR art. 96');
    expect(spec?.defaultRationale).toContain('ADR-0006');
  });

  it('names the settlement as its reader, and the settlement reads it', () => {
    expect(spec?.impact).toContain('finiquito-calculator.ts');
    expect(calculatorReads('usmo_days_per_month')).toBe(true);
  });
});

describe('the texts of the two USMO keys say what the code does now (MNE-001-579)', () => {
  for (const key of ['usmo_isr_subsidy', 'usmo_days_per_month']) {
    const spec = getPolicySpec(key);
    it(`${key}: no longer «nothing is withheld yet», nor «last paragraph»`, () => {
      const prose = [spec?.impact, spec?.defaultRationale, spec?.whatIDo].join(' ');
      expect(prose).not.toMatch(/withheld yet|not in place yet|MNE-001-375/);
      expect(prose).not.toMatch(/last paragraph/);
      expect(prose).toMatch(/payments of art\. 95/);
    });
  }
});

describe('separation_isr_usmo_comparison (MNE-001-579)', () => {
  const spec = getPolicySpec('separation_isr_usmo_comparison');

  it('offers the total paid and the taxable part, the total by default', () => {
    expect(spec?.options.map((o) => o.value)).toEqual(['total_payments', 'taxable_payments']);
    expect(spec?.defaultValue).toBe('total_payments');
  });

  it('its default rationale names its sources and says why it is the conservative one', () => {
    expect(spec?.defaultRationale).toContain('LISR art. 96');
    expect(spec?.defaultRationale).toContain('RLISR art. 172');
    expect(spec?.defaultRationale).toContain('ADR-0006');
    expect(spec?.defaultRationale).toMatch(/never withholds less/);
  });

  it('names the separation ISR as its reader, and it reads it', () => {
    expect(spec?.impact).toContain('separation-isr.ts');
    expect(calculatorReads('separation_isr_usmo_comparison', SEPARATION)).toBe(true);
  });
});
