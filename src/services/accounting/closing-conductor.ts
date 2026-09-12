import { query } from '../../database/connection.js';
import type { AgentContext } from '../../ai/context.js';
import { getCloseReadiness, type ClosablePeriod } from '../../ai/close-service.js';
import { runMonthlyProvisions } from '../accruals/provisions-run.js';
import { runMonthlyAmortization } from '../accruals/amortization-run.js';
import { runMonthlyDepreciation } from '../assets/depreciation.js';
import { softClosePeriod } from './period-close.js';
import { AccountingError } from '../../utils/errors.js';

// ============================================================
// A6 · THE CLOSE CONDUCTOR
//
// The close was already a gate (`close`) and a reading surface (`closing
// preview|check|explain`). What it was not, was CONDUCTED: somebody had to
// remember to accrue benefits, then amortize prepaids, then depreciate, then
// look at the checklist, and only then close — in that order, every month, per
// entity. A conductor is that memory, and nothing more ambitious: it does not
// compute a single figure of its own.
//
// ── THE CONDUCTOR OWNS NO ARITHMETIC ────────────────────────────────────
//
// Every step delegates to the engine that already owns it, unchanged. This is
// the same rule that keeps the API from becoming a second ledger: a conductor
// that recomputed depreciation "because it is faster from here" would be a
// fourth engine, and the day the two disagreed the operator would have no way
// to tell which one was lying. The conductor's only original contribution is
// ORDER, IDEMPOTENCE and EVIDENCE.
//
// ── THE ORDER IS NOT A PREFERENCE ───────────────────────────────────────
//
// Accruals and amortization and depreciation come BEFORE the checklist because
// the checklist asks about them (`FA.DEPR_MISSING` is one of its boxes), and
// the checklist comes before the close because the close refuses to run with a
// blocking box open. Running the checklist first would have produced the
// month's most expensive false alarm: "depreciation missing" on a period whose
// next step was going to post it.
//
// ── WHY IT STOPS AT THE SOFT CLOSE ──────────────────────────────────────
//
// The soft close is reversible; the hard close is not, and it sweeps the
// income statement. A conductor that reached the hard close would be an
// autonomous irreversible act, and A7's single gate exists precisely so that
// there is exactly one of those and a human is standing at it. `close --hard`
// keeps it. The conductor's last step is the reversible one.
// ============================================================

/**
 * The steps, in the only order they are allowed to happen in.
 *
 * The keys are a CONTRACT: `--stop-at` takes them, `closing_run_steps.step_key`
 * stores them, the dossier quotes them, and `src/plan/criterios.ts` reads this
 * very list to check that the order did not change by accident.
 */
export const CLOSING_STEPS = [
  'accrue-benefits',
  'amortize-prepaids',
  'depreciate-assets',
  'verify-checklist',
  'soft-close',
] as const;

export type ClosingStep = (typeof CLOSING_STEPS)[number];

/** What a step row may say. `pending` is NOT one of them: see `StepStatus`. */
export const PERSISTED_STEP_STATUSES = ['done', 'skipped', 'blocked', 'failed'] as const;

/**
 * `pending` exists only in a dry run, where nothing is written: it is the
 * answer to "what would you do if I let you go". It is deliberately absent
 * from `PERSISTED_STEP_STATUSES`, which mirrors the CHECK of migration 082.
 */
export type StepStatus = (typeof PERSISTED_STEP_STATUSES)[number] | 'pending';

export interface ClosingStepOutcome {
  step: ClosingStep;
  ordinal: number;
  status: StepStatus;
  processed: number;
  /** Money the engine reports having moved, or null when it reports none. */
  amount: string | null;
  journalEntryIds: string[];
  detail: string;
  /** true when an earlier attempt of this same run had already taken it. */
  resumed: boolean;
}

