import { query } from '../database/connection.js';
import type { AgentContext } from './context.js';

// ============================================================
// FIRM MEMORY
// Precedents are the asset that makes the AI improve with use,
// but until now they were invisible: only the AI saw them.
// This makes them inspectable, correctable and removable —
// without that, "the AI learned" is something that happens TO
// the user, not something the user controls.
// ============================================================

export interface MemoryEntry {
  id: string;
  question: string;
  answer: string;
  context: string | null;
  topic: string | null;
  answered_by: string;
  answered_at: Date;
  is_precedent: boolean;
  /** Times the AI consulted it (approximated by topic match). */
  usage_hint?: number;
}

const COLUMNS = `id, question, answer, context, topic, answered_by, answered_at, is_precedent`;

export interface ListMemoryOptions {
  /** Free text over question/answer/context/topic. */
  search?: string;
  /** false = also include entries deactivated as precedent. */
  onlyActive?: boolean;
  limit?: number;
}

export async function listMemory(
  ctx: AgentContext,
  opts: ListMemoryOptions = {}
): Promise<MemoryEntry[]> {
  const conditions = ['entity_id = $1', "status = 'answered'"];
  const params: unknown[] = [ctx.entityId];

  if (opts.onlyActive !== false) conditions.push('is_precedent = true');
  if (opts.search) {
    // Escape LIKE metacharacters: a literal '%' would match everything.
    const escaped = opts.search.replace(/[\\%_]/g, (m) => '\\' + m);
    params.push(`%${escaped}%`);
    conditions.push(
      `(question ILIKE $${params.length} OR answer ILIKE $${params.length}
        OR context ILIKE $${params.length} OR topic ILIKE $${params.length})`
    );
  }

  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const r = await query<MemoryEntry>(
    `SELECT ${COLUMNS} FROM ai_questions
     WHERE ${conditions.join(' AND ')}
     ORDER BY answered_at DESC
     LIMIT ${limit}`,
    params
  );
  return r.rows;
}

export async function getMemoryEntry(ctx: AgentContext, id: string): Promise<MemoryEntry | null> {
  const r = await query<MemoryEntry>(
    `SELECT ${COLUMNS} FROM ai_questions
     WHERE id = $1 AND entity_id = $2 AND status = 'answered'`,
    [id, ctx.entityId]
  );
  return r.rows[0] ?? null;
}

/**
 * Correct a precedent's answer. The previous version is preserved in the
 * context: an accounting criterion that changed is information, not garbage,
 * and the trail matters for an audit.
 */
export async function correctMemory(
  ctx: AgentContext,
  id: string,
  newAnswer: string,
  correctedBy: string
): Promise<MemoryEntry> {
  const current = await getMemoryEntry(ctx, id);
  if (!current) throw new Error(`Precedent ${id} does not exist in this entity`);
  if (current.answer === newAnswer) return current;

  const trail =
    `${current.context ? current.context + '\n' : ''}` +
    `[corrected ${new Date().toISOString().split('T')[0]} by ${correctedBy}] ` +
    `previously said: ${current.answer}`;

  const r = await query<MemoryEntry>(
    `UPDATE ai_questions
     SET answer = $1, context = $2, answered_by = $3, answered_at = NOW()
     WHERE id = $4 AND entity_id = $5 AND status = 'answered'
     RETURNING ${COLUMNS}`,
    [newAnswer, trail, correctedBy, id, ctx.entityId]
  );
  if (r.rowCount !== 1) throw new Error(`Could not correct precedent ${id}`);
  return r.rows[0];
}

/**
 * Deactivate a precedent without deleting it: the AI stops seeing it, but
 * the history of what was decided and when survives. A DELETE here would
 * destroy audit evidence.
 */
export async function retireMemory(
  ctx: AgentContext,
  id: string,
  retiredBy: string
): Promise<void> {
  const r = await query(
    `UPDATE ai_questions
     SET is_precedent = false,
         context = COALESCE(context || E'\\n', '') ||
                   '[retired ' || to_char(NOW(), 'YYYY-MM-DD') || ' by ' || $1 || ']'
     WHERE id = $2 AND entity_id = $3 AND status = 'answered' AND is_precedent = true`,
    [retiredBy, id, ctx.entityId]
  );
  if (r.rowCount !== 1) throw new Error(`No active precedent with id ${id} exists`);
}

