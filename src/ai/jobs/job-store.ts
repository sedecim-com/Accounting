import { v4 as uuidv4 } from 'uuid';
import { query } from '../../database/connection.js';
import type { AgentContext } from '../context.js';

// ============================================================
// PERSISTED AGENT JOBS (ai_jobs / ai_job_runs)
// CRUD + the two invariants that make unattended scheduling safe:
//   · claimDueJobs — atomic per-job claim (guarded UPDATE with
//     RETURNING, same pattern as executeExternalOp): two runners
//     ticking at once can never both run the same job.
//   · recordRun — 'error' increments consecutive_failures and
//     auto-disables the job at max_failures in ONE guarded
//     UPDATE; success resets the counter.
// The cron matcher is deliberately minimal (5 fields; *, numbers,
// */n, comma lists) — no dependency, fully unit-tested.
// ============================================================

export type JobKind = 'close_verification' | 'cfdi_reconciliation' | 'ar_reminders';

export const JOB_KINDS: JobKind[] = ['close_verification', 'cfdi_reconciliation', 'ar_reminders'];

export interface JobRow {
  id: string;
  entity_id: string;
  name: string;
  kind: JobKind;
  schedule: string;
  enabled: boolean;
  consecutive_failures: number;
  max_failures: number;
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

export interface JobRunRow {
  id: string;
  job_id: string;
  job_name?: string;
  started_at: Date;
  finished_at: Date | null;
  status: 'ok' | 'skipped_no_work' | 'error';
  detail: Record<string, unknown> | null;
  drafts_created: number;
}

// ─── Minimal 5-field cron matcher ───
// minute hour dom month dow — supports *, plain numbers, */n steps
// and comma lists. No ranges, no names, no dependency.

interface CronField {
  /** null = wildcard (*): matches every value. */
  values: Set<number> | null;
}

export interface CronSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
  /** Standard cron: dom and dow OR together when BOTH are restricted. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELD_BOUNDS: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 }, // 0 and 7 both mean Sunday
];

export function parseCronField(raw: string, min: number, max: number, name: string): CronField {
  if (raw === '*') return { values: null };

  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const step = /^\*\/(\d+)$/.exec(part);
    if (step) {
      const n = parseInt(step[1], 10);
      if (n <= 0) throw new Error(`Invalid cron ${name} field "${raw}": step must be positive`);
      for (let v = min; v <= max; v += n) values.add(v);
      continue;
    }
    if (!/^\d+$/.test(part)) {
      throw new Error(`Invalid cron ${name} field "${raw}": only *, numbers, */n and comma lists are supported`);
    }
    const v = parseInt(part, 10);
    if (v < min || v > max) {
      throw new Error(`Invalid cron ${name} field "${raw}": ${v} is outside ${min}-${max}`);
    }
    // Cron convention: day-of-week 7 is an alias for Sunday (0).
    values.add(name === 'day-of-week' && v === 7 ? 0 : v);
  }
  if (values.size === 0) throw new Error(`Invalid cron ${name} field "${raw}"`);
  return { values };
}

export function parseCronSchedule(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression "${expr}": expected 5 fields (minute hour dom month dow)`);
  }
  const [minute, hour, dom, month, dow] = fields.map((raw, i) =>
    parseCronField(raw, FIELD_BOUNDS[i].min, FIELD_BOUNDS[i].max, FIELD_BOUNDS[i].name)
  );
  return {
    minute, hour, dayOfMonth: dom, month, dayOfWeek: dow,
    domRestricted: dom.values !== null,
    dowRestricted: dow.values !== null,
  };
}

const fieldMatches = (f: CronField, v: number): boolean => f.values === null || f.values.has(v);

/** Does this local-time instant (truncated to the minute) match the schedule? */
export function cronMatches(schedule: CronSchedule, date: Date): boolean {
  if (!fieldMatches(schedule.minute, date.getMinutes())) return false;
  if (!fieldMatches(schedule.hour, date.getHours())) return false;
  if (!fieldMatches(schedule.month, date.getMonth() + 1)) return false;

  const domOk = fieldMatches(schedule.dayOfMonth, date.getDate());
  const dowOk = fieldMatches(schedule.dayOfWeek, date.getDay());
  // Standard cron semantics: when BOTH day fields are restricted the entry
  // runs when EITHER matches; otherwise both must match (wildcards always do).
  return schedule.domRestricted && schedule.dowRestricted ? domOk || dowOk : domOk && dowOk;
}

const MINUTE_MS = 60_000;
// Far enough for any 5-field expression that can ever fire (covers Feb 29).
const HORIZON_MINUTES = 366 * 24 * 60 * 5;

