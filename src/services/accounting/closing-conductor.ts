import { getClient, query } from '../../database/connection.js';
import type { AgentContext } from '../../ai/context.js';
import { getCloseReadiness, type ClosablePeriod } from '../../ai/close-service.js';
import { runMonthlyProvisions } from '../accruals/provisions-run.js';
import { runMonthlyAmortization } from '../accruals/amortization-run.js';
import { runMonthlyDepreciation } from '../assets/depreciation.js';
import { softClosePeriod } from './period-close.js';
import { AccountingError, AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

// ============================================================
// A6 · THE CLOSE CONDUCTOR
//
// The close was already a gate (`close`) and a reading surface (`closing
// preview|check|explain`). What it was not, was CONDUCTED: somebody had to
// remember to accrue benefits, then amortize prepaids, then depreciate, then
// look at the checklist, and only then close — in that order, every month, per
// entity. A conductor is that memory, and nothing more ambitious: it computes
// no figure of the books. (It does add up, in its own step record, what its
// engines reported across the attempts of a run — how many rows, how much —
// but that is a tally of reports, never a figure a dossier or a report reads.)
//
// ── THE CONDUCTOR OWNS NO ACCOUNTING ARITHMETIC ─────────────────────────
//
// Every step delegates to the engine that already owns it, unchanged. A
// conductor that recomputed depreciation "because it is faster from here"
// would be a fourth engine, and the day the two disagreed the operator would
// have no way to tell which one was lying. The conductor's only original
// contribution is ORDER, the RECORD of what was done, and the refusal to walk
// past a known hole.
//
// ── WHY THIS ORDER ──────────────────────────────────────────────────────
//
// The three engines post BEFORE the checklist so the checklist judges the
// month as it will be closed, not as it was before the adjusting entries:
// its trial-balance and ledger-integrity boxes read the entries the engines
// just posted, and its `depreciation-posted` box stops warning about a month
// whose depreciation was about to be posted. Said plainly, because an earlier
// version of this comment overstated it: that box is a WARNING, not a
// blocker, and no box asks about provisions or prepaid amortization at all.
// So the order is what makes the checklist's verdict describe the closed
// month; it is not what makes the close possible. The checklist goes before
// the soft close because the soft close is the act the verdict authorizes.
//
// ── WHY IT STOPS AT THE SOFT CLOSE ──────────────────────────────────────
//
// The soft close is reversible; the hard close is not, and it sweeps the
// income statement. The conductor stays on the reversible side and leaves
// `close --hard` to a person.
//
// ── EVERY ATTEMPT RUNS EVERY STEP ───────────────────────────────────────
//
// A resumed run does NOT trust what an earlier attempt recorded. The engines
// refuse to post a month twice on their own terms, so running them again is
// free when they already posted and necessary when they had nothing to do the
// first time (payroll loaded later, an asset registered later). And the
// checklist is always evaluated again: a verdict from yesterday says nothing
// about the AI draft that arrived this morning, and a soft close authorized by
// a stale verdict is exactly the hole the checklist step exists to close.
// ============================================================

/**
 * The steps, in the only order they are allowed to happen in.
 *
 * The keys are a CONTRACT: `--stop-at` takes them, `closing_run_steps.step_key`
 * stores them, and `src/plan/criterios.ts` reads this very list to check that
 * the order did not change by accident.
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
 * from `PERSISTED_STEP_STATUSES`, which mirrors the CHECK of migration 083.
 */
export type StepStatus = (typeof PERSISTED_STEP_STATUSES)[number] | 'pending';

/** The ledger's `source_type` of what each engine step posts. */
const SOURCE_OF_STEP: Partial<Record<ClosingStep, string>> = {
  'accrue-benefits': 'benefit_provision',
  'amortize-prepaids': 'prepaid_amortization',
  'depreciate-assets': 'depreciation',
};

export interface ClosingStepOutcome {
  step: ClosingStep;
  ordinal: number;
  status: StepStatus;
  /** Accumulated across the attempts of this run. */
  processed: number;
  /** Money the engine reports having moved, accumulated, or null when it reports none. */
  amount: string | null;
  /** The entries the step's engine has posted in this period, read from the ledger. */
  journalEntryIds: string[];
  detail: string;
  /** true when an earlier attempt of this same run had already recorded this step. */
  priorAttempt: boolean;
  /**
   * The error a step raised, when it raised. NOT persisted: it exists so the
   * CLI can exit with the code the engine's error deserves (a misconfigured
   * panel is a 4, a crashed process is a 1) instead of flattening every
   * failure into the generic one.
   */
  cause?: unknown;
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
  /**
   * The caller KNOWS there is an open run and asks to continue it. Without it
   * an open run is refused, and with it a missing run is refused: both
   * checks happen here, under the lock, so no caller can skip them.
   */
  resume?: boolean;
  reason?: string;
}

/**
 * A refusal because of the STATE of the run, not because of the input.
 *
 * 423 maps to exit 5 (blocked by state) in the CLI and to Locked in the API:
 * "another conductor holds this period right now" and "there is an open run
 * you did not ask to continue" are facts about the books, and exiting 2
 * (usage) would tell a script its flags were wrong when they were not.
 */
export class ClosingRunStateError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(423, code, message, undefined, details);
    this.name = 'ClosingRunStateError';
  }
}

