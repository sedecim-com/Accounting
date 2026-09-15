import { randomUUID } from 'node:crypto';
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
export async function abandonStaleRuns(entityId: string, periodId: string): Promise<void> {
  // Never a run somebody is still conducting — asked here, in the write, and
  // not only by the refusal that reads before it (see `claimRun`).
  await query(
    `UPDATE closing_runs cr
        SET status = 'abandoned', ended_at = NOW()
       FROM fiscal_periods fp
      WHERE fp.id = cr.fiscal_period_id AND fp.entity_id = cr.entity_id
        AND cr.entity_id = $1 AND cr.fiscal_period_id = $2
        AND cr.status IN ('running', 'blocked', 'stopped', 'failed')
        AND fp.soft_close_date IS NOT NULL AND fp.soft_close_date >= cr.started_at
        AND NOT COALESCE(cr.status = 'running' AND cr.heartbeat_at > NOW() - make_interval(secs => $3), false)`,
    [entityId, periodId, RUN_HEARTBEAT_STALE_AFTER_SECONDS]
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
 * lock held for the whole call closes it. (What tells a `running` row left by
 * a crash from one still being conducted is the run's heartbeat, not the lock:
 * a conductor that lost its lock connection is alive with the lock free.)
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
 * idle-in-transaction timeout from ending that transaction mid-run.
 *
 * LOSING THE LOCK STOPS THE RUN. The first version only noticed a dead lock
 * connection after the run returned, and logged it: meanwhile the engines and
 * the soft close — which use the shared pool, not the lock's connection — kept
 * going while a second conductor could already take the lock. The lock is now
 * handed to the run as a LEASE it must prove before every step, the soft
 * close included (see `conductClose`). A step already in flight when
 * the connection dies still finishes — nothing preempts a query — but no step
 * starts after it. The run's heartbeat keeps a second conductor out while this
 * one is still heard from (`refuseWhileAnotherConductorActs`), and the run's
 * claim keeps a conductor that was paused past that window, and taken over,
 * from writing into its successor's run (`RunClaim`).
 */
async function withConductorLock<T>(
  entityId: string,
  periodId: string,
  fn: (lease: ConductorLease) => Promise<T>
): Promise<T> {
  const key = `closing-run:${entityId}:${periodId}`;
  const client = await getClient();
  const watch = watchLockConnection(client);
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
    const keepalive = startLockKeepalive(client, LOCK_KEEPALIVE_MS);
    const lease = createConductorLease(client, () => watch.error() ?? keepalive.lost());
    try {
      return await fn(lease);
    } finally {
      const beatError = await keepalive.stop();
      reportLostLock(beatError ?? watch.error(), entityId, periodId);
    }
  } finally {
    // The listener stays until the client is back in the pool: COMMIT is a
    // round trip too, and a socket that fails during it emits `error` on a
    // client nobody else listens to yet.
    try {
      await releaseLockConnection(client);
    } finally {
      watch.stop();
    }
  }
}

/** What the run holds while it conducts: a lock it must prove before acting. */
export interface ConductorLease {
  /** Throws `CLOSING_RUN_LOCK_LOST` when the lock's transaction is gone. */
  assertHeld(): Promise<void>;
}

/**
 * The lease over the lock's connection: what was already seen to fail, or
 * else a probe on the lock's own transaction — if that statement runs, the
 * transaction, and its lock, is alive.
 */
export function createConductorLease(
  client: Pick<LockConnection, 'query'>,
  seen: () => unknown
): ConductorLease {
  return {
    assertHeld: async () => {
      const known = seen();
      if (known !== undefined) throw lockLost(known);
      try {
        await client.query('SELECT 1');
      } catch (err) {
        throw lockLost(err);
      }
    },
  };
}

const LOCK_LOST = 'CLOSING_RUN_LOCK_LOST';

// The operator reads this line, so it carries no driver text: a pg message
// about the session ending would pull the CLI's "check DATABASE_URL" hint
// under a refusal that has its own next step. The cause goes to `details`.
const LOCK_LOST_MESSAGE =
  'This conductor lost its lock or its heartbeat, so it can no longer prove it is the only one on this period.';

function lockLost(cause: unknown, takenOver = false): ClosingRunStateError {
  return new ClosingRunStateError(LOCK_LOST, `${LOCK_LOST_MESSAGE} It stopped before its next step.`, {
    cause: String(cause),
    takenOver,
  });
}

const TAKEN_OVER = 'the run was ended or taken over by another conductor';

function takenOver(): ClosingRunStateError {
  return lockLost(TAKEN_OVER, true);
}

/** Lost the race to claim the run: nothing was done yet, so it is a refusal. */
function claimedByAnother(runId: string | null): ClosingRunStateError {
  return new ClosingRunStateError(
    'CLOSING_RUN_IN_PROGRESS',
    'Another conductor acted on this period a moment ago: it claimed its run, or the period is no longer open. ' +
      'Look at it with --dry-run.',
    { runId }
  );
}

export function isLockLost(err: unknown): boolean {
  return err instanceof ClosingRunStateError && err.code === LOCK_LOST;
}

/**
 * A run whose conductor is still acting, even if it no longer holds the lock.
 *
 * The lock alone cannot tell "the conductor died" from "the conductor lost
 * its lock connection and is finishing a step": in both cases the lock is
 * free and the run says `running`. The heartbeat can. A conductor writes it
 * for as long as it acts on the run, lock or no lock, so a `running` run heard
 * from recently is somebody's live run — continuing it now would put two
 * conductors on the same month. One not heard from for longer than the window
 * belongs to a process that died, and may be resumed.
 */
export const RUN_HEARTBEAT_STALE_AFTER_SECONDS = 30;

/**
 * A conductor stops STARTING steps long before others may take it for dead:
 * half the window. A process paused past it (a stopped process, a laptop
 * asleep) could already have been taken over when it wakes up.
 */
export const HEARTBEAT_SILENCE_LIMIT_MS = (RUN_HEARTBEAT_STALE_AFTER_SECONDS * 1000) / 2;

/** The live run of a period, if its conductor was heard from within the window. */
export async function liveRunOf(
  entityId: string,
  periodId: string
): Promise<{ id: string; seconds: number } | null> {
  const live = await query<{ id: string; seconds: number }>(
    `SELECT id, EXTRACT(EPOCH FROM (NOW() - heartbeat_at))::int AS seconds
       FROM closing_runs
      WHERE entity_id = $1 AND fiscal_period_id = $2
        AND status = 'running'
        AND heartbeat_at > NOW() - make_interval(secs => $3)`,
    [entityId, periodId, RUN_HEARTBEAT_STALE_AFTER_SECONDS]
  );
  return live.rows[0] ?? null;
}

export function describeLiveRun(run: { seconds: number }): string {
  return (
    `A conductor is still acting on this period's run (last heard from ${run.seconds}s ago). ` +
    'Wait for it to stop; if its process died, the run can be resumed ' +
    `${RUN_HEARTBEAT_STALE_AFTER_SECONDS} seconds after its last heartbeat.`
  );
}

async function refuseWhileAnotherConductorActs(entityId: string, periodId: string): Promise<void> {
  const live = await liveRunOf(entityId, periodId);
  if (live) {
    throw new ClosingRunStateError('CLOSING_RUN_IN_PROGRESS', describeLiveRun(live), { runId: live.id });
  }
}

/** Who is acting on a run: the run, and the token of the call that claimed it. */
export interface RunClaim {
  runId: string;
  entityId: string;
  token: string;
}

/**
 * The run's heartbeat: `heartbeat_at = NOW()` every so often, for as long as
 * this conductor acts on the run. It is written through the pool, outside the
 * lock's transaction, so other sessions see it — and only while the run is
 * still `running` UNDER THIS CALL'S TOKEN.
 *
 * `assertBeating` stops the next step in two cases. A beat that matched no
 * row means the run was ended or claimed by another conductor. And silence:
 * no beat landed for longer than the silence limit, so this conductor may
 * already look dead to others. A beat that merely FAILS is not a verdict — a
 * slow pool is not a takeover —; it only lets that silence grow.
 */
export function startRunHeartbeat(
  claim: RunClaim,
  everyMs: number,
  silenceLimitMs: number
): { assertBeating: () => void; stop: () => Promise<void> } {
  let chain = Promise.resolve();
  const displaced: ClosingRunStateError[] = [];
  let lastWall = Date.now();
  let lastMono = performance.now();
  const beat = (): void => {
    chain = chain.then(async () => {
      try {
        const r = await query(
          `UPDATE closing_runs SET heartbeat_at = NOW()
            WHERE id = $1 AND entity_id = $2 AND status = 'running' AND conductor_token = $3`,
          [claim.runId, claim.entityId, claim.token]
        );
        if (r.rowCount === 0) displaced.push(takenOver());
        lastWall = Date.now();
        lastMono = performance.now();
      } catch {
        // Not a verdict (see above): the silence it leaves is what counts.
      }
    });
  };
  const timer = setInterval(beat, everyMs);
  return {
    assertBeating: () => {
      if (displaced.length > 0) throw displaced[0];
      // Both clocks: the wall clock keeps running while a machine sleeps, the
      // monotonic one cannot be set back.
      const silentMs = Math.max(Date.now() - lastWall, performance.now() - lastMono);
      if (silentMs > silenceLimitMs) throw lockLost(new Error(`no heartbeat landed for ${Math.round(silentMs)} ms`));
    },
    stop: async () => {
      clearInterval(timer);
      await chain;
    },
  };
}

/**
 * Listens for the lock connection dying while it is checked out.
 *
 * `pg` handles errors of IDLE pooled connections, not of one a caller holds:
 * a backend terminated under a held client emits `error` with nobody
 * listening, and Node ends the process. The integration test that kills the
 * lock's backend found it — the CLI would have crashed mid-run instead of
 * stopping at its next checkpoint and saying the lock was lost.
 */
export function watchLockConnection(client: {
  on(event: 'error', listener: (err: Error) => void): unknown;
  off(event: 'error', listener: (err: Error) => void): unknown;
}): { error: () => Error | undefined; stop: () => void } {
  let seen: Error | undefined;
  const listener = (err: Error): void => {
    seen ??= err;
  };
  client.on('error', listener);
  return {
    error: () => seen,
    stop: () => {
      client.off('error', listener);
    },
  };
}

const LOCK_KEEPALIVE_MS = 5_000;

/** The part of a pool client the lock helpers use. */
export interface LockConnection {
  query(sql: string): Promise<unknown>;
  release(destroy?: boolean): void;
}

/**
 * The lock's keepalive: a `SELECT 1` on the lock's own transaction every so
 * often, so an idle-in-transaction timeout does not end it mid-run. `lost`
 * reads the first error seen so far; `stop` ends it and hands that error back.
 */
export function startLockKeepalive(
  client: Pick<LockConnection, 'query'>,
  everyMs: number
): { lost: () => unknown; stop: () => Promise<unknown> } {
  let chain = Promise.resolve();
  let lost: unknown;
  const beat = (): void => {
    chain = chain
      .then(() => client.query('SELECT 1').then(() => undefined))
      .catch((err: unknown) => {
        lost ??= err;
      });
  };
  const timer = setInterval(beat, everyMs);
  return {
    lost: () => lost,
    stop: async () => {
      clearInterval(timer);
      await chain;
      return lost;
    },
  };
}

/**
 * Says so when the lock's transaction was found gone. The run itself already
 * stopped at its next checkpoint; this line is what an operator reads when
 * the loss came after the last one — during the soft close, or after it.
 */
export function reportLostLock(lost: unknown, entityId: string, periodId: string): boolean {
  if (lost === undefined) return false;
  logger.warn('closing_run_lock_lost', {
    entityId,
    periodId,
    detail:
      'the transaction holding the conductor lock ended during the run; no step started after it was noticed, and no write to the run was accepted from this conductor once another had claimed it',
    error: lost instanceof Error ? lost.message : 'unknown error',
  });
  return true;
}

/**
 * COMMIT releases the lock. If it fails the connection is in an unknown
 * state, and it goes back to the pool DESTROYED rather than reused.
 */
export async function releaseLockConnection(client: LockConnection): Promise<void> {
  let broken = false;
  await client.query('COMMIT').catch(() => {
    broken = true;
  });
  client.release(broken);
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
  opts: ConductOptions,
  token: string
): Promise<string> {
  await refuseWhileAnotherConductorActs(ctx.entityId, periodId);
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
    if (!(await claimRun({ runId: openRunRow.id, entityId: ctx.entityId, token }))) {
      throw claimedByAnother(openRunRow.id);
    }
    return openRunRow.id;
  }
  if (opts.resume === true) {
    throw new ClosingRunStateError(
      'CLOSING_RUN_NOTHING_TO_RESUME',
      'Nothing to resume: this period has no open close run. Run it without --resume to start one.'
    );
  }
  const created = await startRun(ctx.entityId, periodId, opts.userId, token);
  if (created === null) throw claimedByAnother(null);
  return created;
}

