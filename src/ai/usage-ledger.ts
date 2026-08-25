import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection.js';
import type { AgentContext } from './context.js';
import { lookupPrice } from './providers/prices.js';

// ============================================================
// USAGE LEDGER
// One ai_usage row per completed model call, with a local cost
// estimate. Consumes the shared TurnUsage shape the runners emit
// through onUsage (both the Anthropic runner and the OpenAI-
// compat runner normalize their wire usage into it).
// Recording is append-only bookkeeping: it never blocks a turn.
// ============================================================

/**
 * SHARED CONTRACT — the runners' onUsage callback delivers exactly this
 * shape. Anthropic usage fields (input_tokens, output_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens) and OpenAI-compat
 * usage ({prompt_tokens, completion_tokens,
 * prompt_tokens_details.cached_tokens}) both map into it upstream.
 */
export interface TurnUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * Cost estimate in USD, or null when the model is not in the local price
 * table. Cache tokens without a dedicated rate fall back to the input
 * rate — a deliberate overestimate: budgeting should surprise downward.
 */
export function estimateCostUsd(usage: TurnUsage): number | null {
  const price = lookupPrice(usage.model);
  if (!price) return null;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const usd =
    (usage.inputTokens / 1_000_000) * price.inputPerMTok +
    (usage.outputTokens / 1_000_000) * price.outputPerMTok +
    (cacheRead / 1_000_000) * (price.cacheReadPerMTok ?? price.inputPerMTok) +
    (cacheWrite / 1_000_000) * (price.cacheWritePerMTok ?? price.inputPerMTok);
  // numeric(12,6) precision; avoids float dust like 0.30000000000000004.
  return Number(usd.toFixed(6));
}

/**
 * Largest value the INTEGER token columns can hold (2^31 - 1). Counts are
 * clamped below it so a garbage payload can never abort the insert with a
 * pg 22003 overflow.
 */
const MAX_TOKEN_COUNT = 2_147_483_647;

/**
 * Sanitizes one provider-reported token count. The runners copy these
 * straight off the wire from user-configurable endpoints (ollama, hermes,
 * arbitrary base URLs), so nothing upstream guarantees they are sane:
 * negative, NaN, non-numeric or overflowing values are clamped into
 * [0, 2^31-1] and truncated to integers. The row is still recorded —
 * garbage in one field must not lose the rest of the ledger entry —
 * and totals can never be driven downward by hostile negative counts.
 */
export function clampTokenCount(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const truncated = Math.trunc(n);
  if (!Number.isSafeInteger(truncated)) return truncated > 0 ? MAX_TOKEN_COUNT : 0;
  return Math.min(Math.max(truncated, 0), MAX_TOKEN_COUNT);
}

/**
 * Append one usage row. sessionId is null for paths without a persisted
 * session. Unknown model → estimated_cost_usd NULL, tokens still recorded.
 * Token counts are clamped (see clampTokenCount) BEFORE the cost estimate
 * so a hostile or buggy endpoint can never write negative or overflowing
 * rows into the ledger.
 */
export async function recordUsage(
  ctx: AgentContext,
  sessionId: string | null,
  usage: TurnUsage
): Promise<string> {
  const id = uuidv4();
  const clamped: TurnUsage = {
    provider: usage.provider,
    model: usage.model,
    inputTokens: clampTokenCount(usage.inputTokens),
    outputTokens: clampTokenCount(usage.outputTokens),
    cacheReadInputTokens: clampTokenCount(usage.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: clampTokenCount(usage.cacheCreationInputTokens ?? 0),
  };
  const cost = estimateCostUsd(clamped);
  await query(
    `INSERT INTO ai_usage (
      id, tenant_id, entity_id, session_id, provider, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      estimated_cost_usd
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id, ctx.tenantId, ctx.entityId, sessionId,
      clamped.provider, clamped.model,
      clamped.inputTokens, clamped.outputTokens,
      clamped.cacheReadInputTokens, clamped.cacheCreationInputTokens,
      cost === null ? null : cost.toFixed(6),
    ]
  );
  return id;
}

export type UsageGroupBy = 'model' | 'provider' | 'day' | 'session';

export interface UsageSummaryRow {
  /** Group key: model id, provider name, YYYY-MM-DD day, or session id. */
  key: string;
  /** Provider of the group ('model' grouping only; empty otherwise). */
  provider: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of the priced rows in the group. */
  costUsd: number;
  /** Rows in the group with no price-table match (cost unknown). */
  unpricedTurns: number;
}

export interface UsageSummary {
  rows: UsageSummaryRow[];
  totals: Omit<UsageSummaryRow, 'key' | 'provider'>;
}

// Whitelisted group expressions: groupBy is a closed union, never
// interpolated user text — but keeping the SQL fragments in one table
// makes that property auditable at a glance.
const GROUPINGS: Record<UsageGroupBy, { key: string; provider: string; order: string }> = {
  model: { key: 'model', provider: 'provider', order: 'SUM(estimated_cost_usd) DESC NULLS LAST, key' },
  provider: { key: 'provider', provider: `''`, order: 'SUM(estimated_cost_usd) DESC NULLS LAST, key' },
  day: { key: `to_char(created_at, 'YYYY-MM-DD')`, provider: `''`, order: 'key' },
  session: { key: `COALESCE(session_id::text, '(no session)')`, provider: `''`, order: 'SUM(estimated_cost_usd) DESC NULLS LAST, key' },
};

interface SummaryDbRow {
  key: string;
  provider: string;
  turns: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  cache_read_tokens: string | number;
  cache_write_tokens: string | number;
  cost_usd: string | number | null;
  unpriced_turns: string | number;
}

export async function summarizeUsage(
  ctx: AgentContext,
  opts: { since?: Date; groupBy: UsageGroupBy }
): Promise<UsageSummary> {
  const g = GROUPINGS[opts.groupBy];
  if (!g) throw new Error(`Unknown grouping "${opts.groupBy}" (use model, provider, day or session)`);

  const params: unknown[] = [ctx.entityId];
  let where = 'entity_id = $1';
  if (opts.since) {
    params.push(opts.since);
    where += ` AND created_at >= $${params.length}`;
  }

  const result = await query<SummaryDbRow>(
    `SELECT ${g.key} AS key, ${g.provider} AS provider,
       COUNT(*)::int AS turns,
       COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
       COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
       COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
       COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
       SUM(estimated_cost_usd) AS cost_usd,
       COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int AS unpriced_turns
     FROM ai_usage
     WHERE ${where}
     GROUP BY ${g.key}${opts.groupBy === 'model' ? ', provider' : ''}
     ORDER BY ${g.order}`,
    params
  );

  const rows: UsageSummaryRow[] = result.rows.map((r) => ({
    key: String(r.key),
    provider: String(r.provider ?? ''),
    turns: Number(r.turns),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
    costUsd: r.cost_usd === null ? 0 : Number(r.cost_usd),
    unpricedTurns: Number(r.unpriced_turns),
  }));

  const totals = rows.reduce(
    (acc, r) => ({
      turns: acc.turns + r.turns,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
      costUsd: Number((acc.costUsd + r.costUsd).toFixed(6)),
      unpricedTurns: acc.unpricedTurns + r.unpricedTurns,
    }),
    { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, unpricedTurns: 0 }
  );

  return { rows, totals };
}
