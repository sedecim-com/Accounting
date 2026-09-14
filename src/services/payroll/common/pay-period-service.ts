import { v4 as uuidv4 } from 'uuid';
import { query } from '../../../database/connection.js';
import { requireByIdInScope, type EntityScope } from '../../../database/scope.js';

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
function aMedianocheUtc(value: Date | string): Date {
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
    tax_year: end.getUTCFullYear(),
  };
}

export async function generatePayPeriods(
  scope: EntityScope,
  payScheduleId: string,
  count: number
): Promise<string[]> {
  // TEN-11 (#235): the schedule used to be read by `WHERE id = $1` alone. The
  // route was broken for everyone (see `aMedianocheUtc`), so it leaked nothing
  // — but fixing that bug without this boundary would have opened it.
  //
  // Here the generic helper IS right, unlike for `pay_runs`: `pay_schedules`
  // has its own `entity_id`, so the scope becomes `entity_id = $2`. It throws
  // NotFoundError — the same 404 for a foreign schedule and a missing one,
  // where it used to be a plain Error (500). Checking first and writing after
  // is sound here: nothing in `src/` ever updates `pay_schedules.entity_id`.
  const s = await requireByIdInScope<{
    tenant_id: string;
    frequency: PayScheduleInput['frequency'];
    first_period_start: Date | string;
    pay_day_offset: number;
  }>('pay_schedules', payScheduleId, scope, {
    columns: 'tenant_id, frequency, first_period_start, pay_day_offset',
  });

  const lastResult = await query<{ period_end: Date | string }>(
    `SELECT period_end FROM pay_periods WHERE pay_schedule_id = $1 ORDER BY period_end DESC LIMIT 1`,
    [payScheduleId]
  );

  let cursor: Date;
  if (lastResult.rows.length > 0) {
    cursor = aMedianocheUtc(lastResult.rows[0].period_end);
  } else {
    cursor = addDays(aMedianocheUtc(s.first_period_start), -1);
  }

  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const next = computeNextPeriod(s.frequency, cursor, s.pay_day_offset);
    const id = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pay_schedule_id, period_start) DO NOTHING`,
      [id, s.tenant_id, payScheduleId, next.period_start, next.period_end, next.pay_date, next.tax_year]
    );
    ids.push(id);
    cursor = new Date(next.period_end + 'T00:00:00Z');
  }
  return ids;
}
