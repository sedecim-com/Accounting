import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/ai/draft-service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/ai/draft-service.js')>();
  return {
    ...original,
    createDraft: vi.fn(),
    listDrafts: vi.fn(),
  };
});

import { buildDraftTools } from '../../../src/ai/tools/draft-tools.js';
import { createDraft, listDrafts, DraftValidationError } from '../../../src/ai/draft-service.js';
import type { AgentContext } from '../../../src/ai/context.js';
import type { DraftCreatedInfo } from '../../../src/ai/tools/observer.js';
import type { BetaTool, BetaToolResultContentBlockParam } from '@anthropic-ai/sdk/resources/beta';

/**
 * The concrete shape `betaZodTool` produces: a plain `BetaTool` plus `run`.
 * The builders return a union over many different input schemas and a tool is
 * looked up here by a runtime name string, which TypeScript cannot map back to
 * a single union member — so `run` on the raw union demands the intersection of
 * every tool's schema at once.
 */
type ToolHandle<Input = Record<string, unknown>> = BetaTool & {
  run: (input: Input) => Promise<string | BetaToolResultContentBlockParam[]>;
};

const mockCreateDraft = createDraft as unknown as ReturnType<typeof vi.fn>;
const mockListDrafts = listDrafts as unknown as ReturnType<typeof vi.fn>;

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
  entry_date: '2026-08-01',
  description: 'Renta agosto',
  confidence: 0.9,
  reasoning: 'Precedente JE-31',
  lines: [
    { account_code: '5201', debit: 10000 },
    { account_code: '1101', credit: 10000 },
  ],
};

function getTool(name: string, onDraftCreated?: (info: DraftCreatedInfo) => void): ToolHandle {
  const tool = buildDraftTools(CTX, {
    model: 'claude-opus-5',
    onDraftCreated,
  }).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool as ToolHandle;
}

describe('draft_journal_entry tool', () => {
  beforeEach(() => {
    mockCreateDraft.mockReset();
    mockListDrafts.mockReset();
  });

  it('creates a draft and tells the model it is NOT posted', async () => {
    mockCreateDraft.mockResolvedValueOnce({ id: 'draft-1', totalDebits: '10000.00', totalCredits: '10000.00' });
    const created: unknown[] = [];
    const out = await getTool('draft_journal_entry', (info) => created.push(info)).run(INPUT);
    const parsed = JSON.parse(out as string);
    expect(parsed.draft_id).toBe('draft-1');
    expect(parsed.status).toBe('pending_review');
    expect(parsed.message).toMatch(/mnemosine review/);

    const [ctxArg, inputArg] = mockCreateDraft.mock.calls[0];
    expect(ctxArg.entityId).toBe(CTX.entityId);
    expect(inputArg.model).toBe('claude-opus-5');
    expect(inputArg.payload.lines).toHaveLength(2);

    // Harness hook fired with the info the ingest thresholds need
    expect(created).toEqual([
      { draftId: 'draft-1', confidence: 0.9, totalDebits: '10000.00', totalCredits: '10000.00' },
    ]);
  });

  it('returns validation errors as actionable text instead of throwing', async () => {
    mockCreateDraft.mockRejectedValueOnce(new DraftValidationError(['The journal entry does not balance: debits 10000.00 vs credits 9000.00']));
    const out = await getTool('draft_journal_entry').run(INPUT);
    expect(out).toMatch(/REJECTED by validation/);
    expect(out).toMatch(/does not balance/);
  });

  it('propagates unexpected errors (runner reports them as tool errors)', async () => {
    mockCreateDraft.mockRejectedValueOnce(new Error('db down'));
    await expect(getTool('draft_journal_entry').run(INPUT)).rejects.toThrow('db down');
  });
});

describe('list_drafts tool', () => {
  beforeEach(() => mockListDrafts.mockReset());

  it('summarizes drafts with status and review notes', async () => {
    mockListDrafts.mockResolvedValueOnce([
      {
        id: 'draft-1', status: 'rejected', created_at: new Date('2026-08-01'),
        payload: { entry_date: '2026-08-01', description: 'Renta', lines: [{}, {}] },
        ai_confidence: '0.90', journal_entry_id: null, review_notes: 'Wrong account',
      },
    ]);
    const parsed = JSON.parse((await getTool('list_drafts').run({ status: 'rejected' })) as string);
    expect(parsed.count).toBe(1);
    expect(parsed.drafts[0].review_notes).toBe('Wrong account');
    expect(mockListDrafts.mock.calls[0][1]).toBe('rejected');
  });

  it('reports emptiness plainly', async () => {
    mockListDrafts.mockResolvedValueOnce([]);
    const out = await getTool('list_drafts').run({});
    expect(out).toMatch(/No drafts/);
  });
});
