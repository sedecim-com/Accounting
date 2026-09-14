import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import { olvidarAlcances } from '../../src/database/scope.js';
import payrollRouter from '../../src/api/rest/routes/payroll.js';

/**
 * T9c (#96) · LA CADENA DE LA CORRIDA, Y EL FINIQUITO QUE LLEVA GUARDA Y NO ACOTA.
 *
 * T9a cerró el posteo al mayor y la lectura de la plantilla; T9b, el SSN y las
 * escrituras sobre el empleado. Quedaba la CADENA que lleva hasta el asiento:
 * crear la corrida, calcularla, aprobarla, marcarla pagada, y leer sus recibos.
 * Todas acotan por INQUILINO como mucho — `pay_runs`, `pay_periods` y
 * `paychecks` no tienen `entity_id`, así que su entidad va por JOIN.
 *
 * Y el caso que desmiente la regla fácil: `POST /finiquito` SÍ lleva
 * `requireEntityAccess` desde antes de este tramo, y aun así resuelve al
 * empleado de la sociedad hermana, porque `finiquito-calculator.ts:113` acota
 * `WHERE id = $1 AND tenant_id = $2`. Tener la guarda montada no dice nada de
 * si la consulta acota: son las dos cosas.
 */

let a: Fixture;
let b: Fixture;
let srv: Servidor;

const EMPLEADO_B = randomUUID();
const PERIODO_B = randomUUID();
const CORRIDA_B = randomUUID();
const RECIBO_B = randomUUID();

// LA SOCIEDAD ATACANTE TIENE NÓMINA PROPIA, y esto no es adorno del fixture.
//
// Sin ella la prueba mentía en dos direcciones. Primero, un arreglo que
// contestara 404 A TODO —romper la nómina entera— la pasaba entera: sin
// control positivo, «404» no distingue una frontera de una avería. Y segundo,
// medido: con A sin `pay_schedules`, mutar el JOIN del camino a `ON TRUE`
// dejaba la prueba en verde, porque `ps.entity_id = <A>` no encontraba ningún
// calendario que cruzar. El mutante moría de hambre, no de frontera.
const EMPLEADO_A = randomUUID();
const PERIODO_A = randomUUID();
const CORRIDA_A = randomUUID();
const APROBADA_A = randomUUID();
const RECIBO_A = randomUUID();

beforeAll(async () => {
  olvidarAlcances();
  a = await crearInquilino('T9c sociedad A');
  b = await crearEntidadHermana(a, 'T9c sociedad B');

  const horario = randomUUID();
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, country_code, rfc, sbc, annual_salary, status)
     VALUES ($1,$2,$3,$4,'Ada','Lovelace','2015-01-01','MX','AAAA010101AAA', 1000, 365000, 'active')`,
    [EMPLEADO_B, b.tenantId, b.entityId, `E-${EMPLEADO_B.slice(0, 8)}`]
  );
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start)
     VALUES ($1,$2,$3,'Quincenal','quincenal','MX','2026-01-01')`,
    [horario, b.tenantId, b.entityId]
  );
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year)
     VALUES ($1,$2,$3,'2026-03-01','2026-03-15','2026-03-15',2026)`,
    [PERIODO_B, b.tenantId, horario]
  );
  await query(
    `INSERT INTO pay_runs (id, tenant_id, pay_period_id, status, tax_year_used,
       total_gross, total_pre_tax_deductions, total_net_pay, total_employee_taxes,
       total_employer_taxes, total_post_tax_deductions)
     VALUES ($1,$2,$3,'calculated',2026, 10000, 0, 8500, 1500, 0, 0)`,
    [CORRIDA_B, b.tenantId, PERIODO_B]
  );
  await query(
    `INSERT INTO paychecks (id, tenant_id, pay_run_id, employee_id, gross_earnings, net_pay, isr_withheld)
     VALUES ($1,$2,$3,$4, 10000, 8500, 1500)`,
    [RECIBO_B, b.tenantId, CORRIDA_B, EMPLEADO_B]
  );

  // La cadena propia de A, espejo de la de B.
  const horarioA = randomUUID();
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, country_code, rfc, sbc, annual_salary, status)
     VALUES ($1,$2,$3,$4,'Grace','Hopper','2015-01-01','MX','BBBB010101BBB', 1000, 365000, 'active')`,
    [EMPLEADO_A, a.tenantId, a.entityId, `E-${EMPLEADO_A.slice(0, 8)}`]
  );
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start)
     VALUES ($1,$2,$3,'Quincenal','quincenal','MX','2026-01-01')`,
    [horarioA, a.tenantId, a.entityId]
  );
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year)
     VALUES ($1,$2,$3,'2026-03-01','2026-03-15','2026-03-15',2026)`,
    [PERIODO_A, a.tenantId, horarioA]
  );
  for (const [id, estado] of [[CORRIDA_A, 'calculated'], [APROBADA_A, 'approved']] as const) {
    await query(
      `INSERT INTO pay_runs (id, tenant_id, pay_period_id, status, tax_year_used,
         total_gross, total_pre_tax_deductions, total_net_pay, total_employee_taxes,
         total_employer_taxes, total_post_tax_deductions)
       VALUES ($1,$2,$3,$4,2026, 10000, 0, 8500, 1500, 0, 0)`,
      [id, a.tenantId, PERIODO_A, estado]
    );
  }
  await query(
    `INSERT INTO paychecks (id, tenant_id, pay_run_id, employee_id, gross_earnings, net_pay, isr_withheld)
     VALUES ($1,$2,$3,$4, 10000, 8500, 1500)`,
    [RECIBO_A, a.tenantId, CORRIDA_A, EMPLEADO_A]
  );

  srv = await levantar([['/payroll', payrollRouter]], {
    ...sesionDe(a),
    permissions: ['payroll:read', 'payroll:create', 'payroll:update', 'payroll:approve'],
  });
}, 180_000);

