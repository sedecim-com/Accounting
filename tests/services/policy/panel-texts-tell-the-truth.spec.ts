import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));

import { getPolicySpec, type PolicySpec } from '../../../src/services/policy/policy-service.js';
import { basisLock, investmentBaseFor, taxRateForBasis } from '../../../src/services/assets/depreciation.js';
import { DECISIONS, DEFAULT_THRESHOLDS, PREPAID_THRESHOLD_MXN } from '../../../src/services/xml-ingestion/cfdi-decisions.js';
import type { CfdiFacts } from '../../../src/services/xml-ingestion/cfdi-facts.js';
import type { FixedAsset } from '../../../src/types/index.js';
import { DepreciationMethod } from '../../../src/types/index.js';
import { effectiveInvestmentBase } from '../../../src/services/assets/depreciation-math.js';
import { REQUIRED_ACCOUNTS, ROLE_MAP } from '../../../src/services/xml-ingestion/account-roles-seed.js';
import { CATALOGO_UNIVERSAL } from '../../../src/services/accounting/chart-seed.js';
import { t } from '../../../src/i18n/index.js';
import { yearMonthsSealedBox, yearSealNeedsSealedMonths } from '../../../src/services/accounting/period-close.js';

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

  it('says a rate-less asset runs on its life on cost less salvage, which is what effectiveInvestmentBase does', () => {
    expect(s.impact).toMatch(/without a stored tax rate .* useful life, on cost less the salvage value, under either answer/);
    const rateless = {
      acquisition_cost: '100000',
      salvage_value: '10000',
      useful_life_months: 60,
      depreciation_start_date: new Date(2026, 0, 1),
      method: DepreciationMethod.STRAIGHT_LINE,
      investment_base: investmentBaseFor('tasa_lisr', undefined),
    };
    expect(effectiveInvestmentBase(rateless)).toBe('cost_less_salvage');
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

// MNE-001-632 (#692). The rationale cited NIF B-3 and nobody had read it; the
// corpus carries no text of that standard. It now leans on the seeded chart.
describe('received_credit_note_cost — the default rationale leans on the chart, and the chart says so', () => {
  const s = spec('received_credit_note_cost');
  const STANDARD = /\b(NIF|NIIF|IFRS|IAS|NIC)\b/;

  it('cites no accounting standard, in either language', () => {
    expect(s.defaultRationale).not.toMatch(STANDARD);
    expect(s.defaultRationale).toBe(t('policy.received_credit_note_cost.rationale', {}, 'en'));
    expect(t('policy.received_credit_note_cost.rationale', {}, 'es')).not.toMatch(STANDARD);
  });

  it('says 5200 belongs to cost of sales, which is where the seed puts purchase returns', () => {
    expect(s.defaultRationale).toMatch(/5200 belongs to cost of sales/);
    expect(ROLE_MAP.devolucion_compras).toBe('5200');
    expect(REQUIRED_ACCOUNTS.find((a) => a.code === '5200')?.fs_category).toBe('cogs');
  });

  it('says an expense goes by default to 6100, operating expenses, which is where the seed puts the expense role', () => {
    expect(s.defaultRationale).toMatch(/goes to by default \(6100\) to operating expenses/);
    expect(ROLE_MAP.gasto).toBe('6100');
    expect(CATALOGO_UNIVERSAL.find((a) => a.code === '6100')?.fs).toBe('operating_expenses');
  });
});

describe('year_seal_with_unsealed_months — the text says what the seal does, and cites only what the corpus carries', () => {
  const s = spec('year_seal_with_unsealed_months');
  const december = [{ period_name: 'December 2025', status: 'soft_close' }];
  const corpus = (file: string): string => fs.readFileSync(path.join(ROOT, 'src/ai/docs', file), 'utf8');

  it('the close reads the key, and the default is the answer that refuses', () => {
    expect(readsKey(path.join(ROOT, 'src/services/accounting/period-close.ts'), 'year_seal_with_unsealed_months')).toBe(true);
    expect(s.defaultValue).toBe('require_hard_close');
    expect(yearSealNeedsSealedMonths(s.defaultValue)).toBe(true);
    expect(s.options.map((o) => o.value)).toEqual(['require_hard_close', 'accept_unsealed']);
  });

  it('says the default refuses the seal and not the soft close of the last period, which is what the box does', () => {
    expect(s.impact).toMatch(/that seal is refused while another period of the year is in soft close, open or future/);
    expect(s.impact).toMatch(/the soft close of the last period is not stopped/);
    expect(yearMonthsSealedBox(december, 'require_hard_close', 'soft_close').severity).toBe('blocking');
    expect(yearMonthsSealedBox(december, 'require_hard_close', 'open').severity).toBe('warning');
  });

  it('says accept_unsealed seals and the checklist warns and names them, which is what the box does', () => {
    expect(s.impact).toMatch(/With "accept_unsealed" the year is sealed over them, and the close checklist warns and names them \(box year-months-sealed\)/);
    const box = yearMonthsSealedBox(december, 'accept_unsealed', 'soft_close');
    expect(box.codigo).toBe('year-months-sealed');
    expect(box.severity).toBe('warning');
    expect(box.details).toContain('December 2025 (soft_close)');
  });

  it('cites NIF A-1 chapter 20 and NIF B-1 for what the corpus says of them', () => {
    expect(s.defaultRationale).toMatch(/costs and expenses belong to the period of the revenue they produce \(NIF A-1, chapter 20\)/);
    expect(corpus('nif-marco.md')).toMatch(/Los costos se reconocen en\s+el mismo periodo que los ingresos que generan/);
    expect(s.defaultRationale).toMatch(/NIF B-1 corrects an error of a closed fiscal year with an adjusting entry in the current period against retained earnings, without reopening it/);
    expect(corpus('nif-registro.md')).toMatch(/Error de un ejercicio YA CERRADO\*\*: no se reabre ni se borra nada/);
  });

  it('says that no paragraph is cited for the order of the closes, and names no other norm', () => {
    expect(s.defaultRationale).toMatch(/No paragraph of the standards this system carries rules on the order between the monthly closes and the annual one, so none is cited for it/);
    expect(s.defaultRationale).toMatch(/ADR-0006, decision 1/);
    const norms = (text: string): string[] =>
      [...new Set([...text.matchAll(/\b(NIF [A-E]-\d+|NIIF|IFRS|CFF|LISR|LIVA|RMF|LGSM)\b/g)].map((m) => m[1]))].sort();
    expect(norms(s.defaultRationale)).toEqual(['NIF A-1', 'NIF B-1']);
    const spanish = t('policy.year_seal_with_unsealed_months.rationale', {}, 'es');
    expect(s.defaultRationale).toBe(t('policy.year_seal_with_unsealed_months.rationale', {}, 'en'));
    expect(spanish).toMatch(/para eso no se cita ninguno/);
    expect(norms(spanish)).toEqual(['NIF A-1', 'NIF B-1']);
  });
});

// MNE-001-739 (#601). The ISR of a paycheck paid apart. The text names its
// reader, says what each option does, and cites the regulation only to say
// its text is not in this system.
describe('separate_payment_isr — the text says what the reader does, and cites only what the repository carries', () => {
  const s = spec('separate_payment_isr');
  const research = fs.readFileSync(
    path.join(ROOT, 'docs/investigacion/2026-09-06-normas-y-motores/normas/fiscal-mx.md'), 'utf8'
  );

  it('names separate-payment-isr.ts as its reader, and that file reads the key', () => {
    expect(s.impact).toMatch(/Read by separate-payment-isr\.ts/);
    const file = sourcesNamed('separate-payment-isr.ts');
    expect(file).toHaveLength(1);
    const src = fs.readFileSync(file[0], 'utf8');
    expect(src).toMatch(/SEPARATE_PAYMENT_ISR_POLICY = 'separate_payment_isr'/);
    expect(src).toMatch(/getPolicy\(ctx, SEPARATE_PAYMENT_ISR_POLICY/);
  });

  it('the default is the accumulated base, and the text says it never withholds less than the paycheck alone', async () => {
    const { isrOfPaycheckInPeriod } = await import('../../../src/services/payroll/mx/separate-payment-isr.js');
    expect(s.defaultValue).toBe('period_accumulated_base');
    expect(s.defaultRationale).toMatch(/never withholds less than the tariffs of each paycheck alone/);
    const args = { separate: true, otherPaychecks: 1, ownBase: '541.53', onCombinedBase: '2588.54', alreadyCaused: '1204.26' };
    expect(isrOfPaycheckInPeriod({ ...args, treatment: 'period_accumulated_base' }).toFixed(2)).toBe('1384.28');
    expect(isrOfPaycheckInPeriod({ ...args, treatment: 'own_paycheck_base' }).toFixed(2)).toBe('541.53');
  });

  it('says the regulation\'s option is refused because its text is not here, which the research note confirms', async () => {
    const { isrOfPaycheckInPeriod } = await import('../../../src/services/payroll/mx/separate-payment-isr.js');
    expect(s.impact).toMatch(/"regulation_optional_procedure" is refused/);
    expect(s.defaultRationale).toMatch(/RLISR art\. 174\) is not compared, because this system does not carry its text/);
    expect(research).toMatch(/El RLISR \(art\. 174, retención opcional de aguinaldo\/PTU; art\. 177\) .* no se abrieron/);
    expect(() => isrOfPaycheckInPeriod({
      treatment: 'regulation_optional_procedure', separate: true, otherPaychecks: 0,
      ownBase: 1, onCombinedBase: null, alreadyCaused: 0,
    })).toThrow();
  });

  it('cites the same norms in English and in Spanish, and no other', () => {
    const norms = (text: string): string[] =>
      [...new Set([...text.matchAll(/\b(LISR|RLISR|CFF|LFT|LSS|RMF|NIF [A-E]-\d+)\b/g)].map((m) => m[1]))].sort();
    expect(s.defaultRationale).toBe(t('policy.separate_payment_isr.rationale', {}, 'en'));
    expect(norms(s.defaultRationale)).toEqual(['LISR', 'RLISR']);
    expect(norms(t('policy.separate_payment_isr.rationale', {}, 'es'))).toEqual(['LISR', 'RLISR']);
  });
});