export function isClosingStep(s: string): s is ClosingStep {
  return (CLOSING_STEPS as readonly string[]).includes(s);
}

interface RunRow {
  id: string;
  status: string;
}

interface StepRow {
  step_key: string;
  ordinal: number;
  status: string;
  processed: number;
  amount: string | null;
  journal_entry_ids: string[];
  detail: string;
}

/** The open run of a period, as the CLI needs to describe it. */
export interface OpenRun {
  id: string;
  status: string;
  halted_at_step: string | null;
  started_at: string;
}

/**
 * The one resumable run of this period, or none.
 *
 * A run that started BEFORE the period's last soft close belongs to a close
 * cycle that already ended by another path —`close` by hand, or a conductor
 * that died after closing— and is not resumable: continuing it after a reopen
 * would merge two close cycles into one run. `openRun` marks those
 * `abandoned`; this read already ignores them, so the CLI and the conductor
 * agree on what "open" means.
 */
export async function openRunOf(entityId: string, periodId: string): Promise<OpenRun | null> {
  const r = await query<OpenRun>(
    `SELECT cr.id, cr.status, cr.halted_at_step, cr.started_at::text AS started_at
       FROM closing_runs cr
       JOIN fiscal_periods fp ON fp.id = cr.fiscal_period_id AND fp.entity_id = cr.entity_id
      WHERE cr.entity_id = $1 AND cr.fiscal_period_id = $2
        AND cr.status IN ('running', 'blocked', 'stopped', 'failed')
        AND (fp.soft_close_date IS NULL OR fp.soft_close_date < cr.started_at)`,
    [entityId, periodId]
  );
  return r.rows[0] ?? null;
}

