import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(), enterTenant: vi.fn(), currentTenant: vi.fn(),
}));

import {
  listMemory, getMemoryEntry, correctMemory, retireMemory, restoreMemory,
  teachMemory, memoryStats, buildMemoryDigest,
} from '../../src/ai/memory-service.js';
import { query } from '../../src/database/connection.js';
import type { AgentContext } from '../../src/ai/context.js';

const mockQuery = query as unknown as Mock;
const CTX: AgentContext = {
  entityId: 'entity-1', entityName: 'Acme', tenantId: 'tenant-a',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AME010101AAA',
};

const ENTRY = {
  id: 'mem-1', question: '¿Honorarios o mantenimiento?', answer: '5205 Honorarios',
  context: null, topic: 'clasificacion:X', answered_by: 'admin@demo.com',
  answered_at: new Date('2026-08-01'), is_precedent: true,
};

beforeEach(() => mockQuery.mockReset());

describe('listMemory', () => {
  it('filters only active precedents by default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ENTRY] });
    await listMemory(CTX);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/is_precedent = true/);
    expect(sql).toMatch(/status = 'answered'/);
    expect(params).toEqual(['entity-1']);
  });

  it('includes retired ones with onlyActive:false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listMemory(CTX, { onlyActive: false });
    expect(mockQuery.mock.calls[0][0]).not.toMatch(/is_precedent = true/);
  });

  it('escapes LIKE metacharacters in the search', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listMemory(CTX, { search: 'IVA 16% S_A' });
    expect(mockQuery.mock.calls[0][1]).toEqual(['entity-1', '%IVA 16\\% S\\_A%']);
  });

  it('caps the limit at 200', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listMemory(CTX, { limit: 9999 });
    expect(mockQuery.mock.calls[0][0]).toMatch(/LIMIT 200/);
  });
});

describe('correctMemory', () => {
  it('preserves the previous answer in the context (audit trail)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ENTRY] });                    // getMemoryEntry
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ENTRY, answer: '6130' }], rowCount: 1 });
    await correctMemory(CTX, 'mem-1', '6130 Servicios', 'jefe@demo.com');

    const [, params] = mockQuery.mock.calls[1];
    expect(params[0]).toBe('6130 Servicios');
    expect(String(params[1])).toMatch(/previously said: 5205 Honorarios/);
    expect(String(params[1])).toMatch(/by jefe@demo\.com/);
  });

  it('accumulates on top of the previous context without losing it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ENTRY, context: 'nota original' }] });
    mockQuery.mockResolvedValueOnce({ rows: [ENTRY], rowCount: 1 });
    await correctMemory(CTX, 'mem-1', 'nueva', 'x@y.com');
    expect(String(mockQuery.mock.calls[1][1][1])).toMatch(/^nota original\n\[corrected/);
  });

  it('does not write when the answer is identical', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ENTRY] });
    const r = await correctMemory(CTX, 'mem-1', ENTRY.answer, 'x@y.com');
    expect(r).toEqual(ENTRY);
    expect(mockQuery.mock.calls).toHaveLength(1); // only the SELECT
  });

  it('fails when the precedent does not exist in the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(correctMemory(CTX, 'nope', 'x', 'y@z.com')).rejects.toThrow(/does not exist in this entity/);
  });
});

describe('retireMemory', () => {
  it('deactivates without deleting and records who and when', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await retireMemory(CTX, 'mem-1', 'jefe@demo.com');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SET is_precedent = false/);
    expect(sql).not.toMatch(/DELETE/);
    expect(sql).toMatch(/retired/);
    expect(params).toEqual(['jefe@demo.com', 'mem-1', 'entity-1']);
  });

  it('requires it to be active (no re-retiring)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    await expect(retireMemory(CTX, 'mem-1', 'x@y.com')).rejects.toThrow(/active precedent/);
    expect(mockQuery.mock.calls[0][0]).toMatch(/is_precedent = true/);
  });
});

