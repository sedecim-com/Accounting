import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import {
  createEmployee,
  getEmployee,
  listEmployees,
  type EmployeeInput,
} from '../../src/services/payroll/common/employee-service.js';

/**
 * MNE-001-066 (#306): the employee service under the terminal leaves.
 *
 * The two companies below share one tenant on purpose. RLS bounds by TENANT,
 * so inside one tenant nothing but the predicate the code writes into the
 * SQL can tell them apart: whatever answers 404 here is that predicate.
 */

const TENANT = randomUUID();
const ORG = randomUUID();
const ENTITY = randomUUID();
const SISTER = randomUUID();
const SISTER_SCHEDULE = randomUUID();
const OWN_SCHEDULE = randomUUID();
const SCOPE = entityScope(TENANT, ENTITY);
const SISTER_SCOPE = entityScope(TENANT, SISTER);

function input(number: string, over: Partial<EmployeeInput> = {}): EmployeeInput {
  return {
    tenant_id: TENANT,
    entity_id: ENTITY,
    employee_number: number,
    first_name: 'Ana',
    last_name: 'Ruiz',
    hire_date: '2026-01-15',
    country_code: 'MX',
    rfc: 'RUAA900101AB1',
    curp: 'RUAA900101MDFZNN09',
    nss: '12345678901',
    annual_salary: 180000,
    created_by: randomUUID(),
    ...over,
  };
}

async function countOf(number: string): Promise<{ employees: number; history: number }> {
  const r = await query<{ employees: string; history: string }>(
    `SELECT (SELECT COUNT(*) FROM employees WHERE tenant_id = $1 AND employee_number = $2) AS employees,
            (SELECT COUNT(*) FROM employee_compensation_history h JOIN employees e ON e.id = h.employee_id
              WHERE e.tenant_id = $1 AND e.employee_number = $2) AS history`,
    [TENANT, number]
  );
  return { employees: Number(r.rows[0].employees), history: Number(r.rows[0].history) };
}

beforeAll(async () => {
  await query(`INSERT INTO tenants (id, name, subdomain, schema_name) VALUES ($1,'M066','m066','t_m066')`, [TENANT]);
  await query(`INSERT INTO organizations (id, tenant_id, name, type) VALUES ($1,$2,'G','holding')`, [ORG, TENANT]);
  for (const [id, name, rfc] of [[ENTITY, 'Acme', 'AAA010101AAA'], [SISTER, 'Acme Sister', 'BBB010101BBB']]) {
    await query(
      `INSERT INTO legal_entities (id, organization_id, tenant_id, name, entity_type, tax_id, tax_id_type, incorporation_country)
       VALUES ($1,$2,$3,$4,'corporation',$5,'rfc','MX')`,
      [id, ORG, TENANT, name, rfc]
    );
  }
  for (const [id, entity] of [[OWN_SCHEDULE, ENTITY], [SISTER_SCHEDULE, SISTER]]) {
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start)
       VALUES ($1,$2,$3,'Quincenal','quincenal','MX','2026-01-01')`,
      [id, TENANT, entity]
    );
  }
  await createEmployee(input('M066-SIS', { entity_id: SISTER, first_name: 'Sister' }));
}, 120_000);

afterAll(async () => {
  await query(
    'DELETE FROM employee_compensation_history WHERE employee_id IN (SELECT id FROM employees WHERE tenant_id = $1)',
    [TENANT]
  );
  await query('DELETE FROM employees WHERE tenant_id = $1', [TENANT]);
  await query('DELETE FROM pay_schedules WHERE tenant_id = $1', [TENANT]);
  await query('DELETE FROM legal_entities WHERE tenant_id = $1', [TENANT]);
  await query('DELETE FROM organizations WHERE id = $1', [ORG]);
  await query('DELETE FROM tenants WHERE id = $1', [TENANT]);
});

describe('employee create writes both rows, and only into its own entity', () => {
  it('registers the employee with its initial compensation history', async () => {
    const id = await createEmployee(input('M066-001', { pay_schedule_id: OWN_SCHEDULE }));
    expect(await countOf('M066-001')).toEqual({ employees: 1, history: 1 });
    const row = await getEmployee(id, SCOPE);
    expect(row.pay_schedule_id).toBe(OWN_SCHEDULE);
  });

  it("refuses the sister company's pay schedule with a 404 and leaves nothing behind", async () => {
    await expect(createEmployee(input('M066-002', { pay_schedule_id: SISTER_SCHEDULE }))).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await countOf('M066-002')).toEqual({ employees: 0, history: 0 });
  });

  it('the --dry-run path runs the real writer and its rollback leaves neither row', async () => {
    const rehearsed = await withTransaction(async (client) => {
      const id = await createEmployee(input('M066-003'), { client });
      throw Object.assign(new Error('rehearsed'), { id });
    }).catch((err: Error & { id?: string }) => err.id);
    expect(rehearsed, 'the rehearsal must reach the INSERT').toBeTruthy();
    expect(await countOf('M066-003')).toEqual({ employees: 0, history: 0 });
  });
});

describe('employee show and list stay inside the entity', () => {
  it('show finds an employee by the number on the payslip, in scope only', async () => {
    const row = await getEmployee('M066-001', SCOPE);
    expect(row.employee_number).toBe('M066-001');
    await expect(getEmployee('M066-SIS', SCOPE)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getEmployee('M066-001', SISTER_SCOPE)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("list returns the entity's roll and never the sister company's", async () => {
    const rows = await listEmployees(TENANT, { entity_id: ENTITY, status: 'active' });
    const numbers = rows.map((r) => r.employee_number);
    expect(numbers).toContain('M066-001');
    expect(numbers).not.toContain('M066-SIS');
  });

  it('list pages with limit and offset in the SQL', async () => {
    await createEmployee(input('M066-004', { last_name: 'Zeta' }));
    const all = await listEmployees(TENANT, { entity_id: ENTITY });
    expect(all.map((r) => r.employee_number)).toEqual(['M066-001', 'M066-004']);
    const second = await listEmployees(TENANT, { entity_id: ENTITY, limit: 1, offset: 1 });
    expect(second.map((r) => r.employee_number)).toEqual(['M066-004']);
  });
});
