import type pg from 'pg';
import { query, withTransaction } from '../database/connection.js';
import type { AgentContext } from './context.js';
import type { TurnRecord } from './providers/types.js';

// ============================================================
// SESSION STORE
// Durable transcript of every CLI conversation. It records WHAT
// HAPPENED (user turns, assistant answers, tool activity), not
// the provider wire format: a session survives process restarts
// and provider switches, and `--continue` picks the transcript
// back up even though the model context starts fresh.
//
// ai_messages carries no tenant/entity column: every query here
// reaches it THROUGH ai_sessions, whose tenant_id RLS policy
// scopes the join. Direct-by-session-id functions therefore
// guard with an ai_sessions subquery instead of entity_id = $n.
// ============================================================

export type TranscriptRole = 'user' | 'assistant' | 'tool' | 'system';

export interface SessionRow {
  id: string;
  tenant_id: string;
  entity_id: string;
  title: string | null;
  provider: string;
  model: string;
  terminal_key: string | null;
  created_at: Date;
  last_active_at: Date;
}

export interface SessionListRow extends SessionRow {
  message_count: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: TranscriptRole;
  content: string;
  tool_name: string | null;
  tool_calls: unknown;
  token_count: number | null;
  created_at: Date;
}

/** Anything that can run a parameterized query: the pool wrapper by default,
 *  or a transaction-bound client when the caller needs atomicity. */
type Queryable = Pick<pg.PoolClient, 'query'>;

function runQuery<T extends pg.QueryResultRow>(
  client: Queryable | undefined,
  text: string,
  params: unknown[]
): Promise<pg.QueryResult<T>> {
  return client ? client.query<T>(text, params as unknown[]) : query<T>(text, params);
}

const SESSION_COLUMNS = `id, tenant_id, entity_id, title, provider, model, terminal_key, created_at, last_active_at`;
const MESSAGE_COLUMNS = `id, session_id, seq, role, content, tool_name, tool_calls, token_count, created_at`;

/** ai_sessions.title width (see migration 018). */
const TITLE_MAX_CHARS = 60;

export interface CreateSessionInput {
  provider: string;
  model: string;
  /** Identifies the terminal (TMUX_PANE / TERM_SESSION_ID) for `--continue`. */
  terminalKey?: string | null;
}

export async function createSession(
  ctx: AgentContext,
  input: CreateSessionInput
): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO ai_sessions (tenant_id, entity_id, provider, model, terminal_key)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [ctx.tenantId, ctx.entityId, input.provider, input.model, input.terminalKey ?? null]
  );
  return r.rows[0].id;
}

export interface AppendMessageInput {
  role: TranscriptRole;
  content: string;
  toolName?: string;
  /** Stored as JSONB; for 'tool' rows: { name, input } of the call. */
  toolCalls?: unknown;
  tokenCount?: number;
}

/**
 * Appends one transcript row with seq = MAX(seq) + 1, computed inside the
 * INSERT itself. Race-aware within a single process only: the CLI serializes
 * its writes, and if two processes ever append to the same session the
 * unique (session_id, seq) index makes the loser fail loudly instead of
 * silently interleaving.
 *
 * INSERT … SELECT FROM ai_sessions instead of plain VALUES: under RLS a
 * session of another tenant is invisible, so the insert affects zero rows
 * and the rowCount check rejects the write.
 *
 * If another process wins the race, the unique (session_id, seq) index
 * raises 23505; standalone calls retry a couple of times (each attempt
 * recomputes MAX(seq)+1 inside the INSERT). Inside a caller-provided
 * transaction the retry is skipped — the aborted transaction could not
 * re-run the statement anyway — so the whole turn fails atomically.
 */
export async function appendMessage(
  sessionId: string,
  msg: AppendMessageInput,
  client?: Queryable
): Promise<number> {
  const maxAttempts = client ? 1 : 3;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await runQuery<{ seq: number }>(
        client,
        `INSERT INTO ai_messages (session_id, seq, role, content, tool_name, tool_calls, token_count)
         SELECT s.id,
                COALESCE((SELECT MAX(m.seq) FROM ai_messages m WHERE m.session_id = s.id), 0) + 1,
                $2, $3, $4, $5, $6
         FROM ai_sessions s
         WHERE s.id = $1
         RETURNING seq`,
        [
          sessionId,
          msg.role,
          msg.content,
          msg.toolName ?? null,
          msg.toolCalls === undefined ? null : JSON.stringify(msg.toolCalls),
          msg.tokenCount ?? null,
        ]
      );
      if (r.rowCount !== 1) {
        throw new Error(`Session ${sessionId} does not exist in this tenant`);
      }
      return r.rows[0].seq;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === '23505' && attempt < maxAttempts) continue;
      throw err;
    }
  }
}

export async function touchSession(sessionId: string, client?: Queryable): Promise<void> {
  await runQuery(client, `UPDATE ai_sessions SET last_active_at = NOW() WHERE id = $1`, [sessionId]);
}

