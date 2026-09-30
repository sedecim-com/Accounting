import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { calculatePaycheck } from '../../src/services/payroll/common/paycheck-service.js';
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
  async function runPaidOn(payDate: string, start: string): Promise<string> {
    const periodId = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, $4, $5, $5, 2026, 'draft')`,
      [periodId, f.tenantId, scheduleId, start, payDate]
    );
    const runId = uuidv4();
    await query(
      `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by)
       VALUES ($1, $2, $3, 'regular', 'calculating', 2026, $4)`,
      [runId, f.tenantId, periodId, f.userId]
    );
    return runId;
  }

  async function isrBaseOf(payDate: string, start: string): Promise<string> {
    const r = await calculatePaycheck({
      tenant_id: f.tenantId, pay_run_id: await runPaidOn(payDate, start), employee_id: employeeId,
      earnings: [
        { earning_type: 'salary', amount: 6000, cfdi_clave_sat: '001' },
        { earning_type: 'overtime', amount: 3000, cfdi_clave_sat: '019' },
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

  it('with overtime_isr_exemption=taxed_in_full the overtime is taxed whole', async () => {
    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, OVERTIME_POLICY_KEY, 'taxed_in_full', f.userId);
    expect(await isrBaseOf('2026-08-15', '2026-08-01')).toBe('9000.00 / 0.00');
  });
});
