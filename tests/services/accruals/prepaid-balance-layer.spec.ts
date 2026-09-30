import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type pg from 'pg';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  currentTenant: vi.fn(() => 'ten-1'),
  withTransaction: vi.fn(),
}));
// Spied, not replaced: the real report-layer queries run against the mocked
// connection, and the spies prove the prepaid guards read them (T14 · #101).
vi.mock('../../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/reporting/report-service.js')>();
  return {
    ...real,
    queryAccountBalance: vi.fn(real.queryAccountBalance),
    queryEntryMovementsOnAccount: vi.fn(real.queryEntryMovementsOnAccount),
  };
});

import { respaldoDisponible, huecoDeAnticipados } from '../../../src/services/accruals/prepaid-service.js';
import { query } from '../../../src/database/connection.js';
import {
  queryAccountBalance,
  queryEntryMovementsOnAccount,
} from '../../../src/services/reporting/report-service.js';

const mockQuery = query as unknown as Mock;
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PREPAID = 'acc-1160';
const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');

beforeEach(() => {
  mockQuery.mockReset();
  vi.mocked(queryAccountBalance).mockClear();
  vi.mocked(queryEntryMovementsOnAccount).mockClear();
});

describe('respaldoDisponible reads the posted balance from the report layer', () => {
  it('measures balance and adopted amount on the caller transaction, figures unchanged', async () => {
    // The guard runs under a FOR UPDATE on the account: reading the balance on
    // another connection would measure outside its own lock.
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ account_id: PREPAID, balance: '24000.0000' }] })
      .mockResolvedValueOnce({ rows: [{ adoptado: '18000.0000' }] });
    const client = { query: clientQuery } as unknown as pg.PoolClient;

    const r = await respaldoDisponible(ENTITY, PREPAID, client);

    expect(queryAccountBalance).toHaveBeenCalledWith(ENTITY, PREPAID, client);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(clientQuery).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ saldoPosteado: '24000.0000', yaAdoptado: '18000.0000', disponible: '6000.0000' });
  });

  it('without a transaction reads through the pool, and no posted lines is zero backing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ adoptado: '0' }] });

    const r = await respaldoDisponible(ENTITY, PREPAID);

    expect(queryAccountBalance).toHaveBeenCalledWith(ENTITY, PREPAID, undefined);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ saldoPosteado: '0.0000', yaAdoptado: '0.0000', disponible: '0.0000' });
  });
});

describe('huecoDeAnticipados lists unclaimed debits through the report layer', () => {
  it('excludes the entries a live schedule claims and keeps only net debits, oldest first', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ account_id: PREPAID, balance: '5000.0000' }] })
      .mockResolvedValueOnce({ rows: [{ adoptado: '2000.0000' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'je-claimed' }] })
      .mockResolvedValueOnce({
        rows: [
          { journal_entry_id: 'je-7', entry_number: 'JE-7', entry_date: new Date('2026-03-01'),
            description: 'Annual insurance', amount: '3000.0000' },
        ],
      });

    const r = await huecoDeAnticipados(ENTITY, PREPAID);

    // The claims are read scoped to the entity and to live schedules.
    expect(sql(2)).toMatch(/FROM prepaid_expenses WHERE entity_id = \$1 AND status <> 'cancelled'/);
    expect(mockQuery.mock.calls[2][1]).toEqual([ENTITY]);
    expect(queryEntryMovementsOnAccount).toHaveBeenCalledWith(ENTITY, PREPAID, {
      excludeEntryIds: ['je-claimed'],
      netDebitsOnly: true,
      order: 'oldest',
    });
    expect(sql(3)).toMatch(/AND NOT \(je\.id = ANY\(\$3::uuid\[\]\)\)/);
    expect(sql(3)).toMatch(/HAVING SUM\(COALESCE\(jel\.debit_amount, 0\) - COALESCE\(jel\.credit_amount, 0\)\) > 0/);
    expect(sql(3)).toMatch(/ORDER BY je\.entry_date ASC, je\.entry_number ASC/);
    expect(r).toEqual({
      prepaidAccountId: PREPAID,
      saldoPosteado: '5000.0000',
      yaAdoptado: '2000.0000',
      hueco: '3000.0000',
      hayHueco: true,
      asientos: [
        { journal_entry_id: 'je-7', entry_number: 'JE-7', entry_date: new Date('2026-03-01'),
          description: 'Annual insurance', cargo: '3000.0000' },
      ],
    });
  });
});