export interface ClosingRunOutcome {
  /** null in a dry run: a dry run opens no run. */
  runId: string | null;
  entityId: string;
  periodId: string;
  periodName: string;
  status: 'completed' | 'blocked' | 'stopped' | 'failed' | 'previewed';
  steps: ClosingStepOutcome[];
  /** The step the run did not get past, or null when it got through them all. */
  haltedAtStep: ClosingStep | null;
}

export interface ConductOptions {
  userId: string;
  /**
   * Stop BEFORE this step, as `docs/cli-command-registry.md` defines the flag
   * for every orchestrator in the system ("stop before a named gate").
   * `--stop-at soft-close` is therefore "do the whole month but leave the
   * period open", which is the reason the flag exists.
   */
  stopAt?: ClosingStep;
  /** Report what is pending without writing anything. */
  dryRun?: boolean;
  reason?: string;
}

export function isClosingStep(s: string): s is ClosingStep {
  return (CLOSING_STEPS as readonly string[]).includes(s);
}

interface RunRow {
  id: string;
  status: string;
}

/** The open run of a period, as the CLI needs to describe it before resuming. */
export interface OpenRun {
  id: string;
  status: string;
  halted_at_step: string | null;
  started_at: string;
}

/**
 * The one resumable run of this period, or none.
 *
 * Exported because the CLI has to be able to REFUSE before doing anything: a
 * `closing run` typed over a period somebody else left half-done is continuing
 * another person's work, and doing that without saying so turns "I ran it" into
 * a claim nobody can stand behind.
 */
export async function openRunOf(entityId: string, periodId: string): Promise<OpenRun | null> {
  const r = await query<OpenRun>(
    `SELECT id, status, halted_at_step, started_at::text AS started_at
       FROM closing_runs
      WHERE entity_id = $1 AND fiscal_period_id = $2
        AND status IN ('running', 'blocked', 'stopped', 'failed')`,
    [entityId, periodId]
  );
  return r.rows[0] ?? null;
}

/** The most recent run of this period, whatever became of it. */
export async function latestRunOf(
  entityId: string,
  periodId: string
): Promise<{ id: string; status: string } | null> {
  const r = await query<{ id: string; status: string }>(
    `SELECT id, status FROM closing_runs
      WHERE entity_id = $1 AND fiscal_period_id = $2
      ORDER BY started_at DESC, id DESC
      LIMIT 1`,
    [entityId, periodId]
  );
  return r.rows[0] ?? null;
}

interface StepRow {
  step_key: string;
  status: string;
  processed: number;
  amount: string | null;
  journal_entry_ids: string[];
  detail: string;
}

/**
 * The run to resume, or a new one.
 *
 * The partial unique index `uq_closing_run_open` guarantees there is at most
 * one resumable run per (entity, period), so this never has to CHOOSE. That
 * is the whole reason the index is partial instead of a plain unique: a period
 * that is reopened and closed again gets a second run, and the first one stays
 * as the evidence of what was done the first time.
 */
async function openRun(
  ctx: AgentContext,
  periodId: string,
  userId: string
): Promise<{ runId: string; resumed: boolean }> {
  const abierta = await openRunOf(ctx.entityId, periodId);
  if (abierta) {
    await query(
      `UPDATE closing_runs SET status = 'running', halted_at_step = NULL, ended_at = NULL
        WHERE id = $1 AND entity_id = $2`,
      [abierta.id, ctx.entityId]
    );
    return { runId: abierta.id, resumed: true };
  }
  const creada = await query<RunRow>(
    `INSERT INTO closing_runs (tenant_id, entity_id, fiscal_period_id, status, started_by)
     VALUES ($1, $2, $3, 'running', $4)
     RETURNING id, status`,
    [ctx.tenantId, ctx.entityId, periodId, userId]
  );
  return { runId: creada.rows[0].id, resumed: false };
}