/** Ends the resumable runs of a close cycle that already ended by another path. */
async function abandonStaleRuns(entityId: string, periodId: string): Promise<void> {
  await query(
    `UPDATE closing_runs cr
        SET status = 'abandoned', ended_at = NOW()
       FROM fiscal_periods fp
      WHERE fp.id = cr.fiscal_period_id AND fp.entity_id = cr.entity_id
        AND cr.entity_id = $1 AND cr.fiscal_period_id = $2
        AND cr.status IN ('running', 'blocked', 'stopped', 'failed')
        AND fp.soft_close_date IS NOT NULL AND fp.soft_close_date >= cr.started_at`,
    [entityId, periodId]
  );
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

export function describeOpenRun(run: OpenRun): string {
  return (
    `${run.status}${run.halted_at_step ? ` at ${run.halted_at_step}` : ''}, started ${run.started_at}`
  );
}

/**
 * ONE CONDUCTOR PER PERIOD AT A TIME.
 *
 * Checking for an open run and then inserting one is a race: two operators
 * answering "y" at the same moment would both find nothing and both conduct,
 * or the second would silently continue the first's live run. An advisory
 * lock held for the whole call closes it — and it is also what tells a
 * `running` row left by a crash (lock free) from one being conducted right now
 * (lock taken).
 *
 * TRANSACTION-SCOPED, NOT SESSION-SCOPED. The first version took a session
 * lock with a bare statement and released it with another, and behind a
 * transaction-mode pooler —PgBouncer, which `providers.ts` tells Neon users is
 * compatible because this app keeps no session state— each statement can land
 * on a different backend: the lock leaked on one, the unlock silently returned
 * false on another, and two conductors routed to the leaking backend both got
 * "true". A transaction pins its backend under any pooler, so the lock is
 * taken inside a `BEGIN` on a dedicated connection that stays open for the
 * whole run and is released by its `COMMIT` — or by Postgres itself if the
 * process dies and the connection drops. A light keepalive stops an
 * idle-in-transaction timeout from ending that transaction mid-run, and says
 * so if it does.
 */
async function withConductorLock<T>(
  entityId: string,
  periodId: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = `closing-run:${entityId}:${periodId}`;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const got = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok',
      [key]
    );
    if (!got.rows[0]?.ok) {
      throw new ClosingRunStateError(
        'CLOSING_RUN_IN_PROGRESS',
        'Another conductor is running the close of this period right now. Wait for it to finish, then look at it with --dry-run.'
      );
    }
    let keepalive = Promise.resolve();
    let lost: unknown;
    const timer = setInterval(() => {
      keepalive = keepalive.then(
        () => client.query('SELECT 1').then(() => undefined),
      ).catch((err: unknown) => {
        lost ??= err;
      });
    }, 5_000);
    try {
      return await fn();
    } finally {
      clearInterval(timer);
      await keepalive;
      if (lost !== undefined) {
        logger.warn('closing_run_lock_lost', {
          entityId,
          periodId,
          detail:
            'the transaction holding the conductor lock ended before the run did; the run is recorded, but for part of it another conductor was not kept out',
          error: lost instanceof Error ? lost.message : 'unknown error',
        });
      }
    }
  } finally {
    // COMMIT releases the lock. If it fails the connection is in an unknown
    // state, and it goes back to the pool DESTROYED rather than reused.
    let broken = false;
    await client.query('COMMIT').catch(() => {
      broken = true;
    });
    client.release(broken);
  }
}

/**
 * The run to continue, or a new one — refusing the two mistakes.
 *
 * Runs UNDER the lock, which is what makes the refusal authoritative: a CLI
 * check before a confirmation prompt is a courtesy, this one is the rule.
 */
async function openRun(
  ctx: AgentContext,
  periodId: string,
  opts: ConductOptions
): Promise<string> {
  await abandonStaleRuns(ctx.entityId, periodId);
  const openRunRow = await openRunOf(ctx.entityId, periodId);
  if (openRunRow) {
    if (opts.resume !== true) {
      throw new ClosingRunStateError(
        'CLOSING_RUN_OPEN',
        `This period already has an open close run (${describeOpenRun(openRunRow)}). ` +
          'Continue it with --resume, or look at it first with --dry-run.',
        { runId: openRunRow.id }
      );
    }
    await query(
      `UPDATE closing_runs SET status = 'running', halted_at_step = NULL, ended_at = NULL
        WHERE id = $1 AND entity_id = $2`,
      [openRunRow.id, ctx.entityId]
    );
    return openRunRow.id;
  }
  if (opts.resume === true) {
    throw new ClosingRunStateError(
      'CLOSING_RUN_NOTHING_TO_RESUME',
      'Nothing to resume: this period has no open close run. Run it without --resume to start one.'
    );
  }
  try {
    const created = await query<RunRow>(
      `INSERT INTO closing_runs (entity_id, fiscal_period_id, status, started_by)
       VALUES ($1, $2, 'running', $3)
       RETURNING id, status`,
      [ctx.entityId, periodId, opts.userId]
    );
    return created.rows[0].id;
  } catch (err) {
    // Under the lock this cannot happen; if it does, it is still a state.
    if ((err as { code?: string }).code === '23505') {
      throw new ClosingRunStateError(
        'CLOSING_RUN_OPEN',
        'This period already has an open close run. Continue it with --resume.'
      );
    }
    throw err;
  }
}

/** Which steps this run already has a row for. */
async function stepsOfRun(runId: string, entityId: string): Promise<Set<string>> {
  const r = await query<{ step_key: string }>(
    'SELECT step_key FROM closing_run_steps WHERE run_id = $1 AND entity_id = $2',
    [runId, entityId]
  );
  return new Set(r.rows.map((x) => x.step_key));
}

