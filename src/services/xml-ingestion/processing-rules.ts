import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { boundedString, integerNumber, uuidString } from '../../utils/zod-compat.js';
import { query } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';
import {
  CONDITION_OPERATORS,
  RULE_FIELDS,
  type ConditionOperator,
  type RuleActions,
  type RuleCondition,
} from './rules-engine.js';

// ============================================================
// ING-2 · #319 (MNE-001-032) — THE FIRM'S PROCESSING RULES, FROM THE TERMINAL.
//
// A rule is the firm's criterion, not the agent's: when it codes a CFDI it
// does not go through ai_drafts, but the pre-registration keeps which rule
// decided (`rules_applied`, `account_mapping_method = 'rule'`) and the rule
// counts how often it fired. The body schema is the one the REST route
// validates with, defined once here so the terminal cannot drift from it.
// ============================================================

/** The rule types `processing_rules.rule_type` accepts (its CHECK, 005_xml_ingestion.sql). */
export const RULE_TYPES = [
  'account_mapping', 'cost_center_mapping', 'vendor_matching', 'approval_routing',
  'processing_mode', 'validation', 'transformation', 'rejection',
] as const;

// CONTRACT: body of POST /v1/processing-rules (src/api/rest/routes/xml-ingestion.ts).
export const createProcessingRuleSchema = z.object({
  entity_id: uuidString().optional(),
  rule_name: boundedString({ min: 1, max: 255 }),
  rule_code: boundedString({ max: 50 }).optional(),
  description: z.string().optional(),
  rule_type: boundedString({ min: 1 }),
  priority: integerNumber().optional(),
  conditions: z.record(z.string(), z.unknown()),
  actions: z.record(z.string(), z.unknown()),
  applies_to_document_types: z.array(z.string()).optional(),
  is_active: z.boolean().optional(),
});

export type CreateProcessingRuleInput = z.infer<typeof createProcessingRuleSchema>;

const PROCESSING_MODES = ['auto', 'batch', 'manual', 'hold'] as const;

/**
 * The actions `applyRuleActions` really applies. Any other key the engine
 * accepts (set_cost_center, set_department…) is written and then ignored, so
 * a rule carrying it would promise something it never does.
 */
export const APPLIED_ACTIONS = [
  'set_account', 'set_processing_mode', 'require_approval', 'set_priority', 'add_tag', 'reject', 'reject_reason',
] as const;

function booleanOf(key: string, raw: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ValidationError(`${key} takes true or false; got "${raw}".`, key);
}

/** `"<field> <operator> [value]"`, e.g. `emisor_rfc equals SIN060101AB1`. */
export function parseRuleCondition(spec: string): RuleCondition {
  const match = /^\s*(\S+)\s+(\S+)\s*(.*)$/.exec(spec);
  if (!match) throw new ValidationError(`Condition "${spec}" is not "<field> <operator> <value>".`, 'conditions');
  const [, field, op, rawValue] = match;
  const kind = RULE_FIELDS[field];
  if (!kind) {
    throw new ValidationError(
      `Unknown field "${field}": a rule can read ${Object.keys(RULE_FIELDS).join(', ')}.`, 'conditions'
    );
  }
  if (!(CONDITION_OPERATORS as readonly string[]).includes(op)) {
    throw new ValidationError(`Unknown operator "${op}": use ${CONDITION_OPERATORS.join(', ')}.`, 'conditions');
  }
  const operator = op as ConditionOperator;
  const raw = rawValue.trim();
  if (operator === 'is_null' || operator === 'is_not_null') return { field, operator, value: null };
  if (raw === '') throw new ValidationError(`Condition "${spec}" has no value.`, 'conditions');

  const typed = (v: string): unknown => {
    if (kind === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new ValidationError(`${field} is a number; got "${v}".`, 'conditions');
      return n;
    }
    return kind === 'boolean' ? booleanOf(field, v) : v;
  };
  const value =
    operator === 'in' || operator === 'not_in'
      ? raw.split(',').map((v) => typed(v.trim()))
      : operator === 'regex' || operator.includes('contains') || operator.endsWith('_with')
        ? raw
        : typed(raw);
  return { field, operator, value };
}

