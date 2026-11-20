import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPolicySpec } from '../../../src/services/policy/pending-catalog.js';

// MNE-001-374 · #194: the two readings of the last ordinary monthly salary
// (USMO) that the separation ISR of LISR art. 96, last paragraph, is built on.
// Decided by the owner in MNE-001-373 (#194, comment 6994641593).

const CALCULATOR = path.resolve(__dirname, '../../../src/services/payroll/mx/finiquito-calculator.ts');

/** The calculator declares the key in a constant and passes that constant to getPolicy. */
function calculatorReads(key: string): boolean {
  const src = fs.readFileSync(CALCULATOR, 'utf8');
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
    expect(spec?.defaultRationale).toContain('RLISR art. 174');
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
