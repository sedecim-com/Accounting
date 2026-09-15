import { describe, expect, it } from 'vitest';
import { POLICY_CATALOG, getPolicySpec } from '../../src/services/policy/pending-catalog.js';
import {
  ambiguityQuestion,
  interpretPolicyAnswer,
  resolveAmbiguity,
  type AmbiguousPolicyAnswer,
} from '../../src/cli/policy-answer.js';

// ============================================================
// A TYPED ANSWER NEVER SAVES A VALUE NOBODY TYPED
//
// The old rule — `Number(answer)` between 1 and the list length is a position —
// saved «0.25» when an accountant typed «1.00» for prima_vacacional_pct. These
// tests hold the rule against the LIVE catalog rather than a frozen list, so a
// future option whose value is also a valid position is covered the day it is
// added.
// ============================================================

const opts = (...values: string[]) => values.map((value) => ({ value, label: `label ${value}` }));

describe('interpretPolicyAnswer', () => {
  it('a canonical integer that is not an option value is a position', () => {
    expect(interpretPolicyAnswer('2', opts('a', 'b', 'c'))).toEqual({ kind: 'chosen', value: 'b' });
  });

  it('a canonical integer beyond the list is a free-form value', () => {
    expect(interpretPolicyAnswer('7', opts('a', 'b', 'c'))).toEqual({ kind: 'chosen', value: '7' });
  });

  it('a non-canonical number is exactly what was typed, never a position', () => {
    // «1.00» and «03» parse to integers with Number(); that was the defect.
    expect(interpretPolicyAnswer('1.00', opts('0.25', '0.50', '1.00'))).toEqual({ kind: 'chosen', value: '1.00' });
    expect(interpretPolicyAnswer('03', opts('01', '03', 'block'))).toEqual({ kind: 'chosen', value: '03' });
    expect(interpretPolicyAnswer('01', opts('a', 'b'))).toEqual({ kind: 'chosen', value: '01' });
  });

  it('a canonical integer that is also ANOTHER option value is ambiguous, not guessed', () => {
    expect(interpretPolicyAnswer('3', opts('1', '3', '15'))).toEqual({
      kind: 'ambiguous',
      typed: '3',
      byPosition: '15',
      byValue: '3',
    });
  });

  it('a canonical integer whose position holds that same value is not ambiguous', () => {
    expect(interpretPolicyAnswer('2', opts('1', '2', '3'))).toEqual({ kind: 'chosen', value: '2' });
  });
});

describe('the live catalog', () => {
  it('no option value, typed exactly, resolves to a DIFFERENT option without a question', () => {
    const silentlyWrong: string[] = [];
    let checked = 0;
    for (const spec of POLICY_CATALOG) {
      for (const option of spec.options) {
        checked += 1;
        const result = interpretPolicyAnswer(option.value, spec.options);
        if (result.kind === 'chosen' && result.value !== option.value) {
          silentlyWrong.push(`${spec.key}: typed «${option.value}» saved «${result.value}»`);
        }
      }
    }
    // Guard against a vacuous pass: the catalog must actually have been read.
    expect(checked).toBeGreaterThan(100);
    expect(silentlyWrong).toEqual([]);
  });

  it('the four keys measured before the fix now keep what was typed or ask', () => {
    const cases: Array<[string, string]> = [
      ['prima_vacacional_pct', '1.00'],
      ['rep_tolerancia_importe', '1.00'],
      ['diot_tipo_operacion_por_omision', '03'],
      ['rep_ventana_dias', '3'],
    ];
    for (const [key, typed] of cases) {
      const spec = getPolicySpec(key);
      expect(spec, `${key} must still exist for this test to mean anything`).toBeDefined();
      expect(spec!.options.map((o) => o.value)).toContain(typed);
      const result = interpretPolicyAnswer(typed, spec!.options);
      if (result.kind === 'chosen') expect(result.value, key).toBe(typed);
      else expect(result.byValue, key).toBe(typed);
    }
  });
});

describe('resolving an ambiguous answer', () => {
  const a: AmbiguousPolicyAnswer = { kind: 'ambiguous', typed: '3', byPosition: '15', byValue: '3' };

  it('p takes the option at that position and v takes the typed value', () => {
    expect(resolveAmbiguity('p', a)).toBe('15');
    expect(resolveAmbiguity(' V ', a)).toBe('3');
  });

  it('an empty reply cancels and anything else asks again', () => {
    expect(resolveAmbiguity('', a)).toBeNull();
    expect(resolveAmbiguity('3', a)).toBeUndefined();
    expect(resolveAmbiguity('yes', a)).toBeUndefined();
  });

  it('the question names both readings, so the accountant sees what each key does', () => {
    const q = ambiguityQuestion(a);
    expect(q).toContain('option 3 (15)');
    expect(q).toContain('the value 3');
  });
});
