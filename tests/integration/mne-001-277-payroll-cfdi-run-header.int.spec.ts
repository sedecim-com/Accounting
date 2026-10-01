import { describe, it, expect, beforeAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { calculatePaycheck } from '../../src/services/payroll/common/paycheck-service.js';
import { pacRouter } from '../../src/services/integrations/mexico/pac/pac-router.js';
import { generateAndStampCfdiNomina } from '../../src/services/payroll/mx/cfdi-nomina-generator.js';
import '../../src/services/payroll/tax-engine/register-all.js';

// ============================================================
// MNE-001-277: the payroll CFDI header is read from the run and the schedule
// through the real SELECT, not from a hand-built row. A weekly regular run is
// O / 02 / P{n}W; an off-cycle run is E / 99; a correction run is refused.
// ============================================================

describe('payroll CFDI header reads pay_runs.run_type and pay_schedules.frequency', () => {
  let f: Fixture;
  let scheduleId: string;
  let employeeId: string;

  async function paycheckOf(runType: string, start: string, end: string): Promise<string> {
    const periodId = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, $4, $5, $5, 2026, 'draft')`,
      [periodId, f.tenantId, scheduleId, start, end]
    );
    const runId = uuidv4();
    await query(
      `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by)
       VALUES ($1, $2, $3, $4, 'calculating', 2026, $5)`,
      [runId, f.tenantId, periodId, runType, f.userId]
    );
    const r = await calculatePaycheck({
      tenant_id: f.tenantId, pay_run_id: runId, employee_id: employeeId,
      earnings: [{ earning_type: 'salary', amount: 3000, cfdi_clave_sat: '001' }],
    });
    return r.paycheck_id;
  }

  async function stamp(paycheckId: string): Promise<string> {
    const spy = vi.spyOn(pacRouter, 'stamp').mockResolvedValue({
      uuid: uuidv4(), xml_timbrado: '', cadena_original: '',
      fecha_timbrado: new Date(), no_certificado_sat: '0000', sello_sat: '',
      provider_used: 'prueba', simulado: true,
    });
    try {
      const { xml } = await generateAndStampCfdiNomina(
        paycheckId,
        { tenantId: f.tenantId, userId: f.userId },
        entityScope(f.tenantId, f.entityId)
      );
      return xml;
    } finally {
      spy.mockRestore();
    }
  }

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-277 · CFDI run header');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    scheduleId = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Semanal', 'weekly', 'MX', '2026-01-05', true)`,
      [scheduleId, f.tenantId, f.entityId]
    );
    employeeId = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
         tipo_regimen_sat, pay_schedule_id, salary_type, currency_code)
       VALUES ($1, $2, $3, 'MX-H01', 'Trabajador', 'De Prueba',
         '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901',
         '400.0000', '01', '02', $4, 'salary', 'MXN')`,
      [employeeId, f.tenantId, f.entityId, scheduleId]
    );
  });

  it('a regular run on a weekly schedule stamps O / 02 / P132W', async () => {
    const xml = await stamp(await paycheckOf('regular', '2026-07-06', '2026-07-12'));
    expect(xml).toContain('TipoNomina="O"');
    expect(xml).toContain('PeriodicidadPago="02"');
    // 2024-01-01 .. 2026-07-12 inclusive = 924 days = 132 weeks
    expect(xml).toContain('Antiguedad="P132W"');
  });

  it('an off-cycle run on the same schedule stamps E / 99', async () => {
    const xml = await stamp(await paycheckOf('off_cycle', '2026-07-13', '2026-07-19'));
    expect(xml).toContain('TipoNomina="E"');
    expect(xml).toContain('PeriodicidadPago="99"');
  });

  it('a correction run is refused instead of guessing its type', async () => {
    const id = await paycheckOf('correction', '2026-07-20', '2026-07-26');
    await expect(stamp(id)).rejects.toThrow(/correction run cannot be stamped/);
  });
});
