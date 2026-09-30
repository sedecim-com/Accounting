import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));

import { getPolicySpec, type PolicySpec } from '../../../src/services/policy/policy-service.js';
import { basisLock, investmentBaseFor, taxRateForBasis } from '../../../src/services/assets/depreciation.js';
import { DECISIONS, DEFAULT_THRESHOLDS, PREPAID_THRESHOLD_MXN } from '../../../src/services/xml-ingestion/cfdi-decisions.js';
import type { CfdiFacts } from '../../../src/services/xml-ingestion/cfdi-facts.js';
import type { FixedAsset } from '../../../src/types/index.js';

// ============================================================
// THE PANEL TEXT SAYS WHAT THE CODE DOES (T21b · #301, MNE-001-073)
//
// The accountant answers `init` and `pending` trusting each question's text.
// `every-policy-key-has-reader` (E1.3) checks that SOME reader exists; it does
// not check what the text claims. These tests do: each claim a text makes is
// held against the code that should make it true, so restoring the old texts
// ("never reads it", "BOTH schedules", "with no floor at all") fails here.
// ============================================================

const ROOT = path.resolve(__dirname, '../../..');

function spec(key: string): PolicySpec {
  const s = getPolicySpec(key);
  if (s === undefined) throw new Error(`test precondition: "${key}" must be in POLICY_CATALOG`);
  return s;
}

/** Every `.ts` file under src/ with this basename. */
function sourcesNamed(base: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === base) found.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  return found;
}

/** The source passes this key to a policy reader (getPolicy / getPolicyNumber). */
function readsKey(file: string, key: string): boolean {
  const src = fs.readFileSync(file, 'utf8');
  return new RegExp(`getPolicy(Number)?\\s*\\([^)]{0,80}?['"\`]${key}['"\`]`).test(src);
}

describe('dias_aguinaldo — the text names who reads it, and they do', () => {
  const s = spec('dias_aguinaldo');

  it('does not say that nothing reads it', () => {
    expect(s.impact).not.toMatch(/never reads|hardcodes/i);
  });

  it('names the settlement and the monthly provision as its readers', () => {
    expect(s.impact).toMatch(/finiquito-calculator\.ts/);
    expect(s.impact).toMatch(/provisions-run\.ts/);
  });

  it('every file the text names as a reader reads the key', () => {
    const named = [...s.impact.matchAll(/([a-z0-9-]+\.ts)\b/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThanOrEqual(2);
    for (const base of named) {
      const files = sourcesNamed(base);
      expect(files, `${base} is named by the text but does not exist under src/`).toHaveLength(1);
      expect(readsKey(files[0], 'dias_aguinaldo'), `${base} is named as a reader but never reads the key`).toBe(true);
    }
  });

  it('says the legal floor is enforced, and both readers enforce it', () => {
    expect(s.impact).toMatch(/legal minimum/i);
    for (const base of ['finiquito-calculator.ts', 'provisions-run.ts']) {
      const src = fs.readFileSync(sourcesNamed(base)[0], 'utf8');
      expect(src, `${base} must check the floor it is said to check`).toMatch(/exigirPisoLegal\(\s*'dias_aguinaldo'/);
    }
  });

  it('what it does uses the answer, not a fixed fifteen days', () => {
    expect(s.whatIDo).not.toMatch(/on fifteen days/i);
    expect(s.whatIDo).toMatch(/days you set/i);
  });
});

describe('base_depreciacion — the text promises one schedule and the lock the run enforces', () => {
  const s = spec('base_depreciacion');
  const asset = (over: Partial<FixedAsset>): FixedAsset => ({ tax_rate: null, ...over }) as FixedAsset;

  it('does not promise both schedules', () => {
    expect(s.impact).not.toMatch(/both schedules/i);
    expect(s.impact).toMatch(/only one schedule/i);
  });

  it('says an asset with posted rows is refused on the other basis, which is what basisLock does', () => {
    expect(s.impact).toMatch(/refuses/i);
    expect(basisLock(new Set(['book']), 'tax')).not.toBeNull();
    expect(basisLock(new Set(['tax']), 'book')).not.toBeNull();
    expect(basisLock(new Set(['book']), 'book')).toBeNull();
  });

  it('says an asset without a stored tax rate stays on its useful life, which is what taxRateForBasis does', () => {
    expect(s.impact).toMatch(/without a stored (tax )?rate/i);
    expect(taxRateForBasis(asset({ tax_rate: null }), 'tasa_lisr')).toBeUndefined();
    expect(taxRateForBasis(asset({ tax_rate: '0.35' } as Partial<FixedAsset>), 'tasa_lisr')).toBe('0.35');
  });

  it('says tasa_lisr runs on the original investment (art. 31 LISR), which is what investmentBaseFor does', () => {
    expect(s.impact).toMatch(/original investment with no salvage value subtracted \(art\. 31 LISR\)/);
    expect(investmentBaseFor('tasa_lisr', undefined)).toBe('original_investment');
    expect(investmentBaseFor('vida_util_nif', undefined)).toBe('cost_less_salvage');
  });
});

describe('umbral_anticipado_mxn — the text says where the floor applies today', () => {
  const s = spec('umbral_anticipado_mxn');
  const decision = DECISIONS.find((d) => d.id === 'gasto_vs_anticipado')!;
  const facts = (subtotal: number): CfdiFacts =>
    ({ direction: 'recibido', tipo: 'I', subtotal, conceptosDescripcion: 'Seguro anual de flotilla' }) as CfdiFacts;

  it('does not say the classifier has no floor, because it has one', () => {
    expect(s.impact).not.toMatch(/no floor|any amount/i);
    expect(decision.applies(facts(PREPAID_THRESHOLD_MXN - 0.01), DEFAULT_THRESHOLDS)).toBe(false);
    expect(decision.applies(facts(PREPAID_THRESHOLD_MXN), DEFAULT_THRESHOLDS)).toBe(true);
  });

  it('says `prepaid create` stops below the threshold unless forced, and the prepaid service reads the key', () => {
    expect(s.impact).toMatch(/prepaid create/);
    expect(s.impact).toMatch(/--force/);
    expect(readsKey(path.join(ROOT, 'src/services/accruals/prepaid-service.ts'), 'umbral_anticipado_mxn')).toBe(true);
  });

  it('says whether ingestion uses the answer or the default, matching what pre-registration reads', () => {
    // When pre-registration starts passing the entity's answer to the
    // classifier (MNE-001-045), this flips and the text has to follow.
    const preReg = path.join(ROOT, 'src/services/xml-ingestion/pre-registration-service.ts');
    if (readsKey(preReg, 'umbral_anticipado_mxn')) {
      expect(s.impact).not.toMatch(/not your answer/i);
      expect(s.impact).toMatch(/classifier compares against your answer/i);
    } else {
      expect(s.impact).toMatch(/fixed default of 5,000 MXN, not your answer/i);
    }
  });
});
