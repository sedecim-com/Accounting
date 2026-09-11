import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import { olvidarAlcances } from '../../src/database/scope.js';
import payrollRouter from '../../src/api/rest/routes/payroll.js';

/**
 * T9 (#96) · LA FRONTERA DE ENTIDAD QUE NÓMINA NO MONTA.
 *
 * `payroll.ts` monta 36 rutas y 23 no llevan `requireEntityAccess`. No es un
 * olvido uniforme: las que DECLARAN la entidad (`?entity_id=`) sí lo llevan, y
 * las que la DEDUCEN de un `:id` de la ruta, no — porque esa guarda comprueba
 * una entidad declarada y aquí no hay ninguna que comprobar. Es exactamente el
 * hueco que `assertEntryAccess` cerró para las pólizas
 * (journal-entries.ts:31), metiendo el filtro DENTRO del SQL con
 * `requireByIdInScope`.
 *
 * Las dos consecuencias que se miden aquí, las dos entre entidades del MISMO
 * inquilino —o sea, donde la RLS no acota nada, porque acota por inquilino—:
 *
 *   · ESCRITURA. `gl-posting-service.ts:54` saca `ps.entity_id` del JOIN y
 *     filtra sólo por `pr.tenant_id`: la entidad la elige el id que se manda,
 *     no el token. Un contador con acceso a la sociedad A deja una póliza
 *     POSTEADA en el mayor de B.
 *   · LECTURA. `GET /employees/:id` llama a `getEmployee(req.params.id)` sin
 *     acotar: RFC, CURP, NSS y sueldo de la plantilla ajena.
 *
 * Corre como superusuario a propósito, como el resto de la suite: lo que se
 * comprueba es la frontera del CÓDIGO, y RLS no cubre este eje.
 */

let a: Fixture;
let b: Fixture;
let srv: Servidor;

const EMPLEADO_B = randomUUID();
const CORRIDA_B = randomUUID();

async function sembrarNominaDe(f: Fixture, empleadoId: string, corridaId: string): Promise<void> {
  const horario = randomUUID();
  const periodo = randomUUID();
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, country_code, ssn_encrypted, rfc, curp, nss, annual_salary)
     VALUES ($1,$2,$3,$4,'Ada','Lovelace','2015-01-01','MX','x','AAAA010101AAA','AAAA010101HDFAAA01','12345678901',1234567.89)`,
    [empleadoId, f.tenantId, f.entityId, `E-${empleadoId.slice(0, 8)}`]
  );
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start)
     VALUES ($1,$2,$3,'Quincenal','quincenal','MX','2026-01-01')`,
    [horario, f.tenantId, f.entityId]
  );
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year)
     VALUES ($1,$2,$3,'2026-03-01','2026-03-15','2026-03-15',2026)`,
    [periodo, f.tenantId, horario]
  );
  await query(
    `INSERT INTO pay_runs (id, tenant_id, pay_period_id, status, tax_year_used,
       total_gross, total_pre_tax_deductions, total_net_pay, total_employee_taxes,
       total_employer_taxes, total_post_tax_deductions)
     VALUES ($1,$2,$3,'approved',2026, 10000, 0, 8500, 1500, 0, 0)`,
    [corridaId, f.tenantId, periodo]
  );
  await query(
    `INSERT INTO paychecks (id, tenant_id, pay_run_id, employee_id, gross_earnings, net_pay, isr_withheld)
     VALUES ($1,$2,$3,$4, 10000, 8500, 1500)`,
    [randomUUID(), f.tenantId, corridaId, empleadoId]
  );
  // El mapeo mínimo que exige el servicio. El fixture ya siembra el suyo, así
  // que esto sólo rellena lo que falte.
  for (const [bucket, codigo] of [
    ['wages_expense', '5100'],
    ['payroll_tax_expense', '5200'],
    ['cash_payroll', '1110'],
  ] as const) {
    const cuenta = f.cuentas[codigo];
    if (!cuenta) throw new Error(`el catálogo sembrado no tiene la cuenta ${codigo}`);
    await query(
      `INSERT INTO payroll_account_mapping (id, tenant_id, entity_id, bucket, account_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, entity_id, bucket) DO NOTHING`,
      [randomUUID(), f.tenantId, f.entityId, bucket, cuenta]
    );
  }
}

const polizasDe = async (entityId: string): Promise<number> => {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_entries WHERE entity_id = $1`,
    [entityId]
  );
  return Number(rows[0].n);
};

