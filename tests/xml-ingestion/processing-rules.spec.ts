import { describe, it, expect, vi, beforeEach } from 'vitest';

const sql: Array<{ text: string; params: unknown[] }> = [];
vi.mock('../../src/database/connection.js', () => ({
  query: (text: string, params: unknown[] = []) => {
    sql.push({ text, params });
    return Promise.resolve({ rows: [{ id: 'R1', text, total_count: '1' }], rowCount: 1 });
  },
}));

import {
  createProcessingRule,
  listProcessingRules,
  parseRuleAction,
  parseRuleCondition,
  validateProcessingRule,
  type CreateProcessingRuleInput,
} from '../../src/services/xml-ingestion/processing-rules.js';

// ING-2 · #319 (MNE-001-032): what `bill rule create` accepts is what the
// engine honors and the REST route validates, nothing looser.

beforeEach(() => { sql.length = 0; });

describe('parseRuleCondition', () => {
  it.each([
    ['emisor_rfc equals SIN060101AB1', { field: 'emisor_rfc', operator: 'equals', value: 'SIN060101AB1' }],
    ['total_amount greater_than 50000', { field: 'total_amount', operator: 'greater_than', value: 50000 }],
    ['has_retention equals true', { field: 'has_retention', operator: 'equals', value: true }],
    ['currency_code in MXN, USD', { field: 'currency_code', operator: 'in', value: ['MXN', 'USD'] }],
    ['line_count not_in 1,2', { field: 'line_count', operator: 'not_in', value: [1, 2] }],
    ['vendor_id is_null', { field: 'vendor_id', operator: 'is_null', value: null }],
    ['emisor_nombre contains Papeleria del Centro', { field: 'emisor_nombre', operator: 'contains', value: 'Papeleria del Centro' }],
    ['first_descripcion regex ^Hon', { field: 'first_descripcion', operator: 'regex', value: '^Hon' }],
  ])('%s', (spec, expected) => {
    expect(parseRuleCondition(spec)).toEqual(expected);
  });

  it.each([
    ['emisor_rfc', /not "<field> <operator> <value>"/],
    ['rfc_emisor equals X', /Unknown field "rfc_emisor"/],
    ['emisor_rfc like X', /Unknown operator "like"/],
    ['emisor_rfc equals', /has no value/],
    ['total_amount greater_than mucho', /total_amount is a number/],
    ['is_high_value equals si', /true or false/],
  ])('refuses %s', (spec, message) => {
    expect(() => parseRuleCondition(spec)).toThrow(message);
  });
});

describe('parseRuleAction', () => {
  it.each([
    ['set_account=6100', { set_account: '6100' }],
    ['set_processing_mode=auto', { set_processing_mode: 'auto' }],
    ['require_approval=true', { require_approval: true }],
    ['reject=false', { reject: false }],
    ['set_priority=3', { set_priority: 3 }],
    ['add_tag=consultoria', { add_tag: 'consultoria' }],
    ['reject_reason=No es del ente', { reject_reason: 'No es del ente' }],
  ])('%s', (spec, expected) => {
    expect(parseRuleAction(spec)).toEqual(expected);
  });

  it.each([
    ['set_cost_center=cc', /Unknown action "set_cost_center"/],
    ['set_account', /has no value/],
    ['set_processing_mode=fast', /one of auto, batch, manual, hold/],
    ['set_priority=1.5', /integer/],
  ])('refuses %s', (spec, message) => {
    expect(() => parseRuleAction(spec)).toThrow(message);
  });
});

describe('validateProcessingRule', () => {
  const ok = { rule_name: 'R', rule_type: 'account_mapping', conditions: { all: [] }, actions: {} };

  it('takes the body the REST route takes', () => {
    expect(validateProcessingRule(ok)).toEqual(ok);
  });

  it('refuses what the schema refuses and a type the table would reject', () => {
    expect(() => validateProcessingRule({ ...ok, rule_name: '' })).toThrow(/rule_name/);
    expect(() => validateProcessingRule({ ...ok, rule_type: 'nope' })).toThrow(/Unknown rule type "nope"/);
  });
});

describe('persistence, scoped to the entity', () => {
  it('createProcessingRule inserts under the entity and the user, active by default', async () => {
    await createProcessingRule('E1', 'U1', {
      rule_name: 'R', rule_type: 'account_mapping', conditions: { all: [] }, actions: { set_account: 'A1' },
    });
    const [{ text, params }] = sql;
    expect(text).toMatch(/INSERT INTO processing_rules/);
    expect(params[1]).toBe('E1');
    expect(params[6]).toBe(100);
    expect(params[10]).toBe(true);
    expect(params[11]).toBe('U1');
    await expect(createProcessingRule('E1', 'U1', {} as CreateProcessingRuleInput)).rejects.toThrow(/rule_name/);
  });

  it('listProcessingRules filters by entity inside the SQL, and by type when asked', async () => {
    expect((await listProcessingRules('E1')).total).toBe(1);
    const page = await listProcessingRules('E1', { ruleType: 'rejection', active: true, limit: 5, offset: 10 });
    expect(sql[0].text).toMatch(/WHERE r\.entity_id = \$1/);
    expect(sql.map((s) => s.params)).toEqual([['E1', null, null, null, 0], ['E1', 'rejection', true, 5, 10]]);
    expect(page.rows).toHaveLength(1);
  });
});
