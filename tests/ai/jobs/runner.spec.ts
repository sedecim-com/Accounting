import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(), enterTenant: vi.fn(), currentTenant: vi.fn(),
}));

import { runDueJobs, buildJobPrompt } from '../../../src/ai/jobs/runner.js';
import type { JobRow } from '../../../src/ai/jobs/job-store.js';
import type { GateResult } from '../../../src/ai/jobs/wake-gate.js';
import type { AgentContext } from '../../../src/ai/context.js';

const CTX: AgentContext = {
  entityId: 'entity-1', entityName: 'Acme', tenantId: 'tenant-a',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AME010101AAA',
};

const JOB: JobRow = {
  id: 'job-1', entity_id: 'entity-1', name: 'nightly-close', kind: 'close_verification',
  schedule: '0 2 * * *', enabled: true, consecutive_failures: 0, max_failures: 3,
  last_run_at: null, next_run_at: new Date(), created_by: null, created_at: new Date(),
};

const WORK: GateResult = {
  hasWork: true,
  context: '2 unbalanced non-posted journal entries (e.g. JE-001, JE-002)',
  counts: { unbalanced_entries: 2, overdue_open_periods: 0 },
  sampleIds: ['je-1', 'je-2'],
};

const NO_WORK: GateResult = {
  hasWork: false, context: 'No unbalanced entries and no overdue open periods.',
  counts: { unbalanced_entries: 0, overdue_open_periods: 0 }, sampleIds: [],
};

function makeDeps(overrides: Partial<Record<'claim' | 'gate' | 'record' | 'runAgentTurn', ReturnType<typeof vi.fn>>> = {}) {
  return {
    claim: overrides.claim ?? vi.fn().mockResolvedValue([JOB]),
    gate: overrides.gate ?? vi.fn().mockResolvedValue(WORK),
    record: overrides.record ?? vi.fn().mockResolvedValue({ runId: 'run-1', autoDisabled: false }),
    runAgentTurn: overrides.runAgentTurn ?? vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildJobPrompt', () => {
  it('threads the gate context and the kind instructions into the prompt', () => {
    const prompt = buildJobPrompt(JOB, WORK);
    expect(prompt).toContain('nightly-close');
    expect(prompt).toContain(WORK.context);
    expect(prompt).toMatch(/draft_journal_entry/);
    expect(prompt).toMatch(/staged draft or a logged question/);
  });
});

