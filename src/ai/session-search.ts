import { query } from '../database/connection.js';
import type { AgentContext } from './context.js';

// ============================================================
// SESSION TRANSCRIPT SEARCH (on-demand recall)
// Full-text search over ai_messages so the agent can recall
// facts from PAST sessions (decisions, amounts, classifications)
// when it needs them — NOTHING is ever injected into the live
// context automatically; the session_search tool is the only
// path. That is the design point: unlimited historical recall
// without inflating every session's context.
//
// The tsquery config is 'simple' to mirror the expression GIN
// index from migration 029 (language-neutral: RFCs, folios and
// amounts must match literally). Both sides MUST tokenize with
// the same config or the index is useless and matches drift.
// ============================================================

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** Snippets stay small so many hits fit under the runner's result cap. */
export const MAX_SNIPPET_CHARS = 300;

export interface SessionSearchOptions {
  query: string;
  /** Clamped to [1, 50]; default 10. */
  limit?: number;
  /** Only messages created at/after this instant. */
  since?: Date;
}

export interface SessionSearchHit {
  sessionId: string;
  seq: number;
  role: string;
  snippet: string;
  createdAt: Date;
  sessionTitle: string | null;
}

export interface SessionSearchResult {
  hits: SessionSearchHit[];
  /** TOTAL matches in the corpus, not just the page returned — so the
   *  caller can be honest about truncation ("N more matches"). */
  matchCount: number;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Caps a snippet at MAX_SNIPPET_CHARS on a CODE POINT boundary. A plain
 * .slice() cuts by UTF-16 code unit and can sever a surrogate pair (emoji,
 * CJK-extension chars that occur in real transcripts), leaving a lone
 * surrogate; strict UTF-8 encoders in the SDK/transport then reject or
 * mangle it, turning one emoji-heavy stored message into a serialization
 * error that fails the whole recall call. Array.from splits by code point,
 * so no half-character is ever emitted.
 */
export function truncateSnippet(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= MAX_SNIPPET_CHARS) return text;
  return codePoints.slice(0, MAX_SNIPPET_CHARS).join('');
}

interface SearchRow {
  session_id: string;
  seq: number;
  role: string;
  snippet: string;
  created_at: Date;
  session_title: string | null;
  match_count: string | number;
}

/**
 * Searches past transcripts of THIS entity. Entity scoping is structural
 * (the join condition pins ai_sessions.entity_id), not an afterthought
 * filter: ai_messages has no entity column of its own, so every row is
 * reachable only through a session of the caller's entity — and RLS on
 * ai_sessions scopes the tenant on top.
 */
export async function searchSessions(
  ctx: AgentContext,
  opts: SessionSearchOptions
): Promise<SessionSearchResult> {
  const text = opts.query.trim();
  if (!text) return { hits: [], matchCount: 0 };

  const limit = clampLimit(opts.limit);
  const params: unknown[] = [ctx.entityId, text];
  let sinceClause = '';
  if (opts.since) {
    params.push(opts.since);
    sinceClause = ` AND m.created_at >= $${params.length}`;
  }
  params.push(limit);
  const limitParam = `$${params.length}`;

  // COUNT(*) OVER () gives the total match count in the same round trip.
  // Rank: relevance first, recency as the tiebreaker (recent sessions are
  // more likely to reflect the current state of the books).
  const result = await query<SearchRow>(
    `SELECT m.session_id,
            m.seq,
            m.role,
            ts_headline('simple', m.content, plainto_tsquery('simple', $2),
                        'MaxFragments=1, MaxWords=35, MinWords=10') AS snippet,
            m.created_at,
            s.title AS session_title,
            COUNT(*) OVER () AS match_count
     FROM ai_messages m
     JOIN ai_sessions s ON s.id = m.session_id AND s.entity_id = $1
     WHERE to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $2)${sinceClause}
     ORDER BY ts_rank(to_tsvector('simple', m.content), plainto_tsquery('simple', $2)) DESC,
              m.created_at DESC
     LIMIT ${limitParam}`,
    params
  );

  const hits = result.rows.map((row) => ({
    sessionId: row.session_id,
    seq: row.seq,
    role: row.role,
    snippet: truncateSnippet(row.snippet ?? ''),
    createdAt: row.created_at,
    sessionTitle: row.session_title,
  }));
  const matchCount = result.rows.length > 0 ? Number(result.rows[0].match_count) : 0;
  return { hits, matchCount };
}
