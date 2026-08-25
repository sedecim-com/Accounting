import { claimDueJobs, recordRun, type JobKind, type JobRow } from './job-store.js';
import { checkForWork, type GateResult } from './wake-gate.js';
import type { AgentContext } from '../context.js';
import type { DraftCapture } from '../ingest-service.js';

// ============================================================
// JOB RUNNER — the `mnemosine jobs run-due` tick.
// For each atomically claimed due job:
//   1. wake-gate (deterministic SQL): no work → the run is
//      recorded as 'skipped_no_work' and the LLM is NEVER
//      invoked (token cost ~0).
//   2. work → an ISOLATED one-shot agent session (injected
//      runAgentTurn; the runner never imports the CLI) with a
//      kind-specific prompt seeded from the gate context.
// The runner itself NEVER writes the ledger or external systems:
// every agent outcome lands as reviewable drafts/questions via
// the staged tools; drafts_created is counted through the same
// DraftCapture pattern the ingest pipeline uses.
// ============================================================

/**
 * Isolated one-shot agent turn. The CLI wires this to a fresh LlmSession
 * whose SessionCallbacks.onDraftCreated pushes into `capture.drafts`
 * (see `mnemosine ask` in src/cli/mnemosine.ts for the session shape).
 */
export type RunAgentTurn = (opts: {
  job: JobRow;
  prompt: string;
  capture: DraftCapture;
}) => Promise<void>;

export interface RunnerDeps {
  runAgentTurn: RunAgentTurn;
  /** Test seams; production uses the real store/gate. */
  claim?: typeof claimDueJobs;
  gate?: typeof checkForWork;
  record?: typeof recordRun;
  onProgress?: (message: string) => void;
}

export interface JobRunOutcome {
  jobId: string;
  name: string;
  kind: JobKind;
  status: 'ok' | 'skipped_no_work' | 'error';
  detail: string;
  draftsCreated: number;
  /** true when this run's failure reached max_failures and disabled the job. */
  autoDisabled: boolean;
  /**
   * Set when persisting this run to ai_job_runs itself failed. The tick
   * still processed the remaining claimed jobs; the outcome carries the
   * bookkeeping error so the operator sees the gap in the history.
   */
  recordError?: string;
}

const KIND_INSTRUCTIONS: Record<JobKind, string> = {
  close_verification:
    'Verify the month-end close blockers found by the deterministic scan. ' +
    'Investigate each unbalanced entry and each overdue open period with the read tools ' +
    '(search_journal_entries, reports). For every correction you can justify, create a DRAFT ' +
    'journal entry (draft_journal_entry) for human review; for anything ambiguous, log a ' +
    'question with ask_user. Do not assume anything not visible in the ledger.',
  cfdi_reconciliation:
    'Reconcile the CFDI XML documents that have no matching journal entry yet. ' +
    'For each pending CFDI, search precedents and prior entries for the issuer, then create ' +
    'a DRAFT journal entry (draft_journal_entry) for human review. If a CFDI cannot be ' +
    'classified, log a question with ask_user instead of guessing.',
  ar_reminders:
    'Review the overdue accounts-receivable invoices found by the deterministic scan. ' +
    'Verify each balance against the ledger, then stage reminder follow-ups as reviewable ' +
    'output: draft any needed adjustment entries (draft_journal_entry) and log a question ' +
    '(ask_user) listing the customers to contact, so a human sends the reminders. ' +
    'Never contact anyone directly.',
};

/** Kind-specific prompt seeded with the wake-gate's parsed summary. */
export function buildJobPrompt(job: JobRow, gate: GateResult): string {
  return (
    `Scheduled job "${job.name}" (${job.kind}) woke you because the deterministic ` +
    `pre-check found work:\n\n${gate.context}\n\n` +
    `${KIND_INSTRUCTIONS[job.kind]}\n\n` +
    'This is an unattended run: every outcome must be a staged draft or a logged question ' +
    'for human review — never assume a human is watching this session.'
  );
}

