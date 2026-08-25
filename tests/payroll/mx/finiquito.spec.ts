import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { calculateFiniquito } from '../../../src/services/payroll/mx/finiquito-calculator.js';
import { query } from '../../../src/database/connection.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

describe('Finiquito MX (LFT Art. 76, 79, 80, 87)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('computes salarios pendientes + aguinaldo + prima + vacaciones', async () => {
    // Employee with sbc=500, hire_date 2020-01-01
    mockQuery.mockResolvedValueOnce({
      rows: [{ sbc: '500', hire_date: '2020-01-01', annual_salary: null }],
    });

    const r = await calculateFiniquito({
      employee_id: 'e1',
      termination_date: '2026-04-30',     // ~120 days into 2026
      last_paid_through: '2026-04-15',    // 15 days unpaid
      pending_vacation_days: 5,
    });

    // Salary: 15 days × 500 = 7500
    expect(r.salary_pending_days).toBe(15);
    expect(r.salary_pending_amount).toBe(7500);

    // Aguinaldo: (15 days/year × 120/365) × 500 ≈ 2465.75
    expect(r.aguinaldo_amount).toBeGreaterThan(2400);
    expect(r.aguinaldo_amount).toBeLessThan(2500);

    // Vacaciones pendientes: 5 × 500 = 2500
    expect(r.vacation_pending_amount).toBe(2500);

    // Prima vacacional: 25% × proportional vacation days × daily wage
    expect(r.prima_vacacional_amount).toBeGreaterThan(0);

    expect(r.total).toBeCloseTo(
      r.salary_pending_amount + r.aguinaldo_amount + r.prima_vacacional_amount + r.vacation_pending_amount,
      1
    );
  });

  it('falls back to annual_salary / 365 if sbc missing', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ sbc: null, hire_date: '2024-01-01', annual_salary: '365000' }],
    });

    const r = await calculateFiniquito({
      employee_id: 'e1',
      termination_date: '2026-01-11',
      last_paid_through: '2026-01-01',
    });

    // Daily wage = 365000/365 = 1000; 10 days = 10000
    expect(r.salary_pending_days).toBe(10);
    expect(r.salary_pending_amount).toBe(10000);
  });

  it('throws when employee not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(calculateFiniquito({
      employee_id: 'missing',
      termination_date: '2026-01-15',
      last_paid_through: '2026-01-01',
    })).rejects.toThrow('Employee not found');
  });

  it('clamps negative salary_pending to 0 if last_paid > termination', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ sbc: '500', hire_date: '2024-01-01', annual_salary: null }],
    });
    const r = await calculateFiniquito({
      employee_id: 'e1',
      termination_date: '2026-01-01',
      last_paid_through: '2026-01-15',
    });
    expect(r.salary_pending_days).toBe(0);
    expect(r.salary_pending_amount).toBe(0);
  });
});
