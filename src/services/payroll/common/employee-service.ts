import { v4 as uuidv4 } from 'uuid';
import type pg from 'pg';
import { query, withTransaction } from '../../../database/connection.js';
import { encrypt } from '../../../utils/encryption.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import {
  condicionDeAlcance,
  entityScope,
  requireByIdInScope,
  type Scope,
} from '../../../database/scope.js';

// ============================================================
// EMPLOYEE SERVICE
// CRUD with salary versioning.
// ============================================================

export interface EmployeeInput {
  tenant_id: string;
  entity_id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  second_last_name?: string;
  email?: string;
  phone?: string;
  hire_date: string;
  country_code: 'MX' | 'US';
  salary_type?: 'salary' | 'hourly' | 'commission' | 'contractor_1099';
  annual_salary?: number;
  hourly_rate?: number;
  currency_code?: string;
  pay_schedule_id?: string;

  // MX
  rfc?: string;
  curp?: string;
  nss?: string;
  sbc?: number;
  tipo_regimen_sat?: string;
  tipo_contrato_sat?: string;
  tipo_jornada_sat?: string;
  riesgo_puesto?: string;
  infonavit_credit_number?: string;
  infonavit_credit_type?: 'factor' | 'vsm' | 'pesos';
  infonavit_credit_value?: number;

  // US
  ssn?: string;
  w4_data?: Record<string, unknown>;
  work_state?: string;
  residence_state?: string;
  work_city?: string;

  // Bank
  bank_account?: Record<string, unknown>;
  bank_name?: string;

  created_by: string;
}

/**
 * Registers one employee and seeds the initial compensation history row.
 *
 * Both inserts run in ONE transaction: they used to be two autocommitted
 * statements, so a failure on the second left an employee with no salary
 * history. Passing `opts.client` runs them on the caller's transaction, which
 * is how `employee create --dry-run` rehearses the real path and rolls it back.
 *
 * NOTE: a pay schedule is looked up inside the employee's own entity. The FK
 * only proves the schedule exists somewhere, so a sister company's schedule
 * was accepted and the employee then joined the other entity's pay periods.
 * Out of scope answers 404, like every other scoped read.
 */
export async function createEmployee(
  input: EmployeeInput,
  opts: { client?: pg.PoolClient } = {}
): Promise<string> {
  if (input.country_code === 'MX' && !input.rfc) {
    throw new ValidationError('RFC is required for MX employees');
  }
  if (input.country_code === 'US' && !input.ssn) {
    throw new ValidationError('SSN is required for US employees');
  }
  return opts.client
    ? insertEmployee(opts.client, input)
    : withTransaction((client) => insertEmployee(client, input));
}

async function insertEmployee(client: pg.PoolClient, input: EmployeeInput): Promise<string> {
  if (input.pay_schedule_id) {
    await requireByIdInScope('pay_schedules', input.pay_schedule_id, entityScope(input.tenant_id, input.entity_id), {
      client,
      columns: 'id',
    });
  }

  const id = uuidv4();
  const ssnEncrypted = input.ssn ? encrypt(input.ssn) : null;
  const bankEncrypted = input.bank_account ? encrypt(JSON.stringify(input.bank_account)) : null;

  await client.query(
    `INSERT INTO employees (
      id, tenant_id, entity_id, employee_number,
      first_name, last_name, second_last_name, email, phone,
      hire_date, status, country_code,
      rfc, curp, nss, sbc, tipo_regimen_sat, tipo_contrato_sat, tipo_jornada_sat, riesgo_puesto,
      infonavit_credit_number, infonavit_credit_type, infonavit_credit_value,
      ssn_encrypted, w4_data, work_state, residence_state, work_city,
      salary_type, annual_salary, hourly_rate, currency_code, pay_schedule_id,
      bank_account_encrypted, bank_name, created_by
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8, $9,
      $10, 'active', $11,
      $12, $13, $14, $15, $16, $17, $18, $19,
      $20, $21, $22,
      $23, $24::jsonb, $25, $26, $27,
      $28, $29, $30, $31, $32,
      $33, $34, $35
    )`,
    [
      id, input.tenant_id, input.entity_id, input.employee_number,
      input.first_name, input.last_name, input.second_last_name || null, input.email || null, input.phone || null,
      input.hire_date, input.country_code,
      input.rfc || null, input.curp || null, input.nss || null, input.sbc || null,
      input.tipo_regimen_sat || null, input.tipo_contrato_sat || null, input.tipo_jornada_sat || null, input.riesgo_puesto || null,
      input.infonavit_credit_number || null, input.infonavit_credit_type || null, input.infonavit_credit_value || null,
      ssnEncrypted, JSON.stringify(input.w4_data || {}), input.work_state || null, input.residence_state || null, input.work_city || null,
      input.salary_type || 'salary', input.annual_salary || null, input.hourly_rate || null,
      input.currency_code || (input.country_code === 'MX' ? 'MXN' : 'USD'), input.pay_schedule_id || null,
      bankEncrypted, input.bank_name || null, input.created_by,
    ]
  );

  // Initial compensation history
  await client.query(
    `INSERT INTO employee_compensation_history (employee_id, effective_date, salary_type, annual_salary, hourly_rate, reason, changed_by)
     VALUES ($1, $2, $3, $4, $5, 'initial', $6)`,
    [id, input.hire_date, input.salary_type || 'salary', input.annual_salary || null, input.hourly_rate || null, input.created_by]
  );

  return id;
}

