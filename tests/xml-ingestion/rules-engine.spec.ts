import { describe, it, expect } from 'vitest';
import {
  RulesEngine,
  autoRuleRequiring,
  type Rule,
  type RuleActions,
  type RuleConditions,
} from '../../src/services/xml-ingestion/rules-engine.js';

// MNE-001-490 (#692, part 3/3): a received credit note posts by itself only
// under a firm rule that sets auto AND requires document_type = credit_note.

const NOTE = { document_type: 'credit_note', total_amount: '2320.00', lines: [] };
const IS_NOTE = { field: 'document_type', operator: 'equals', value: 'credit_note' } as const;

function rule(id: string, priority: number, conditions: RuleConditions, actions: RuleActions): Rule {
  return { id, name: id, priority, conditions, actions, isActive: true };
}

async function decide(rules: Rule[], preRegistration: Record<string, unknown> = NOTE) {
  const { results, aggregatedActions } = await new RulesEngine().evaluate(preRegistration, {}, rules);
  return autoRuleRequiring(rules, results, aggregatedActions, 'credit_note')?.id ?? null;
}

describe('autoRuleRequiring', () => {
  const catchAll = (priority: number) => rule('catch-all', priority, {}, { set_processing_mode: 'auto' });
  const noteAuto = (priority: number) => rule('notes', priority, { all: [IS_NOTE] }, { set_processing_mode: 'auto' });

  it('a rule that sets auto and requires the type is the one that counts', async () => {
    expect(await decide([noteAuto(10)])).toBe('notes');
  });

  it('a rule with no conditions never reaches a note', async () => {
    expect(await decide([catchAll(10)])).toBeNull();
    expect(await decide([rule('empty-all', 10, { all: [], any: [] }, { set_processing_mode: 'auto' })])).toBeNull();
  });

  it.each([
    ['in', { all: [{ field: 'document_type', operator: 'in', value: ['credit_note'] }] }],
    ['not_equals', { all: [{ field: 'document_type', operator: 'not_equals', value: 'bill' }] }],
    ['regex', { all: [{ field: 'document_type', operator: 'regex', value: '^credit_note$' }] }],
    ['equals inside any', { any: [IS_NOTE] }],
    ['equals on another field', { all: [{ field: 'currency_code', operator: 'equals', value: 'credit_note' }] }],
  ] as Array<[string, RuleConditions]>)('%s matches the note but does not require it', async (_name, conditions) => {
    const loose = rule('loose', 10, conditions, { set_processing_mode: 'auto' });
    const pre = { ...NOTE, currency_code: 'credit_note' };
    const { results } = await new RulesEngine().evaluate(pre, {}, [loose]);
    expect(results[0].matched).toBe(true);
    expect(await decide([loose], pre)).toBeNull();
  });

  it('a catch-all auto plus a note rule that only tags does not post', async () => {
    const tagger = rule('tagger', 20, { all: [IS_NOTE] }, { add_tag: 'nota' });
    expect(await decide([catchAll(10), tagger])).toBeNull();
    expect(await decide([tagger, catchAll(30)])).toBeNull();
  });

  it('a note rule in auto posts whatever its order against a catch-all auto', async () => {
    expect(await decide([catchAll(10), noteAuto(20)])).toBe('notes');
    expect(await decide([noteAuto(10), catchAll(20)])).toBe('notes');
    expect(await decide([noteAuto(10), catchAll(10)])).toBe('notes');
  });

  it('a later hold or manual wins, as for bills', async () => {
    expect(await decide([noteAuto(10), rule('hold', 20, {}, { set_processing_mode: 'hold' })])).toBeNull();
    expect(await decide([noteAuto(10), rule('manual', 20, {}, { set_processing_mode: 'manual' })])).toBeNull();
  });

  it('a note rule that did not match, or none at all, gives nothing', async () => {
    const forOneVendor = rule('notes', 10, {
      all: [IS_NOTE, { field: 'emisor_rfc', operator: 'equals', value: 'SIN060101AB1' }],
    }, { set_processing_mode: 'auto' });
    expect(await decide([forOneVendor, catchAll(20)])).toBeNull();
    expect(await decide([])).toBeNull();
    expect(await decide([{ ...noteAuto(10), isActive: false }])).toBeNull();
  });
});