/**
 * Session title = first user message, set exactly once (title IS NULL
 * predicate): later turns never overwrite it.
 */
export async function setTitleIfEmpty(
  sessionId: string,
  title: string,
  client?: Queryable
): Promise<void> {
  await runQuery(
    client,
    `UPDATE ai_sessions SET title = $2 WHERE id = $1 AND title IS NULL`,
    [sessionId, title.slice(0, TITLE_MAX_CHARS)]
  );
}

/**
 * Re-points the session's provenance columns after a `/provider` hot-swap
 * or a resume under a different profile, so the audit record names the
 * provider actually producing the turns.
 */
export async function updateSessionProvider(
  sessionId: string,
  provider: string,
  model: string
): Promise<void> {
  await query(
    `UPDATE ai_sessions SET provider = $2, model = $3 WHERE id = $1`,
    [sessionId, provider, model]
  );
}

/**
 * Most recent session for `--continue`: the one from THIS terminal first
 * (terminal_key match), falling back to the entity's most recent session
 * from any terminal. The fallback excludes sessions active within the
 * last 5 minutes: a live chat in another (key-less) terminal would
 * otherwise be shared, interleaving two conversations into one
 * transcript. The terminal_key branch stays unrestricted so the same
 * terminal can always continue its own recent session.
 */
export async function latestSession(
  ctx: AgentContext,
  terminalKey?: string
): Promise<SessionRow | null> {
  if (terminalKey) {
    const byTerminal = await query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM ai_sessions
       WHERE entity_id = $1 AND terminal_key = $2
       ORDER BY last_active_at DESC
       LIMIT 1`,
      [ctx.entityId, terminalKey]
    );
    if (byTerminal.rows.length === 1) return byTerminal.rows[0];
  }
  const r = await query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM ai_sessions
     WHERE entity_id = $1
       AND last_active_at < NOW() - INTERVAL '5 minutes'
     ORDER BY last_active_at DESC
     LIMIT 1`,
    [ctx.entityId]
  );
  return r.rows[0] ?? null;
}

/** Session by id, scoped to the entity (`--resume <id>`). */
export async function getSession(ctx: AgentContext, id: string): Promise<SessionRow | null> {
  const r = await query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM ai_sessions WHERE id = $1 AND entity_id = $2`,
    [id, ctx.entityId]
  );
  return r.rows[0] ?? null;
}

/**
 * Full transcript in order. The EXISTS guard scopes through ai_sessions
 * (whose RLS policy filters by tenant): a foreign session id returns an
 * empty transcript, never another tenant's messages.
 */
export async function getSessionMessages(sessionId: string): Promise<MessageRow[]> {
  const r = await query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM ai_messages
     WHERE session_id = $1
       AND EXISTS (SELECT 1 FROM ai_sessions s WHERE s.id = $1)
     ORDER BY seq`,
    [sessionId]
  );
  return r.rows;
}

export async function listSessions(
  ctx: AgentContext,
  limit = 20
): Promise<SessionListRow[]> {
  // NaN/Infinity (e.g. `sessions -n abc` parsed with parseInt) would turn
  // into `LIMIT NaN`: fall back to the default before clamping.
  const capped = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
  const r = await query<SessionListRow>(
    `SELECT s.id, s.tenant_id, s.entity_id, s.title, s.provider, s.model,
            s.terminal_key, s.created_at, s.last_active_at,
            COUNT(m.id)::int AS message_count
     FROM ai_sessions s
     LEFT JOIN ai_messages m ON m.session_id = s.id
     WHERE s.entity_id = $1
     GROUP BY s.id
     ORDER BY s.last_active_at DESC
     LIMIT $2`,
    [ctx.entityId, capped]
  );
  return r.rows;
}

/**
 * Persists one completed turn as transcript rows, in the order things
 * happened: user input → one 'tool' row per tool call (result preview as
 * content, {name, input} as tool_calls) → assistant answer. Sets the
 * session title on the first turn and refreshes last_active_at.
 *
 * Runs as ONE transaction so a turn is all-or-nothing: a mid-sequence
 * failure (pool closing, DB blip, seq collision with another process)
 * never leaves a committed user row without its assistant answer.
 * withTransaction re-applies the tenant set_config on its client, so
 * RLS scoping is preserved for every row.
 */
export async function recordTurn(sessionId: string, record: TurnRecord): Promise<void> {
  await withTransaction(async (client) => {
    await setTitleIfEmpty(sessionId, record.userInput, client);
    await appendMessage(sessionId, { role: 'user', content: record.userInput }, client);
    for (const use of record.toolUses) {
      await appendMessage(sessionId, {
        role: 'tool',
        content: use.resultPreview,
        toolName: use.name,
        toolCalls: { name: use.name, input: use.input },
      }, client);
    }
    await appendMessage(sessionId, { role: 'assistant', content: record.assistantText }, client);
    await touchSession(sessionId, client);
  });
}