/**
 * Un empleado, si el alcance lo alcanza (T9 · #96).
 *
 * Antes tomaba el id y nada más: `GET /payroll/employees/:id` devolvía RFC,
 * CURP, NSS y `annual_salary` de la plantilla de la sociedad hermana con sólo
 * conocer su UUID. Medido — y entre entidades del MISMO inquilino, o sea donde
 * la RLS no acota nada, porque acota por inquilino.
 *
 * El alcance va DENTRO de la consulta, no en una comprobación previa, y la
 * ausencia se contesta como inexistencia: 404 y no 403, para que la respuesta
 * no delate qué empleados tienen las otras sociedades.
 */
export async function getEmployee(id: string, scope: Scope): Promise<Record<string, unknown>> {
  // `employees` lleva `entity_id` propio, así que el ayudante de la casa
  // deduce la columna del esquema y mete el filtro en la misma sentencia.
  // NOTE: a reference that is not a UUID is the employee number printed on
  // the payslip, which is what `employee show` is given at the terminal.
  return await requireByIdInScope(
    'employees',
    id,
    scope,
    { idColumn: UUID_RE.test(id) ? 'id' : 'employee_number', columns: `id, tenant_id, entity_id, employee_number,
            first_name, last_name, second_last_name, email, phone,
            hire_date, termination_date, status, country_code,
            rfc, curp, nss, sbc, tipo_regimen_sat, riesgo_puesto,
            infonavit_credit_number, infonavit_credit_type, infonavit_credit_value,
            w4_data, work_state, residence_state, work_city,
            salary_type, annual_salary, hourly_rate, currency_code, pay_schedule_id,
            bank_name, metadata, created_at, updated_at` }
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listEmployees(
  tenantId: string,
  options: { entity_id?: string; status?: string; country?: string; limit?: number; offset?: number } = {}
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [tenantId];
  let where = 'WHERE tenant_id = $1';
  if (options.entity_id) { where += ` AND entity_id = $${params.length + 1}`; params.push(options.entity_id); }
  if (options.status) { where += ` AND status = $${params.length + 1}`; params.push(options.status); }
  if (options.country) { where += ` AND country_code = $${params.length + 1}`; params.push(options.country); }

  const result = await query(
    `SELECT id, employee_number, first_name, last_name, email, hire_date,
            status, country_code, salary_type, annual_salary, hourly_rate,
            currency_code, pay_schedule_id, work_state
     FROM employees ${where}
     ORDER BY last_name, first_name, employee_number
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, options.limit ?? null, options.offset ?? 0]
  );
  return result.rows;
}

/**
 * El sueldo de un empleado, si el alcance lo alcanza (T9b · #96).
 *
 * El UPDATE decía `WHERE id = $4` y nada más: sin inquilino y sin entidad.
 * Medido — `POST /payroll/employees/<empleado de la sociedad B>/compensation`
 * contestaba 200 y le dejaba el sueldo en 1.00 desde 1 234 567.89.
 *
 * El alcance va DENTRO de la misma sentencia, con `condicionDeAlcance`, por la
 * razón que ese ayudante lleva escrita: comprobar con un SELECT y escribir
 * después reabre la ventana entre mirar y escribir.
 *
 * Y la fila de HISTORIAL se escribe sólo si el UPDATE alcanzó algo. Sin esa
 * comprobación, acotar el UPDATE deja igualmente un renglón de historial del
 * empleado ajeno — una escritura menos visible y con su nombre encima.
 */
export async function updateSalary(
  employeeId: string,
  newSalary: { salary_type: string; annual_salary?: number; hourly_rate?: number },
  effectiveDate: string,
  reason: string,
  scope: Scope,
  changedBy: string
): Promise<void> {
  const alcance = await condicionDeAlcance('employees', scope, 5);
  await withTransaction(async (client) => {
    const r = await client.query(
      `UPDATE employees SET salary_type = $1, annual_salary = $2, hourly_rate = $3, updated_at = NOW()
       WHERE id = $4 AND ${alcance.sql}`,
      [newSalary.salary_type, newSalary.annual_salary || null, newSalary.hourly_rate || null, employeeId, alcance.valor]
    );
    // Cero filas = fuera del alcance, y se contesta como inexistencia: 404 y no
    // 403, para que la respuesta no delate qué plantilla tienen las otras
    // sociedades.
    if (r.rowCount === 0) throw new NotFoundError('Employee', employeeId);
    await client.query(
      `INSERT INTO employee_compensation_history (employee_id, effective_date, salary_type, annual_salary, hourly_rate, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [employeeId, effectiveDate, newSalary.salary_type, newSalary.annual_salary || null, newSalary.hourly_rate || null, reason, changedBy]
    );
  });
}

/**
 * La baja de un empleado, si el alcance lo alcanza (T9b · #96).
 *
 * Mismo defecto y misma cura que `updateSalary`, y con más consecuencia: dar de
 * baja es lo que dispara el finiquito. Medido: la plantilla de la sociedad
 * hermana pasaba de `active` a `terminated` con un 200.
 */
export async function terminateEmployee(
  employeeId: string,
  terminationDate: string,
  reason: string,
  scope: Scope
): Promise<void> {
  const alcance = await condicionDeAlcance('employees', scope, 4);
  const r = await query(
    `UPDATE employees SET status = 'terminated', termination_date = $1, termination_reason = $2, updated_at = NOW()
      WHERE id = $3 AND ${alcance.sql}`,
    [terminationDate, reason, employeeId, alcance.valor]
  );
  if (r.rowCount === 0) throw new NotFoundError('Employee', employeeId);
}