beforeAll(async () => {
  olvidarAlcances();
  a = await crearInquilino('T9 sociedad A');
  b = await crearEntidadHermana(a, 'T9 sociedad B');
  await sembrarNominaDe(b, EMPLEADO_B, CORRIDA_B);

  // La sesión concede SÓLO la sociedad A. Mismo inquilino: la RLS no objeta.
  srv = await levantar([['/payroll', payrollRouter]], {
    ...sesionDe(a),
    permissions: ['payroll:read', 'payroll:approve', 'payroll:create'],
  });
}, 180_000);

afterAll(async () => {
  await srv?.cerrar();
  await closeDatabase();
});

describe('la escritura: postear la nómina de la sociedad hermana', () => {
  it('no deja una póliza en el mayor ajeno, y contesta 404', async () => {
    const antes = await polizasDe(b.entityId);
    const r = await pedir(srv, 'POST', `/payroll/pay-runs/${CORRIDA_B}/post-to-gl`, {});
    // 404 y no 403: distinguirlos delataría que la corrida existe.
    expect(r.status, `contestó ${r.status}`).toBe(404);
    expect(await polizasDe(b.entityId), 'quedó una póliza en el mayor de B').toBe(antes);
  });
});

describe('la lectura: la plantilla de la sociedad hermana', () => {
  it('no entrega al empleado ajeno', async () => {
    const r = await pedir(srv, 'GET', `/payroll/employees/${EMPLEADO_B}`);
    expect(r.status).toBe(404);
  });

  it('y menos sus datos personales y su sueldo', async () => {
    const r = await pedir(srv, 'GET', `/payroll/employees/${EMPLEADO_B}`);
    const cuerpo = JSON.stringify(r.body ?? {});
    for (const dato of ['AAAA010101AAA', 'AAAA010101HDFAAA01', '12345678901', '1234567.89']) {
      expect(cuerpo, `el cuerpo lleva ${dato}`).not.toContain(dato);
    }
  });
});

// LO QUE ESTÁ LEÍDO PERO NO EJECUTADO, y por eso no tiene prueba todavía.
//
// Dos rutas MÁS parecen abiertas, y las dos desmienten la regla fácil («las que
// declaran la entidad la llevan»). No se afirman aquí porque sobre este árbol
// contestan 500 por causas ajenas a la frontera —falta siembra fiscal que vive
// en otra rama— y un 500 no prueba una fuga:
//
//   · POST /finiquito (payroll.ts:290) SÍ lleva `requireEntityAccess`, y aun
//     así `finiquito-calculator.ts:89` acota `WHERE id = $1 AND tenant_id = $2`
//     — sólo por INQUILINO. Y nueve líneas después toma
//     `e.entity_id ?? ctx.entityId`, así que calcularía con las políticas de la
//     sociedad ajena. Tener la guarda montada no implica que la consulta acote.
//   · POST /w2 (payroll.ts:303-307) se declara `escribe: 'tax_form_filings'` y
//     llama a `generateW2(employee_id, tax_year)` SIN inquilino ni entidad,
//     mientras `/form-941`, justo debajo, sí lleva guarda y sí los pasa.
//
// Quien tome el tramo tiene que reproducirlas antes de repararlas.

describe('sobre lo suyo sigue funcionando', () => {
  it('la corrida de su propia sociedad se puede postear', async () => {
    const empleadoA = randomUUID();
    const corridaA = randomUUID();
    await sembrarNominaDe(a, empleadoA, corridaA);
    const antes = await polizasDe(a.entityId);
    const r = await pedir(srv, 'POST', `/payroll/pay-runs/${corridaA}/post-to-gl`, {});
    expect(r.status, `contestó ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
    expect(await polizasDe(a.entityId)).toBe(antes + 1);
  });
});
