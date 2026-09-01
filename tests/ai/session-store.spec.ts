import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(), enterTenant: vi.fn(), currentTenant: vi.fn(), withTransaction: vi.fn(),
}));

import {
  createSession, appendMessage, touchSession, setTitleIfEmpty, updateSessionProvider,
  latestSession, getSession, getSessionMessages, listSessions, recordTurn,
} from '../../src/ai/session-store.js';
import { query, withTransaction } from '../../src/database/connection.js';
import type { AgentContext } from '../../src/ai/context.js';

const mockQuery = query as unknown as Mock;
const mockTx = withTransaction as unknown as Mock;
// Transaction-bound client handed to recordTurn's callback by the mocked
// withTransaction: every statement of the turn must go through it, not
// through the pool-level query().
const clientQuery = vi.fn();
const fakeClient = { query: clientQuery };

const CTX: AgentContext = {
  entityId: 'entity-1', entityName: 'Acme', tenantId: 'tenant-a',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AME010101AAA',
};

const SESSION = {
  id: 'sess-1', tenant_id: 'tenant-a', entity_id: 'entity-1', title: null,
  provider: 'anthropic', model: 'claude-opus-5', terminal_key: null,
  created_at: new Date('2026-08-24T10:00:00Z'), last_active_at: new Date('2026-08-24T10:05:00Z'),
};

beforeEach(() => {
  mockQuery.mockReset();
  clientQuery.mockReset();
  mockTx.mockReset();
  mockTx.mockImplementation(
    async (fn: (client: typeof fakeClient) => Promise<unknown>) => fn(fakeClient)
  );
});

describe('createSession', () => {
  it('inserts tenant- and entity-scoped with provider/model', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'sess-1' }], rowCount: 1 });
    const id = await createSession(CTX, { provider: 'anthropic', model: 'claude-opus-5' });
    expect(id).toBe('sess-1');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_sessions/);
    expect(params).toEqual(['tenant-a', 'entity-1', 'anthropic', 'claude-opus-5', null]);
  });

  it('stores the terminal key when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'sess-1' }], rowCount: 1 });
    await createSession(CTX, { provider: 'hermes', model: 'Hermes-4-405B', terminalKey: '%3' });
    expect(mockQuery.mock.calls[0][1][4]).toBe('%3');
  });
});

describe('appendMessage', () => {
  it('assigns seq = MAX+1 inside the INSERT and guards through ai_sessions', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ seq: 4 }], rowCount: 1 });
    const seq = await appendMessage('sess-1', { role: 'user', content: 'hola' });
    expect(seq).toBe(4);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/MAX\(m\.seq\)/);
    expect(sql).toMatch(/FROM ai_sessions s/);
    expect(sql).toMatch(/WHERE s\.id = \$1/);
    expect(params).toEqual(['sess-1', 'user', 'hola', null, null, null]);
  });

  it('serializes toolCalls as JSON and carries tool_name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ seq: 2 }], rowCount: 1 });
    await appendMessage('sess-1', {
      role: 'tool', content: 'result…', toolName: 'query_balance',
      toolCalls: { name: 'query_balance', input: { account: '1110' } },
    });
    const params = mockQuery.mock.calls[0][1];
    expect(params[3]).toBe('query_balance');
    expect(JSON.parse(params[4] as string)).toEqual({
      name: 'query_balance', input: { account: '1110' },
    });
  });

  it('throws when the session is not visible (rowCount 0)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(appendMessage('sess-x', { role: 'user', content: 'x' }))
      .rejects.toThrow(/does not exist in this tenant/);
  });

  it('retries a standalone 23505 unique-violation, recomputing MAX(seq)+1', async () => {
    const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockQuery
      .mockRejectedValueOnce(dup)
      .mockResolvedValueOnce({ rows: [{ seq: 5 }], rowCount: 1 });
    const seq = await appendMessage('sess-1', { role: 'user', content: 'x' });
    expect(seq).toBe(5);
    expect(mockQuery.mock.calls).toHaveLength(2); // second attempt re-runs the INSERT
  });

  it('gives up after exhausting retries on persistent 23505', async () => {
    const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockQuery.mockRejectedValue(dup);
    await expect(appendMessage('sess-1', { role: 'user', content: 'x' }))
      .rejects.toThrow(/duplicate key/);
    expect(mockQuery.mock.calls).toHaveLength(3);
  });

  it('does NOT retry inside a caller-provided transaction (aborted tx cannot re-run)', async () => {
    const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
    clientQuery.mockRejectedValueOnce(dup);
    await expect(appendMessage('sess-1', { role: 'user', content: 'x' }, fakeClient))
      .rejects.toThrow(/duplicate key/);
    expect(clientQuery.mock.calls).toHaveLength(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('touchSession / setTitleIfEmpty / updateSessionProvider', () => {
  it('touch updates last_active_at by id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await touchSession('sess-1');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SET last_active_at = NOW\(\)/);
    expect(params).toEqual(['sess-1']);
  });

  it('title is only set while NULL and truncated to 60 chars', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await setTitleIfEmpty('sess-1', 'x'.repeat(100));
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/AND title IS NULL/);
    expect(params[1]).toHaveLength(60);
  });

  it('updateSessionProvider re-points provider and model by id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await updateSessionProvider('sess-1', 'hermes', 'Hermes-4-405B');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE ai_sessions SET provider = \$2, model = \$3/);
    expect(params).toEqual(['sess-1', 'hermes', 'Hermes-4-405B']);
  });
});