/**
 * `"<action>=<value>"`, e.g. `set_processing_mode=auto`. `set_account` is
 * returned as written: the caller resolves the code to a postable account.
 */
export function parseRuleAction(spec: string): RuleActions {
  const eq = spec.indexOf('=');
  const key = (eq < 0 ? spec : spec.slice(0, eq)).trim();
  const raw = eq < 0 ? '' : spec.slice(eq + 1).trim();
  if (!(APPLIED_ACTIONS as readonly string[]).includes(key)) {
    throw new ValidationError(`Unknown action "${key}": use ${APPLIED_ACTIONS.join(', ')}.`, 'actions');
  }
  if (raw === '') throw new ValidationError(`Action "${key}" has no value: ${key}=<value>.`, 'actions');
  switch (key) {
    case 'set_processing_mode':
      if (!(PROCESSING_MODES as readonly string[]).includes(raw)) {
        throw new ValidationError(`set_processing_mode is one of ${PROCESSING_MODES.join(', ')}.`, 'actions');
      }
      return { set_processing_mode: raw as RuleActions['set_processing_mode'] };
    case 'require_approval':
      return { require_approval: booleanOf(key, raw) };
    case 'reject':
      return { reject: booleanOf(key, raw) };
    case 'set_priority': {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new ValidationError(`set_priority is an integer; got "${raw}".`, 'actions');
      return { set_priority: n };
    }
    default:
      return { [key]: raw };
  }
}

/** Validates the body exactly as the REST route does, plus the rule type the table accepts. */
export function validateProcessingRule(input: unknown): CreateProcessingRuleInput {
  const parsed = createProcessingRuleSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
    );
  }
  if (!(RULE_TYPES as readonly string[]).includes(parsed.data.rule_type)) {
    throw new ValidationError(`Unknown rule type "${parsed.data.rule_type}": use ${RULE_TYPES.join(', ')}.`, 'rule_type');
  }
  return parsed.data;
}

export async function createProcessingRule(
  entityId: string,
  userId: string,
  input: CreateProcessingRuleInput
): Promise<Record<string, unknown>> {
  const rule = validateProcessingRule(input);
  const result = await query<Record<string, unknown>>(
    `INSERT INTO processing_rules (
      id, entity_id, rule_name, rule_code, description, rule_type,
      priority, conditions, actions, applies_to_document_types, is_active, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
    RETURNING *`,
    [
      uuidv4(), entityId, rule.rule_name, rule.rule_code ?? null, rule.description ?? null, rule.rule_type,
      rule.priority ?? 100, JSON.stringify(rule.conditions), JSON.stringify(rule.actions),
      rule.applies_to_document_types ?? null, rule.is_active !== false, userId,
    ]
  );
  return result.rows[0];
}

/** The rules of one entity in the order the engine evaluates them, with the code of the account each one sets. */
export async function listProcessingRules(
  entityId: string,
  filter: { ruleType?: string; active?: boolean; limit?: number; offset?: number } = {}
): Promise<{ rows: Array<Record<string, unknown>>; total: number }> {
  const result = await query<Record<string, unknown>>(
    `SELECT r.*, a.code AS set_account_code, COUNT(*) OVER () AS total_count
       FROM processing_rules r
       LEFT JOIN accounts a ON a.id::text = r.actions->>'set_account' AND a.entity_id = r.entity_id
      WHERE r.entity_id = $1 AND ($2::text IS NULL OR r.rule_type = $2)
        AND ($3::boolean IS NULL OR r.is_active = $3)
      ORDER BY r.priority ASC, r.created_at DESC
      LIMIT $4 OFFSET $5`,
    [entityId, filter.ruleType ?? null, filter.active ?? null, filter.limit ?? null, filter.offset ?? 0]
  );
  return { rows: result.rows, total: result.rows.length ? Number(result.rows[0].total_count) : 0 };
}