/** What this run already did. Only `done` and `skipped` count as taken. */
async function stepsAlreadyTaken(runId: string, entityId: string): Promise<Map<string, StepRow>> {
  const r = await query<StepRow>(
    `SELECT step_key, status, processed, amount, journal_entry_ids, detail
       FROM closing_run_steps
      WHERE run_id = $1 AND entity_id = $2`,
    [runId, entityId]
  );
  const m = new Map<string, StepRow>();
  for (const row of r.rows) {
    if (row.status === 'done' || row.status === 'skipped') m.set(row.step_key, row);
  }
  return m;
}

async function recordStep(
  ctx: AgentContext,
  runId: string,
  o: ClosingStepOutcome
): Promise<void> {
  // UPSERT and not INSERT: a step recorded `blocked` or `failed` is re-run on
  // the next attempt, and its row has to say what happened THIS time. Only
  // `done` and `skipped` are never revisited, because `stepsAlreadyTaken`
  // filters them out before the step is reached.
  await query(
    `INSERT INTO closing_run_steps
       (tenant_id, entity_id, run_id, step_key, ordinal, status, processed, amount,
        journal_entry_ids, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (run_id, step_key) DO UPDATE SET
       status = EXCLUDED.status,
       processed = EXCLUDED.processed,
       amount = EXCLUDED.amount,
       journal_entry_ids = EXCLUDED.journal_entry_ids,
       detail = EXCLUDED.detail,
       ran_at = NOW()`,
    [
      ctx.tenantId,
      ctx.entityId,
      runId,
      o.step,
      o.ordinal,
      o.status,
      o.processed,
      o.amount,
      o.journalEntryIds,
      o.detail,
    ]
  );
}

async function closeRun(
  runId: string,
  entityId: string,
  status: ClosingRunOutcome['status'],
  haltedAtStep: ClosingStep | null
): Promise<void> {
  await query(
    `UPDATE closing_runs
        SET status = $1, halted_at_step = $2, ended_at = NOW()
      WHERE id = $3 AND entity_id = $4`,
    [status, haltedAtStep, runId, entityId]
  );
}

/** The period's current status, to tell "already closed" from "refuses to close". */
async function periodStatus(entityId: string, periodId: string): Promise<string> {
  const r = await query<{ status: string }>(
    'SELECT status FROM fiscal_periods WHERE id = $1 AND entity_id = $2',
    [periodId, entityId]
  );
  if (r.rows.length === 0) {
    throw new AccountingError('PERIOD_NOT_FOUND', 'Fiscal period not found');
  }
  return r.rows[0].status;
}

/**
 * Runs ONE step. Pure dispatch: every branch hands over to the engine that
 * owns the arithmetic and translates its result into the same shape.
 *
 * A step that comes back with per-row errors is `failed`, not `done`. The
 * engines tolerate a broken row so the other twenty still get theirs — that is
 * their job — but the conductor's job is not to walk past a known hole on its
 * way to sealing a dossier. The run stops there and says which rows.
 */
