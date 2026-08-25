import { v4 as uuidv4 } from 'uuid';
import { query } from '../../../../database/connection.js';
import { ValidationError } from '../../../../utils/errors.js';

// ============================================================
// USA Benefits — 401k, HSA, FSA, Section 125 cafeteria plans
// Handles employee elections + employer match/contributions.
// Annual limits (IRS 2026): 401(k) $23,500 + catch-up $7,500 (50+),
// HSA $4,300 self / $8,550 family, FSA $3,200, DCFSA $5,000.
// ============================================================

export type BenefitPlanType = '401k' | 'roth_401k' | 'hsa' | 'fsa' | 'dcfsa' | 'health_insurance' | 'dental' | 'vision';

export interface BenefitPlanInput {
  tenant_id: string;
  entity_id: string;
  plan_type: BenefitPlanType;
  plan_name: string;
  is_pre_tax: boolean;
  employer_match_formula?: {
    type: 'percentage_of_contribution' | 'percentage_of_salary' | 'fixed';
    match_rate?: number;       // e.g. 1.0 = 100% match
    max_salary_pct?: number;   // e.g. 0.06 = match up to 6% of salary
    fixed_amount?: number;
  };
  annual_limit?: number;
}

export interface EmployeeElectionInput {
  employee_id: string;
  benefit_plan_id: string;
  election_type: 'percentage' | 'fixed_amount';
  election_value: number;
  effective_date: string;
}

export interface BenefitDeductionResult {
  deduction_type: BenefitPlanType;
  is_pre_tax: boolean;
  employee_amount: number;
  employer_match: number;
  benefit_plan_id: string;
  limited_by: 'annual_cap' | 'match_cap' | null;
}

export async function createBenefitPlan(input: BenefitPlanInput): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO benefits_plans (id, tenant_id, entity_id, plan_type, plan_name,
       is_pre_tax, employer_match_formula, annual_limit)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [id, input.tenant_id, input.entity_id, input.plan_type, input.plan_name,
     input.is_pre_tax, JSON.stringify(input.employer_match_formula || null), input.annual_limit || null]
  );
  return id;
}

export async function electBenefit(input: EmployeeElectionInput): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO employee_benefit_elections
       (id, employee_id, benefit_plan_id, election_type, election_value, effective_date, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     ON CONFLICT (employee_id, benefit_plan_id)
     DO UPDATE SET election_type = EXCLUDED.election_type,
                   election_value = EXCLUDED.election_value,
                   effective_date = EXCLUDED.effective_date,
                   status = 'active'`,
    [id, input.employee_id, input.benefit_plan_id, input.election_type, input.election_value, input.effective_date]
  );
  return id;
}

/**
 * Compute per-paycheck benefit deductions for an employee.
 * Returns list of deductions to feed into paycheck-service.
 */
export async function calculateBenefitsForPaycheck(
  employeeId: string,
  grossEarnings: number,
  taxYear: number,
  ytdBenefits: Record<string, number> = {}
): Promise<BenefitDeductionResult[]> {
  const elections = await query<{
    election_id: string;
    benefit_plan_id: string;
    election_type: 'percentage' | 'fixed_amount';
    election_value: string;
    plan_type: BenefitPlanType;
    is_pre_tax: boolean;
    employer_match_formula: Record<string, unknown> | null;
    annual_limit: string | null;
  }>(
    `SELECT ebe.id AS election_id, ebe.benefit_plan_id, ebe.election_type, ebe.election_value,
            bp.plan_type, bp.is_pre_tax, bp.employer_match_formula, bp.annual_limit
     FROM employee_benefit_elections ebe
     JOIN benefits_plans bp ON bp.id = ebe.benefit_plan_id
     WHERE ebe.employee_id = $1 AND ebe.status = 'active'`,
    [employeeId]
  );

  const results: BenefitDeductionResult[] = [];

  for (const e of elections.rows) {
    let eeAmount = e.election_type === 'percentage'
      ? grossEarnings * (parseFloat(e.election_value) / 100)
      : parseFloat(e.election_value);

    // Apply annual cap
    let limitedBy: BenefitDeductionResult['limited_by'] = null;
    const annualLimit = e.annual_limit ? parseFloat(e.annual_limit) : Infinity;
    const ytd = ytdBenefits[e.plan_type] || 0;
    if (ytd + eeAmount > annualLimit) {
      eeAmount = Math.max(0, annualLimit - ytd);
      limitedBy = 'annual_cap';
    }

    // Employer match
    let employerMatch = 0;
    const formula = e.employer_match_formula as {
      type?: string; match_rate?: number; max_salary_pct?: number; fixed_amount?: number;
    } | null;
    if (formula && formula.type) {
      if (formula.type === 'percentage_of_contribution') {
        const rate = formula.match_rate || 0;
        const cap = formula.max_salary_pct ? grossEarnings * formula.max_salary_pct : Infinity;
        employerMatch = Math.min(eeAmount * rate, cap);
        if (employerMatch === cap && cap < eeAmount * rate) limitedBy = 'match_cap';
      } else if (formula.type === 'percentage_of_salary') {
        employerMatch = grossEarnings * (formula.match_rate || 0);
      } else if (formula.type === 'fixed') {
        employerMatch = formula.fixed_amount || 0;
      }
    }

    results.push({
      deduction_type: e.plan_type,
      is_pre_tax: e.is_pre_tax,
      employee_amount: Math.round(eeAmount * 100) / 100,
      employer_match: Math.round(employerMatch * 100) / 100,
      benefit_plan_id: e.benefit_plan_id,
      limited_by: limitedBy,
    });
  }

  return results;
}

export async function listBenefitPlans(entityId: string): Promise<Record<string, unknown>[]> {
  const result = await query(
    `SELECT * FROM benefits_plans WHERE entity_id = $1 ORDER BY plan_type, plan_name`,
    [entityId]
  );
  return result.rows as Record<string, unknown>[];
}

export async function listEmployeeElections(employeeId: string): Promise<Record<string, unknown>[]> {
  const result = await query(
    `SELECT ebe.*, bp.plan_name, bp.plan_type, bp.is_pre_tax
     FROM employee_benefit_elections ebe
     JOIN benefits_plans bp ON bp.id = ebe.benefit_plan_id
     WHERE ebe.employee_id = $1 AND ebe.status = 'active'`,
    [employeeId]
  );
  return result.rows as Record<string, unknown>[];
}

export function validateContribution(planType: BenefitPlanType, amount: number, ytd: number, year: number): void {
  const limits2026: Partial<Record<BenefitPlanType, number>> = {
    '401k': 23500, 'roth_401k': 23500, 'hsa': 4300, 'fsa': 3200, 'dcfsa': 5000,
  };
  const limit = limits2026[planType];
  if (limit && (ytd + amount) > limit) {
    throw new ValidationError(`Contribution exceeds IRS ${year} limit for ${planType}: $${limit}`);
  }
}
