import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// MNE-001-720 (#601): the deposit file reads the run's status in the statement
// that already reads the run, and a run that is not approved costs that one
// statement: no paycheck is read, no account is decrypted, nothing is written.

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));

import { generateNachaFile } from '../../../src/services/payroll/usa/nacha-generator.js';
import { query } from '../../../src/database/connection.js';

const mockQuery = query as unknown as Mock;
const scope = { kind: 'entity', tenantId: 't-1', entityId: 'ent-1' } as const;
const company = {
  immediate_destination: '021000021', immediate_origin: '1234567890', company_name: 'SAMPLE CO',
  company_identification: '1234567890', odfi_routing: '02100002', effective_entry_date: '',
};

function runIs(status: string): void {
  mockQuery.mockImplementation(async (sql: string) =>
    /FROM pay_runs pr/.test(sql)
      ? { rows: [{ tenant_id: 't-1', pay_date: '2026-03-20', status }] }
      : { rows: [] }
  );
}

beforeEach(() => mockQuery.mockReset());

describe('the deposit file asks the run for its status', () => {
  it.each(['draft', 'calculating', 'calculated', 'voided'])('a %s run is refused by key after one statement', async (status) => {
    runIs(status);
    await expect(generateNachaFile(scope, 'run-1', company)).rejects.toMatchObject({
      statusCode: 409,
      messageKey: { key: 'payrun.deposit_file.run_not_approved', params: { id: 'run-1', status } },
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it.each(['approved', 'paid'])('a run that is %s costs the four statements it cost before', async (status) => {
    runIs(status);
    const file = await generateNachaFile(scope, 'run-1', company);
    expect(file.entry_count).toBe(0);
    expect(mockQuery).toHaveBeenCalledTimes(4);
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/SELECT pr\.tenant_id, pp\.pay_date, pr\.status FROM pay_runs pr/);
  });

  it('a run outside the scope is a 404 whatever its status would be', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(generateNachaFile(scope, 'run-1', company)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