describe('latestSession', () => {
  it('prefers the session of this terminal, with no liveness exclusion', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [SESSION], rowCount: 1 });
    const row = await latestSession(CTX, '%3');
    expect(row).toEqual(SESSION);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/terminal_key = \$2/);
    expect(sql).toMatch(/ORDER BY last_active_at DESC/);
    expect(sql).not.toMatch(/INTERVAL/); // own terminal may always continue
    expect(params).toEqual(['entity-1', '%3']);
    expect(mockQuery.mock.calls).toHaveLength(1); // no fallback query needed
  });

  it('falls back to the most recent NON-LIVE session of the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // terminal miss
    mockQuery.mockResolvedValueOnce({ rows: [SESSION], rowCount: 1 });
    const row = await latestSession(CTX, '%3');
    expect(row).toEqual(SESSION);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).not.toMatch(/terminal_key = /);
    // Excludes sessions another live CLI is actively appending to, so two
    // processes do not interleave into one transcript.
    expect(sql).toMatch(/last_active_at < NOW\(\) - INTERVAL '5 minutes'/);
    expect(params).toEqual(['entity-1']);
  });

  it('skips the terminal query when no key is given', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const row = await latestSession(CTX);
    expect(row).toBeNull();
    expect(mockQuery.mock.calls).toHaveLength(1);
    expect(mockQuery.mock.calls[0][0]).not.toMatch(/terminal_key = /);
  });
});

describe('getSession', () => {
  it('is entity-scoped', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [SESSION], rowCount: 1 });
    await getSession(CTX, 'sess-1');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/id = \$1 AND entity_id = \$2/);
    expect(params).toEqual(['sess-1', 'entity-1']);
  });

  it('returns null when nothing matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await getSession(CTX, 'sess-x')).toBeNull();
  });
});

describe('getSessionMessages', () => {
  it('orders by seq and scopes through ai_sessions (RLS join guard)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getSessionMessages('sess-1');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/ORDER BY seq/);
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM ai_sessions s WHERE s\.id = \$1\)/);
    expect(params).toEqual(['sess-1']);
  });
});

describe('listSessions', () => {
  it('lists entity-scoped with message counts, newest first, LIMIT parameterized', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...SESSION, message_count: 7 }], rowCount: 1 });
    const rows = await listSessions(CTX);
    expect(rows[0].message_count).toBe(7);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/COUNT\(m\.id\)::int AS message_count/);
    expect(sql).toMatch(/WHERE s\.entity_id = \$1/);
    expect(sql).toMatch(/ORDER BY s\.last_active_at DESC/);
    expect(sql).toMatch(/LIMIT \$2/);
    expect(params).toEqual(['entity-1', 20]);
  });

  it('caps the limit at 100', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await listSessions(CTX, 9999);
    expect(mockQuery.mock.calls[0][1]).toEqual(['entity-1', 100]);
  });

  it('falls back to the default on a non-finite limit (NaN never reaches SQL)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await listSessions(CTX, Number.NaN);
    expect(mockQuery.mock.calls[0][1]).toEqual(['entity-1', 20]);
  });
});

describe('recordTurn', () => {
  it('persists title, user, tool rows, assistant, and touches the session — in that order, in ONE transaction', async () => {
    // setTitleIfEmpty, user, tool, assistant, touch — all on the tx client
    clientQuery.mockResolvedValue({ rows: [{ seq: 1 }], rowCount: 1 });
    await recordTurn('sess-1', {
      userInput: 'record the August rent: 10,000 from banks',
      assistantText: 'Draft created.',
      toolUses: [{ name: 'create_draft', input: { amount: 10000 }, resultPreview: 'draft-1' }],
    });

    expect(mockTx).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled(); // nothing escapes the transaction
    expect(clientQuery.mock.calls).toHaveLength(5);
    expect(clientQuery.mock.calls[0][0]).toMatch(/SET title = \$2/);
    expect(clientQuery.mock.calls[1][1][1]).toBe('user');
    expect(clientQuery.mock.calls[2][1][1]).toBe('tool');
    expect(clientQuery.mock.calls[2][1][3]).toBe('create_draft');
    expect(clientQuery.mock.calls[2][1][2]).toBe('draft-1'); // content = result preview
    expect(JSON.parse(clientQuery.mock.calls[2][1][4] as string)).toEqual({
      name: 'create_draft', input: { amount: 10000 },
    });
    expect(clientQuery.mock.calls[3][1][1]).toBe('assistant');
    expect(clientQuery.mock.calls[3][1][2]).toBe('Draft created.');
    expect(clientQuery.mock.calls[4][0]).toMatch(/SET last_active_at/);
  });

  it('writes no tool rows on a tool-less turn', async () => {
    clientQuery.mockResolvedValue({ rows: [{ seq: 1 }], rowCount: 1 });
    await recordTurn('sess-1', { userInput: 'hola', assistantText: 'Hola.', toolUses: [] });
    // title + user + assistant + touch
    expect(clientQuery.mock.calls).toHaveLength(4);
    const roles = [clientQuery.mock.calls[1][1][1], clientQuery.mock.calls[2][1][1]];
    expect(roles).toEqual(['user', 'assistant']);
  });

  it('propagates a mid-turn failure so withTransaction rolls the whole turn back', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })            // title
      .mockResolvedValueOnce({ rows: [{ seq: 1 }], rowCount: 1 })  // user
      .mockRejectedValueOnce(new Error('connection terminated'));  // assistant fails
    await expect(
      recordTurn('sess-1', { userInput: 'hola', assistantText: 'Hola.', toolUses: [] })
    ).rejects.toThrow(/connection terminated/);
    expect(mockTx).toHaveBeenCalledTimes(1); // the real impl ROLLBACKs here
  });
});