afterAll(async () => {
  await srv?.cerrar();
  await closeDatabase();
});

const estadoCorrida = async (): Promise<string> => {
  const { rows } = await query<{ status: string }>('SELECT status FROM pay_runs WHERE id = $1', [CORRIDA_B]);
  return rows[0].status;
};

describe('la cadena que lleva la corrida hasta el mayor', () => {
  it('no se crea una corrida sobre el periodo de la sociedad hermana', async () => {
    const r = await pedir(srv, 'POST', '/payroll/pay-runs', { pay_period_id: PERIODO_B });
    expect(r.status, `contestó ${r.status}`).toBe(404);
  });

  it('ni se lee la corrida ajena', async () => {
    const r = await pedir(srv, 'GET', `/payroll/pay-runs/${CORRIDA_B}`);
    expect(r.status, `contestó ${r.status}`).toBe(404);
  });

  it('ni se aprueba', async () => {
    const r = await pedir(srv, 'POST', `/payroll/pay-runs/${CORRIDA_B}/approve`, {});
    expect(r.status, `contestó ${r.status}`).toBe(404);
    expect(await estadoCorrida(), 'la corrida ajena quedó aprobada').toBe('calculated');
  });

  it('ni se marca pagada', async () => {
    const r = await pedir(srv, 'POST', `/payroll/pay-runs/${CORRIDA_B}/mark-paid`, {});
    expect(r.status, `contestó ${r.status}`).toBe(404);
    expect(await estadoCorrida(), 'la corrida ajena quedó pagada').toBe('calculated');
  });

  it('ni se calcula: calcular la corrida ajena le pone sus totales en cero', async () => {
    const r = await pedir(srv, 'POST', `/payroll/pay-runs/${CORRIDA_B}/calculate`, {
      pay_period_id: PERIODO_B,
      employee_inputs: [],
    });
    expect(r.status, `contestó ${r.status}`).toBe(404);
    const { rows } = await query<{ status: string; total_gross: string }>(
      'SELECT status, total_gross FROM pay_runs WHERE id = $1',
      [CORRIDA_B]
    );
    expect(rows[0].status, 'la corrida ajena cambió de estado').toBe('calculated');
    expect(rows[0].total_gross, 'los totales de la corrida ajena se reescribieron').toBe('10000.00');
  });

  it('ni se timbra su recibo ante el PAC', async () => {
    const r = await pedir(srv, 'POST', `/payroll/paychecks/${RECIBO_B}/cfdi-nomina`, {});
    expect(r.status, `contestó ${r.status}`).toBe(404);
  });

  it('ni se lee su recibo', async () => {
    const r = await pedir(srv, 'GET', `/payroll/paychecks/${RECIBO_B}`);
    expect(r.status, `contestó ${r.status}`).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════════════
// EL CONTROL POSITIVO. Sin esto, «todo contesta 404» es indistinguible de
// «la nómina está rota», y la prueba de arriba aplaudiría las dos.
// ════════════════════════════════════════════════════════════════════════
describe('y la cadena PROPIA sigue funcionando', () => {
  it('la corrida propia se lee', async () => {
    const r = await pedir(srv, 'GET', `/payroll/pay-runs/${CORRIDA_A}`);
    expect(r.status, `contestó ${r.status}`).toBe(200);
  });

  it('el recibo propio se lee', async () => {
    const r = await pedir(srv, 'GET', `/payroll/paychecks/${RECIBO_A}`);
    expect(r.status, `contestó ${r.status}`).toBe(200);
  });

  it('la corrida propia se crea sobre el periodo propio', async () => {
    const r = await pedir(srv, 'POST', '/payroll/pay-runs', { pay_period_id: PERIODO_A });
    expect(r.status, `contestó ${r.status}`).toBe(201);
  });

  it('la corrida propia sí se calcula, y sus totales son los que sale de calcular', async () => {
    const r = await pedir(srv, 'POST', `/payroll/pay-runs/${CORRIDA_A}/calculate`, {
      pay_period_id: PERIODO_A,
      employee_inputs: [],
    });
    expect(r.status, `contestó ${r.status}`).toBe(200);
    const { rows } = await query<{ total_gross: string }>(
      'SELECT total_gross FROM pay_runs WHERE id = $1',
      [CORRIDA_A]
    );
    expect(rows[0].total_gross).toBe('0.00');
  });

  it('el recibo propio llega al timbrado: lo para el PAC simulado, no la frontera', async () => {
    // 422 PAC_SIMULADO y no 404: la frontera dejó pasar el recibo propio y
    // quien se niega es el guardián del PAC de mentira, que es otra puerta.
    // Se afirma «no 404» y nada más — un 200 aquí exigiría un PAC de verdad.
    const r = await pedir(srv, 'POST', `/payroll/paychecks/${RECIBO_A}/cfdi-nomina`, {});
    expect(r.status, `contestó ${r.status}`).not.toBe(404);
  });

  it('y la corrida propia aprobada se marca pagada de verdad', async () => {
    const r = await pedir(srv, 'POST', `/payroll/pay-runs/${APROBADA_A}/mark-paid`, {});
    expect(r.status, `contestó ${r.status}`).toBe(200);
    const { rows } = await query<{ status: string }>('SELECT status FROM pay_runs WHERE id = $1', [APROBADA_A]);
    expect(rows[0].status).toBe('paid');
  });
});

describe('el finiquito: la guarda estaba puesta y la consulta no acotaba', () => {
  it('no se calcula el finiquito del empleado ajeno', async () => {
    // EL CUERPO TIENE QUE SER VÁLIDO, y no lo era. Mandaba `motivo_baja` —una
    // clave en español que el código nunca leyó— y omitía `last_paid_through`.
    // Daba 404 igual, porque el 404 sale del SELECT acotado por entidad y eso
    // ocurre antes de mirar nada más. Desde T6 (#93) la ruta lleva esquema
    // estricto, y con el cuerpo viejo contestaría 422: la prueba seguiría
    // verde en apariencia y habría dejado de medir la frontera. Un 422 y un
    // 404 dicen cosas distintas sobre si el recurso existe, y lo que aquí se
    // afirma es lo segundo.
    const r = await pedir(srv, 'POST', '/payroll/finiquito', {
      employee_id: EMPLEADO_B,
      termination_date: '2026-06-30',
      last_paid_through: '2026-06-30',
      termination_reason: 'renuncia',
    });
    expect(r.status, `contestó ${r.status}`).toBe(404);
  });
});
