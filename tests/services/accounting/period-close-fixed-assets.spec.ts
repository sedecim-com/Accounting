import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/database/connection.js')>();
  return { ...real, query: vi.fn() };
});
// Spied, not replaced: the real report-layer query runs against the mocked
// connection (or the fake client), and the spy proves the close box reads
// it (T14 · #101, MNE-001-436).
vi.mock('../../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/reporting/report-service.js')>();
  return { ...real, queryAccumulatedBalances: vi.fn(real.queryAccumulatedBalances) };
});

import { fixedAssetBalanceWithoutRegister } from '../../../src/services/accounting/period-close.js';
import { query } from '../../../src/database/connection.js';
import { queryAccumulatedBalances } from '../../../src/services/reporting/report-service.js';
import { clienteFalso } from '../../helpers/fake-pg.js';

const mockQuery = query as unknown as Mock;
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const flat = (s: unknown) => String(s).replace(/\s+/g, ' ');

/** The two fixed-asset accounts: 1220 by its subtype, 1230 through an asset class. */
const FIXED = [{ id: 'acc-1220' }, { id: 'acc-1230' }];

function books(accounts: { id: string }[], balances: { account_id: string; balance: string }[]): void {
  mockQuery.mockImplementation(async (raw: string) => {
    const sql = flat(raw);
    if (/AS balance FROM accounts a/.test(sql)) return { rows: balances };
    if (/FROM accounts a/.test(sql) && /asset_categories/.test(sql)) return { rows: accounts };
    return { rows: [] };
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  vi.mocked(queryAccumulatedBalances).mockClear();
});

describe('the fixed-asset balance of the close box reads report-service (MNE-001-436)', () => {
  it('sums the fixed-asset accounts at the period end, closing entries included', async () => {
    books(FIXED, [
      { account_id: 'acc-1220', balance: '36000.0000' },
      { account_id: 'acc-1230', balance: '4500.0000' },
    ]);

    // By hand: 36 000 + 4 500.
    expect(await fixedAssetBalanceWithoutRegister(ENTITY, '2026-01-31')).toBe('40500.00');
    expect(queryAccumulatedBalances).toHaveBeenCalledWith(
      ENTITY,
      { date: '2026-01-31', inclusive: true },
      { ignoreClosingPolicy: true, accountIds: ['acc-1220', 'acc-1230'] }
    );
    const lookup = mockQuery.mock.calls.map(([s]) => flat(s)).find((s) => /asset_categories/.test(s)) ?? '';
    expect(lookup).toMatch(/a\.entity_id = \$1 AND a\.account_type = 'asset'/);
    expect(lookup).toMatch(/a\.account_subtype = 'fixed_asset' OR a\.id IN \(SELECT ac\.default_asset_account_id/);
    expect(lookup).not.toMatch(/SUM\(/);
  });

  it('a balance that nets to zero is no finding', async () => {
    books(FIXED, [
      { account_id: 'acc-1220', balance: '1000.0000' },
      { account_id: 'acc-1230', balance: '-1000.0000' },
    ]);
    expect(await fixedAssetBalanceWithoutRegister(ENTITY, '2026-01-31')).toBeNull();
  });

  it('with no fixed-asset account there is nothing to sum and the ledger is not read', async () => {
    books([], []);
    expect(await fixedAssetBalanceWithoutRegister(ENTITY, '2026-01-31')).toBeNull();
    expect(queryAccumulatedBalances).not.toHaveBeenCalled();
  });

  it('inside the close both reads run on its transaction client, none on the pool', async () => {
    const f = clienteFalso([
      { cuando: /asset_categories/, responde: { rows: FIXED } },
      { cuando: /AS balance FROM accounts a/, responde: { rows: [{ account_id: 'acc-1220', balance: '900.0000' }] } },
    ]);

    expect(await fixedAssetBalanceWithoutRegister(ENTITY, '2026-01-31', f.client)).toBe('900.00');
    expect(f.consultas).toHaveLength(2);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(vi.mocked(queryAccumulatedBalances).mock.calls[0][2]).toMatchObject({ client: f.client });
  });
});
