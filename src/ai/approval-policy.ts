import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection.js';
import { FLOOR_MAX_AUTO_POST } from './floor.js';
import type { AgentContext } from './context.js';

// ============================================================
// GRADUATED APPROVAL POLICIES
// A human pre-authorizes a PATTERN of staged writes (Hermes
// once/session/always + OpenClaw allowlists). Matching is
// CONSERVATIVE: a policy matches only when EVERY field it
// specifies matches the candidate, and the candidate amount is
// numerically <= the policy's max_amount.
//
// The effective policy is ALWAYS the strictest of config vs
// stored approvals, and the FLOOR (src/ai/floor.ts) wins over
// everything — a stored approval can never authorize above
// FLOOR_MAX_AUTO_POST or an aged op past FLOOR_MAX_OP_AGE_DAYS.
// Amounts are combined ONLY via Math.min (stricter wins).
// ============================================================

export type ApprovalScope = 'draft' | 'external_op';
export type ApprovalMode = 'once' | 'session' | 'always';

/**
 * Free-form matcher stored as JSONB. `max_amount` is a numeric string
 * compared numerically; every other field is compared for exact equality
 * against the candidate. A field the pattern does NOT specify is a
 * wildcard; a field it DOES specify that the candidate lacks is a
 * mismatch (conservative).
 */
export interface ApprovalPattern {
  max_amount?: string;
  [field: string]: unknown;
}

/**
 * What a staged write looks like to the matcher. `amount` is the
 * candidate's total in the entity's functional currency (string or
 * number, compared numerically); the rest are plain match fields
 * (kind, provider, operation, ...).
 *
 * `amount` is REQUIRED for a match: callers must derive it SERVER-SIDE
 * from schema-guaranteed fields (never from a free-form AI payload key).
 * matchApproval fails closed — no amount, no authorization — so the
 * FLOOR_MAX_AUTO_POST gate can never be skipped by omitting the field.
 */
export interface ApprovalCandidate {
  amount?: string | number;
  [field: string]: unknown;
}