async function takeStep(
  ctx: AgentContext,
  period: ClosablePeriod,
  step: ClosingStep,
  ordinal: number,
  opts: ConductOptions
): Promise<ClosingStepOutcome> {
  const base = { step, ordinal, resumed: false, journalEntryIds: [] as string[] };

  switch (step) {
    case 'accrue-benefits': {
      const r = await runMonthlyProvisions(ctx.entityId, period.id, opts.userId);
      return {
        ...base,
        status: r.errors.length > 0 ? 'failed' : r.processed > 0 ? 'done' : 'skipped',
        processed: r.processed,
        amount: r.total,
        journalEntryIds: r.journalEntryId ? [r.journalEntryId] : [],
        detail:
          r.errors.length > 0
            ? `${r.errors.length} employee(s) could not be accrued: ${r.errors.join('; ')}`
            : `${r.processed} accrued, ${r.skipped} skipped, ${r.total} provisioned`,
      };
    }
    case 'amortize-prepaids': {
      const r = await runMonthlyAmortization(ctx.entityId, period.id, opts.userId);
      return {
        ...base,
        status: r.errors.length > 0 ? 'failed' : r.processed > 0 ? 'done' : 'skipped',
        processed: r.processed,
        amount: r.total,
        detail:
          r.errors.length > 0
            ? `${r.errors.length} prepaid(s) could not be amortized: ${r.errors.join('; ')}`
            : `${r.processed} amortized, ${r.skipped} skipped, ${r.total} expensed`,
      };
    }
    case 'depreciate-assets': {
      const r = await runMonthlyDepreciation(ctx.entityId, period.id, opts.userId);
      return {
        ...base,
        status: r.errors.length > 0 ? 'failed' : r.processed > 0 ? 'done' : 'skipped',
        processed: r.processed,
        // The engine reports a count, not a total: see the column's comment in
        // migration 082. A zero here would be a figure nobody computed.
        amount: null,
        detail:
          r.errors.length > 0
            ? `${r.errors.length} asset(s) could not be depreciated: ${r.errors.join('; ')}`
            : `${r.processed} asset(s) depreciated`,
      };
    }
    case 'verify-checklist': {
      // THE SAME READINESS `closing preview` SHOWS, and deliberately not the
      // engine's checklist alone: an AI draft dated inside the period stops the
      // close like a red box does, and two surfaces that disagreed about
      // whether the month can close would make the preview worthless.
      const r = await getCloseReadiness(ctx, period);
      return {
        ...base,
        status: r.canClose ? 'done' : 'blocked',
        processed: r.checklist.length,
        amount: null,
        detail: r.canClose
          ? `${r.checklist.length} checks, no blocking items, ${r.warnings.length} warning(s)`
          : `blocking: ${r.blockingIssues.join('; ')}`,
      };
    }
    case 'soft-close': {
      const estado = await periodStatus(ctx.entityId, period.id);
      if (estado !== 'open') {
        return {
          ...base,
          status: 'skipped',
          processed: 0,
          amount: null,
          detail: `period is already ${estado}`,
        };
      }
      await softClosePeriod(period.id, ctx.entityId, opts.userId, opts.reason);
      return {
        ...base,
        status: 'done',
        processed: 1,
        amount: null,
        detail: 'period soft-closed: reversible, and new entries are refused',
      };
    }
  }
}

/**
 * THE CONDUCTOR.
 *
 * Walks the steps in order, records each one, and halts at the first that
 * blocks or fails. Calling it again resumes: what is recorded `done` or
 * `skipped` is not repeated, what is `blocked` or `failed` is retried.
 */