/** Reactivate a retired precedent. */
export async function restoreMemory(ctx: AgentContext, id: string): Promise<void> {
  const r = await query(
    `UPDATE ai_questions SET is_precedent = true
     WHERE id = $1 AND entity_id = $2 AND status = 'answered' AND is_precedent = false`,
    [id, ctx.entityId]
  );
  if (r.rowCount !== 1) throw new Error(`No retired precedent with id ${id} exists`);
}

/**
 * Teach a criterion WITHOUT waiting for the AI to ask. It is the difference
 * between a memory that only reacts and one the firm can seed with its
 * policies from day one.
 */
export async function teachMemory(
  ctx: AgentContext,
  input: { rule: string; criterion: string; topic?: string; taughtBy: string }
): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO ai_questions (
       tenant_id, entity_id, status, question, answer, topic,
       answered_by, answered_at, is_precedent, ai_model, context
     ) VALUES ($1, $2, 'answered', $3, $4, $5, $6, NOW(), true, 'human-taught',
               'Criterion taught directly by the firm (did not arise from a question).')
     RETURNING id`,
    [ctx.tenantId, ctx.entityId, input.rule, input.criterion, input.topic ?? null, input.taughtBy]
  );
  return r.rows[0].id;
}

// ============================================================
// MEMORY DIGEST (frozen snapshot for the system prompt)
// Rendered ONCE at session start into the stable/cached block.
// Hard char budget (~tokens*4): the digest must never grow
// unbounded with the precedent table, and it must never mutate
// mid-session (that would invalidate the prompt cache).
// ============================================================

/** Newest precedents fetched for the digest before the char budget cuts in. */
const DIGEST_MAX_ENTRIES = 50;

const DIGEST_TRUNCATION_NOTE =
  '[memory truncated at budget — use search_precedents for older criteria]';

/**
 * Compact digest of the most recent active precedents, newest first, one per
 * line: 'topic: answer (by, date)'. Cut at `maxChars` with an explicit note so
 * the model knows older criteria exist and how to reach them.
 */
export async function buildMemoryDigest(ctx: AgentContext, maxChars = 3000): Promise<string> {
  const r = await query<{
    topic: string | null; question: string; answer: string;
    answered_by: string; answered_at: Date;
  }>(
    `SELECT topic, question, answer, answered_by, answered_at
     FROM ai_questions
     WHERE entity_id = $1 AND status = 'answered' AND is_precedent = true
     ORDER BY answered_at DESC
     LIMIT ${DIGEST_MAX_ENTRIES}`,
    [ctx.entityId]
  );
  if (r.rows.length === 0) return '';

  const lines: string[] = [];
  let used = 0;
  let truncated = false;
  // Reserve room for the note so appending it never busts the budget.
  const budget = maxChars - (DIGEST_TRUNCATION_NOTE.length + 1);
  for (const row of r.rows) {
    const date = new Date(row.answered_at).toISOString().split('T')[0];
    const line = `${row.topic ?? row.question}: ${row.answer} (${row.answered_by}, ${date})`;
    if (used + line.length + 1 > budget) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  // The entry cap also hides older precedents — flag that too.
  if (truncated || r.rows.length === DIGEST_MAX_ENTRIES) {
    lines.push(DIGEST_TRUNCATION_NOTE);
  }
  return lines.join('\n');
}

export interface MemoryStats {
  active: number;
  retired: number;
  taught: number;
  topics: Array<{ topic: string; count: number }>;
}

export async function memoryStats(ctx: AgentContext): Promise<MemoryStats> {
  const r = await query<{ active: string; retired: string; taught: string }>(
    `SELECT
       count(*) FILTER (WHERE is_precedent)::text AS active,
       count(*) FILTER (WHERE NOT is_precedent)::text AS retired,
       count(*) FILTER (WHERE ai_model = 'human-taught')::text AS taught
     FROM ai_questions WHERE entity_id = $1 AND status = 'answered'`,
    [ctx.entityId]
  );
  const topics = await query<{ topic: string; count: string }>(
    `SELECT topic, count(*)::text AS count FROM ai_questions
     WHERE entity_id = $1 AND status = 'answered' AND is_precedent AND topic IS NOT NULL
     GROUP BY topic ORDER BY count(*) DESC LIMIT 10`,
    [ctx.entityId]
  );
  return {
    active: parseInt(r.rows[0].active, 10),
    retired: parseInt(r.rows[0].retired, 10),
    taught: parseInt(r.rows[0].taught, 10),
    topics: topics.rows.map((t) => ({ topic: t.topic, count: parseInt(t.count, 10) })),
  };
}
