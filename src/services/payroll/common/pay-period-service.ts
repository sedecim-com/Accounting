import { v4 as uuidv4, validate as isUuid } from 'uuid';
import { query } from '../../../database/connection.js';
import { requireByIdInScope, type EntityScope } from '../../../database/scope.js';
import { NotFoundError } from '../../../utils/errors.js';

// ============================================================
// PAY PERIOD SERVICE
// Generate pay periods from pay schedules.
// ============================================================

export interface PayScheduleInput {
  tenant_id: string;
  entity_id: string;
  name: string;
  frequency: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quincenal';
  country_code: 'MX' | 'US';
  first_period_start: string;
  period_end_day?: number;
  pay_day_offset?: number;
}

export async function createPaySchedule(input: PayScheduleInput): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start, period_end_day, pay_day_offset)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id, input.tenant_id, input.entity_id, input.name, input.frequency, input.country_code,
      input.first_period_start, input.period_end_day || null, input.pay_day_offset || 0,
    ]
  );
  return id;
}

/**
 * A DATE column comes back from pg as a `Date` at LOCAL midnight; every bit of
 * arithmetic in this file is UTC. So the bridge takes the LOCAL calendar day
 * and builds UTC midnight of that same day.
 *
 * This used to be `new Date(value + 'T00:00:00Z')`, which only works on a
 * string: on a `Date` it concatenates the long human-readable form, and
 * `new Date()` of that is Invalid Date. Measured: the route answered 500 to
 * everyone and wrote nothing (TEN-11, #235). The naive fix —
 * `value.toISOString()` — would shift the day east of Greenwich, which is the
 * family of #211.
 */
function toUtcMidnight(value: Date | string): Date {
  if (typeof value === 'string') return new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface GeneratedPeriod {
  period_start: string;
  period_end: string;
  pay_date: string;
  tax_year: number;
}

export function computeNextPeriod(
  frequency: PayScheduleInput['frequency'],
  lastEnd: Date,
  payDayOffset: number
): GeneratedPeriod {
  let start: Date, end: Date;
  switch (frequency) {
    case 'weekly':
      start = addDays(lastEnd, 1);
      end = addDays(start, 6);
      break;
    case 'biweekly':
      start = addDays(lastEnd, 1);
      end = addDays(start, 13);
      break;
    case 'quincenal': {
      // MX: 1-15 and 16-end of month
      start = addDays(lastEnd, 1);
      const day = start.getUTCDate();
      if (day === 1) {
        end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 15));
      } else {
        end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
      }
      break;
    }
    case 'semimonthly': {
      start = addDays(lastEnd, 1);
      const day = start.getUTCDate();
      if (day === 1) {
        end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 15));
      } else {
        end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
      }
      break;
    }
    case 'monthly':
      start = addDays(lastEnd, 1);
      end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
      break;
  }
  const pay = addDays(end, payDayOffset);
  return {
    period_start: isoDate(start),
    period_end: isoDate(end),
    pay_date: isoDate(pay),
    // The exercise is the PAYMENT's (#242): a period closing on December 31st
    // and paid on January 5th is wages of the new year — for ISR (LISR 96, the
    // CFDI's `FechaPago`) and for the US withholding alike. The period's end
    // labelled it with the old year, and its YTD with it.
    tax_year: pay.getUTCFullYear(),
  };
}

interface ScheduleInScope {
  tenant_id: string;
  frequency: PayScheduleInput['frequency'];
  first_period_start: Date | string;
  pay_day_offset: number;
}

/**
 * TEN-11 (#235): the schedule used to be read by `WHERE id = $1` alone. The
 * route was broken for everyone (see `toUtcMidnight`), so it leaked nothing
 * — but fixing that bug without this boundary would have opened it.
 *
 * Here the generic helper IS right, unlike for `pay_runs`: `pay_schedules`
 * has its own `entity_id`, so the scope becomes `entity_id = $2`. It throws
 * NotFoundError — the same 404 for a foreign schedule and a missing one,
 * where it used to be a plain Error (500). Checking first and writing after
 * is sound here: nothing in `src/` ever updates `pay_schedules.entity_id`.
 */
async function scheduleInScope(scope: EntityScope, payScheduleId: string): Promise<ScheduleInScope> {
  // An id that cannot be a UUID names no schedule: the same 404 as a missing
  // one, instead of Postgres's cast error surfacing as a 500.
  if (!isUuid(payScheduleId)) throw new NotFoundError('Pay schedule', payScheduleId);
  return requireByIdInScope<ScheduleInScope>('pay_schedules', payScheduleId, scope, {
    columns: 'tenant_id, frequency, first_period_start, pay_day_offset',
  });
}

