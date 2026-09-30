import { query } from '../../../database/connection.js';
import type { EntityScope } from '../../../database/scope.js';
import { NotFoundError } from '../../../utils/errors.js';
import { reciboEnEntidad } from './alcance-nomina.js';
import { getPayRun } from './pay-run-service.js';

// ============================================================
// Reading paychecks — shared by GET /v1/payroll/paychecks/:id and the
// terminal's `payslip show|list` (MNE-001-070, #306 part 4/4).
//
// `paychecks` has no entity_id: a paycheck reaches its entity through its
// EMPLOYEE (alcance-nomina.ts says why that road and not the run's). The
// predicate goes inside the SQL, so a paycheck of the sister company answers
// the same 404 as one that does not exist.
// ============================================================

export type PaycheckDetail = Record<string, unknown> & {
  id: string;
  employee_id: string;
  earnings: Record<string, unknown>[];
  deductions: Record<string, unknown>[];
  taxes: Record<string, unknown>[];
};

/** One paycheck of the entity, with its earning, deduction and tax lines. */
export async function getPaycheck(paycheckId: string, scope: EntityScope): Promise<PaycheckDetail> {
  const pc = await query<Record<string, unknown> & { id: string; employee_id: string }>(
    `SELECT * FROM paychecks WHERE id = $1 AND tenant_id = $2
        AND ${reciboEnEntidad('paychecks.employee_id', 3)}`,
    [paycheckId, scope.tenantId, scope.entityId]
  );
  if (pc.rows.length === 0) throw new NotFoundError('Paycheck', paycheckId);
  // The lines have no scope column of their own; they are read by the id the
  // scoped query above just returned, never by the caller's.
  const id = pc.rows[0].id;
  const [earnings, deductions, taxes] = await Promise.all([
    query(`SELECT * FROM paycheck_earnings WHERE paycheck_id = $1 ORDER BY earning_type, id`, [id]),
    query(`SELECT * FROM paycheck_deductions WHERE paycheck_id = $1 ORDER BY deduction_type, id`, [id]),
    query(`SELECT * FROM paycheck_taxes WHERE paycheck_id = $1 ORDER BY employee_employer, tax_type, id`, [id]),
  ]);
  return { ...pc.rows[0], earnings: earnings.rows, deductions: deductions.rows, taxes: taxes.rows };
}

export interface PaycheckSummary {
  id: string;
  employee_number: string;
  employee_name: string;
  gross_earnings: string;
  net_pay: string;
  payment_method: string | null;
  cfdi_status: string | null;
}

/**
 * The paychecks of one run of the entity, by employee number. Prints no tax
 * identifier: a listing that carried the RFC of the whole roll would be the
 * bulk PII the catalog keeps away from the agent.
 */
export async function listPaychecks(payRunId: string, scope: EntityScope): Promise<PaycheckSummary[]> {
  // A foreign or missing run is a 404, not an empty list.
  await getPayRun(payRunId, scope);
  const r = await query<PaycheckSummary>(
    `SELECT p.id, e.employee_number,
            concat_ws(' ', e.first_name, e.last_name, e.second_last_name) AS employee_name,
            p.gross_earnings::text AS gross_earnings, p.net_pay::text AS net_pay,
            p.payment_method, p.cfdi_status
       FROM paychecks p
       JOIN employees e ON e.id = p.employee_id
      WHERE p.pay_run_id = $1 AND p.tenant_id = $2 AND e.entity_id = $3
      ORDER BY e.employee_number, p.id`,
    [payRunId, scope.tenantId, scope.entityId]
  );
  return r.rows;
}
