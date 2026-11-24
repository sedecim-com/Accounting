import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { calculatePayRun, createPayRun } from '../../src/services/payroll/common/pay-run-service.js';
import { entityScope } from '../../src/database/scope.js';
import { ConflictError } from '../../src/utils/errors.js';

// ============================================================
// A PAY RUN IS CALCULATED WHOLE OR NOT AT ALL, AND AGAIN BEFORE IT IS APPROVED
// (MNE-001-657 · #601)
//
// Against a migrated Postgres, through the service both doors call. The
// failure is injected with data, not with a double: the inputs name an
// employee twice, which passes the checks that read and collides with
// UNIQUE(pay_run_id, employee_id) on the THIRD paycheck, after two were
// written. Each run gets a fortnight of its own, so no case leans on two
// ordinary runs sharing a period.
// ============================================================

describe('a pay run is calculated whole or not at all, and again before it is approved', () => {
  let f: Fixture;
  let scheduleId: string;
  let a: string;
  let b: string;
  let c: string;
  let fortnight = 0;

  const scope = () => entityScope(f.tenantId, f.entityId);

  async function employee(number: string, sbc: string): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto, tipo_regimen_sat,
         work_state, pay_schedule_id, salary_type, currency_code)
       VALUES ($1, $2, $3, $4, 'Trabajador', $4, '2024-01-01', 'active', 'MX', 'XAXX010101000',
         'XAXX010101HDFXXX01', '12345678901', $5, '01', '02', 'JA', $6, 'salary', 'MXN')`,
      [id, f.tenantId, f.entityId, number, sbc, scheduleId]
    );
    return id;
  }

  /** A draft run over the first fortnight of the next month of 2026. */
  async function newRun(): Promise<string> {
    fortnight += 1;
    const month = String(fortnight).padStart(2, '0');
    const periodId = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, $4, $5, $5, 2026, 'draft')`,
      [periodId, f.tenantId, scheduleId, `2026-${month}-01`, `2026-${month}-15`]
    );
    return createPayRun(
      { tenant_id: f.tenantId, pay_period_id: periodId, employee_inputs: [], created_by: f.userId },
      scope()
    );
  }

  const calculate = (runId: string, salaries: Array<[string, number]>) =>
    calculatePayRun(
      runId,
      {
        tenant_id: f.tenantId, pay_period_id: '', created_by: f.userId,
        employee_inputs: salaries.map(([employee_id, amount]) => ({
          employee_id,
          earnings: [{ earning_type: 'salary', amount, cfdi_clave_sat: '001' }],
        })),
      },
      scope()
    );

  const paychecksOf = async (runId: string) =>
    (await query<{ id: string; employee_id: string; gross: string; net: string; employer: string }>(
      `SELECT p.id, p.employee_id, p.gross_earnings::text AS gross, p.net_pay::text AS net,
              (p.imss_employer + p.infonavit_employer)::text AS employer
         FROM paychecks p JOIN employees e ON e.id = p.employee_id
        WHERE p.pay_run_id = $1 ORDER BY e.employee_number`,
      [runId]
    )).rows;

  const runOf = async (runId: string) =>
    (await query<{ status: string; employees: number; gross: string; net: string; employer: string; cost: string }>(
      `SELECT status, employee_count AS employees, total_gross::text AS gross, total_net_pay::text AS net,
              total_employer_taxes::text AS employer, total_employer_cost::text AS cost
         FROM pay_runs WHERE id = $1`,
      [runId]
    )).rows[0];

  const setStatus = (runId: string, status: string) =>
    query('UPDATE pay_runs SET status = $2 WHERE id = $1 AND tenant_id = $3', [runId, status, f.tenantId]);

  /** The run's totals against the sum of the paychecks it holds, column by column. */
  async function expectTotalsAreTheSumOfItsPaychecks(runId: string): Promise<void> {
    const rows = await paychecksOf(runId);
    const sum = (k: 'gross' | 'net' | 'employer') => rows.reduce((s, p) => s.plus(p[k]), new Decimal(0));
    const run = await runOf(runId);
    expect(run.employees).toBe(rows.length);
    expect(run.gross).toBe(sum('gross').toFixed(2));
    expect(run.net).toBe(sum('net').toFixed(2));
    expect(run.employer).toBe(sum('employer').toFixed(2));
    expect(run.cost).toBe(sum('gross').plus(sum('employer')).toFixed(2));
  }

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-657 · pay run atomic');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    scheduleId = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
      [scheduleId, f.tenantId, f.entityId]
    );
    a = await employee('R-001', '400.0000');
    b = await employee('R-002', '650.0000');
    c = await employee('R-003', '320.0000');
  }, 120_000);

  it('a failure on the third paycheck leaves no paycheck written and the run in draft', async () => {
    const runId = await newRun();
    await expect(calculate(runId, [[a, 6000], [b, 9750], [a, 6000]])).rejects.toThrow(
      /paychecks_pay_run_id_employee_id_key/
    );
    expect(await paychecksOf(runId)).toEqual([]);
    expect((await runOf(runId)).status).toBe('draft');
  });

  it('a calculated run is calculated again with a changed input: its paychecks are rebuilt', async () => {
    const runId = await newRun();
    await calculate(runId, [[a, 6000], [b, 9750]]);
    const first = await paychecksOf(runId);
    expect(first.map((p) => p.gross)).toEqual(['6000.00', '9750.00']);

    await calculate(runId, [[a, 6500], [b, 9750]]);
    const rebuilt = await paychecksOf(runId);
    expect(rebuilt.map((p) => [p.employee_id, p.gross])).toEqual([[a, '6500.00'], [b, '9750.00']]);
    // Rebuilt, not patched: no row of the first calculation survives.
    for (const p of first) expect(rebuilt.map((r) => r.id)).not.toContain(p.id);
    const run = await runOf(runId);
    expect(run.status).toBe('calculated');
    // By hand: 6,500.00 + 9,750.00.
    expect(run.gross).toBe('16250.00');
    await expectTotalsAreTheSumOfItsPaychecks(runId);
  });

  it('the rebuilt run holds the employees of the last inputs only, and totals them', async () => {
    const runId = await newRun();
    await calculate(runId, [[a, 6000], [b, 9750]]);
    await calculate(runId, [[a, 6000], [c, 4800]]);
    expect((await paychecksOf(runId)).map((p) => p.employee_id)).toEqual([a, c]);
    const run = await runOf(runId);
    expect(run.employees).toBe(2);
    // By hand: 6,000.00 + 4,800.00; the 9,750.00 of the employee left out is gone.
    expect(run.gross).toBe('10800.00');
    await expectTotalsAreTheSumOfItsPaychecks(runId);
  });

  it('a recalculation that fails halfway leaves the calculated run as it was', async () => {
    const runId = await newRun();
    await calculate(runId, [[a, 6000], [b, 9750]]);
    const before = { run: await runOf(runId), paychecks: await paychecksOf(runId) };

    await expect(calculate(runId, [[c, 4800], [a, 6500], [c, 4800]])).rejects.toThrow(
      /paychecks_pay_run_id_employee_id_key/
    );
    expect(await runOf(runId)).toEqual(before.run);
    expect(await paychecksOf(runId)).toEqual(before.paychecks);
  });

  it('a run left in `calculating` with a paycheck half-written is rebuilt whole', async () => {
    // What a failure halfway left behind before this task: the status and one paycheck.
    const runId = await newRun();
    await setStatus(runId, 'calculating');
    await query(
      `INSERT INTO paychecks (id, tenant_id, pay_run_id, employee_id, gross_earnings, net_pay)
       VALUES ($1, $2, $3, $4, 6000, 5000)`,
      [uuidv4(), f.tenantId, runId, a]
    );
    await calculate(runId, [[a, 6000], [b, 9750]]);
    const run = await runOf(runId);
    expect(run.status).toBe('calculated');
    // By hand: 6,000.00 + 9,750.00.
    expect(run.gross).toBe('15750.00');
    await expectTotalsAreTheSumOfItsPaychecks(runId);
  });

  it.each(['approved', 'paid'])('a run that is %s is still refused, and keeps its paychecks', async (status) => {
    const runId = await newRun();
    await calculate(runId, [[a, 6000], [b, 9750]]);
    await setStatus(runId, status);
    const before = { run: await runOf(runId), paychecks: await paychecksOf(runId) };

    await expect(calculate(runId, [[a, 6500], [b, 9750]])).rejects.toBeInstanceOf(ConflictError);
    expect(await runOf(runId)).toEqual(before.run);
    expect(await paychecksOf(runId)).toEqual(before.paychecks);
  });

  it.each(['a payroll CFDI', 'a deposit batch'])(
    'a calculated run with a paycheck that already left in %s is not rebuilt',
    async (what) => {
      const runId = await newRun();
      await calculate(runId, [[a, 6000], [b, 9750]]);
      // Written by hand: both doors refuse an unapproved run since MNE-001-720, but a row
      // stamped or batched before that can still hold one.
      if (what === 'a payroll CFDI') {
        await query(
          `UPDATE paychecks SET cfdi_uuid = $3, cfdi_status = 'stamped' WHERE pay_run_id = $1 AND employee_id = $2`,
          [runId, a, uuidv4()]
        );
      } else {
        const batchId = uuidv4();
        await query(
          `INSERT INTO direct_deposit_batches (id, tenant_id, pay_run_id, rail, total_amount, entry_count, effective_date)
           VALUES ($1, $2, $3, 'spei', 5000, 1, '2026-01-15')`,
          [batchId, f.tenantId, runId]
        );
        await query(
          'UPDATE paychecks SET direct_deposit_batch_id = $3 WHERE pay_run_id = $1 AND employee_id = $2',
          [runId, a, batchId]
        );
      }
      const before = { run: await runOf(runId), paychecks: await paychecksOf(runId) };

      const error = await calculate(runId, [[a, 6500], [b, 9750]]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).messageKey?.key).toBe('payrun.calculate.paycheck_left_the_system');
      expect(await runOf(runId)).toEqual(before.run);
      expect(await paychecksOf(runId)).toEqual(before.paychecks);
    }
  );
});