/** The next instant STRICTLY AFTER `from` that matches the expression. */
export function nextRunAt(expr: string, from: Date = new Date()): Date {
  const schedule = parseCronSchedule(expr);
  let t = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let i = 0; i < HORIZON_MINUTES; i++, t += MINUTE_MS) {
    if (cronMatches(schedule, new Date(t))) return new Date(t);
  }
  throw new Error(`Cron expression "${expr}" never matches (searched 5 years ahead)`);
}

// ─── CRUD ───

const JOB_COLUMNS = `id, entity_id, name, kind, schedule, enabled, consecutive_failures,
            max_failures, last_run_at, next_run_at, created_by, created_at`;

export interface CreateJobInput {
  name: string;
  kind: JobKind;
  schedule: string;
  maxFailures?: number;
  createdBy?: string;
}

export async function createJob(ctx: AgentContext, input: CreateJobInput): Promise<JobRow> {
  if (!JOB_KINDS.includes(input.kind)) {
    throw new Error(`Unknown job kind "${input.kind}". Valid kinds: ${JOB_KINDS.join(', ')}`);
  }
  // Validates the expression AND seeds the first due time.
  const next = nextRunAt(input.schedule);
  const id = uuidv4();
  const result = await query<JobRow>(
    `INSERT INTO ai_jobs (
       id, tenant_id, entity_id, name, kind, schedule, max_failures, next_run_at, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${JOB_COLUMNS}`,
    [
      id, ctx.tenantId, ctx.entityId, input.name, input.kind, input.schedule,
      input.maxFailures ?? 3, next, input.createdBy ?? null,
    ]
  );
  return result.rows[0];
}

export async function listJobs(ctx: AgentContext): Promise<JobRow[]> {
  const result = await query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM ai_jobs WHERE entity_id = $1 ORDER BY name ASC`,
    [ctx.entityId]
  );
  return result.rows;
}

export async function getJob(ctx: AgentContext, jobId: string): Promise<JobRow | null> {
  const result = await query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM ai_jobs WHERE id = $1 AND entity_id = $2`,
    [jobId, ctx.entityId]
  );
  return result.rows[0] ?? null;
}

/**
 * Enable/disable a job. Enabling resets the failure counter and recomputes
 * next_run_at from the schedule (a job re-enabled after auto-disable must
 * not fire immediately on a stale next_run_at).
 */
export async function setEnabled(ctx: AgentContext, jobId: string, enabled: boolean): Promise<JobRow> {
  const job = await getJob(ctx, jobId);
  if (!job) throw new Error(`Job ${jobId} does not exist in this entity`);

  const next = enabled ? nextRunAt(job.schedule) : job.next_run_at;
  const result = await query<JobRow>(
    `UPDATE ai_jobs
     SET enabled = $1,
         consecutive_failures = CASE WHEN $1 THEN 0 ELSE consecutive_failures END,
         next_run_at = $2
     WHERE id = $3 AND entity_id = $4
     RETURNING ${JOB_COLUMNS}`,
    [enabled, next, jobId, ctx.entityId]
  );
  if (result.rowCount !== 1) {
    throw new Error(`Job ${jobId} does not exist in this entity`);
  }
  return result.rows[0];
}

/**
 * Atomically claim every due job. Per job, a single guarded UPDATE moves
 * next_run_at forward and stamps last_run_at ONLY IF the job is still due
 * and enabled AND next_run_at still equals the value this runner read
 * (claim-by-expected-value) — a concurrent runner racing on the same job
 * gets rowCount 0 and skips it. Same single-executor pattern as
 * executeExternalOp (external-service.ts).
 *
 * The stored next_run_at is clamped to the DB clock in SQL:
 * GREATEST($next, date_trunc('minute', NOW()) + 1 minute). The JS-computed
 * next slot serves sparse schedules, but if this process's clock trails
 * the DB clock the naive value could land in the DB's past and let a
 * second runner immediately re-claim the same slot — the clamp guarantees
 * the replacement is always strictly in the DB's future.
 */
