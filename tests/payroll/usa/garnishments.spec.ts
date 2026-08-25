import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB before importing the engine
vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { calculateGarnishments } from '../../../src/services/payroll/usa/garnishments/garnishment-engine.js';
import { query } from '../../../src/database/connection.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

function ordersResponse(rows: Array<Record<string, unknown>>) {
  mockQuery.mockResolvedValueOnce({ rows });
}

describe('Garnishment engine — CCPA caps', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns 0 with no active orders', async () => {
    ordersResponse([]);
    const r = await calculateGarnishments({
      employee_id: 'e1', disposable_earnings: 1000, gross_wages: 1200, pay_frequency: 'biweekly',
    });
    expect(r.total_withheld).toBe(0);
    expect(r.per_order).toEqual([]);
  });

  it('applies child-support 50% cap (supports second family, no arrears)', async () => {
    ordersResponse([
      {
        id: 'cs1', type: 'child_support', amount_per_period: '600', percentage: null,
        priority: 1, supports_second_family: true, arrears_over_12_weeks: false, exempt_amount: null,
      },
    ]);
    const r = await calculateGarnishments({
      employee_id: 'e1', disposable_earnings: 1000, gross_wages: 1200, pay_frequency: 'biweekly',
    });
    // Cap 50% of $1000 = $500 (desired $600)
    expect(r.total_withheld).toBe(500);
    expect(r.per_order[0].cap_applied).toMatch(/CCPA 50/);
  });

  it('applies 65% cap (no second family, arrears > 12 weeks)', async () => {
    ordersResponse([
      {
        id: 'cs2', type: 'child_support', amount_per_period: '900', percentage: null,
        priority: 1, supports_second_family: false, arrears_over_12_weeks: true, exempt_amount: null,
      },
    ]);
    const r = await calculateGarnishments({
      employee_id: 'e1', disposable_earnings: 1000, gross_wages: 1200, pay_frequency: 'biweekly',
    });
    expect(r.total_withheld).toBe(650);
  });

  it('honors order amount when below cap', async () => {
    ordersResponse([
      {
        id: 'cs3', type: 'child_support', amount_per_period: '300', percentage: null,
        priority: 1, supports_second_family: true, arrears_over_12_weeks: false, exempt_amount: null,
      },
    ]);
    const r = await calculateGarnishments({
      employee_id: 'e1', disposable_earnings: 1000, gross_wages: 1200, pay_frequency: 'biweekly',
    });
    expect(r.total_withheld).toBe(300);
    expect(r.per_order[0].cap_applied).toBeNull();
  });

  it('creditor garnishment respects 25% disposable cap', async () => {
    ordersResponse([
      {
        id: 'cr1', type: 'creditor', amount_per_period: '500', percentage: null,
        priority: 5, supports_second_family: null, arrears_over_12_weeks: null, exempt_amount: null,
      },
    ]);
    const r = await calculateGarnishments({
      employee_id: 'e1', disposable_earnings: 1000, gross_wages: 1200, pay_frequency: 'weekly',
    });
    // 25% of $1000 = $250
    expect(r.total_withheld).toBeLessThanOrEqual(250.01);
    expect(r.per_order[0].cap_applied).toMatch(/CCPA/);
  });

  it('creditor returns 0 when disposable below 30×FMW (≈$217.50/wk)', async () => {
    ordersResponse([
      {
        id: 'cr2', type: 'creditor', amount_per_period: '100', percentage: null,
        priority: 5, supports_second_family: null, arrears_over_12_weeks: null, exempt_amount: null,
      },
    ]);
    const r = await calculateGarnishments({
      employee_id: 'e1', disposable_earnings: 200, gross_wages: 250, pay_frequency: 'weekly',
    });
    // min(25% × 200=50, 200 − 217.50 = −17.50→0) → 0
    expect(r.total_withheld).toBe(0);
  });

  it('tax levy uses Pub 1494 exempt amount', async () => {
    ordersResponse([
      {
        id: 'tl1', type: 'tax_levy', amount_per_period: null, percentage: null,
        priority: 2, supports_second_family: null, arrears_over_12_weeks: null, exempt_amount: '300',
      },
    ]);
    const r = await calculateGarnishments({
      employee_id: 'e1', disposable_earnings: 1000, gross_wages: 1200, pay_frequency: 'biweekly',
    });
    expect(r.total_withheld).toBe(700);
  });

  it('AWG student loan caps at 15%', async () => {
    ordersResponse([
      {
        id: 'sl1', type: 'student_loan', amount_per_period: '500', percentage: null,
        priority: 4, supports_second_family: null, arrears_over_12_weeks: null, exempt_amount: null,
      },
    ]);
    const r = await calculateGarnishments({
      employee_id: 'e1', disposable_earnings: 1000, gross_wages: 1200, pay_frequency: 'biweekly',
    });
    expect(r.total_withheld).toBe(150);
    expect(r.per_order[0].cap_applied).toBe('AWG 15%');
  });
});
