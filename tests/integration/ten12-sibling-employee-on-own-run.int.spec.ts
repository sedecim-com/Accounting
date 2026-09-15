import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import payrollRouter from '../../src/api/rest/routes/payroll.js';
// The tax calculators register at app startup; mounting only the router needs
// them registered explicitly, or every paycheck is a 500 that proves nothing.
import '../../src/services/payroll/tax-engine/register-all.js';

// ============================================================
// TEN-12 · EL EMPLEADO DE LA HERMANA, COLGADO DE LA CORRIDA PROPIA
//
// `POST /v1/payroll/pay-runs/:id/calculate` monta la guarda y acota la CORRIDA
// (T9c). Lo que no acota son las llaves que llegan en el cuerpo: cada
// `employee_inputs[].employee_id`, y `pay_period_id`. `calculatePaycheck` las
// busca por inquilino y nada más.
//
// El daño lo describe el propio servicio para el caso entre inquilinos: el
// agregado del que sale la póliza de nómina suma recibos por `pay_run_id`, así
// que el sueldo del empleado ajeno entra en el mayor de la sociedad que
// calcula; y el pasivo patronal de la sociedad dueña se queda sin ese recibo.
// Entre dos sociedades del mismo despacho es exactamente igual, y la RLS no lo
// ve porque acota por inquilino.
// ============================================================

let own: Fixture;
let sibling: Fixture;
let server: Servidor;

interface PayrollSetup {
  schedule: string;
  period: string;
  run: string;
  employee: string;
}

async function payrollSetup(fx: Fixture, tag: string, start: string, end: string): Promise<PayrollSetup> {
  const schedule = randomUUID();
  const period = randomUUID();
  const run = randomUUID();
  const employee = randomUUID();
  await seedPolicies({ tenantId: fx.tenantId, entityId: fx.entityId });
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start, is_active)
     VALUES ($1,$2,$3,'Quincenal','quincenal','MX','2026-01-01',true)`,
    [schedule, fx.tenantId, fx.entityId]
  );
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, status)
     VALUES ($1,$2,$3,$4,$5,$5,2026,'draft')`,
    [period, fx.tenantId, schedule, start, end]
  );
  await query(
    `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by)
     VALUES ($1,$2,$3,'regular','draft',2026,$4)`,
    [run, fx.tenantId, period, fx.userId]
  );
  await addEmployee(fx, schedule, employee, tag);
  return { schedule, period, run, employee };
}

