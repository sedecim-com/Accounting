import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { calculatePaycheck } from '../../src/services/payroll/common/paycheck-service.js';
import { calculatePayRun } from '../../src/services/payroll/common/pay-run-service.js';
import { entityScope } from '../../src/database/scope.js';
import { legalParameterAt } from '../../src/services/jurisdiction/legal-parameters.js';
import {
  OVERTIME_EXEMPT_CAP_KEY,
  OVERTIME_POLICY_KEY,
  OVERTIME_WEEKLY_HOURS_KEY,
} from '../../src/services/payroll/mx/isr-exemption.js';
// The calculators register on import; without it `getRequired('MX','isr')` throws.
import '../../src/services/payroll/tax-engine/register-all.js';

// ============================================================
// OVERTIME IS EXEMPT BY LISR ART. 93 FR. I (#297, MNE-001-110)
//
// Against a migrated database, with no seeder: the share, the cap and the
// dated LFT limit come from migration 164, the UMA from the dated
// `tax_parameters` rows of 073, and the answer from the panel.
// ============================================================

describe('overtime is exempt by half up to 5 UMA a week, as the panel says', () => {
  let f: Fixture;
  let scheduleId: string;
  let employeeId: string;

  /** A 15-day period paid on its last day: 15/7 weeks of service. */
  async function periodPaidOn(payDate: string, start: string): Promise<string> {
    const periodId = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, $4, $5, $5, 2026, 'draft')`,
      [periodId, f.tenantId, scheduleId, start, payDate]
    );
    return periodId;
  }

  async function runOn(periodId: string, runType = 'regular'): Promise<string> {
    const runId = uuidv4();
    await query(
      `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by)
       VALUES ($1, $2, $3, $4, 'calculating', 2026, $5)`,
      [runId, f.tenantId, periodId, runType, f.userId]
    );
    return runId;
  }

  async function runPaidOn(payDate: string, start: string): Promise<string> {
    return runOn(await periodPaidOn(payDate, start));
  }

  /** The overtime row's exempt part, for one paycheck calculated in `runId`, which then counts. */
  async function overtimeExemptIn(runId: string, amount: number, hours: number): Promise<string> {
    const r = await calculatePaycheck({
      tenant_id: f.tenantId, pay_run_id: runId, employee_id: employeeId,
      earnings: [
        { earning_type: 'salary', amount: 6000, cfdi_clave_sat: '001' },
        { earning_type: 'overtime', amount, hours, cfdi_clave_sat: '019' },
      ],
    });
    await query(`UPDATE pay_runs SET status = 'calculated' WHERE id = $1`, [runId]);
    const { rows } = await query<{ exempt: string }>(
      `SELECT isr_exempt_amount::text AS exempt FROM paycheck_earnings
        WHERE paycheck_id = $1 AND earning_type = 'overtime'`,
      [r.paycheck_id]
    );
    return rows[0].exempt;
  }

  async function isrBaseOf(payDate: string, start: string): Promise<string> {
    const r = await calculatePaycheck({
      tenant_id: f.tenantId, pay_run_id: await runPaidOn(payDate, start), employee_id: employeeId,
      earnings: [
        { earning_type: 'salary', amount: 6000, cfdi_clave_sat: '001' },
        { earning_type: 'overtime', amount: 3000, hours: 19, cfdi_clave_sat: '019' },
      ],
    });
    const { rows } = await query<{ base: string; exempt: string }>(
      `SELECT p.taxable_wages_isr::text AS base, pe.isr_exempt_amount::text AS exempt
         FROM paychecks p JOIN paycheck_earnings pe ON pe.paycheck_id = p.id
        WHERE p.id = $1 AND pe.earning_type = 'overtime'`,
      [r.paycheck_id]
    );
    return `${rows[0].base} / ${rows[0].exempt}`;
  }

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-110 · overtime exemption');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    scheduleId = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
      [scheduleId, f.tenantId, f.entityId]
    );
    employeeId = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
         tipo_regimen_sat, pay_schedule_id, salary_type, currency_code)
       VALUES ($1, $2, $3, 'MX-HE01', 'Trabajador', 'De Prueba',
         '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901',
         '400.0000', '01', '02', $4, 'salary', 'MXN')`,
      [employeeId, f.tenantId, f.entityId, scheduleId]
    );
  });

  it('the cap and the dated LFT limit are in legal_parameters, without running any seeder', async () => {
    const cap = await legalParameterAt('MX', OVERTIME_EXEMPT_CAP_KEY, '2026-07-15');
    expect([cap.value, cap.unit, cap.effectiveFrom]).toEqual(['5.0000', 'UMA', '2016-01-28']);
    expect((await legalParameterAt('MX', OVERTIME_WEEKLY_HOURS_KEY, '2027-12-31')).value).toBe('9.0000');
    expect((await legalParameterAt('MX', OVERTIME_WEEKLY_HOURS_KEY, '2030-01-01')).value).toBe('12.0000');
  });

  it('ACCEPTANCE: 3 000.00 of overtime in a July 2026 quincena exempts 5 × 117.31 × 15/7 = 1 256.89', async () => {
    expect(await isrBaseOf('2026-07-15', '2026-07-01')).toBe('7743.11 / 1256.89');
  });

  it('below the cap, the migrated 50 % decides: 1 000.00 of overtime in 8 hours exempts 500.00', async () => {
    expect(await overtimeExemptIn(await runPaidOn('2026-07-31', '2026-07-16'), 1000, 8)).toBe('500.00');
  });

  it('a regular and an off_cycle run of the same quincena share one cap and one LFT limit', async () => {
    const period = await periodPaidOn('2026-06-15', '2026-06-01');
    expect(await overtimeExemptIn(await runOn(period), 3000, 10)).toBe('1256.89');
    expect(await overtimeExemptIn(await runOn(period, 'off_cycle'), 1000, 5)).toBe('0.00');
    // 10 + 5 hours are paid; 5 more pass the 9 × 15/7 = 19.29 of the quincena.
    await expect(overtimeExemptIn(await runOn(period, 'correction'), 500, 5)).rejects.toThrow(/pay 20 hours/);
  });

  it('a run with an overtime line refused for its second employee writes no paycheck at all', async () => {
    const second = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
         tipo_regimen_sat, pay_schedule_id, salary_type, currency_code)
       VALUES ($1, $2, $3, 'MX-HE02', 'Segunda', 'De Prueba',
         '2024-01-01', 'active', 'MX', 'XEXX010101000', 'XAXX010101HDFXXX02', '12345678902',
         '400.0000', '01', '02', $4, 'salary', 'MXN')`,
      [second, f.tenantId, f.entityId, scheduleId]
    );
    const runId = await runPaidOn('2026-05-15', '2026-05-01');
    await expect(
      calculatePayRun(
        runId,
        {
          tenant_id: f.tenantId,
          pay_period_id: '',
          created_by: f.userId,
          employee_inputs: [
            { employee_id: employeeId, earnings: [{ earning_type: 'overtime', amount: 900, hours: 9 }] },
            { employee_id: second, earnings: [{ earning_type: 'overtime', amount: 900 }] },
          ],
        },
        entityScope(f.tenantId, f.entityId)
      )
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'hours' });
    const { rows } = await query(`SELECT 1 FROM paychecks WHERE pay_run_id = $1`, [runId]);
    expect(rows).toHaveLength(0);
  });

  it('with overtime_isr_exemption=taxed_in_full the overtime is taxed whole', async () => {
    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, OVERTIME_POLICY_KEY, 'taxed_in_full', f.userId);
    expect(await isrBaseOf('2026-08-15', '2026-08-01')).toBe('9000.00 / 0.00');
  });
});
