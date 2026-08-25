import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/ai/question-service.js', () => ({
  createQuestion: vi.fn(),
  recordAnsweredQuestion: vi.fn(),
  searchPrecedents: vi.fn(),
}));

import { buildQuestionTools } from '../../../src/ai/tools/question-tools.js';
import {
  createQuestion,
  recordAnsweredQuestion,
  searchPrecedents,
} from '../../../src/ai/question-service.js';
import type { AgentContext } from '../../../src/ai/context.js';
import type { BetaTool, BetaToolResultContentBlockParam } from '@anthropic-ai/sdk/resources/beta';

/**
 * The concrete shape `betaZodTool` produces: a plain `BetaTool` plus `run`.
 * The builders return a union over many different input schemas and a tool is
 * looked up here by a runtime name string, which TypeScript cannot map back to
 * a single union member — so `run` on the raw union demands the intersection of
 * every tool's schema at once.
 */
type ToolHandle<Input> = BetaTool & {
  run: (input: Input) => Promise<string | BetaToolResultContentBlockParam[]>;
};

/** Mirrors the zod inputSchema of each tool in `buildQuestionTools`. */
type AskUserInput = { question: string; context?: string; options?: string[]; topic?: string };
type SearchPrecedentsInput = { search: string };

const mockCreate = createQuestion as unknown as ReturnType<typeof vi.fn>;
const mockRecord = recordAnsweredQuestion as unknown as ReturnType<typeof vi.fn>;
const mockSearch = searchPrecedents as unknown as ReturnType<typeof vi.fn>;

const CTX: AgentContext = {
  entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  entityName: 'Acme MX',
  tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'AME010101AAA',
};

const INPUT = {
  question: '¿Honorarios (5205) o mantenimiento (5310)?',
  context: 'Proveedor nuevo, factura $45,000',
  options: ['5205 Honorarios', '5310 Mantenimiento'],
  topic: 'clasificacion:Servicios Integrales SA',
};

beforeEach(() => {
  mockCreate.mockReset();
  mockRecord.mockReset();
  mockSearch.mockReset();
});

describe('ask_user (interactive)', () => {
  it('returns the human answer and records it as a precedent', async () => {
    mockRecord.mockResolvedValueOnce('prec-1');
    const askUser = vi.fn().mockResolvedValueOnce('5205 Honorarios');
    const tool = buildQuestionTools(CTX, { model: 'claude-opus-5', askUser })
      .find((t) => t.name === 'ask_user')! as ToolHandle<AskUserInput>;

    const parsed = JSON.parse((await tool.run(INPUT)) as string);
    expect(parsed.answered).toBe(true);
    expect(parsed.answer).toBe('5205 Honorarios');
    expect(parsed.precedent_id).toBe('prec-1');

    expect(askUser).toHaveBeenCalledWith({
      question: INPUT.question,
      context: INPUT.context,
      options: INPUT.options,
    });
    const recordArgs = mockRecord.mock.calls[0][1];
    expect(recordArgs.answer).toBe('5205 Honorarios');
    expect(recordArgs.topic).toBe(INPUT.topic);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('falls back to a pending question when the human declines (null)', async () => {
    mockCreate.mockResolvedValueOnce('q-1');
    const askUser = vi.fn().mockResolvedValueOnce(null);
    const tool = buildQuestionTools(CTX, { model: 'claude-opus-5', askUser })
      .find((t) => t.name === 'ask_user')! as ToolHandle<AskUserInput>;

    const parsed = JSON.parse((await tool.run(INPUT)) as string);
    expect(parsed.answered).toBe(false);
    expect(parsed.question_id).toBe('q-1');
    expect(parsed.note).toMatch(/mnemosine questions/);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('ask_user (non-interactive)', () => {
  it('persists a pending question and tells the model not to invent data', async () => {
    mockCreate.mockResolvedValueOnce('q-2');
    const tool = buildQuestionTools(CTX, { model: 'claude-opus-5' })
      .find((t) => t.name === 'ask_user')! as ToolHandle<AskUserInput>;

    const parsed = JSON.parse((await tool.run(INPUT)) as string);
    expect(parsed.answered).toBe(false);
    expect(parsed.note).toMatch(/WITHOUT inventing/);
    const createArgs = mockCreate.mock.calls[0][1];
    expect(createArgs.question).toBe(INPUT.question);
    expect(createArgs.options).toEqual(INPUT.options);
  });
});

describe('search_precedents', () => {
  it('returns formatted precedents', async () => {
    mockSearch.mockResolvedValueOnce([
      {
        id: 'q-1', question: '¿Honorarios?', answer: '5205', context: null,
        topic: 'clasificacion:X', answered_by: 'admin@demo.com',
        answered_at: new Date('2026-08-01'), is_precedent: true,
      },
    ]);
    const tool = buildQuestionTools(CTX, { model: 'claude-opus-5' })
      .find((t) => t.name === 'search_precedents')! as ToolHandle<SearchPrecedentsInput>;
    const parsed = JSON.parse((await tool.run({ search: 'honorarios' })) as string);
    expect(parsed.count).toBe(1);
    expect(parsed.precedents[0].answer).toBe('5205');
  });

  it('reports emptiness plainly', async () => {
    mockSearch.mockResolvedValueOnce([]);
    const tool = buildQuestionTools(CTX, { model: 'claude-opus-5' })
      .find((t) => t.name === 'search_precedents')! as ToolHandle<SearchPrecedentsInput>;
    expect(await tool.run({ search: 'nada' })).toMatch(/No precedents/);
  });
});
