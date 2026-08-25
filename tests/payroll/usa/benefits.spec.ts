import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import {
  calculateBenefitsForPaycheck,
  validateContribution,
} from '../../../src/services/payroll/usa/benefits/benefits-service.js';
import { query } from '../../../src/database/connection.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

describe('Benefits service', () => {
  beforeEach(() => mockQuery.mockReset());

  it('computes 401k as percentage of gross + employer match (% of contribution capped at 6%)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        election_id: 'el1', benefit_plan_id: 'bp1',
        election_type: 'percentage', election_value: '10',
        plan_type: '401k', is_pre_tax: true,
        employer_match_formula: { type: 'percentage_of_contribution', match_rate: 1.0, max_salary_pct: 0.06 },
        annual_limit: '23500',
      }],
    });

    const r = await calculateBenefitsForPaycheck('e1', 5000, 2026);
    // EE: 10% × 5000 = 500
    expect(r[0].employee_amount).toBe(500);
    // ER match: 100% of contribution capped at 6% of salary = $300
    expect(r[0].employer_match).toBe(300);
  });

  it('caps EE contribution at remaining annual limit', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        election_id: 'el2', benefit_plan_id: 'bp2',
        election_type: 'fixed_amount', election_value: '1000',
        plan_type: '401k', is_pre_tax: true,
        employer_match_formula: null,
        annual_limit: '23500',
      }],
    });

    // YTD already 23000, only $500 of room
    const r = await calculateBenefitsForPaycheck('e1', 5000, 2026, { '401k': 23000 });
    expect(r[0].employee_amount).toBe(500);
    expect(r[0].limited_by).toBe('annual_cap');
  });

  it('fixed match applies regardless of contribution', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        election_id: 'el3', benefit_plan_id: 'bp3',
        election_type: 'fixed_amount', election_value: '200',
        plan_type: 'hsa', is_pre_tax: true,
        employer_match_formula: { type: 'fixed', fixed_amount: 100 },
        annual_limit: '4300',
      }],
    });
    const r = await calculateBenefitsForPaycheck('e1', 5000, 2026);
    expect(r[0].employee_amount).toBe(200);
    expect(r[0].employer_match).toBe(100);
  });

  it('validateContribution throws when over IRS limit', () => {
    expect(() => validateContribution('401k', 1000, 23000, 2026)).toThrow(/exceeds IRS/);
    expect(() => validateContribution('hsa', 200, 4200, 2026)).toThrow(/exceeds IRS/);
  });

  it('validateContribution allows under-limit amounts', () => {
    expect(() => validateContribution('401k', 500, 22000, 2026)).not.toThrow();
    expect(() => validateContribution('fsa', 200, 2000, 2026)).not.toThrow();
  });
});