describe('restoreMemory', () => {
  it('reactivates only retired ones', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await restoreMemory(CTX, 'mem-1');
    expect(mockQuery.mock.calls[0][0]).toMatch(/is_precedent = false/);
  });

  it('fails when there was no retired one with that id', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    await expect(restoreMemory(CTX, 'mem-1')).rejects.toThrow(/retired/);
  });
});

describe('teachMemory', () => {
  it('creates an active precedent marked as human-taught', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new-1' }] });
    const id = await teachMemory(CTX, {
      rule: 'facturas de Telmex', criterion: 'van a 6130',
      topic: 'clasificacion:Telmex', taughtBy: 'jefe@demo.com',
    });
    expect(id).toBe('new-1');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/'answered'/);
    expect(sql).toMatch(/'human-taught'/);
    expect(params).toEqual([
      'tenant-a', 'entity-1', 'facturas de Telmex', 'van a 6130',
      'clasificacion:Telmex', 'jefe@demo.com',
    ]);
  });
});

describe('buildMemoryDigest', () => {
  const row = (i: number, over: Partial<Record<string, unknown>> = {}) => ({
    topic: `topic-${i}`, question: `question-${i}`, answer: `answer-${i}`,
    answered_by: 'admin@demo.com', answered_at: new Date('2026-08-10'), ...over,
  });

  it('queries only active precedents of the entity, newest first', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await buildMemoryDigest(CTX);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/entity_id = \$1/);
    expect(sql).toMatch(/status = 'answered'/);
    expect(sql).toMatch(/is_precedent = true/);
    expect(sql).toMatch(/ORDER BY answered_at DESC/);
    expect(params).toEqual(['entity-1']);
  });

  it('renders compact lines topic: answer (by, date), newest first', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row(1), row(2)] });
    const digest = await buildMemoryDigest(CTX);
    expect(digest.split('\n')).toEqual([
      'topic-1: answer-1 (admin@demo.com, 2026-08-10)',
      'topic-2: answer-2 (admin@demo.com, 2026-08-10)',
    ]);
  });

  it('falls back to the question when topic is null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row(1, { topic: null })] });
    expect(await buildMemoryDigest(CTX)).toMatch(/^question-1: answer-1/);
  });

  it('returns empty string when there are no precedents', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await buildMemoryDigest(CTX)).toBe('');
  });

  it('cuts at the char budget with a note, keeping the newest entries', async () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row(i, { answer: 'x'.repeat(200) })
    );
    mockQuery.mockResolvedValueOnce({ rows });
    const digest = await buildMemoryDigest(CTX, 1000);
    expect(digest.length).toBeLessThanOrEqual(1000);
    expect(digest).toMatch(/\[memory truncated at budget — use search_precedents for older criteria\]$/);
    // Newest (first) entries survive; the oldest were the ones cut
    expect(digest).toContain('topic-0:');
    expect(digest).not.toContain('topic-39:');
  });

  it('does not append the note when everything fits', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row(1)] });
    expect(await buildMemoryDigest(CTX)).not.toMatch(/truncated/);
  });
});

describe('memoryStats', () => {
  it('counts active, retired and taught, with frequent topics', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ active: '5', retired: '2', taught: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ topic: 'clasificacion:X', count: '3' }] });
    const s = await memoryStats(CTX);
    expect(s).toEqual({
      active: 5, retired: 2, taught: 1,
      topics: [{ topic: 'clasificacion:X', count: 3 }],
    });
  });
});

describe('entity isolation', () => {
  it('all operations filter by entity_id', async () => {
    mockQuery.mockResolvedValue({ rows: [ENTRY], rowCount: 1 });
    await listMemory(CTX);
    await getMemoryEntry(CTX, 'mem-1');
    await retireMemory(CTX, 'mem-1', 'x@y.com');
    await restoreMemory(CTX, 'mem-1');
    for (const call of mockQuery.mock.calls) {
      expect(String(call[0])).toMatch(/entity_id = \$\d/);
      expect(call[1]).toContain('entity-1');
    }
  });
});
