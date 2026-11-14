import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { calculatePayRun } from '../../src/services/payroll/common/pay-run-service.js';
import { entityScope } from '../../src/database/scope.js';
// The calculators register on import.
import '../../src/services/payroll/tax-engine/register-all.js';

// ============================================================
// A MISSING BRACKET TABLE STOPS THE RUN BEFORE ITS FIRST PAYCHECK
// (MNE-001-353 · #127). Each paycheck commits on its own, so a gap found for
// the second employee used to leave the first one's paycheck written.
// Migration 009 seeds 2026 FIT for single, married_jointly and
// head_of_household only: married_separately has no table.
// ============================================================

describe('a US run with an employee whose tax table is missing', () => {
  let f: Fixture;
  let scheduleId: string;
  let periodId: string;

  async function usEmployee(number: string, w4: Record<string, unknown>, state: string | null): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, ssn_encrypted, pay_schedule_id, salary_type,
         currency_code, w4_data, work_state)
       VALUES ($1, $2, $3, $4, 'Worker', $4, '2024-01-01', 'active', 'US', 'x', $5,
         'salary', 'USD', $6::jsonb, $7)`,
      [id, f.tenantId, f.entityId, number, scheduleId, JSON.stringify(w4), state]
    );
    return id;
  }

  async function newRun(): Promise<string> {
    const runId = uuidv4();
    await query(
      `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by)
       VALUES ($1, $2, $3, 'regular', 'calculating', 2026, $4)`,
      [runId, f.tenantId, periodId, f.userId]
    );
    return runId;
  }

  const salary = [{ earning_type: 'salary', amount: 5000 }];
  const run = (runId: string, ids: string[]) =>
    calculatePayRun(
      runId,
      {
        tenant_id: f.tenantId, pay_period_id: '', created_by: f.userId,
        employee_inputs: ids.map((employee_id) => ({ employee_id, earnings: salary })),
      },
      entityScope(f.tenantId, f.entityId)
    );
  const paychecksOf = async (runId: string) =>
    (await query(`SELECT 1 FROM paychecks WHERE pay_run_id = $1`, [runId])).rows.length;

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-353 · run tax tables');
    scheduleId = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Monthly', 'monthly', 'US', '2026-01-01', true)`,
      [scheduleId, f.tenantId, f.entityId]
    );
    periodId = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, '2026-07-01', '2026-07-31', '2026-07-31', 2026, 'draft')`,
      [periodId, f.tenantId, scheduleId]
    );
  }, 120_000);

  it('writes zero paychecks when the SECOND employee is married_separately, and names them', async () => {
    const ok = await usEmployee('US-OK1', { filing_status: 'single' }, null);
    const bad = await usEmployee('US-MS1', { filing_status: 'married_separately' }, null);
    const runId = await newRun();
    await expect(run(runId, [ok, bad])).rejects.toThrow(
      new RegExp(`employee ${bad}: No fit brackets for US-FEDERAL, 2026, filing_status «married_separately»`)
    );
    expect(await paychecksOf(runId)).toBe(0);
  });

  it('names every employee and table that is missing in one error, SIT included', async () => {
    const federal = await usEmployee('US-MS2', { filing_status: 'married_separately' }, null);
    const state = await usEmployee('US-CA1', { filing_status: 'married_jointly' }, 'CA');
    const runId = await newRun();
    const error = await run(runId, [federal, state]).catch((e: Error) => e);
    expect((error as Error).message).toContain(`employee ${federal}: No fit brackets`);
    expect((error as Error).message).toContain(`employee ${state}: No sit brackets for US-CA, 2026`);
    expect(await paychecksOf(runId)).toBe(0);
  });

  it('a run whose employees all have their tables still calculates', async () => {
    const a = await usEmployee('US-OK2', { filing_status: 'single' }, null);
    const b = await usEmployee('US-OK3', { filing_status: 'married_jointly' }, null);
    const runId = await newRun();
    await run(runId, [a, b]);
    expect(await paychecksOf(runId)).toBe(2);
  });
});
