import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

import { getPendingBoard } from '../../src/ai/pending-service.js';
import { query } from '../../src/database/connection.js';
import type { AgentContext } from '../../src/ai/context.js';

const mockQuery = query as unknown as Mock;

const CTX: AgentContext = {
  entityId: 'entity-1', entityName: 'Acme MX', tenantId: 'tenant-a',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AME010101AAA',
};

/**
 * The 5 queries run in Promise.all, so resolution order is not call order:
 * responses are keyed by the table the SQL mentions.
 */
function mockSources(sources: {
  drafts?: unknown[]; questions?: unknown[]; ops?: unknown[];
  creds?: unknown[]; periods?: unknown[];
}) {
  // Defensive with the first argument: the runner may invoke the mock with
  // no args when clearing it, and a mock that assumes its shape breaks.
  mockQuery.mockImplementation((sql?: unknown) => {
    const q = typeof sql === 'string' ? sql : '';
    if (q.includes('ai_drafts')) return Promise.resolve({ rows: sources.drafts ?? [] });
    if (q.includes('ai_questions')) return Promise.resolve({ rows: sources.questions ?? [] });
    if (q.includes('ai_external_ops')) return Promise.resolve({ rows: sources.ops ?? [] });
    if (q.includes('fiscal_credentials')) return Promise.resolve({ rows: sources.creds ?? [] });
    if (q.includes('fiscal_periods')) return Promise.resolve({ rows: sources.periods ?? [] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => mockQuery.mockReset());

describe('getPendingBoard', () => {
  it('returns an empty board when nothing is pending', async () => {
    mockSources({});
    const board = await getPendingBoard(CTX);
    expect(board.items).toEqual([]);
    expect(board.totalWork).toBe(0);
  });

  it('aggregates the four work sources with their command', async () => {
    mockSources({
      drafts: [{ description: 'Renta', total: '2026-08-01' }],
      questions: [{ question: '¿Honorarios o mantenimiento?' }, { question: '¿IVA acreditable?' }],
      ops: [{ provider: 'contalink', operation: 'push_journal_entry' }],
      periods: [{ period_name: 'Julio 2026', end_date: '2026-07-31' }],
    });
    const board = await getPendingBoard(CTX);

    const byKind = Object.fromEntries(board.items.map((i) => [i.kind, i]));
    expect(byKind.draft.command).toBe('mnemosine review');
    expect(byKind.question.command).toBe('mnemosine questions');
    expect(byKind.external_op.command).toBe('mnemosine outbox');
    expect(byKind.period_close.command).toBe('mnemosine close');
    // 1 draft + 2 questions + 1 op + 1 period
    expect(board.totalWork).toBe(5);
  });

  it('uses correct singular and plural', async () => {
    mockSources({ drafts: [{ description: 'x', total: '2026-08-01' }] });
    let board = await getPendingBoard(CTX);
    expect(board.items[0].summary).toBe('1 draft awaits your approval');

    mockSources({ drafts: [{ description: 'x', total: 'd' }, { description: 'y', total: 'd' }] });
    board = await getPendingBoard(CTX);
    expect(board.items[0].summary).toBe('2 drafts await your approval');
  });

  it('an expiring e.firma is a WARNING, not work', async () => {
    mockSources({ creds: [{ credential_type: 'efirma', days: '23' }] });
    const board = await getPendingBoard(CTX);
    expect(board.items[0].warning).toBe(true);
    expect(board.items[0].summary).toMatch(/e\.firma expires in 23 days/);
    expect(board.totalWork).toBe(0); // does not count toward actionable work
  });

  it('warns differently when the credential has ALREADY expired', async () => {
    mockSources({ creds: [{ credential_type: 'efirma', days: '-4' }] });
    const board = await getPendingBoard(CTX);
    expect(board.items[0].summary).toMatch(/ALREADY EXPIRED/);
  });

  it('limits examples to 3 even when there are more', async () => {
    mockSources({
      questions: Array.from({ length: 7 }, (_, i) => ({ question: `duda ${i}` })),
    });
    const board = await getPendingBoard(CTX);
    expect(board.items[0].count).toBe(7);
    expect(board.items[0].examples).toHaveLength(3);
  });

  it('puts warnings last (work first)', async () => {
    mockSources({
      drafts: [{ description: 'x', total: 'd' }],
      creds: [{ credential_type: 'efirma', days: '10' }],
    });
    const board = await getPendingBoard(CTX);
    expect(board.items[board.items.length - 1].kind).toBe('credential_expiry');
  });

  it('scopes every query to the session entity', async () => {
    mockSources({});
    await getPendingBoard(CTX);
    const realCalls = mockQuery.mock.calls.filter((c) => typeof c[0] === 'string');
    expect(realCalls).toHaveLength(5);
    for (const call of realCalls) {
      expect(call[1]).toEqual(['entity-1']);
      expect(String(call[0])).toMatch(/entity_id = \$1/);
    }
  });
});