/**
 * THE CLAIM IS ONE STATEMENT. Everything `openRun` read before it — nobody
 * live on the run, the run resumable, the period open — can have changed by
 * the time it writes: a conductor that lost its lock can be paused anywhere
 * in between, while another one finishes the month. So the write itself
 * re-asks all of it, and takes the row only if every answer still holds,
 * recording which call took it. False when it took nothing.
 */
export async function claimRun(claim: RunClaim): Promise<boolean> {
  const r = await query(
    `UPDATE closing_runs cr
        SET status = 'running', halted_at_step = NULL, ended_at = NULL,
            heartbeat_at = NOW(), conductor_token = $3
       FROM fiscal_periods fp
      WHERE cr.id = $1 AND cr.entity_id = $2
        AND fp.id = cr.fiscal_period_id AND fp.entity_id = cr.entity_id
        AND fp.status = 'open'
        AND (fp.soft_close_date IS NULL OR fp.soft_close_date < cr.started_at)
        AND cr.status IN ('running', 'blocked', 'stopped', 'failed')
        AND NOT COALESCE(cr.status = 'running' AND cr.heartbeat_at > NOW() - make_interval(secs => $4), false)`,
    [claim.runId, claim.entityId, claim.token, RUN_HEARTBEAT_STALE_AFTER_SECONDS]
  );
  return r.rowCount === 1;
}