/** The next `count` periods of the schedule after its last one, computed and not written. */
export async function planPayPeriods(
  scope: EntityScope,
  payScheduleId: string,
  count: number
): Promise<GeneratedPeriod[]> {
  const s = await scheduleInScope(scope, payScheduleId);
  // `pay_periods` has no `entity_id`: its boundary is its schedule's, joined
  // inside this statement instead of trusted from the check above.
  const lastResult = await query<{ period_end: Date | string }>(
    `SELECT pp.period_end FROM pay_periods pp
       JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id
      WHERE pp.pay_schedule_id = $1 AND ps.tenant_id = $2 AND ps.entity_id = $3
      ORDER BY pp.period_end DESC LIMIT 1`,
    [payScheduleId, scope.tenantId, scope.entityId]
  );

  let cursor: Date;
  if (lastResult.rows.length > 0) {
    cursor = toUtcMidnight(lastResult.rows[0].period_end);
  } else {
    cursor = addDays(toUtcMidnight(s.first_period_start), -1);
  }

  const periods: GeneratedPeriod[] = [];
  for (let i = 0; i < count; i++) {
    const next = computeNextPeriod(s.frequency, cursor, s.pay_day_offset);
    periods.push(next);
    cursor = new Date(next.period_end + 'T00:00:00Z');
  }
  return periods;
}

/**
 * Writes planned periods of a schedule of the entity and returns the ones it
 * created, with their ids.
 *
 * Idempotent on UNIQUE(pay_schedule_id, period_start) (008_payroll.sql): two
 * runs that planned the same range — a retry, or two operators at once —
 * write it once. Only the ids `RETURNING` hands back are reported; this used
 * to report the id of every attempted insert, so a replay announced periods
 * it never wrote.
 */
export async function writePayPeriods(
  scope: EntityScope,
  payScheduleId: string,
  periods: GeneratedPeriod[]
): Promise<Array<GeneratedPeriod & { id: string }>> {
  const s = await scheduleInScope(scope, payScheduleId);
  const written: Array<GeneratedPeriod & { id: string }> = [];
  for (const next of periods) {
    const inserted = await query<{ id: string }>(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pay_schedule_id, period_start) DO NOTHING
       RETURNING id`,
      [uuidv4(), s.tenant_id, payScheduleId, next.period_start, next.period_end, next.pay_date, next.tax_year]
    );
    for (const r of inserted.rows) written.push({ ...next, id: r.id });
  }
  return written;
}

export async function generatePayPeriods(
  scope: EntityScope,
  payScheduleId: string,
  count: number
): Promise<string[]> {
  const written = await writePayPeriods(scope, payScheduleId, await planPayPeriods(scope, payScheduleId, count));
  return written.map((p) => p.id);
}

export interface PayScheduleRow {
  id: string;
  name: string;
  frequency: string;
  country_code: string;
  first_period_start: Date | string;
  pay_day_offset: number;
  is_active: boolean;
  employees: number;
}

/** The schedules of the entity, active ones unless `all`, with how many employees each one pays. */
export async function listPaySchedules(
  scope: EntityScope,
  options: { all?: boolean; limit?: number; offset?: number } = {}
): Promise<PayScheduleRow[]> {
  const result = await query<PayScheduleRow>(
    `SELECT ps.id, ps.name, ps.frequency, ps.country_code, ps.first_period_start, ps.pay_day_offset, ps.is_active,
            (SELECT COUNT(*)::int FROM employees e
              WHERE e.pay_schedule_id = ps.id AND e.tenant_id = $1 AND e.entity_id = $2) AS employees
       FROM pay_schedules ps
      WHERE ps.tenant_id = $1 AND ps.entity_id = $2 AND ($3::boolean OR ps.is_active)
      ORDER BY ps.created_at, ps.id
      LIMIT $4 OFFSET $5`,
    [scope.tenantId, scope.entityId, options.all === true, options.limit ?? null, options.offset ?? 0]
  );
  return result.rows;
}

export interface PayPeriodRow {
  id: string;
  pay_schedule_id: string;
  schedule_name: string;
  period_start: Date | string;
  period_end: Date | string;
  pay_date: Date | string;
  status: string;
  tax_year: number;
}

/** The periods of the entity's schedules, newest first; the boundary is the schedule's, joined in the SQL. */
export async function listPayPeriods(
  scope: EntityScope,
  options: { status?: string; year?: number; limit?: number; offset?: number } = {}
): Promise<PayPeriodRow[]> {
  const result = await query<PayPeriodRow>(
    `SELECT pp.id, pp.pay_schedule_id, ps.name AS schedule_name, pp.period_start, pp.period_end,
            pp.pay_date, pp.status, pp.tax_year
       FROM pay_periods pp
       JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id
      WHERE ps.tenant_id = $1 AND ps.entity_id = $2 AND pp.tenant_id = $1
        AND ($3::text IS NULL OR pp.status = $3) AND ($4::int IS NULL OR pp.tax_year = $4)
      ORDER BY pp.period_start DESC, ps.name
      LIMIT $5 OFFSET $6`,
    [scope.tenantId, scope.entityId, options.status ?? null, options.year ?? null, options.limit ?? null, options.offset ?? 0]
  );
  return result.rows;
}
