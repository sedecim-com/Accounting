import { describe, expect, it } from 'vitest';
import { POLICY_CATALOG } from '../../../src/services/policy/pending-catalog.js';
import {
  optionKeySegment,
  optionSegmentCollisions,
  policyOptionKey,
} from '../../../src/services/policy/policy-text-key.js';
import { entriesOf, headOf } from '../../../src/language/vocabulary-registry.js';
import { CRITERIOS, conFuenteMutada, crudoDe } from '../../../src/plan/criterios.js';

// I10 · #152, part 0 (MNE-001-122): the key schema of the policy panel.

describe('optionKeySegment', () => {
  it('turns a dotted value into one segment, as the owner decided (option.0_25)', () => {
    expect(optionKeySegment('0.25')).toBe('0_25');
    expect(policyOptionKey('vacation_premium_pct', '0.25')).toBe('policy.vacation_premium_pct.option.0_25');
  });

  it('turns an IANA zone into a lower snake segment', () => {
    expect(optionKeySegment('America/Mexico_City')).toBe('america_mexico_city');
  });

  it('keeps a plain snake value as it is', () => {
    expect(optionKeySegment('exigir_misma_seccion')).toBe('exigir_misma_seccion');
  });
});

describe('optionSegmentCollisions', () => {
  it('names two values that would share one key', () => {
    expect(optionSegmentCollisions(['0.25', '0_25', '0.50'])).toEqual(['0.25 / 0_25 → 0_25']);
  });

  it('no two option values of one policy in the catalog share a key', () => {
    const found = POLICY_CATALOG.flatMap((s) =>
      optionSegmentCollisions(s.options.map((o) => o.value)).map((c) => `${s.key}: ${c}`)
    );
    expect(found).toEqual([]);
  });
});

describe('textKey', () => {
  it('every policy has the English name the registry decided (en ?? es), and no two share it', () => {
    const decided = new Map(entriesOf('policy-key').map((e) => [headOf(e.where), e.en ?? e.es]));
    const wrong = POLICY_CATALOG.filter((s) => decided.get(s.key) !== s.textKey).map(
      (s) => `${s.key}: ${s.textKey} ≠ ${decided.get(s.key)}`
    );
    expect(wrong).toEqual([]);
    expect(new Set(POLICY_CATALOG.map((s) => s.textKey)).size).toBe(POLICY_CATALOG.length);
  });

  it('every option value of the catalog is in the registry', () => {
    const registered = new Set(entriesOf('policy-value').map((e) => `${headOf(e.where).split('/')[0]}/${e.es}`));
    const missing = POLICY_CATALOG.flatMap((s) => s.options.map((o) => `${s.key}/${o.value}`)).filter(
      (w) => !registered.has(w)
    );
    expect(missing).toEqual([]);
  });
});

describe('criterion policy-text-key-matches-vocabulary-registry', () => {
  const criterion = CRITERIOS.find((c) => c.id === 'policy-text-key-matches-vocabulary-registry')!;
  const catalog = 'src/services/policy/pending-catalog.ts';

  it('is green on the tree', async () => {
    expect((await criterion.evaluar()).estado).toBe('ok');
  });

  it('goes red when two option values of one policy would share a key', async () => {
    const src = crudoDe(catalog);
    const mutated = src.replace("value: '0.50'", "value: '0_25'");
    expect(mutated).not.toBe(src);
    const r = await conFuenteMutada({ [catalog]: mutated }, () => criterion.evaluar());
    expect(r.estado).toBe('falla');
    expect(r.detalle).toContain('prima_vacacional_pct: options share a key (0.25 / 0_25 → 0_25)');
  });

  it('goes red when a policy loses its textKey', async () => {
    const src = crudoDe(catalog);
    const mutated = src.replace("    textKey: 'benefit_accrual_wage_base',\n", '');
    expect(mutated).not.toBe(src);
    const r = await conFuenteMutada({ [catalog]: mutated }, () => criterion.evaluar());
    expect(r.estado).toBe('falla');
    expect(r.detalle).toContain('provision_base_salarial declares no textKey');
  });
});