/** What the step's engine has posted in this period, read from the ledger. */
async function postedBy(
  entityId: string,
  periodId: string,
  step: ClosingStep
): Promise<string[]> {
  const source = SOURCE_OF_STEP[step];
  if (!source) return [];
  const r = await query<{ id: string }>(
    `SELECT je.id FROM journal_entries je
      WHERE je.entity_id = $1 AND je.fiscal_period_id = $2
        AND je.source_type = $3 AND je.status = 'posted'
        -- Net of corrections: a reversal mirror is not the step's work, and
        -- an original that was reversed no longer is either.
        AND je.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM journal_entries r
                         WHERE r.reverses_entry_id = je.id AND r.status = 'posted')
      ORDER BY je.entry_date, je.id`,
    [entityId, periodId, source]
  );
  return r.rows.map((x) => x.id);
}

/**
 * Writes an attempt into the step's row and returns the ACCUMULATED row.
 *
 * Engine steps accumulate `processed` and `amount` — a resumed run that
 * posts the twelfth employee must not erase the eleven the first attempt
 * posted — and never demote to `skipped` a step that did work in an earlier
 * attempt: not a `done`, and not a `failed` that posted five assets before
 * tripping on the sixth, whose row the operator then entered by hand. Their journal ids are the
 * ledger's, read after the attempt, so they replace. The checklist and the
 * soft close describe a state, not a quantity: they replace everything.
 */
