import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../../../database/connection.js';
import { calculatePaycheck, type EarningLine, type DeductionLine } from './paycheck-service.js';
import { dispatchEvent } from '../../webhooks/webhook-service.js';
import { payRunStateTransitions } from '../../../api/rest/middleware/metrics.js';

// ============================================================
// PAY RUN ORCHESTRATOR
// Creates a pay run, iterates employees, computes paychecks,
// aggregates totals, transitions status.
// ============================================================

export interface EmployeePayInput {
  employee_id: string;
  earnings: EarningLine[];
  deductions?: DeductionLine[];
  hours_worked?: number;
}

export interface PayRunInput {
  tenant_id: string;
  pay_period_id: string;
  run_type?: 'regular' | 'bonus' | 'correction' | 'final' | 'off_cycle';
  employee_inputs: EmployeePayInput[];
  created_by: string;
}

export async function createPayRun(input: PayRunInput): Promise<string> {
  const periodResult = await query<{ tax_year: number }>(
    `SELECT tax_year FROM pay_periods WHERE id = $1`,
    [input.pay_period_id]
  );
  if (periodResult.rows.length === 0) throw new Error('Pay period not found');
  const taxYear = periodResult.rows[0].tax_year;

  const id = uuidv4();
  await query(
    `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6)`,
    [id, input.tenant_id, input.pay_period_id, input.run_type || 'regular', taxYear, input.created_by]
  );
  return id;
}

export async function calculatePayRun(payRunId: string, input: PayRunInput): Promise<void> {
  await query(`UPDATE pay_runs SET status = 'calculating' WHERE id = $1`, [payRunId]);

  let totalGross = new Decimal(0);
  let totalPreTax = new Decimal(0);
  let totalPostTax = new Decimal(0);
  let totalEeTax = new Decimal(0);
  let totalErTax = new Decimal(0);
  let totalNet = new Decimal(0);

  for (const emp of input.employee_inputs) {
    const result = await calculatePaycheck({
      tenant_id: input.tenant_id,
      pay_run_id: payRunId,
      employee_id: emp.employee_id,
      pay_period_id: input.pay_period_id,
      earnings: emp.earnings,
      deductions: emp.deductions,
      hours_worked: emp.hours_worked,
    });
    totalGross = totalGross.plus(result.gross_earnings);
    totalPreTax = totalPreTax.plus(result.pre_tax_deductions);
    totalPostTax = totalPostTax.plus(result.post_tax_deductions);
    totalEeTax = totalEeTax.plus(result.employee_taxes);
    totalErTax = totalErTax.plus(result.employer_taxes);
    totalNet = totalNet.plus(result.net_pay);
  }

  await query(
    `UPDATE pay_runs SET
       status = 'calculated',
       total_gross = $1,
       total_pre_tax_deductions = $2,
       total_post_tax_deductions = $3,
       total_employee_taxes = $4,
       total_employer_taxes = $5,
       total_net_pay = $6,
       total_employer_cost = $7,
       employee_count = $8,
       calculated_at = NOW()
     WHERE id = $9`,
    [
      totalGross.toFixed(2),
      totalPreTax.toFixed(2),
      totalPostTax.toFixed(2),
      totalEeTax.toFixed(2),
      totalErTax.toFixed(2),
      totalNet.toFixed(2),
      totalGross.plus(totalErTax).toFixed(2),
      input.employee_inputs.length,
      payRunId,
    ]
  );
  await dispatchEvent(input.tenant_id, 'payroll.run.calculated', {
    pay_run_id: payRunId,
    total_gross: totalGross.toFixed(2),
    total_net: totalNet.toFixed(2),
    employee_count: input.employee_inputs.length,
  });
  payRunStateTransitions.inc({ from: 'draft', to: 'calculated', country: 'unknown' });
}

export async function approvePayRun(payRunId: string, approvedBy: string): Promise<void> {
  let tenantId = '';
  await withTransaction(async (client) => {
    const res = await client.query<{ status: string; tenant_id: string }>(
      `SELECT status, tenant_id FROM pay_runs WHERE id = $1 FOR UPDATE`,
      [payRunId]
    );
    if (res.rows.length === 0) throw new Error('Pay run not found');
    if (res.rows[0].status !== 'calculated') {
      throw new Error(`Cannot approve pay run in status ${res.rows[0].status}`);
    }
    tenantId = res.rows[0].tenant_id;
    await client.query(
      `UPDATE pay_runs SET status = 'approved', approved_by = $1, approved_at = NOW() WHERE id = $2`,
      [approvedBy, payRunId]
    );
  });
  await dispatchEvent(tenantId, 'payroll.run.approved', { pay_run_id: payRunId, approved_by: approvedBy });
  payRunStateTransitions.inc({ from: 'calculated', to: 'approved', country: 'unknown' });
}

export async function markPayRunPaid(payRunId: string): Promise<void> {
  const res = await query<{ tenant_id: string }>(
    `UPDATE pay_runs SET status = 'paid', paid_at = NOW()
     WHERE id = $1 AND status = 'approved' RETURNING tenant_id`,
    [payRunId]
  );
  if (res.rows[0]) {
    await dispatchEvent(res.rows[0].tenant_id, 'payroll.run.paid', { pay_run_id: payRunId });
    payRunStateTransitions.inc({ from: 'approved', to: 'paid', country: 'unknown' });
  }
}
