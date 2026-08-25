import { v4 as uuidv4 } from 'uuid';

// ============================================================
// TYPES
// ============================================================

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'greater_than'
  | 'greater_than_or_equal'
  | 'less_than'
  | 'less_than_or_equal'
  | 'in'
  | 'not_in'
  | 'is_null'
  | 'is_not_null'
  | 'regex';

export interface RuleCondition {
  field: string;
  operator: ConditionOperator;
  value: unknown;
}

export interface RuleConditions {
  all?: RuleCondition[];
  any?: RuleCondition[];
}

export interface RuleActions {
  set_account?: string;
  set_cost_center?: string;
  set_department?: string;
  set_project?: string;
  set_processing_mode?: 'auto' | 'batch' | 'manual' | 'hold';
  require_approval?: boolean;
  approval_level?: string;
  set_priority?: number;
  add_tag?: string;
  add_tags?: string[];
  set_due_date_offset?: number;
  reject?: boolean;
  reject_reason?: string;
  custom_action?: string;
}

export interface Rule {
  id: string;
  name: string;
  priority: number;
  conditions: RuleConditions;
  actions: RuleActions;
  isActive: boolean;
}

export interface RuleEvaluationResult {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  matchedConditions: string[];
  actions: RuleActions;
}

// ============================================================
// RULES ENGINE
// ============================================================

export class RulesEngine {
  async evaluate(
    preRegistration: Record<string, unknown>,
    xmlDocument: Record<string, unknown>,
    rules: Rule[]
  ): Promise<{ results: RuleEvaluationResult[]; aggregatedActions: RuleActions }> {
    const context = this.buildContext(preRegistration, xmlDocument);

    const sortedRules = [...rules]
      .filter((r) => r.isActive)
      .sort((a, b) => a.priority - b.priority);

    const results = sortedRules.map((rule) => this.evaluateRule(rule, context));
    const aggregatedActions = this.aggregateActions(results);

    return { results, aggregatedActions };
  }

  private buildContext(
    preRegistration: Record<string, unknown>,
    xmlDocument: Record<string, unknown>
  ): Record<string, unknown> {
    const lines = (preRegistration.lines as Array<Record<string, unknown>>) || [];

    return {
      // Pre-registration
      document_type: preRegistration.document_type,
      vendor_id: preRegistration.vendor_id,
      subtotal: Number(preRegistration.subtotal),
      tax_amount: Number(preRegistration.tax_amount),
      total_amount: Number(preRegistration.total_amount),
      currency_code: preRegistration.currency_code,
      document_date: preRegistration.document_date,

      // XML
      emisor_rfc: xmlDocument.emisor_rfc,
      emisor_nombre: xmlDocument.emisor_nombre,
      receptor_rfc: xmlDocument.receptor_rfc,
      cfdi_uuid: xmlDocument.cfdi_uuid,
      forma_pago: xmlDocument.forma_pago,
      metodo_pago: xmlDocument.metodo_pago,

      // Tax details
      total_iva_16: Number(xmlDocument.total_iva_16 || 0),
      total_iva_8: Number(xmlDocument.total_iva_8 || 0),
      total_isr_retenido: Number(xmlDocument.total_isr_retenido || 0),

      // First line
      first_clave_prod_serv: lines[0]?.clave_prod_serv,
      first_descripcion: lines[0]?.descripcion,

      // Computed
      has_retention: Number(xmlDocument.total_impuestos_retenidos || 0) > 0,
      is_high_value: Number(preRegistration.total_amount) >= 50000,
      line_count: lines.length,

      tags: preRegistration.tags || [],
    };
  }