async function recordStep(
  entityId: string,
  runId: string,
  o: ClosingStepOutcome,
  accumulate: boolean
): Promise<StepRow> {
  const r = await query<StepRow>(
    `INSERT INTO closing_run_steps
       (entity_id, run_id, step_key, ordinal, status, processed, amount, journal_entry_ids, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (run_id, step_key) DO UPDATE SET
       status = CASE
         WHEN $10::boolean AND EXCLUDED.status = 'skipped'
              AND (closing_run_steps.status = 'done' OR closing_run_steps.processed > 0)
           THEN 'done' ELSE EXCLUDED.status END,
       detail = CASE
         WHEN $10::boolean AND EXCLUDED.status = 'skipped' AND closing_run_steps.status = 'done'
           THEN closing_run_steps.detail
         WHEN $10::boolean AND EXCLUDED.status = 'skipped' AND closing_run_steps.processed > 0
           THEN closing_run_steps.processed::text
                || ' processed by earlier attempts of this run; nothing was left to do in this one'
         WHEN $10::boolean AND closing_run_steps.processed > 0
           THEN EXCLUDED.detail || ' (this run so far: '
                || (closing_run_steps.processed + EXCLUDED.processed)::text || ' processed'
                || CASE WHEN closing_run_steps.amount IS NULL AND EXCLUDED.amount IS NULL THEN ''
                        ELSE ', ' || (COALESCE(closing_run_steps.amount, 0) + COALESCE(EXCLUDED.amount, 0))::text END
                || ')'
         ELSE EXCLUDED.detail END,
       processed = CASE WHEN $10::boolean
         THEN closing_run_steps.processed + EXCLUDED.processed ELSE EXCLUDED.processed END,
       amount = CASE
         WHEN NOT $10::boolean THEN EXCLUDED.amount
         WHEN closing_run_steps.amount IS NULL AND EXCLUDED.amount IS NULL THEN NULL
         ELSE COALESCE(closing_run_steps.amount, 0) + COALESCE(EXCLUDED.amount, 0) END,
       journal_entry_ids = EXCLUDED.journal_entry_ids,
       ran_at = NOW()
     RETURNING step_key, ordinal, status, processed, amount::text AS amount, journal_entry_ids, detail`,
    [
      entityId,
      runId,
      o.step,
      o.ordinal,
      o.status,
      o.processed,
      o.amount,
      o.journalEntryIds,
      o.detail,
      accumulate,
    ]
  );
  return r.rows[0];
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

function checklistOutcome(
  step: ClosingStep,
  ordinal: number,
  r: Awaited<ReturnType<typeof getCloseReadiness>>
): ClosingStepOutcome {
  return {
    step,
    ordinal,
    status: r.canClose ? 'done' : 'blocked',
    processed: r.checklist.length,
    amount: null,
    journalEntryIds: [],
    detail: r.canClose
      ? `${r.checklist.length} checks, no blocking items, ${r.warnings.length} warning(s)`
      : `blocking: ${r.blockingIssues.join('; ')}`,
    priorAttempt: false,
  };
}

/**
 * Runs ONE step. Pure dispatch: every branch hands over to the engine that
 * owns the arithmetic and translates its result into the same shape.
 *
 * A step whose engine comes back with per-row errors is `failed`, not `done`.
 * The engines tolerate a broken row so the other twenty still get theirs —
 * that is their job — but the conductor's job is not to walk past a known hole
 * on its way to a close.
 */
async function takeStep(
  ctx: AgentContext,
  period: ClosablePeriod,
  step: ClosingStep,
  ordinal: number,
  opts: ConductOptions
): Promise<ClosingStepOutcome> {
  const base = { step, ordinal, priorAttempt: false, journalEntryIds: [] as string[] };

  switch (step) {
    case 'accrue-benefits': {
      const r = await runMonthlyProvisions(ctx.entityId, period.id, opts.userId);
      return {
        ...base,
        status: r.errors.length > 0 ? 'failed' : r.processed > 0 ? 'done' : 'skipped',
        processed: r.processed,
        amount: r.total,
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
        // migration 083. A zero here would be a figure nobody computed.
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
      // close like a red box does — and `softClosePeriod` does NOT count AI
      // drafts, so this is the only place the conductor sees them.
      return checklistOutcome(step, ordinal, await getCloseReadiness(ctx, period));
    }
    case 'soft-close': {
      const periodState = await periodStatus(ctx.entityId, period.id);
      if (periodState !== 'open') {
        return {
          ...base,
          status: 'skipped',
          processed: 0,
          amount: null,
          detail: `period is already ${periodState}`,
        };
      }
      await softClosePeriod(period.id, ctx.entityId, opts.userId, opts.reason);
      return {
        ...base,
        status: 'done',
        processed: 1,
        amount: null,
        // What soft_close really does: postings are still ACCEPTED. The
        // validator records a warning ("Only adjusting entries recommended"),
        // but `entry post` does not show it — only `entry check` does — so
        // this line promises neither a refusal nor a warning.
        detail:
          'period soft-closed: reversible, still accepts adjusting postings, and the hard close stays with `close --hard`',
      };
    }
  }
}

function stepFailed(step: ClosingStep, ordinal: number, err: unknown): ClosingStepOutcome {
  return {
    step,
    ordinal,
    status: 'failed',
    processed: 0,
    amount: null,
    journalEntryIds: [],
    detail: err instanceof Error ? err.message : String(err),
    priorAttempt: false,
    cause: err,
  };
}

/**
 * THE CONDUCTOR.
 *
 * Walks the steps in order, records each one, and halts at the first that
 * blocks or fails. Every attempt runs every step again (see the header): the
 * engines skip what is already posted, and the checklist is judged fresh.
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
  const requested: string | undefined = opts.stopAt;
  if (requested !== undefined && !isClosingStep(requested)) {
    throw new AccountingError(
      'UNKNOWN_CLOSING_STEP',
      `Unknown step "${requested}". The steps are: ${CLOSING_STEPS.join(', ')}.`
    );
  }

  const frame = {
    entityId: ctx.entityId,
    periodId: period.id,
    periodName: period.period_name,
  };

  // ONLY AN OPEN PERIOD IS CONDUCTED, AND THE RULE IS THE CONDUCTOR'S. It used
  // to live only in the CLI leaf: called any other way, the conductor ran its
  // engines over a soft-closed month, and its dry run disagreed with its real
  // run. The soft-close step still re-checks, for the period closed in between.
  const periodNow = await periodStatus(ctx.entityId, period.id);
  if (periodNow !== 'open') {
    throw new ClosingRunStateError(
      'PERIOD_NOT_OPEN_TO_CONDUCT',
      `${period.period_name} is already ${periodNow}: there is nothing left to conduct.`
    );
  }

  if (opts.dryRun) {
    return { ...frame, runId: null, status: 'previewed', ...(await dryRun(ctx, period, opts)) };
  }

  return withConductorLock(ctx.entityId, period.id, async () => {
    const runId = await openRun(ctx, period.id, opts);
    const priorSteps = await stepsOfRun(runId, ctx.entityId);
    const steps: ClosingStepOutcome[] = [];

    for (const [i, step] of CLOSING_STEPS.entries()) {
      const ordinal = i + 1;

      if (opts.stopAt === step) {
        await closeRun(runId, ctx.entityId, 'stopped', step);
        return { ...frame, runId, status: 'stopped' as const, steps, haltedAtStep: step };
      }

      let outcome: ClosingStepOutcome;
      try {
        outcome = await takeStep(ctx, period, step, ordinal, opts);
      } catch (err) {
        // AN ENGINE THAT RAISES IS EVIDENCE TOO. Letting it escape would leave
        // the run row saying `running`, and the next attempt would have no
        // record of what stopped the last one.
        outcome = stepFailed(step, ordinal, err);
      }

      const engine = SOURCE_OF_STEP[step] !== undefined;
      if (engine) outcome.journalEntryIds = await postedBy(ctx.entityId, period.id, step);
      const row = await recordStep(ctx.entityId, runId, outcome, engine);
      const accumulated: ClosingStepOutcome = {
        ...outcome,
        status: row.status as StepStatus,
        processed: row.processed,
        amount: row.amount,
        journalEntryIds: row.journal_entry_ids,
        detail: row.detail,
        priorAttempt: priorSteps.has(step),
      };
      steps.push(accumulated);

      if (accumulated.status === 'blocked' || accumulated.status === 'failed') {
        const runState = accumulated.status === 'blocked' ? 'blocked' : 'failed';
        await closeRun(runId, ctx.entityId, runState, step);
        return { ...frame, runId, status: runState, steps, haltedAtStep: step };
      }
    }

    await closeRun(runId, ctx.entityId, 'completed', null);
    return { ...frame, runId, status: 'completed' as const, steps, haltedAtStep: null };
  });
}

/**
 * The dry run, which is a real answer and not a rehearsal of one.
 *
 * It writes nothing. It ACTUALLY EVALUATES the checklist, every time — reading
 * is free, and a verdict cached from an earlier attempt would be the stale
 * answer the real run no longer trusts either. The engine steps are reported
 * as pending, because the only honest thing to say without running an engine
 * is that it will run and post what is not already posted.
 */
async function dryRun(
  ctx: AgentContext,
  period: ClosablePeriod,
  opts: ConductOptions
): Promise<{ steps: ClosingStepOutcome[]; haltedAtStep: ClosingStep | null }> {
  const openRunRow = await openRunOf(ctx.entityId, period.id);
  const priorSteps = openRunRow ? await stepsOfRun(openRunRow.id, ctx.entityId) : new Set<string>();

  const steps: ClosingStepOutcome[] = [];
  let haltedAtStep: ClosingStep | null = null;

  for (const [i, step] of CLOSING_STEPS.entries()) {
    const ordinal = i + 1;
    if (opts.stopAt === step) {
      haltedAtStep = step;
      break;
    }
    if (step === 'verify-checklist') {
      const r = checklistOutcome(step, ordinal, await getCloseReadiness(ctx, period));
      r.priorAttempt = priorSteps.has(step);
      steps.push(r);
      if (r.status === 'blocked') {
        haltedAtStep = step;
        break;
      }
      continue;
    }
    if (step === 'soft-close') {
      const periodState = await periodStatus(ctx.entityId, period.id);
      steps.push({
        step,
        ordinal,
        status: periodState === 'open' ? 'pending' : 'skipped',
        processed: 0,
        amount: null,
        journalEntryIds: [],
        detail: periodState === 'open' ? 'would soft-close the period' : `period is already ${periodState}`,
        priorAttempt: priorSteps.has(step),
      });
      continue;
    }
    steps.push({
      step,
      ordinal,
      status: 'pending',
      processed: 0,
      amount: null,
      journalEntryIds: await postedBy(ctx.entityId, period.id, step),
      detail: 'would run; the engine posts only what is not already posted this period',
      priorAttempt: priorSteps.has(step),
    });
  }

  return { steps, haltedAtStep };
}