/** An MX employee with complete fiscal data, so the calculator does not 500. */
async function addEmployee(fx: Fixture, schedule: string, employee: string, tag: string): Promise<void> {
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
       tipo_regimen_sat, pay_schedule_id, salary_type, currency_code)
     VALUES ($1,$2,$3,$4,'Worker',$5,'2024-01-01','active','MX','XAXX010101000','XAXX010101HDFXXX01',
       '12345678901','200.0000','01','02',$6,'salary','MXN')`,
    [employee, fx.tenantId, fx.entityId, `MX-${tag}`, tag, schedule]
  );
}

let ownSetup: PayrollSetup;
let siblingSetup: PayrollSetup;

beforeAll(async () => {
  own = await crearInquilino('TEN-12 own');
  sibling = await crearEntidadHermana(own, 'TEN-12 sibling');
  // Different period lengths ON PURPOSE: the IMSS quota depends on the days in
  // the period, so it tells which period decided the paycheck.
  ownSetup = await payrollSetup(own, 'OWN', '2026-01-01', '2026-01-15');
  siblingSetup = await payrollSetup(sibling, 'SIB', '2026-02-01', '2026-02-28');
  server = await levantar([['/v1/payroll', payrollRouter]], {
    ...sesionDe(own),
    permissions: ['payroll:read', 'payroll:create', 'payroll:approve'],
  });
}, 180_000);

afterAll(async () => {
  await server?.cerrar();
  await closeDatabase();
});

const paychecksOf = async (employee: string): Promise<Array<{ pay_run_id: string }>> => {
  const { rows } = await query<{ pay_run_id: string }>(
    'SELECT pay_run_id FROM paychecks WHERE employee_id = $1',
    [employee]
  );
  return rows;
};

const calculateBody = (employee: string, period: string): Record<string, unknown> => ({
  pay_period_id: period,
  employee_inputs: [{ employee_id: employee, earnings: [{ earning_type: 'salary', amount: 3000 }] }],
});

describe('the sibling company employee on the own pay run', () => {
  it('answers 404, and no paycheck of the sibling employee is written anywhere', async () => {
    const r = await pedir(
      server, 'POST', `/v1/payroll/pay-runs/${ownSetup.run}/calculate`,
      calculateBody(siblingSetup.employee, ownSetup.period)
    );
    expect(await paychecksOf(siblingSetup.employee), 'a paycheck of the sibling employee was written').toEqual([]);
    expect(r.status, `answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(404);
  });

  it('the 404 is identical to an employee that does not exist', async () => {
    const foreign = await pedir(
      server, 'POST', `/v1/payroll/pay-runs/${ownSetup.run}/calculate`,
      calculateBody(siblingSetup.employee, ownSetup.period)
    );
    const ghostId = randomUUID();
    const ghost = await pedir(
      server, 'POST', `/v1/payroll/pay-runs/${ownSetup.run}/calculate`,
      calculateBody(ghostId, ownSetup.period)
    );
    expect(ghost.status).toBe(404);
    const normalize = (body: unknown, id: string): string =>
      JSON.stringify((body as { errors?: unknown }).errors).split(id).join('<id>');
    expect(normalize(foreign.body, siblingSetup.employee)).toBe(normalize(ghost.body, ghostId));
  });

  it('a sibling pay period in the body does not decide anything: the run period does', async () => {
    // Two identical own employees. One is calculated with the run's own
    // 15-day period in the body; the other with the sibling's 28-day period.
    // If the body decides, their IMSS quotas differ.
    const withOwnPeriod = randomUUID();
    const withSiblingPeriod = randomUUID();
    await addEmployee(own, ownSetup.schedule, withOwnPeriod, 'OWN-P1');
    await addEmployee(own, ownSetup.schedule, withSiblingPeriod, 'OWN-P2');
    const a = await pedir(server, 'POST', `/v1/payroll/pay-runs/${ownSetup.run}/calculate`,
      calculateBody(withOwnPeriod, ownSetup.period));
    const b = await pedir(server, 'POST', `/v1/payroll/pay-runs/${ownSetup.run}/calculate`,
      calculateBody(withSiblingPeriod, siblingSetup.period));
    expect(a.status, JSON.stringify(a.body).slice(0, 200)).toBe(200);
    expect(b.status, JSON.stringify(b.body).slice(0, 200)).toBe(200);
    const { rows } = await query<{ employee_id: string; imss_employee: string }>(
      `SELECT employee_id, imss_employee::text FROM paychecks WHERE employee_id = ANY($1::uuid[])`,
      [[withOwnPeriod, withSiblingPeriod]]
    );
    const quota = (id: string): string | undefined => rows.find((r) => r.employee_id === id)?.imss_employee;
    expect(quota(withSiblingPeriod), 'the sibling period in the body changed the IMSS quota').toBe(quota(withOwnPeriod));
  });

  it('THE COUNTERWEIGHT: an own employee on the own run is calculated', async () => {
    const fresh = randomUUID();
    await addEmployee(own, ownSetup.schedule, fresh, 'OWN-CW');
    const r = await pedir(server, 'POST', `/v1/payroll/pay-runs/${ownSetup.run}/calculate`,
      calculateBody(fresh, ownSetup.period));
    expect(r.status, `answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
    expect(await paychecksOf(fresh)).toHaveLength(1);
  });
});