export async function claimDueJobs(ctx: AgentContext, now: Date = new Date()): Promise<JobRow[]> {
  const due = await query<{ id: string; schedule: string; next_run_at: Date }>(
    `SELECT id, schedule, next_run_at FROM ai_jobs
     WHERE entity_id = $1 AND enabled = true AND next_run_at <= NOW()
     ORDER BY next_run_at ASC`,
    [ctx.entityId]
  );

  const claimed: JobRow[] = [];
  for (const candidate of due.rows) {
    let next: Date;
    try {
      next = nextRunAt(candidate.schedule, now);
    } catch {
      // Unparseable schedule (edited by hand?): leave the row alone; the
      // operator sees it stuck in `jobs list` instead of a silent crash loop.
      continue;
    }
    const result = await query<JobRow>(
      `UPDATE ai_jobs
       SET last_run_at = NOW(),
           next_run_at = GREATEST($1::timestamptz, date_trunc('minute', NOW()) + interval '1 minute')
       WHERE id = $2 AND entity_id = $3 AND enabled = true
         AND next_run_at <= NOW() AND next_run_at = $4
       RETURNING ${JOB_COLUMNS}`,
      [next, candidate.id, ctx.entityId, candidate.next_run_at]
    );
    // rowCount 0 = another runner claimed it (or it was disabled) — not ours.
    if (result.rowCount === 1) claimed.push(result.rows[0]);
  }
  return claimed;
}

export interface RecordRunInput {
  status: 'ok' | 'skipped_no_work' | 'error';
  detail?: Record<string, unknown>;
  draftsCreated?: number;
  startedAt: Date;
  finishedAt?: Date;
}

export interface RecordRunResult {
  runId: string;
  /** true when THIS error run pushed the job to max_failures and disabled it. */
  autoDisabled: boolean;
}

/**
 * Persist one run and apply the backoff bookkeeping on the job row.
 * 'error' increments consecutive_failures and flips enabled = false the
 * moment the counter reaches max_failures — one guarded UPDATE (WHERE
 * enabled = true), so two racing recorders can never double-disable or
 * lose an increment, and autoDisabled is true ONLY when THIS call
 * flipped the job off (an already-disabled job matches no row).
 * Counter semantics: 'ok' resets it, 'error' increments it, and
 * 'skipped_no_work' touches NOTHING — an empty gate says nothing about
 * job health, so a healthy-looking skip must never mask alternating
 * real failures by resetting the counter between them.
 */
export async function recordRun(
  ctx: AgentContext,
  jobId: string,
  input: RecordRunInput
): Promise<RecordRunResult> {
  const runId = uuidv4();
  await query(
    `INSERT INTO ai_job_runs (
       id, job_id, tenant_id, entity_id, started_at, finished_at, status, detail, drafts_created
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      runId, jobId, ctx.tenantId, ctx.entityId,
      input.startedAt, input.finishedAt ?? new Date(),
      input.status,
      input.detail ? JSON.stringify(input.detail) : null,
      input.draftsCreated ?? 0,
    ]
  );

  if (input.status === 'error') {
    // Guarded by enabled = true: an already-disabled job matches no row
    // (rowCount 0), so autoDisabled can only report a flip THIS call made.
    const result = await query<{ enabled: boolean; consecutive_failures: number }>(
      `UPDATE ai_jobs
       SET consecutive_failures = consecutive_failures + 1,
           enabled = CASE
             WHEN consecutive_failures + 1 >= max_failures THEN false
             ELSE enabled
           END
       WHERE id = $1 AND entity_id = $2 AND enabled = true
       RETURNING enabled, consecutive_failures`,
      [jobId, ctx.entityId]
    );
    const row = result.rows[0];
    return {
      runId,
      autoDisabled: result.rowCount === 1 && row !== undefined && row.enabled === false,
    };
  }

  if (input.status === 'ok') {
    await query(
      `UPDATE ai_jobs SET consecutive_failures = 0
       WHERE id = $1 AND entity_id = $2 AND consecutive_failures <> 0`,
      [jobId, ctx.entityId]
    );
  }
  // 'skipped_no_work' deliberately leaves consecutive_failures untouched:
  // an empty wake-gate proves nothing about the job's health, and resetting
  // here would let alternating error/skip cycles evade max_failures forever.
  return { runId, autoDisabled: false };
}

export async function listRuns(
  ctx: AgentContext,
  opts?: { jobId?: string; limit?: number }
): Promise<JobRunRow[]> {
  const conditions = ['r.entity_id = $1'];
  const params: unknown[] = [ctx.entityId];
  if (opts?.jobId) {
    params.push(opts.jobId);
    conditions.push(`r.job_id = $${params.length}`);
  }
  // Same pattern as session-store listSessions: a NaN/Infinity limit (e.g.
  // parseInt of garbage CLI input) must fall back to the default BEFORE
  // clamping, and the value travels as a bind parameter, never interpolated.
  const raw = opts?.limit;
  const limit = Math.min(500, Math.max(1, Number.isFinite(raw) ? Math.trunc(raw as number) : 20));
  params.push(limit);
  const result = await query<JobRunRow>(
    `SELECT r.id, r.job_id, j.name AS job_name, r.started_at, r.finished_at,
            r.status, r.detail, r.drafts_created
     FROM ai_job_runs r
     JOIN ai_jobs j ON j.id = r.job_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY r.started_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}
