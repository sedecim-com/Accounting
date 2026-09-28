import { describe, it, expect, beforeAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { calculatePaycheck } from '../../src/services/payroll/common/paycheck-service.js';
import { legalParameterAt } from '../../src/services/jurisdiction/legal-parameters.js';
import { VACATION_PREMIUM_EXEMPT_CAP_KEY } from '../../src/services/payroll/mx/isr-exemption.js';
import { pacRouter } from '../../src/services/integrations/mexico/pac/pac-router.js';
import { generateAndStampCfdiNomina } from '../../src/services/payroll/mx/cfdi-nomina-generator.js';
// The calculators register on import; without it `getRequired('MX','isr')` throws.
import '../../src/services/payroll/tax-engine/register-all.js';

// ============================================================
// THE VACATION PREMIUM IS EXEMPT UP TO 15 UMA, AND THE CFDI SAYS SO
// (#297, MNE-001-063)
//
// Against a migrated database, with no seeder: the cap comes from migration
// 106 and the UMA from the dated `tax_parameters` rows of 073. The paycheck
// is calculated, and its payroll CFDI is built from what got written.
// ============================================================

describe('the vacation premium is taxed only above 15 UMA a year, and the CFDI states the split', () => {
  let f: Fixture;
  let scheduleId: string;
  let employeeId: string;

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

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-063 · vacation premium exemption');
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
       VALUES ($1, $2, $3, 'MX-PV01', 'Trabajador', 'De Prueba',
         '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901',
         '400.0000', '01', '02', $4, 'salary', 'MXN')`,
      [employeeId, f.tenantId, f.entityId, scheduleId]
    );
  });

  it('the cap is in legal_parameters, dated, without running any seeder', async () => {
    const cap = await legalParameterAt('MX', VACATION_PREMIUM_EXEMPT_CAP_KEY, '2026-07-15');
    expect(cap.value).toBe('15.0000');
    expect(cap.unit).toBe('UMA');
    expect(cap.effectiveFrom).toBe('2016-01-28');
  });

  it('ACCEPTANCE: a premium of 3 000.00 in July 2026 exempts 15 × 117.31, and the CFDI declares that split', async () => {
    const runId = await runPaidOn('2026-07-15', '2026-07-01');
    const r = await calculatePaycheck({
      tenant_id: f.tenantId, pay_run_id: runId, employee_id: employeeId,
      earnings: [
        { earning_type: 'salary', amount: 6000, cfdi_clave_sat: '001' },
        { earning_type: 'prima_vacacional', amount: 3000, cfdi_clave_sat: '021' },
      ],
    });
    const { rows } = await query<{ base: string }>(
      `SELECT taxable_wages_isr::text AS base FROM paychecks WHERE id = $1`,
      [r.paycheck_id]
    );
    expect(rows[0].base).toBe('7240.35');

    const spy = vi.spyOn(pacRouter, 'stamp').mockResolvedValue({
      uuid: uuidv4(), xml_timbrado: '', cadena_original: '',
      fecha_timbrado: new Date(), no_certificado_sat: '0000', sello_sat: '',
      provider_used: 'prueba', simulado: true,
    });
    try {
      const { xml } = await generateAndStampCfdiNomina(
        r.paycheck_id,
        { tenantId: f.tenantId, userId: f.userId },
        entityScope(f.tenantId, f.entityId)
      );
      expect(xml).toMatch(/Clave="prima_vacacional"[^>]*ImporteGravado="1240\.35" ImporteExento="1759\.65"/);
      expect(xml).toMatch(/TotalGravado="7240\.35" TotalExento="1759\.65"/);
    } finally {
      spy.mockRestore();
    }
  });
});
