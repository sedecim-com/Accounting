import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { calculatePaycheck } from '../../src/services/payroll/common/paycheck-service.js';
import { legalParameterAt } from '../../src/services/jurisdiction/legal-parameters.js';
import { YEAR_END_BONUS_EXEMPT_CAP_KEY } from '../../src/services/payroll/mx/isr-exemption.js';
// The calculators register on import; without it `getRequired('MX','isr')` throws.
import '../../src/services/payroll/tax-engine/register-all.js';

// ============================================================
// T5a · THE AGUINALDO IS EXEMPT UP TO 30 UMA (#297, MNE-001-062)
//
// Against a migrated database, with no seeder: the cap comes from migration
// 094 and the UMA from the dated `tax_parameters` rows of 073. What is checked
// is what got WRITTEN: the ISR base on the paycheck and the two parts on the
// earning row, because the second aguinaldo of the year reads them back.
// ============================================================

describe('the aguinaldo is taxed only above 30 UMA a year', () => {
  let f: Fixture;
  let scheduleId: string;
  let employeeId: string;

  /** A run paid on `payDate`, already `calculated` once its paycheck is in. */
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
       VALUES ($1, $2, $3, 'bonus', 'calculating', 2026, $4)`,
      [runId, f.tenantId, periodId, f.userId]
    );
    return runId;
  }

  async function payYearEndBonus(runId: string, amount: number) {
    const r = await calculatePaycheck({
      tenant_id: f.tenantId, pay_run_id: runId, employee_id: employeeId,
      earnings: [{ earning_type: 'aguinaldo', amount, cfdi_clave_sat: '002' }],
    });
    await query(`UPDATE pay_runs SET status = 'calculated' WHERE id = $1 AND tenant_id = $2`, [runId, f.tenantId]);
    const { rows } = await query<{ base: string; exempt: string; taxable: string }>(
      `SELECT p.taxable_wages_isr::text AS base,
              pe.isr_exempt_amount::text AS exempt, pe.isr_taxable_amount::text AS taxable
         FROM paychecks p JOIN paycheck_earnings pe ON pe.paycheck_id = p.id
        WHERE p.id = $1`,
      [r.paycheck_id]
    );
    return rows[0];
  }

  beforeAll(async () => {
    f = await crearInquilino('T5a · aguinaldo exemption');
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
       VALUES ($1, $2, $3, 'MX-AG01', 'Trabajador', 'De Prueba',
         '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901',
         '400.0000', '01', '02', $4, 'salary', 'MXN')`,
      [employeeId, f.tenantId, f.entityId, scheduleId]
    );
  });

  it('the cap is in legal_parameters, dated, without running any seeder', async () => {
    const cap = await legalParameterAt('MX', YEAR_END_BONUS_EXEMPT_CAP_KEY, '2026-12-15');
    expect(cap.value).toBe('30.0000');
    expect(cap.unit).toBe('UMA');
    expect(cap.effectiveFrom).toBe('2016-01-28');
  });

  it('ACCEPTANCE: 10 000.00 paid from February 2026 is taxed on 6 480.70, and the split is stored', async () => {
    const row = await payYearEndBonus(await runPaidOn('2026-02-15', '2026-02-01'), 10000);
    expect(row).toEqual({ base: '6480.70', exempt: '3519.30', taxable: '6480.70' });
  });

  it('a second aguinaldo in the same calendar year finds the cap used up', async () => {
    const row = await payYearEndBonus(await runPaidOn('2026-12-15', '2026-12-01'), 1000);
    expect(row).toEqual({ base: '1000.00', exempt: '0.00', taxable: '1000.00' });
  });

  it('the schema refuses parts that do not add up to the amount', async () => {
    const { rows } = await query<{ id: string }>(
      `SELECT pe.id FROM paycheck_earnings pe JOIN paychecks p ON p.id = pe.paycheck_id
        WHERE p.employee_id = $1 LIMIT 1`,
      [employeeId]
    );
    await expect(
      query(`UPDATE paycheck_earnings SET isr_exempt_amount = isr_exempt_amount + 1 WHERE id = $1`, [rows[0].id])
    ).rejects.toThrow(/paycheck_earnings_isr_parts_add_up/);
  });
});