describe('runDueJobs', () => {
  it('no work → records skipped_no_work and NEVER invokes the agent', async () => {
    const deps = makeDeps({ gate: vi.fn().mockResolvedValue(NO_WORK) });
    const outcomes = await runDueJobs(CTX, deps);

    expect(deps.runAgentTurn).not.toHaveBeenCalled();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('skipped_no_work');
    expect(deps.record).toHaveBeenCalledWith(CTX, 'job-1', expect.objectContaining({
      status: 'skipped_no_work',
      detail: expect.objectContaining({ gate: NO_WORK.counts }),
    }));
  });

  it('work → wakes the agent with the gate-seeded prompt and counts captured drafts', async () => {
    const runAgentTurn = vi.fn().mockImplementation(async ({ capture }) => {
      capture.drafts.push(
        { draftId: 'd-1', confidence: 0.9, totalDebits: '100.00', totalCredits: '100.00' },
        { draftId: 'd-2', confidence: 0.8, totalDebits: '50.00', totalCredits: '50.00' },
      );
    });
    const deps = makeDeps({ runAgentTurn });
    const outcomes = await runDueJobs(CTX, deps);

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    const call = runAgentTurn.mock.calls[0][0];
    expect(call.job.id).toBe('job-1');
    expect(call.prompt).toContain(WORK.context); // gate context seeds the prompt

    expect(outcomes[0].status).toBe('ok');
    expect(outcomes[0].draftsCreated).toBe(2);
    expect(deps.record).toHaveBeenCalledWith(CTX, 'job-1', expect.objectContaining({
      status: 'ok', draftsCreated: 2,
      detail: expect.objectContaining({ drafts: ['d-1', 'd-2'] }),
    }));
  });

  it('agent failure → records error (backoff counter in the store) and surfaces auto-disable', async () => {
    const deps = makeDeps({
      runAgentTurn: vi.fn().mockRejectedValue(new Error('provider down')),
      record: vi.fn().mockResolvedValue({ runId: 'run-1', autoDisabled: true }),
    });
    const outcomes = await runDueJobs(CTX, deps);

    expect(outcomes[0].status).toBe('error');
    expect(outcomes[0].detail).toMatch(/provider down/);
    expect(outcomes[0].autoDisabled).toBe(true);
    expect(deps.record).toHaveBeenCalledWith(CTX, 'job-1', expect.objectContaining({
      status: 'error',
      detail: expect.objectContaining({ phase: 'agent', error: 'provider down' }),
    }));
  });

  it('wake-gate failure → records error without ever invoking the agent', async () => {
    const deps = makeDeps({ gate: vi.fn().mockRejectedValue(new Error('relation missing')) });
    const outcomes = await runDueJobs(CTX, deps);

    expect(deps.runAgentTurn).not.toHaveBeenCalled();
    expect(outcomes[0].status).toBe('error');
    expect(deps.record).toHaveBeenCalledWith(CTX, 'job-1', expect.objectContaining({
      status: 'error',
      detail: expect.objectContaining({ phase: 'wake_gate' }),
    }));
  });

  it('one failing job does not stop the rest of the tick', async () => {
    const job2 = { ...JOB, id: 'job-2', name: 'ar-chase', kind: 'ar_reminders' as const };
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue([JOB, job2]),
      runAgentTurn: vi.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined),
    });
    const outcomes = await runDueJobs(CTX, deps);
    expect(outcomes.map((o) => o.status)).toEqual(['error', 'ok']);
  });

  it('a recordRun failure does not abort the tick: remaining jobs still run and record', async () => {
    const job2 = { ...JOB, id: 'job-2', name: 'ar-chase', kind: 'ar_reminders' as const };
    const record = vi.fn()
      .mockRejectedValueOnce(new Error('ai_job_runs insert failed'))
      .mockResolvedValueOnce({ runId: 'run-2', autoDisabled: false });
    const deps = makeDeps({ claim: vi.fn().mockResolvedValue([JOB, job2]), record });
    const outcomes = await runDueJobs(CTX, deps);

    expect(outcomes).toHaveLength(2);
    // Job 1 ran (status ok) but its bookkeeping failed — surfaced, not thrown.
    expect(outcomes[0].status).toBe('ok');
    expect(outcomes[0].recordError).toMatch(/ai_job_runs insert failed/);
    // Job 2 still ran AND recorded its outcome.
    expect(outcomes[1].status).toBe('ok');
    expect(outcomes[1].recordError).toBeUndefined();
    expect(deps.runAgentTurn).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('a recordRun failure on the error path still lets the next job run', async () => {
    const job2 = { ...JOB, id: 'job-2', name: 'ar-chase', kind: 'ar_reminders' as const };
    const record = vi.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ runId: 'run-2', autoDisabled: false });
    const deps = makeDeps({
      claim: vi.fn().mockResolvedValue([JOB, job2]),
      runAgentTurn: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined),
      record,
    });
    const outcomes = await runDueJobs(CTX, deps);
    expect(outcomes.map((o) => o.status)).toEqual(['error', 'ok']);
    expect(outcomes[0].recordError).toMatch(/db down/);
    expect(outcomes[0].autoDisabled).toBe(false); // fail closed: unknown ≠ disabled
    expect(outcomes[1].recordError).toBeUndefined();
  });

  it('no due jobs → no gate, no agent, no records', async () => {
    const deps = makeDeps({ claim: vi.fn().mockResolvedValue([]) });
    const outcomes = await runDueJobs(CTX, deps);
    expect(outcomes).toEqual([]);
    expect(deps.gate).not.toHaveBeenCalled();
    expect(deps.runAgentTurn).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
  });
});
