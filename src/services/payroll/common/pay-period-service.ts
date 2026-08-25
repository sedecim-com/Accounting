import { v4 as uuidv4 } from 'uuid';
import { query } from '../../../database/connection.js';

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
  payScheduleId: string,
  count: number
): Promise<string[]> {
  const schedResult = await query<{
    tenant_id: string;
    frequency: PayScheduleInput['frequency'];
    first_period_start: string;
    pay_day_offset: number;
  }>(
    `SELECT tenant_id, frequency, first_period_start, pay_day_offset FROM pay_schedules WHERE id = $1`,
    [payScheduleId]
  );
  if (schedResult.rows.length === 0) throw new Error('pay_schedule not found');
  const s = schedResult.rows[0];

  const lastResult = await query<{ period_end: string }>(
    `SELECT period_end FROM pay_periods WHERE pay_schedule_id = $1 ORDER BY period_end DESC LIMIT 1`,
    [payScheduleId]
  );

  let cursor: Date;
  if (lastResult.rows.length > 0) {
    cursor = new Date(lastResult.rows[0].period_end + 'T00:00:00Z');
  } else {
    cursor = addDays(new Date(s.first_period_start + 'T00:00:00Z'), -1);
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
