import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../../database/connection.js';
import { encrypt } from '../../../utils/encryption.js';
import { ValidationError, NotFoundError } from '../../../utils/errors.js';

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

export async function createEmployee(input: EmployeeInput): Promise<string> {
  if (input.country_code === 'MX' && !input.rfc) {
    throw new ValidationError('RFC is required for MX employees');
  }
  if (input.country_code === 'US' && !input.ssn) {
    throw new ValidationError('SSN is required for US employees');
  }

  const id = uuidv4();
  const ssnEncrypted = input.ssn ? encrypt(input.ssn) : null;
  const bankEncrypted = input.bank_account ? encrypt(JSON.stringify(input.bank_account)) : null;

  await query(
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
  await query(
    `INSERT INTO employee_compensation_history (employee_id, effective_date, salary_type, annual_salary, hourly_rate, reason, changed_by)
     VALUES ($1, $2, $3, $4, $5, 'initial', $6)`,
    [id, input.hire_date, input.salary_type || 'salary', input.annual_salary || null, input.hourly_rate || null, input.created_by]
  );

  return id;
}

export async function getEmployee(id: string): Promise<Record<string, unknown>> {
  const result = await query(
    `SELECT id, tenant_id, entity_id, employee_number,
            first_name, last_name, second_last_name, email, phone,
            hire_date, termination_date, status, country_code,
            rfc, curp, nss, sbc, tipo_regimen_sat, riesgo_puesto,
            infonavit_credit_number, infonavit_credit_type, infonavit_credit_value,
            w4_data, work_state, residence_state, work_city,
            salary_type, annual_salary, hourly_rate, currency_code, pay_schedule_id,
            bank_name, metadata, created_at, updated_at
     FROM employees WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) throw new NotFoundError('Employee', id);
  return result.rows[0] as Record<string, unknown>;
}

export async function listEmployees(
  tenantId: string,
  options: { entity_id?: string; status?: string; country?: string } = {}
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
     ORDER BY last_name, first_name`,
    params
  );
  return result.rows as Record<string, unknown>[];
}

export async function updateSalary(
  employeeId: string,
  newSalary: { salary_type: string; annual_salary?: number; hourly_rate?: number },
  effectiveDate: string,
  reason: string,
  changedBy: string
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE employees SET salary_type = $1, annual_salary = $2, hourly_rate = $3, updated_at = NOW()
       WHERE id = $4`,
      [newSalary.salary_type, newSalary.annual_salary || null, newSalary.hourly_rate || null, employeeId]
    );
    await client.query(
      `INSERT INTO employee_compensation_history (employee_id, effective_date, salary_type, annual_salary, hourly_rate, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [employeeId, effectiveDate, newSalary.salary_type, newSalary.annual_salary || null, newSalary.hourly_rate || null, reason, changedBy]
    );
  });
}

export async function terminateEmployee(
  employeeId: string,
  terminationDate: string,
  reason: string
): Promise<void> {
  await query(
    `UPDATE employees SET status = 'terminated', termination_date = $1, termination_reason = $2, updated_at = NOW() WHERE id = $3`,
    [terminationDate, reason, employeeId]
  );
}