/**
 * A new run, claimed by `token` — only on a period that is still open, and
 * never next to another resumable run (the partial unique index refuses the
 * row instead of raising). Null when nothing was created.
 */
export async function startRun(
  entityId: string,
  periodId: string,
  userId: string,
  token: string
): Promise<string | null> {
  const created = await query<RunRow>(
    `INSERT INTO closing_runs (entity_id, fiscal_period_id, status, started_by, heartbeat_at, conductor_token)
     SELECT $1::uuid, $2::uuid, 'running', $3::uuid, NOW(), $4::uuid
      WHERE EXISTS (SELECT 1 FROM fiscal_periods WHERE id = $2 AND entity_id = $1 AND status = 'open')
     ON CONFLICT DO NOTHING
     RETURNING id, status`,
    [entityId, periodId, userId, token]
  );
  return created.rows[0]?.id ?? null;
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
  claim: RunClaim,
  o: ClosingStepOutcome,
  accumulate: boolean
): Promise<StepRow> {
  // Written only while the run is still this call's: a conductor displaced
  // while its step was in flight does not add its attempt to another's run.
  // The guard LOCKS the run row (FOR SHARE): a plain EXISTS is read from the
  // statement's snapshot, and a claim committing meanwhile would not stop it.
  // With the lock, a claim in progress makes this statement wait and re-read
  // the row, and a claim that comes later waits for this record to land.
  const r = await query<StepRow>(
    `WITH owned AS (
       SELECT 1 FROM closing_runs
        WHERE id = $2 AND entity_id = $1 AND status = 'running' AND conductor_token = $11
          FOR SHARE
     )
     INSERT INTO closing_run_steps
       (entity_id, run_id, step_key, ordinal, status, processed, amount, journal_entry_ids, detail)
     SELECT $1::uuid, $2::uuid, $3::varchar, $4::int, $5::varchar, $6::int, $7::numeric, $8::uuid[], $9::text
      WHERE EXISTS (SELECT 1 FROM owned)
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
      claim.entityId,
      claim.runId,
      o.step,
      o.ordinal,
      o.status,
      o.processed,
      o.amount,
      o.journalEntryIds,
      o.detail,
      accumulate,
      claim.token,
    ]
  );
  if (r.rows.length === 0) throw takenOver();
  return r.rows[0];
}

/** Ends the run — only if it is still `running` under this call's token. */
async function closeRun(
  claim: RunClaim,
  status: ClosingRunOutcome['status'],
  haltedAtStep: ClosingStep | null
): Promise<void> {
  const r = await query(
    `UPDATE closing_runs
        SET status = $1, halted_at_step = $2, ended_at = NOW()
      WHERE id = $3 AND entity_id = $4 AND status = 'running' AND conductor_token = $5`,
    [status, haltedAtStep, claim.runId, claim.entityId, claim.token]
  );
  if (r.rowCount === 0) throw takenOver();
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

  return withConductorLock(ctx.entityId, period.id, async (lease) => {
    const token = randomUUID();
    await lease.assertHeld();
    const runId = await openRun(ctx, period.id, opts, token);
    const claim: RunClaim = { runId, entityId: ctx.entityId, token };
    const heartbeat = startRunHeartbeat(claim, LOCK_KEEPALIVE_MS, HEARTBEAT_SILENCE_LIMIT_MS);
    // PROVE, THEN ACT. Before every step, which is also after the previous
    // one: the soft close starts only after the lease was proven at its door,
    // with nothing in between but the read of the period's status.
    const checkpoint = async (): Promise<void> => {
      heartbeat.assertBeating();
      await lease.assertHeld();
    };
    const steps: ClosingStepOutcome[] = [];
    let current: ClosingStep = CLOSING_STEPS[0];
    // How far `current` got: a record or a close refused after the step's
    // engine (or the soft close) acted is not a step "not started", and a
    // close refused after the step's record landed is not "without its record".
    let currentRan = false;
    let currentRecorded = false;

    try {
      const priorSteps = await stepsOfRun(runId, ctx.entityId);

      for (const [i, step] of CLOSING_STEPS.entries()) {
        const ordinal = i + 1;
        current = step;
        currentRan = false;
        currentRecorded = false;
        await checkpoint();

        if (opts.stopAt === step) {
          await closeRun(claim, 'stopped', step);
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
        currentRan = true;

        const engine = SOURCE_OF_STEP[step] !== undefined;
        if (engine) outcome.journalEntryIds = await postedBy(ctx.entityId, period.id, step);
        const row = await recordStep(claim, outcome, engine);
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
        currentRecorded = true;

        if (accumulated.status === 'blocked' || accumulated.status === 'failed') {
          const runState = accumulated.status === 'blocked' ? 'blocked' : 'failed';
          await closeRun(claim, runState, step);
          return { ...frame, runId, status: runState, steps, haltedAtStep: step };
        }
      }

      await closeRun(claim, 'completed', null);
      return { ...frame, runId, status: 'completed' as const, steps, haltedAtStep: null };
    } catch (err) {
      // WHATEVER STOPPED THE RUN, THE RUN SAYS SO — a database error too, or
      // the row would read `running` and look live for a whole window. The
      // write is guarded by the claim: a conductor that was taken over
      // changes nothing, and then there is nothing more to say than the error.
      // The close is also the last word on ownership: a checkpoint that
      // stopped on silence or on the lock cannot know the run was claimed
      // meanwhile, and this guarded write can.
      const closing = await closeRun(claim, 'failed', current).then(
        () => 'closed' as const,
        (closeErr: unknown) =>
          isLockLost(closeErr) && (closeErr as ClosingRunStateError).details?.takenOver === true
            ? ('ended-by-another' as const)
            : ('unknown' as const)
      );
      if (isLockLost(err)) {
        // What the recorded steps posted stays posted and recorded. `current`
        // never started, ran without its record, or was recorded and the run
        // could not be closed — say which. And a run another conductor claimed
        // is not this one's to resume.
        const lost = err as ClosingRunStateError;
        const taken = lost.details?.takenOver === true || closing === 'ended-by-another';
        const where = currentRecorded
          ? `after ${current} and its record, without closing the run`
          : currentRan
            ? `after ${current} ran, without its record`
            : `before ${current}`;
        // Three honest answers: another conductor ended or claimed the run
        // (abandoned counts: it is no longer this one's either); this one
        // recorded it as failed and it can be resumed; or even that close
        // failed, and nobody here knows who holds the run.
        const next = taken
          ? 'The run was ended or taken over by another conductor; look at the period with --dry-run.'
          : closing === 'closed'
            ? 'Look at it with --dry-run and pick it up again with --resume.'
            : 'Its run could not be closed either; look at the period with --dry-run before resuming anything.';
        throw new ClosingRunStateError(
          LOCK_LOST,
          `${LOCK_LOST_MESSAGE} It stopped ${where}, after ${steps.length} recorded step(s). ${next}`,
          {
            ...lost.details,
            runId,
            haltedAtStep: current,
            stepRan: currentRan,
            stepRecorded: currentRecorded,
            takenOver: taken ? true : closing === 'closed' ? false : null,
            stepsTaken: steps.map((s) => s.step),
          }
        );
      }
      throw err;
    } finally {
      await heartbeat.stop();
    }
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