export async function conductClose(
  ctx: AgentContext,
  period: ClosablePeriod,
  opts: ConductOptions
): Promise<ClosingRunOutcome> {
  // FALLA CERRADO, aunque el tipo ya lo diga. La hoja del CLI valida antes,
  // pero este motor lo llaman además las pruebas y mañana la API, y un
  // `--stop-at` que no case con ningún paso no debe correr el mes entero en
  // silencio. Se ensancha a `string` a propósito: con el tipo estrecho el
  // comprobador estrecha el else a `never` y la guarda parecería muerta.
  const pedido: string | undefined = opts.stopAt;
  if (pedido !== undefined && !isClosingStep(pedido)) {
    throw new AccountingError(
      'UNKNOWN_CLOSING_STEP',
      `Unknown step "${pedido}". The steps are: ${CLOSING_STEPS.join(', ')}.`
    );
  }

  const marco = {
    entityId: ctx.entityId,
    periodId: period.id,
    periodName: period.period_name,
  };

  if (opts.dryRun) {
    return { ...marco, runId: null, status: 'previewed', ...(await dryRun(ctx, period, opts)) };
  }

  const { runId } = await openRun(ctx, period.id, opts.userId);
  const yaHechos = await stepsAlreadyTaken(runId, ctx.entityId);
  const steps: ClosingStepOutcome[] = [];

  for (const [i, step] of CLOSING_STEPS.entries()) {
    const ordinal = i + 1;

    if (opts.stopAt === step) {
      await closeRun(runId, ctx.entityId, 'stopped', step);
      return { ...marco, runId, status: 'stopped', steps, haltedAtStep: step };
    }

    const previo = yaHechos.get(step);
    if (previo) {
      steps.push({
        step,
        ordinal,
        status: previo.status as StepStatus,
        processed: previo.processed,
        amount: previo.amount,
        journalEntryIds: previo.journal_entry_ids,
        detail: previo.detail,
        resumed: true,
      });
      continue;
    }

    let outcome: ClosingStepOutcome;
    try {
      outcome = await takeStep(ctx, period, step, ordinal, opts);
    } catch (err) {
      // AN ENGINE THAT RAISES IS EVIDENCE TOO. Letting it escape would leave
      // the run row saying `running` forever, and the next attempt would have
      // no record of what stopped the last one.
      outcome = {
        step,
        ordinal,
        status: 'failed',
        processed: 0,
        amount: null,
        journalEntryIds: [],
        detail: err instanceof Error ? err.message : String(err),
        resumed: false,
      };
      await recordStep(ctx, runId, outcome);
      steps.push(outcome);
      await closeRun(runId, ctx.entityId, 'failed', step);
      return { ...marco, runId, status: 'failed', steps, haltedAtStep: step };
    }

    await recordStep(ctx, runId, outcome);
    steps.push(outcome);

    if (outcome.status === 'blocked' || outcome.status === 'failed') {
      const estado = outcome.status === 'blocked' ? 'blocked' : 'failed';
      await closeRun(runId, ctx.entityId, estado, step);
      return { ...marco, runId, status: estado, steps, haltedAtStep: step };
    }
  }

  await closeRun(runId, ctx.entityId, 'completed', null);
  return { ...marco, runId, status: 'completed', steps, haltedAtStep: null };
}

/**
 * The dry run, which is a real answer and not a rehearsal of one.
 *
 * It says, for each step, whether this period's open run already took it, and
 * it ACTUALLY EVALUATES the checklist — which is read-only, so there is nothing
 * to rehearse. A `--dry-run` that answered "would run" for the one step that
 * can be asked for free would have been the exact kind of command this house
 * calls worse than absent.
 */
async function dryRun(
  ctx: AgentContext,
  period: ClosablePeriod,
  opts: ConductOptions
): Promise<{ steps: ClosingStepOutcome[]; haltedAtStep: ClosingStep | null }> {
  const abierta = await openRunOf(ctx.entityId, period.id);
  const yaHechos = abierta
    ? await stepsAlreadyTaken(abierta.id, ctx.entityId)
    : new Map<string, StepRow>();

  const steps: ClosingStepOutcome[] = [];
  let haltedAtStep: ClosingStep | null = null;

  for (const [i, step] of CLOSING_STEPS.entries()) {
    const ordinal = i + 1;
    if (opts.stopAt === step) {
      haltedAtStep = step;
      break;
    }
    const previo = yaHechos.get(step);
    if (previo) {
      steps.push({
        step,
        ordinal,
        status: previo.status as StepStatus,
        processed: previo.processed,
        amount: previo.amount,
        journalEntryIds: previo.journal_entry_ids,
        detail: previo.detail,
        resumed: true,
      });
      continue;
    }
    if (step === 'verify-checklist') {
      const r = await getCloseReadiness(ctx, period);
      steps.push({
        step,
        ordinal,
        status: r.canClose ? 'done' : 'blocked',
        processed: r.checklist.length,
        amount: null,
        journalEntryIds: [],
        detail: r.canClose
          ? `${r.checklist.length} checks, no blocking items, ${r.warnings.length} warning(s)`
          : `blocking: ${r.blockingIssues.join('; ')}`,
        resumed: false,
      });
      if (!r.canClose) haltedAtStep = step;
      continue;
    }
    steps.push({
      step,
      ordinal,
      status: 'pending',
      processed: 0,
      amount: null,
      journalEntryIds: [],
      detail: 'not taken yet by this run',
      resumed: false,
    });
  }

  return { steps, haltedAtStep };
}