  private evaluateRule(rule: Rule, context: Record<string, unknown>): RuleEvaluationResult {
    const matchedConditions: string[] = [];
    let allMatched = true;
    let anyMatched = false;

    if (rule.conditions.all && rule.conditions.all.length > 0) {
      for (const cond of rule.conditions.all) {
        if (this.evaluateCondition(cond, context)) {
          matchedConditions.push(`${cond.field} ${cond.operator} ${JSON.stringify(cond.value)}`);
        } else {
          allMatched = false;
        }
      }
    }

    if (rule.conditions.any && rule.conditions.any.length > 0) {
      for (const cond of rule.conditions.any) {
        if (this.evaluateCondition(cond, context)) {
          anyMatched = true;
          matchedConditions.push(`${cond.field} ${cond.operator} ${JSON.stringify(cond.value)}`);
        }
      }
    } else {
      anyMatched = true;
    }

    const matched = allMatched && anyMatched;

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      matched,
      matchedConditions,
      actions: matched ? rule.actions : {},
    };
  }

  private evaluateCondition(condition: RuleCondition, context: Record<string, unknown>): boolean {
    const fieldValue = this.getFieldValue(condition.field, context);
    const compareValue = condition.value;

    switch (condition.operator) {
      case 'equals':
        return fieldValue === compareValue;
      case 'not_equals':
        return fieldValue !== compareValue;
      case 'contains':
        return String(fieldValue).toLowerCase().includes(String(compareValue).toLowerCase());
      case 'not_contains':
        return !String(fieldValue).toLowerCase().includes(String(compareValue).toLowerCase());
      case 'starts_with':
        return String(fieldValue).toLowerCase().startsWith(String(compareValue).toLowerCase());
      case 'ends_with':
        return String(fieldValue).toLowerCase().endsWith(String(compareValue).toLowerCase());
      case 'greater_than':
        return Number(fieldValue) > Number(compareValue);
      case 'greater_than_or_equal':
        return Number(fieldValue) >= Number(compareValue);
      case 'less_than':
        return Number(fieldValue) < Number(compareValue);
      case 'less_than_or_equal':
        return Number(fieldValue) <= Number(compareValue);
      case 'in': {
        const list = Array.isArray(compareValue) ? compareValue : [compareValue];
        return list.includes(fieldValue);
      }
      case 'not_in': {
        const list = Array.isArray(compareValue) ? compareValue : [compareValue];
        return !list.includes(fieldValue);
      }
      case 'is_null':
        return fieldValue === null || fieldValue === undefined;
      case 'is_not_null':
        return fieldValue !== null && fieldValue !== undefined;
      case 'regex':
        return new RegExp(String(compareValue), 'i').test(String(fieldValue));
      default:
        return false;
    }
  }

  private getFieldValue(field: string, context: Record<string, unknown>): unknown {
    const parts = field.split('.');
    let value: unknown = context;

    for (const part of parts) {
      if (value === null || value === undefined) return undefined;
      value = (value as Record<string, unknown>)[part];
    }

    return value;
  }

  private aggregateActions(results: RuleEvaluationResult[]): RuleActions {
    const aggregated: RuleActions = {};

    for (const result of results) {
      if (!result.matched) continue;

      Object.assign(aggregated, result.actions);

      if (result.actions.add_tag) {
        if (!aggregated.add_tags) aggregated.add_tags = [];
        if (!aggregated.add_tags.includes(result.actions.add_tag)) {
          aggregated.add_tags.push(result.actions.add_tag);
        }
      }

      if (result.actions.add_tags) {
        if (!aggregated.add_tags) aggregated.add_tags = [];
        for (const tag of result.actions.add_tags) {
          if (!aggregated.add_tags.includes(tag)) aggregated.add_tags.push(tag);
        }
      }
    }

    return aggregated;
  }
}

// ============================================================
// RULE BUILDER
// ============================================================

export class RuleBuilder {
  private rule: Partial<Rule> = {
    conditions: { all: [], any: [] },
    actions: {},
    isActive: true,
    priority: 100,
  };

  static create(name: string): RuleBuilder {
    const builder = new RuleBuilder();
    builder.rule.name = name;
    return builder;
  }

  withPriority(priority: number): this {
    this.rule.priority = priority;
    return this;
  }

  when(field: string, operator: ConditionOperator, value: unknown): this {
    this.rule.conditions!.all!.push({ field, operator, value });
    return this;
  }

  orWhen(field: string, operator: ConditionOperator, value: unknown): this {
    this.rule.conditions!.any!.push({ field, operator, value });
    return this;
  }

  then(actions: RuleActions): this {
    this.rule.actions = { ...this.rule.actions, ...actions };
    return this;
  }

  setAccount(accountId: string): this {
    this.rule.actions!.set_account = accountId;
    return this;
  }

  setCostCenter(costCenterId: string): this {
    this.rule.actions!.set_cost_center = costCenterId;
    return this;
  }

  setProcessingMode(mode: 'auto' | 'batch' | 'manual' | 'hold'): this {
    this.rule.actions!.set_processing_mode = mode;
    return this;
  }

  requireApproval(level?: string): this {
    this.rule.actions!.require_approval = true;
    if (level) this.rule.actions!.approval_level = level;
    return this;
  }

  build(): Rule {
    return { ...(this.rule as Rule), id: this.rule.id ?? uuidv4() };
  }
}
