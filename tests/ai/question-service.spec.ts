import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import {
  createQuestion,
  answerQuestion,
  dismissQuestion,
  recordAnsweredQuestion,
  listQuestions,
  searchPrecedents,
} from '../../src/ai/question-service.js';
import { query } from '../../src/database/connection.js';
import type { AgentContext } from '../../src/ai/context.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

const CTX: AgentContext = {
  entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  entityName: 'Acme MX',
  tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'AME010101AAA',
};

describe('createQuestion', () => {
  beforeEach(() => mockQuery.mockReset());

  it('inserts a pending question with options as JSONB', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const id = await createQuestion(CTX, {
      question: '¿Qué cuenta uso para Servicios Integrales SA?',
      context: 'Factura por $45,000, proveedor sin historial',
      options: ['5205 Honorarios', '5310 Mantenimiento'],
      topic: 'clasificacion:Servicios Integrales SA',
      model: 'claude-opus-5',
      userRequest: 'registra la factura de servicios integrales',
    });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_questions/);
    expect(sql).toMatch(/'pending'/);
    expect(params[1]).toBe(CTX.tenantId);
    expect(params[2]).toBe(CTX.entityId);
    expect(JSON.parse(params[5] as string)).toEqual(['5205 Honorarios', '5310 Mantenimiento']);
    expect(params[6]).toBe('clasificacion:Servicios Integrales SA');
  });
});

describe('answerQuestion', () => {
  beforeEach(() => mockQuery.mockReset());

  it('answers with a guarded pending-only update', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await answerQuestion(CTX, 'q-1', '5205 Honorarios', 'admin@demo.com');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SET status = 'answered'/);
    expect(sql).toMatch(/status = 'pending'/);
    expect(params).toEqual(['5205 Honorarios', 'admin@demo.com', true, 'q-1', CTX.entityId]);
  });

  it('throws when the question is not pending anymore', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(answerQuestion(CTX, 'q-1', 'x', 'e')).rejects.toThrow(/No pending question/);
  });
});

describe('dismissQuestion', () => {
  beforeEach(() => mockQuery.mockReset());

  it('dismisses only pending questions', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await dismissQuestion(CTX, 'q-1', 'admin@demo.com');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/'dismissed'/);
    expect(sql).toMatch(/status = 'pending'/);
  });
});

describe('recordAnsweredQuestion', () => {
  beforeEach(() => mockQuery.mockReset());

  it('stores an already-answered exchange (inline chat answer)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await recordAnsweredQuestion(CTX, {
      question: '¿Honorarios o mantenimiento?',
      answer: '5205 Honorarios',
      answeredBy: 'chat',
      model: 'claude-opus-5',
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/'answered'/);
    expect(params).toContain('5205 Honorarios');
    expect(params).toContain('chat');
  });
});

describe('searchPrecedents', () => {
  beforeEach(() => mockQuery.mockReset());

  it('matches answered precedents by text, scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'q-1', question: 'x', answer: 'y' }] });
    const rows = await searchPrecedents(CTX, 'Servicios Integrales');
    expect(rows).toHaveLength(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/status = 'answered'/);
    expect(sql).toMatch(/is_precedent = true/);
    expect(sql).toMatch(/ILIKE \$2/);
    expect(sql).toMatch(/LIMIT 20/);
    expect(params).toEqual([CTX.entityId, '%Servicios Integrales%']);
  });

  it('escapes LIKE metacharacters in the model-supplied term', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await searchPrecedents(CTX, 'IVA 16% S_A');
    const [, params] = mockQuery.mock.calls[0];
    expect(params[1]).toBe('%IVA 16\\% S\\_A%');
  });
});

describe('listQuestions', () => {
  beforeEach(() => mockQuery.mockReset());

  it('filters by status and orders oldest-first', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listQuestions(CTX, 'pending');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/status = \$2/);
    expect(sql).toMatch(/ORDER BY created_at ASC/);
    expect(params).toEqual([CTX.entityId, 'pending']);
  });
});
