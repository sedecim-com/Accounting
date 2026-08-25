import { query } from '../../database/connection.js';
import { POLICY_CATALOG, getPolicySpec, type PolicySpec } from './pending-catalog.js';

// ============================================================
// POLICY SERVICE
// Reads and resolves policy decisions. The important piece:
// `getPolicy` returns the resolved value or the declared default,
// so consuming code NEVER blocks — and `listPending` keeps what
// remains undefined visible.
// ============================================================

export interface PolicyRow {
  id: string;
  key: string;
  category: string;
  question: string;
  impact: string;
  options: Array<{ value: string; label: string }>;
  default_value: string | null;
  default_rationale: string | null;
  status: 'pending' | 'resolved' | 'dismissed';
  resolved_value: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_notes: string | null;
  priority: number;
  entity_id: string | null;
}

const COLUMNS = `id, key, category, question, impact, options, default_value, default_rationale,
  status, resolved_value, resolved_by, resolved_at, resolution_notes, priority, entity_id`;

export interface PolicyContext {
  tenantId: string;
  entityId?: string;
}

/**
 * Seeds the catalog for a tenant. Idempotent: it does not touch existing
 * ones, so an already-resolved decision is not revived when new ones are
 * added to the catalog.
 */
export async function seedPolicies(ctx: PolicyContext): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const spec of POLICY_CATALOG) {
    const r = await query(
      `INSERT INTO policy_decisions (
         tenant_id, entity_id, key, category, question, impact, options,
         default_value, default_rationale, priority, source
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'seed')
       -- No target: uniqueness lives in two partial indexes (one for
       -- tenant scope with entity_id NULL, another for entity scope), and
       -- ON CONFLICT DO NOTHING covers both without naming them.
       ON CONFLICT DO NOTHING`,
      [
        ctx.tenantId, ctx.entityId ?? null, spec.key, spec.category,
        spec.question, spec.impact, JSON.stringify(spec.options),
        spec.defaultValue, spec.defaultRationale, spec.priority,
      ]
    );
    inserted += r.rowCount ?? 0;
  }
  return { inserted };
}

export async function listPolicies(
  ctx: PolicyContext,
  status?: PolicyRow['status']
): Promise<PolicyRow[]> {
  const conditions = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (status) {
    conditions.push(`status = $${params.length + 1}`);
    params.push(status);
  }
  const r = await query<PolicyRow>(
    `SELECT ${COLUMNS} FROM policy_decisions
     WHERE ${conditions.join(' AND ')}
     ORDER BY status = 'pending' DESC, priority ASC, key ASC`,
    params
  );
  return r.rows;
}

export const listPending = (ctx: PolicyContext) => listPolicies(ctx, 'pending');

export interface EffectivePolicy {
  key: string;
  value: string;
  /** true = the user defined it; false = the default is being used. */
  defined: boolean;
  question: string;
  rationale: string | null;
}

/**
 * Effective value of a policy. Priority:
 *   resolved value > DB default > catalog default.
 * Never throws for lack of definition: the system keeps operating and
 * the decision remains visible in `/pendientes`.
 */
export async function getPolicy(ctx: PolicyContext, key: string): Promise<EffectivePolicy> {
  const r = await query<PolicyRow>(
    `SELECT ${COLUMNS} FROM policy_decisions
     WHERE tenant_id = $1 AND key = $2
     ORDER BY entity_id IS NULL ASC
     LIMIT 1`,
    [ctx.tenantId, key]
  );
  const row = r.rows[0];
  const spec = getPolicySpec(key);

  if (row?.status === 'resolved' && row.resolved_value !== null) {
    return {
      key, value: row.resolved_value, defined: true,
      question: row.question,
      rationale: row.resolution_notes,
    };
  }
  const fallback = row?.default_value ?? spec?.defaultValue;
  if (fallback === undefined || fallback === null) {
    throw new Error(`Policy "${key}" does not exist in the catalog or in the database`);
  }
  return {
    key, value: fallback, defined: false,
    question: row?.question ?? spec?.question ?? key,
    rationale: row?.default_rationale ?? spec?.defaultRationale ?? null,
  };
}

/** Numeric shortcut for policies that are amounts or quantities. */
export async function getPolicyNumber(ctx: PolicyContext, key: string): Promise<number> {
  const p = await getPolicy(ctx, key);
  const n = Number(p.value);
  if (!Number.isFinite(n)) {
    const spec = getPolicySpec(key);
    return Number(spec?.defaultValue ?? 0);
  }
  return n;
}

export async function resolvePolicy(
  ctx: PolicyContext,
  key: string,
  value: string,
  resolvedBy: string,
  notes?: string
): Promise<void> {
  const spec = getPolicySpec(key);
  // A free-form value is accepted (catalogs don't cover everything), but a
  // note is added when it is not among the options so it doesn't go unnoticed.
  const known = spec?.options.some((o) => o.value === value) ?? true;
  const finalNotes = known ? notes ?? null : `${notes ?? ''} [value outside the catalog]`.trim();

  const r = await query(
    `UPDATE policy_decisions
     SET status = 'resolved', resolved_value = $1, resolved_by = $2,
         resolved_at = NOW(), resolution_notes = $3, updated_at = NOW()
     WHERE tenant_id = $4 AND key = $5 AND status = 'pending'`,
    [value, resolvedBy, finalNotes, ctx.tenantId, key]
  );
  if (r.rowCount === 0) {
    throw new Error(`There is no pending decision with key "${key}" in this tenant`);
  }
}

export async function dismissPolicy(
  ctx: PolicyContext,
  key: string,
  dismissedBy: string,
  notes?: string
): Promise<void> {
  const r = await query(
    `UPDATE policy_decisions
     SET status = 'dismissed', resolved_by = $1, resolved_at = NOW(),
         resolution_notes = $2, updated_at = NOW()
     WHERE tenant_id = $3 AND key = $4 AND status = 'pending'`,
    [dismissedBy, notes ?? null, ctx.tenantId, key]
  );
  if (r.rowCount === 0) {
    throw new Error(`There is no pending decision with key "${key}" in this tenant`);
  }
}

/** Reopens an already-resolved decision (the policy changed). */
export async function reopenPolicy(ctx: PolicyContext, key: string): Promise<void> {
  const r = await query(
    `UPDATE policy_decisions
     SET status = 'pending', resolved_value = NULL, resolved_by = NULL,
         resolved_at = NULL, updated_at = NOW()
     WHERE tenant_id = $1 AND key = $2 AND status != 'pending'`,
    [ctx.tenantId, key]
  );
  if (r.rowCount === 0) {
    throw new Error(`Decision "${key}" is already pending or does not exist`);
  }
}

export { POLICY_CATALOG, getPolicySpec } from './pending-catalog.js';
export type { PolicySpec } from './pending-catalog.js';
