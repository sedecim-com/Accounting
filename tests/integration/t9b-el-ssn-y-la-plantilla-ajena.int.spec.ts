import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import { olvidarAlcances } from '../../src/database/scope.js';
import { encrypt } from '../../src/utils/encryption.js';
import payrollRouter from '../../src/api/rest/routes/payroll.js';

/**
 * T9b (#96) · EL SSN DE LA PLANTILLA AJENA, Y LAS ESCRITURAS SOBRE ELLA.
 *
 * T9a cerró las dos fugas del mayor. El censo de las 36 rutas dejó tres más, y
 * éstas no son de lectura: escriben.
 *
 *   · POST /w2 lee `FROM employees WHERE id = $1` sin acotar
 *     (w2-generator.ts:57), devuelve `ssn: decrypt(e.ssn_encrypted)` (:124) —
 *     el ÚNICO sitio de las 36 rutas donde un SSN sale en claro— y remata
 *     insertando en `tax_form_filings` con el `tenant_id` y el `entity_id` DE
 *     LA FILA LEÍDA (:145-153), no los de la sesión. A la sociedad hermana le
 *     queda una declaración fiscal 'ready' que no pidió, firmada con su EIN.
 *   · POST /employees/:id/compensation hace `UPDATE employees SET
 *     annual_salary = … WHERE id = $4` — sin inquilino y sin entidad.
 *   · POST /employees/:id/terminate hace `UPDATE employees SET status =
 *     'terminated' … WHERE id = $3`, igual. Y dar de baja es lo que dispara el
 *     finiquito.
 *
 * Las tres, entre entidades del MISMO inquilino: donde la RLS no acota nada,
 * porque acota por inquilino.
 */

let a: Fixture;
let b: Fixture;
let srv: Servidor;

const EMPLEADO_B = randomUUID();
const SSN = '123-45-6789';

const empleadoB = async (): Promise<{ status: string; annual_salary: string | null }> => {
  const { rows } = await query<{ status: string; annual_salary: string | null }>(
    'SELECT status, annual_salary::text AS annual_salary FROM employees WHERE id = $1',
    [EMPLEADO_B]
  );
  return rows[0];
};

const historialDe = async (employeeId: string): Promise<number> => {
  const { rows } = await query<{ n: string }>(
    'SELECT count(*)::text AS n FROM employee_compensation_history WHERE employee_id = $1',
    [employeeId]
  );
  return Number(rows[0].n);
};

const declaracionesDe = async (entityId: string): Promise<number> => {
  const { rows } = await query<{ n: string }>(
    'SELECT count(*)::text AS n FROM tax_form_filings WHERE entity_id = $1',
    [entityId]
  );
  return Number(rows[0].n);
};

beforeAll(async () => {
  olvidarAlcances();
  a = await crearInquilino('T9b sociedad A', { pais: 'US' });
  b = await crearEntidadHermana(a, 'T9b sociedad B');
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, country_code, ssn_encrypted, annual_salary, status, work_state)
     VALUES ($1,$2,$3,$4,'Ada','Lovelace','2015-01-01','US',$5, 1234567.89, 'active', 'CA')`,
    [EMPLEADO_B, b.tenantId, b.entityId, `E-${EMPLEADO_B.slice(0, 8)}`, encrypt(SSN)]
  );

  // La sesión concede SÓLO la sociedad A.
  srv = await levantar([['/payroll', payrollRouter]], {
    ...sesionDe(a),
    permissions: ['payroll:read', 'payroll:update', 'payroll:approve', 'payroll:create'],
  });
}, 180_000);

afterAll(async () => {
  await srv?.cerrar();
  await closeDatabase();
});

describe('el SSN de la plantilla ajena', () => {
  it('no sale en claro, y la petición no llega', async () => {
    const r = await pedir(srv, 'POST', '/payroll/w2', { employee_id: EMPLEADO_B, tax_year: 2026 });
    expect(r.status, `contestó ${r.status}`).toBe(404);
    expect(JSON.stringify(r.body ?? {}), 'el cuerpo lleva el SSN descifrado').not.toContain(SSN);
  });

  it('ni le queda a la sociedad hermana una declaración que no pidió', async () => {
    const antes = await declaracionesDe(b.entityId);
    await pedir(srv, 'POST', '/payroll/w2', { employee_id: EMPLEADO_B, tax_year: 2026 });
    expect(await declaracionesDe(b.entityId), 'quedó una declaración en la entidad ajena').toBe(antes);
  });
});

describe('las escrituras sobre la plantilla ajena', () => {
  it('no se le cambia el sueldo', async () => {
    const antes = (await empleadoB()).annual_salary;
    const r = await pedir(srv, 'POST', `/payroll/employees/${EMPLEADO_B}/compensation`, {
      salary_type: 'salary',
      annual_salary: 1.0,
      effective_date: '2026-06-01',
    });
    expect(r.status, `contestó ${r.status}`).toBe(404);
    expect((await empleadoB()).annual_salary, 'le cambiaron el sueldo').toBe(antes);
  });

  it('ni le queda un renglón de historial a su nombre', async () => {
    // LA MITAD SUTIL. Acotar sólo el UPDATE deja pasar el INSERT del historial:
    // el sueldo no cambia, pero al empleado ajeno le queda escrito un cambio de
    // sueldo con el nombre de quien lo intentó. Por eso el servicio comprueba
    // `rowCount` ANTES de escribir el renglón, dentro de la misma transacción.
    const antes = await historialDe(EMPLEADO_B);
    await pedir(srv, 'POST', `/payroll/employees/${EMPLEADO_B}/compensation`, {
      salary_type: 'salary',
      annual_salary: 2.0,
      effective_date: '2026-07-01',
    });
    expect(await historialDe(EMPLEADO_B), 'quedó un renglón de historial ajeno').toBe(antes);
  });

  it('ni se le da de baja — que es lo que dispara el finiquito', async () => {
    const r = await pedir(srv, 'POST', `/payroll/employees/${EMPLEADO_B}/terminate`, {
      termination_date: '2026-06-30',
      reason: 'ajena',
    });
    expect(r.status, `contestó ${r.status}`).toBe(404);
    expect((await empleadoB()).status, 'quedó dada de baja').toBe('active');
  });
});

describe('sobre lo suyo sigue funcionando', () => {
  it('el empleado propio sí se puede tocar', async () => {
    const propio = randomUUID();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, country_code, ssn_encrypted, annual_salary, status)
       VALUES ($1,$2,$3,$4,'Grace','Hopper','2015-01-01','US',$5, 100000, 'active')`,
      [propio, a.tenantId, a.entityId, `E-${propio.slice(0, 8)}`, encrypt('987-65-4321')]
    );
    const r = await pedir(srv, 'POST', `/payroll/employees/${propio}/compensation`, {
      salary_type: 'salary',
      annual_salary: 120000,
      effective_date: '2026-06-01',
    });
    expect(r.status, `contestó ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`).toBe(200);
  });
});