export interface ApprovalPolicyRow {
  id: string;
  entity_id: string;
  scope: ApprovalScope;
  pattern: ApprovalPattern;
  mode: ApprovalMode;
  session_id: string | null;
  created_by: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const POLICY_COLUMNS = `id, entity_id, scope, pattern, mode, session_id,
            created_by, created_at, last_used_at, revoked_at`;

/**
 * Strictest-wins amount cap: every provided limit combined with the
 * floor via Math.min ONLY. A non-finite or negative limit fails
 * CLOSED (cap 0 — nothing matches), never open.
 */
export function effectiveApprovalCap(...limits: Array<number | undefined>): number {
  let cap = FLOOR_MAX_AUTO_POST;
  for (const limit of limits) {
    if (limit === undefined) continue;
    if (!Number.isFinite(limit) || limit < 0) return 0;
    cap = Math.min(cap, limit);
  }
  return cap;
}

/** Numeric parse that fails closed: null for anything unparseable. */
function toDecimal(value: unknown): Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const d = new Decimal(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

export interface GrantApprovalInput {
  scope: ApprovalScope;
  pattern: ApprovalPattern;
  mode: ApprovalMode;
  /** Who granted it (email) — the audit trail for `mnemosine approvals`. */
  grantedBy: string;
  /** Required for mode 'session': the granting session's id. */
  sessionId?: string;
}

export async function grantApproval(ctx: AgentContext, input: GrantApprovalInput): Promise<string> {
  if (input.mode === 'session' && !input.sessionId) {
    throw new Error("A 'session' approval requires the granting session id");
  }
  if (input.mode !== 'session' && input.sessionId !== undefined) {
    // Silently dropping the session id would grant BROADER authority than
    // the operator asked for ('always' valid in every session) — refuse.
    throw new Error(
      `--session only applies to --mode session; a '${input.mode}' policy is not session-scoped`
    );
  }
  if (input.pattern.max_amount !== undefined && toDecimal(input.pattern.max_amount) === null) {
    throw new Error(`max_amount "${String(input.pattern.max_amount)}" is not a valid numeric string`);
  }

  const id = uuidv4();
  await query(
    `INSERT INTO ai_approval_policies (
      id, tenant_id, entity_id, scope, pattern, mode, session_id, created_by
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    [
      id, ctx.tenantId, ctx.entityId, input.scope,
      JSON.stringify(input.pattern), input.mode,
      input.mode === 'session' ? input.sessionId : null, // non-session modes already rejected any session id
      input.grantedBy,
    ]
  );
  return id;
}

/** Guarded revoke: only a live policy of this entity can be revoked. */
export async function revokeApproval(ctx: AgentContext, policyId: string): Promise<void> {
  const result = await query(
    `UPDATE ai_approval_policies SET revoked_at = NOW()
     WHERE id = $1 AND entity_id = $2 AND revoked_at IS NULL`,
    [policyId, ctx.entityId]
  );
  if (result.rowCount !== 1) {
    throw new Error(`No active approval policy with id ${policyId} exists in this entity`);
  }
}

export async function listApprovals(
  ctx: AgentContext,
  opts?: { scope?: ApprovalScope; includeRevoked?: boolean }
): Promise<ApprovalPolicyRow[]> {
  const conditions = ['entity_id = $1'];
  const params: unknown[] = [ctx.entityId];
  if (opts?.scope) {
    params.push(opts.scope);
    conditions.push(`scope = $${params.length}`);
  }
  if (!opts?.includeRevoked) {
    conditions.push('revoked_at IS NULL');
  }
  const result = await query<ApprovalPolicyRow>(
    `SELECT ${POLICY_COLUMNS}
     FROM ai_approval_policies
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at ASC`,
    params
  );
  return result.rows;
}

/**
 * Pure pattern-vs-candidate check (no amount handling — that is the
 * caller's, so the floor combination stays in one place). Every field
 * the pattern specifies (except max_amount) must be present on the
 * candidate and strictly equal after string coercion of primitives.
 */
function patternMatches(pattern: ApprovalPattern, candidate: ApprovalCandidate): boolean {
  for (const [field, expected] of Object.entries(pattern)) {
    if (field === 'max_amount') continue;
    const actual = candidate[field];
    const primitive = (v: unknown): v is string | number =>
      typeof v === 'string' || typeof v === 'number';
    if (!primitive(expected) || !primitive(actual)) return false;
    if (String(expected) !== String(actual)) return false;
  }
  return true;
}

/**
 * Amount gate for one policy. Rules (all fail closed):
 * - cap = Math.min(policy max_amount?, configured max?, FLOOR_MAX_AUTO_POST);
 * - a pattern that specifies max_amount rejects a candidate WITHOUT a
 *   parseable amount;
 * - a candidate WITH an amount must be <= cap even when the pattern
 *   specifies no max_amount — the floor wins over everything.
 */
function amountAllowed(
  pattern: ApprovalPattern,
  candidate: ApprovalCandidate,
  configuredMaxAmount?: number
): boolean {
  const policyMax = pattern.max_amount !== undefined ? toDecimal(pattern.max_amount) : undefined;
  if (pattern.max_amount !== undefined && policyMax === null) return false; // unparseable limit

  const amount = candidate.amount !== undefined ? toDecimal(candidate.amount) : undefined;
  if (candidate.amount !== undefined && amount === null) return false; // unparseable amount
  if (policyMax !== undefined && amount === undefined) return false; // limit with nothing to check

  if (amount === undefined || amount === null) return true; // nothing amount-like to gate
  if (amount.isNegative()) return false;

  const cap = effectiveApprovalCap(policyMax?.toNumber(), configuredMaxAmount);
  return amount.lessThanOrEqualTo(cap);
}

export interface MatchApprovalOpts {
  /** Current session id: 'session' policies match only their own session. */
  sessionId?: string;
  /**
   * Configured auto-approval cap (e.g. ingest thresholds.maxAmount).
   * Combined with the policy max and the floor via Math.min — a stored
   * approval can never be MORE permissive than the configuration.
   */
  configuredMaxAmount?: number;
}

/**
 * Non-consuming policies are preferred: an 'always' policy is tried
 * before 'session', and both before 'once' — so a candidate a standing
 * policy covers never SPENDS a one-shot grant meant for something else.
 * Within the same mode, oldest first (created_at ASC).
 */
const MODE_PREFERENCE: Record<ApprovalMode, number> = { always: 0, session: 1, once: 2 };

/**
 * Finds the first live policy of this entity+scope that authorizes the
 * candidate, trying non-consuming modes first (always, then session,
 * then 'once' — see MODE_PREFERENCE).
 *
 * FAIL CLOSED on the amount: a candidate without a parseable,
 * non-negative `amount` matches NOTHING — the caller must derive the
 * amount from trustworthy, schema-guaranteed fields, and when it
 * cannot, the staged write stays pending for human review.
 *
 * Side effects on the winner:
 * - 'once' policies are CONSUMED atomically (guarded UPDATE setting
 *   revoked_at WHERE revoked_at IS NULL + rowCount check) — a lost race
 *   means another session spent it, and the search continues;
 * - 'session'/'always' winners get last_used_at touched, also guarded
 *   on revoked_at IS NULL so a concurrent revoke voids the match.
 * Returns null when nothing authorizes the candidate.
 */
/**
 * Las candidatas vivas de esta entidad y alcance, en el orden en que se
 * intentan: no consumidoras primero (always < session < once), y dentro del
 * mismo modo la más antigua. Compartida por el emparejador REAL y el de sólo
 * lectura, para que la sombra no pueda medir un orden distinto del que se
 * aplicará (A7: la evidencia mide el modo que se va a encender).
 */
async function candidatasOrdenadas(
  ctx: AgentContext,
  scope: ApprovalScope
): Promise<ApprovalPolicyRow[]> {
  const result = await query<ApprovalPolicyRow>(
    `SELECT ${POLICY_COLUMNS}
     FROM ai_approval_policies
     WHERE entity_id = $1 AND scope = $2 AND revoked_at IS NULL
     ORDER BY created_at ASC`,
    [ctx.entityId, scope]
  );
  return [...result.rows].sort(
    (a, b) =>
      MODE_PREFERENCE[a.mode] - MODE_PREFERENCE[b.mode] ||
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
}

/** ¿Esta política autoriza al candidato? Pura: sin base y sin efectos. */
function autoriza(
  policy: ApprovalPolicyRow,
  candidate: ApprovalCandidate,
  opts?: MatchApprovalOpts
): boolean {
  if (policy.mode === 'session' && (!opts?.sessionId || policy.session_id !== opts.sessionId)) {
    return false;
  }
  if (!patternMatches(policy.pattern, candidate)) return false;
  return amountAllowed(policy.pattern, candidate, opts?.configuredMaxAmount);
}

/**
 * ¿HABRÍA autorizado alguna política? Sin consumir nada (A7).
 *
 * La sombra necesita saber si el modo real habría posteado, y el modo real
 * incluye la vía de política que A3 añadió: medir sólo el umbral haría que la
 * evidencia validara un clasificador MÁS CONSERVADOR que el que se enciende —
 * exactamente el defecto que la auditoría II nombró.
 *
 * Pero la sombra no puede llamar a `matchApproval`: ése toca `last_used_at` y
 * GASTA las políticas 'once'. Una sombra con efectos deja de ser sombra.
 *
 * Límite declarado: una política 'once' que aquí «habría autorizado» podría
 * estar gastada cuando el modo real llegue. La sombra es optimista en ese
 * caso concreto, y sobre-declarar «habría posteado» empuja la concordancia
 * hacia abajo cuando el humano rechaza — que es el lado seguro para una
 * medición cuyo propósito es autorizar el encendido.
 */
export async function wouldMatchApproval(
  ctx: AgentContext,
  scope: ApprovalScope,
  candidate: ApprovalCandidate,
  opts?: MatchApprovalOpts
): Promise<ApprovalPolicyRow | null> {
  const candidateAmount = toDecimal(candidate.amount);
  if (candidateAmount === null || candidateAmount.isNegative()) return null;
  const ordered = await candidatasOrdenadas(ctx, scope);
  return ordered.find((p) => autoriza(p, candidate, opts)) ?? null;
}

export async function matchApproval(
  ctx: AgentContext,
  scope: ApprovalScope,
  candidate: ApprovalCandidate,
  opts?: MatchApprovalOpts
): Promise<ApprovalPolicyRow | null> {
  // FAIL CLOSED: no trustworthy amount, no authorization. This is the
  // last line of defense — even a caller that forgets to derive the
  // amount cannot open an uncapped auto-approve path.
  const candidateAmount = toDecimal(candidate.amount);
  if (candidateAmount === null || candidateAmount.isNegative()) return null;

  const ordered = await candidatasOrdenadas(ctx, scope);

  for (const policy of ordered) {
    if (!autoriza(policy, candidate, opts)) continue;

    const claimed =
      policy.mode === 'once'
        ? await query(
            `UPDATE ai_approval_policies SET revoked_at = NOW(), last_used_at = NOW()
             WHERE id = $1 AND entity_id = $2 AND revoked_at IS NULL`,
            [policy.id, ctx.entityId]
          )
        : await query(
            `UPDATE ai_approval_policies SET last_used_at = NOW()
             WHERE id = $1 AND entity_id = $2 AND revoked_at IS NULL`,
            [policy.id, ctx.entityId]
          );
    // rowCount 0: another session consumed/revoked it between our read
    // and the guarded update — this policy no longer authorizes anything.
    if (claimed.rowCount !== 1) continue;

    return policy;
  }
  return null;
}
