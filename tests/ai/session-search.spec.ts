import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { searchSessions, clampLimit, MAX_SNIPPET_CHARS } from '../../src/ai/session-search.js';
import { query } from '../../src/database/connection.js';
import type { AgentContext } from '../../src/ai/context.js';

const mockQuery = query as unknown as Mock;

const CTX: AgentContext = {
  entityId: 'entity-1', entityName: 'Nueva Empresa SA', tenantId: 'tenant-a',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'NUE010101AAA',
};

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    session_id: 'sess-1',
    seq: 4,
    role: 'assistant',
    snippet: 'the <b>folio</b> A-123 was classified as freight',
    created_at: new Date('2026-08-01T12:00:00Z'),
    session_title: 'classify freight invoices',
    match_count: '1',
    ...over,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('searchSessions — SQL shape (scoping and parameterization)', () => {
  it('is entity-scoped through the ai_sessions join, parameterized', async () => {
    await searchSessions(CTX, { query: 'folio A-123' });
    expect(mockQuery.mock.calls).toHaveLength(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/JOIN ai_sessions s ON s\.id = m\.session_id AND s\.entity_id = \$1/);
    expect(params[0]).toBe('entity-1');
    expect(params[1]).toBe('folio A-123');
    // the search text never gets interpolated into the SQL string
    expect(String(sql)).not.toContain('folio A-123');
  });

  it("uses plainto_tsquery with the language-neutral 'simple' config on both sides", async () => {
    await searchSessions(CTX, { query: 'RFC XAXX010101000' });
    const [sql] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/plainto_tsquery\('simple', \$2\)/);
    expect(String(sql)).toMatch(/to_tsvector\('simple', m\.content\) @@ plainto_tsquery\('simple', \$2\)/);
    expect(String(sql)).not.toMatch(/'spanish'|'english'/);
  });

  it('ranks by ts_rank with recency as tiebreaker', async () => {
    await searchSessions(CTX, { query: 'x' });
    const [sql] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/ORDER BY ts_rank\([\s\S]*\) DESC,\s*m\.created_at DESC/);
  });

  it('passes since as a parameter when provided, omits the clause otherwise', async () => {
    const since = new Date('2026-01-01T00:00:00Z');
    await searchSessions(CTX, { query: 'x', since });
    let [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/m\.created_at >= \$3/);
    expect(params[2]).toBe(since);

    mockQuery.mockClear();
    await searchSessions(CTX, { query: 'x' });
    [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).not.toMatch(/created_at >=/);
    expect(params).toHaveLength(3); // entity, text, limit
  });

  it('short-circuits on an empty/whitespace query without touching the database', async () => {
    const result = await searchSessions(CTX, { query: '   ' });
    expect(result).toEqual({ hits: [], matchCount: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('searchSessions — limit clamping', () => {
  it('defaults to 10, clamps to [1, 50], floors fractions', () => {
    expect(clampLimit(undefined)).toBe(10);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(999)).toBe(50);
    expect(clampLimit(7.9)).toBe(7);
    expect(clampLimit(Number.NaN)).toBe(10);
  });

  it('passes the clamped limit as a bind parameter', async () => {
    await searchSessions(CTX, { query: 'x', limit: 500 });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/LIMIT \$3/);
    expect(params[2]).toBe(50);
  });
});

describe('searchSessions — result shaping', () => {
  it('maps rows to hits and reads matchCount from the window count', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ match_count: '37' })] });
    const { hits, matchCount } = await searchSessions(CTX, { query: 'folio' });
    expect(matchCount).toBe(37);
    expect(hits).toEqual([{
      sessionId: 'sess-1',
      seq: 4,
      role: 'assistant',
      snippet: 'the <b>folio</b> A-123 was classified as freight',
      createdAt: new Date('2026-08-01T12:00:00Z'),
      sessionTitle: 'classify freight invoices',
    }]);
  });

  it('caps each snippet at MAX_SNIPPET_CHARS', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ snippet: 'x'.repeat(1000) })] });
    const { hits } = await searchSessions(CTX, { query: 'x' });
    expect(hits[0].snippet).toHaveLength(MAX_SNIPPET_CHARS);
  });

  it('truncates on a code-point boundary — never emits a lone surrogate', async () => {
    // The emoji straddles code unit index 300: a naive .slice(0, 300) would
    // keep only its high surrogate and emit ill-formed UTF-16.
    const snippet = 'a'.repeat(MAX_SNIPPET_CHARS - 1) + '😀' + 'tail';
    mockQuery.mockResolvedValue({ rows: [row({ snippet })] });
    const { hits } = await searchSessions(CTX, { query: 'x' });
    const out = hits[0].snippet;
    // No unpaired high or low surrogate anywhere in the result.
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    // The emoji survives whole; the tail past the cap is dropped.
    expect(out.endsWith('😀')).toBe(true);
    expect(Array.from(out)).toHaveLength(MAX_SNIPPET_CHARS);
  });

  it('leaves a short snippet with surrogate pairs untouched', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ snippet: 'hola 😀 mundo 🚀' })] });
    const { hits } = await searchSessions(CTX, { query: 'x' });
    expect(hits[0].snippet).toBe('hola 😀 mundo 🚀');
  });

  it('returns matchCount 0 for no rows', async () => {
    const { hits, matchCount } = await searchSessions(CTX, { query: 'nothing' });
    expect(hits).toEqual([]);
    expect(matchCount).toBe(0);
  });
});
