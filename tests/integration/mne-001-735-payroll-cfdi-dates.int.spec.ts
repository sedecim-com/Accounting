import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { calculatePayRun, createPayRun } from '../../src/services/payroll/common/pay-run-service.js';
import { pacRouter } from '../../src/services/integrations/mexico/pac/pac-router.js';
import { generateAndStampCfdiNomina } from '../../src/services/payroll/mx/cfdi-nomina-generator.js';
import { validateUnsealedCfdi } from '../../src/services/sat/cfdi40/income-cfdi.js';
import { validateAgainstPayrollComplementXsd } from '../../src/services/sat/cfdi40/official-xsd.js';

// ============================================================
// THE PAYROLL CFDI WRITES ITS DATES AS THE SAT'S SCHEMAS ASK (MNE-001-735 · #601)
//
// Against a migrated Postgres, through the generator's own SELECT: the unit
// specs hand it a row of strings, and the driver hands it `Date` objects for
// the four DATE columns (pay_periods.period_start, period_end, pay_date and
// employees.hire_date). The PAC is the suite's double: `pacRouter.stamp` is
// replaced and answers a simulated stamp, so no PAC is reached and no
// credential is read.
//
// The dates, by hand (none is equal to another, so a swap would show):
//   hired        2025-03-09 (a Sunday)
//   period       2026-08-01 to 2026-08-15 (a Saturday): 15 days, both counted
//   paid         2026-08-14
//   seniority    2025-03-09 to 2026-03-09 is 365 days (no 29 February between);
//                to 2026-08-15 is 22 + 30 + 31 + 30 + 31 + 15 = 159 more: 524,
//                and 525 with both days counted = 75 weeks exactly. A slip of
//                one day at either end gives P74W.
// ============================================================

const DATE_ATTRIBUTES = [
  'Folio', 'Fecha', 'FechaPago', 'FechaInicialPago', 'FechaFinalPago', 'FechaInicioRelLaboral',
] as const;

describe('the payroll CFDI of a paycheck read from Postgres', () => {
  let f: Fixture;
  let xml: string;

  const attribute = (name: string): string => {
    const found = new RegExp(`\\s${name}="([^"]*)"`).exec(xml);
    expect(found, `the XML carries no ${name}`).toBeTruthy();
    return found![1];
  };

  /** The lines of a verdict that name one of the date attributes. */
  const aboutTheDates = (errors: string[]): string[] =>
    errors.filter((line) => DATE_ATTRIBUTES.some((name) => line.includes(`attribute '${name}'`)));

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-735 · payroll CFDI dates');
    const scope = entityScope(f.tenantId, f.entityId);
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    const scheduleId = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
      [scheduleId, f.tenantId, f.entityId]
    );
    const worker = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto, tipo_regimen_sat,
         work_state, pay_schedule_id, salary_type, currency_code)
       VALUES ($1, $2, $3, 'N-735', 'Trabajador', 'De Prueba', '2025-03-09', 'active', 'MX',
         'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901', '400.0000', '01', '02', 'JA', $4,
         'salary', 'MXN')`,
      [worker, f.tenantId, f.entityId, scheduleId]
    );
    const periodId = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, '2026-08-01', '2026-08-15', '2026-08-14', 2026, 'draft')`,
      [periodId, f.tenantId, scheduleId]
    );
    const runId = await createPayRun(
      { tenant_id: f.tenantId, pay_period_id: periodId, employee_inputs: [], created_by: f.userId },
      scope
    );
    await calculatePayRun(
      runId,
      {
        tenant_id: f.tenantId, pay_period_id: '', created_by: f.userId,
        employee_inputs: [
          { employee_id: worker, earnings: [{ earning_type: 'salary', amount: 6000, cfdi_clave_sat: '001' }] },
        ],
      },
      scope
    );
    // A paycheck is stamped once its run is approved (MNE-001-720).
    await query(`UPDATE pay_runs SET status = 'approved' WHERE id = $1 AND tenant_id = $2`, [runId, f.tenantId]);
    const paycheck = await query<{ id: string }>(
      'SELECT id FROM paychecks WHERE pay_run_id = $1 AND tenant_id = $2',
      [runId, f.tenantId]
    );

    const pac = vi.spyOn(pacRouter, 'stamp').mockResolvedValue({
      uuid: uuidv4(), xml_timbrado: '', cadena_original: '',
      fecha_timbrado: new Date(), no_certificado_sat: '0000', sello_sat: '',
      provider_used: 'test', simulado: true,
    });
    const stamped = await generateAndStampCfdiNomina(
      paycheck.rows[0].id,
      { tenantId: f.tenantId, userId: f.userId },
      scope
    );
    xml = stamped.xml;
    // What went to the PAC is the document the caller got back.
    expect(pac).toHaveBeenCalledTimes(1);
    expect(pac.mock.calls[0][0]).toBe(xml);
  }, 180_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes Fecha as AAAA-MM-DDThh:mm:ss and a Folio of 40 characters at most', () => {
    expect(attribute('Fecha')).toBe('2026-08-14T10:00:00');
    expect(attribute('Folio')).toBe('NOM-N-735-2026-08-14');
  });

  it('writes the three dates of the payment and the hire date as AAAA-MM-DD', () => {
    expect(attribute('FechaPago')).toBe('2026-08-14');
    expect(attribute('FechaInicialPago')).toBe('2026-08-01');
    expect(attribute('FechaFinalPago')).toBe('2026-08-15');
    expect(attribute('FechaInicioRelLaboral')).toBe('2025-03-09');
  });

  it('counts the days paid and the seniority on those same calendar dates', () => {
    expect(attribute('NumDiasPagados')).toBe('15');
    expect(attribute('Antiguedad')).toBe('P75W');
  });

  it('cfdv40.xsd has nothing to say about Fecha or Folio', () => {
    expect(aboutTheDates(validateUnsealedCfdi(xml).errors)).toEqual([]);
  });

  it('nomina12.xsd has nothing to say about the four dates of the complement', () => {
    expect(aboutTheDates(validateAgainstPayrollComplementXsd(complementOf(xml)).errors)).toEqual([]);
  });

  it('and the schemas are the ones that judge: the text of a JavaScript Date is named by both', () => {
    const asADate = String(new Date(2026, 7, 14));
    const voucher = validateUnsealedCfdi(xml.replace('Fecha="2026-08-14T10:00:00"', `Fecha="${asADate}T10:00:00"`));
    expect(aboutTheDates(voucher.errors).join('\n')).toMatch(/attribute 'Fecha'/);
    const complement = validateAgainstPayrollComplementXsd(
      complementOf(xml).replace('FechaPago="2026-08-14"', `FechaPago="${asADate}"`)
    );
    expect(aboutTheDates(complement.errors).join('\n')).toMatch(/attribute 'FechaPago'/);
  });
});

/**
 * The complement as a document of its own: cfdv40.xsd takes it as xs:any, so
 * nomina12.xsd judges it apart (official-xsd.ts). The namespace is declared on
 * the voucher's root and is repeated here.
 */
function complementOf(xml: string): string {
  const node = /<nomina12:Nomina [\s\S]*<\/nomina12:Nomina>/.exec(xml);
  expect(node, 'the XML carries no nomina12:Nomina').toBeTruthy();
  return node![0].replace('<nomina12:Nomina ', '<nomina12:Nomina xmlns:nomina12="http://www.sat.gob.mx/nomina12" ');
}
