import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { getEmployeeSutaYtd } from '../../../src/services/payroll/tax-engine/ytd-service.js';
import { query } from '../../../src/database/connection.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

describe('getEmployeeSutaYtd — per-state SUTA wage tracking', () => {
  beforeEach(() => mockQuery.mockReset());

  it('filters paychecks by employee.work_state', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ wages: '6500' }] });
    const ytd = await getEmployeeSutaYtd('emp1', 2026, 'CA');
    expect(ytd).toBe(6500);

    // Verify the SQL used the state param
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['emp1', 2026, 'CA', null]);
  });

  it('returns 0 when no paychecks match', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ wages: '0' }] });
    const ytd = await getEmployeeSutaYtd('emp1', 2026, 'TX');
    expect(ytd).toBe(0);
  });

  it('handles missing row defensively', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const ytd = await getEmployeeSutaYtd('emp1', 2026, 'NY');
    expect(ytd).toBe(0);
  });

  it('respects beforePayDate cutoff', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ wages: '3500' }] });
    const cutoff = new Date('2026-06-15');
    await getEmployeeSutaYtd('emp1', 2026, 'WA', cutoff);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[3]).toEqual(cutoff);
  });
});