/**
 * One tick: claim every due job, gate each one, wake the agent only when
 * the gate found work, and record every run. A failure in one job never
 * stops the others — including a failure in recordRun itself: every
 * record call is wrapped so a broken ai_job_runs insert on one job still
 * lets the remaining claimed jobs run and record their outcomes; the
 * bookkeeping error lands on the outcome as `recordError`.
 */
export async function runDueJobs(ctx: AgentContext, deps: RunnerDeps): Promise<JobRunOutcome[]> {
  const claim = deps.claim ?? claimDueJobs;
  const gate = deps.gate ?? checkForWork;
  const record = deps.record ?? recordRun;

  /** recordRun that can never throw the tick down: errors become data. */
  const safeRecord = async (
    jobId: string,
    input: Parameters<typeof recordRun>[2]
  ): Promise<{ autoDisabled: boolean; recordError?: string }> => {
    try {
      const { autoDisabled } = await record(ctx, jobId, input);
      return { autoDisabled };
    } catch (err) {
      const message = (err as Error).message;
      deps.onProgress?.(`Failed to record run for job ${jobId}: ${message}`);
      return { autoDisabled: false, recordError: message };
    }
  };

  const jobs = await claim(ctx);
  const outcomes: JobRunOutcome[] = [];

  for (const job of jobs) {
    const startedAt = new Date();
    deps.onProgress?.(`Running job "${job.name}" (${job.kind})…`);

    let gateResult: GateResult;
    try {
      gateResult = await gate(ctx, job.kind);
    } catch (err) {
      const message = (err as Error).message;
      const { autoDisabled, recordError } = await safeRecord(job.id, {
        status: 'error', startedAt, finishedAt: new Date(),
        detail: { phase: 'wake_gate', error: message },
      });
      outcomes.push({
        jobId: job.id, name: job.name, kind: job.kind,
        status: 'error', detail: `wake-gate failed: ${message}`,
        draftsCreated: 0, autoDisabled, recordError,
      });
      continue;
    }

    if (!gateResult.hasWork) {
      // The pre-gate short-circuit: the LLM is never invoked on empty cycles.
      const { recordError } = await safeRecord(job.id, {
        status: 'skipped_no_work', startedAt, finishedAt: new Date(),
        detail: { gate: gateResult.counts, summary: gateResult.context },
      });
      outcomes.push({
        jobId: job.id, name: job.name, kind: job.kind,
        status: 'skipped_no_work', detail: gateResult.context,
        draftsCreated: 0, autoDisabled: false, recordError,
      });
      continue;
    }

    const capture: DraftCapture = { drafts: [] };
    try {
      await deps.runAgentTurn({ job, prompt: buildJobPrompt(job, gateResult), capture });
    } catch (err) {
      const message = (err as Error).message;
      const { autoDisabled, recordError } = await safeRecord(job.id, {
        status: 'error', startedAt, finishedAt: new Date(),
        detail: { phase: 'agent', error: message, gate: gateResult.counts },
        draftsCreated: capture.drafts.length,
      });
      outcomes.push({
        jobId: job.id, name: job.name, kind: job.kind,
        status: 'error', detail: `agent failed: ${message}`,
        draftsCreated: capture.drafts.length, autoDisabled, recordError,
      });
      continue;
    }

    const { recordError } = await safeRecord(job.id, {
      status: 'ok', startedAt, finishedAt: new Date(),
      detail: {
        gate: gateResult.counts,
        summary: gateResult.context,
        drafts: capture.drafts.map((d) => d.draftId),
      },
      draftsCreated: capture.drafts.length,
    });
    outcomes.push({
      jobId: job.id, name: job.name, kind: job.kind,
      status: 'ok', detail: gateResult.context,
      draftsCreated: capture.drafts.length, autoDisabled: false, recordError,
    });
  }

  return outcomes;
}
