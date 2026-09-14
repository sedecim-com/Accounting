import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import { encrypt } from '../../src/utils/encryption.js';
import payrollRouter from '../../src/api/rest/routes/payroll.js';

// ============================================================
// TEN-11 · LAS ELECCIONES DE BENEFICIO DE LA SOCIEDAD HERMANA
//
// `POST /v1/payroll/employees/:id/benefit-elections` crea o SOBRESCRIBE la
// elección de un empleado —tipo, valor, fecha— y la reactiva. La tabla no
// guarda historial: el valor anterior se pierde. La ruta no montaba
// `requireEntityAccess` y el servicio hacía un INSERT … ON CONFLICT sin WHERE.
//
// Hay DOS llaves que cruzar, y por eso cuatro casos: el empleado y el plan. Un
// plan de la hermana sobre un empleado propio también es una llave ajena.
// ============================================================

let a: Fixture;
let b: Fixture;
let srv: Servidor;

async function empleadoUS(fx: Fixture): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, country_code, ssn_encrypted, annual_salary, status)
     VALUES ($1,$2,$3,$4,'Ada','Lovelace','2020-01-01','US',$5, 90000, 'active')`,
    [id, fx.tenantId, fx.entityId, `E-${id.slice(0, 8)}`, encrypt('987-65-4321')]
  );
  return id;
}

async function plan(fx: Fixture, nombre: string): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO benefits_plans (id, tenant_id, entity_id, plan_type, name, is_pre_tax)
     VALUES ($1,$2,$3,'401k',$4,true)`,
    [id, fx.tenantId, fx.entityId, nombre]
  );
  return id;
}

let empleadoA: string;
let empleadoB: string;
let planA: string;
let planB: string;
const ELECCION_PREVIA_DE_B = randomUUID();

const cuerpo = (benefit_plan_id: string): Record<string, unknown> => ({
  benefit_plan_id,
  election_type: 'percentage',
  election_value: 99,
  effective_date: '2026-03-01',
});

beforeAll(async () => {
  a = await crearInquilino('TEN-11 beneficios A');
  b = await crearEntidadHermana(a, 'TEN-11 beneficios B');
  empleadoA = await empleadoUS(a);
  empleadoB = await empleadoUS(b);
  planA = await plan(a, 'Plan de A');
  planB = await plan(b, 'Plan de B');
  // Una elección previa de B, DESACTIVADA, al 4 %: el ataque no puede
  // reactivarla ni cambiarle el porcentaje.
  await query(
    `INSERT INTO employee_benefit_elections (id, employee_id, benefit_plan_id, effective_date,
       employee_contribution_type, employee_contribution_value, is_active)
     VALUES ($1,$2,$3,'2025-01-01','percentage',4,false)`,
    [ELECCION_PREVIA_DE_B, empleadoB, planB]
  );
  srv = await levantar([['/v1/payroll', payrollRouter]], {
    ...sesionDe(a),
    permissions: ['payroll:read', 'payroll:update'],
  });
}, 180_000);

afterAll(async () => {
  await srv?.cerrar();
  await closeDatabase();
});

const eleccionesDe = async (empleado: string): Promise<number> => {
  const { rows } = await query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM employee_benefit_elections WHERE employee_id = $1',
    [empleado]
  );
  return Number(rows[0].n);
};

describe('las elecciones de beneficio de la hermana', () => {
  it('empleado de la hermana con plan PROPIO: 404, y no se escribe', async () => {
    const antes = await eleccionesDe(empleadoB);
    const r = await pedir(srv, 'POST', `/v1/payroll/employees/${empleadoB}/benefit-elections`, cuerpo(planA));
    expect(r.status, `contestó ${r.status}`).toBe(404);
    expect(await eleccionesDe(empleadoB)).toBe(antes);
  });

  it('empleado de la hermana con SU plan: 404, y la elección previa queda intacta', async () => {
    const r = await pedir(srv, 'POST', `/v1/payroll/employees/${empleadoB}/benefit-elections`, cuerpo(planB));
    expect(r.status, `contestó ${r.status}`).toBe(404);
    const { rows } = await query<{ employee_contribution_value: string; is_active: boolean }>(
      'SELECT employee_contribution_value, is_active FROM employee_benefit_elections WHERE id = $1',
      [ELECCION_PREVIA_DE_B]
    );
    expect(rows[0].is_active, 'la elección ajena se reactivó').toBe(false);
    expect(rows[0].employee_contribution_value, 'la elección ajena cambió de valor').toBe('4.0000');
  });

  it('empleado PROPIO con el plan de la hermana: 404 — la segunda llave también es ajena', async () => {
    const antes = await eleccionesDe(empleadoA);
    const r = await pedir(srv, 'POST', `/v1/payroll/employees/${empleadoA}/benefit-elections`, cuerpo(planB));
    expect(r.status, `contestó ${r.status}`).toBe(404);
    expect(await eleccionesDe(empleadoA)).toBe(antes);
  });

  it('el 404 es idéntico al de un empleado que no existe', async () => {
    const ajena = await pedir(srv, 'POST', `/v1/payroll/employees/${empleadoB}/benefit-elections`, cuerpo(planA));
    const fantasmaId = randomUUID();
    const fantasma = await pedir(srv, 'POST', `/v1/payroll/employees/${fantasmaId}/benefit-elections`, cuerpo(planA));
    expect(fantasma.status).toBe(404);
    const normalizar = (body: unknown, id: string): string =>
      JSON.stringify((body as { errors?: unknown }).errors).split(id).join('<id>');
    expect(normalizar(ajena.body, empleadoB)).toBe(normalizar(fantasma.body, fantasmaId));
  });

  it('EL CONTRAPESO: empleado propio con plan propio sí elige', async () => {
    const r = await pedir(srv, 'POST', `/v1/payroll/employees/${empleadoA}/benefit-elections`, cuerpo(planA));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await eleccionesDe(empleadoA)).toBe(1);
  });
});
