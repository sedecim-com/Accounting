import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/database/connection.js')>();
  return { ...real, query: vi.fn(), withTransaction: vi.fn() };
});
// Spied, not replaced: the real report-layer query runs against the mocked
// connection, and the spy proves the revaluation net reads it (MNE-001-436).
// MNE-001-617: the foreign balances and the marker's net too, whose SQL
// reaches the fake transaction client below.
vi.mock('../../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/reporting/report-service.js')>();
  return {
    ...real,
    queryEntryMovementsOnAccount: vi.fn(real.queryEntryMovementsOnAccount),
    queryForeignBalancesByAccount: vi.fn(real.queryForeignBalancesByAccount),
    queryRevaluationNetByAccount: vi.fn(real.queryRevaluationNetByAccount),
  };
});

import {
  gainAndLoss,
  postedSoFar,
  revalue,
  revaluationOnAccount,
  revalueForeignBalances,
  sourcesFixedBy,
} from '../../../src/services/accounting/fx-revaluation.js';
import { query, withTransaction } from '../../../src/database/connection.js';
import {
  queryEntryMovementsOnAccount,
  queryForeignBalancesByAccount,
  queryRevaluationNetByAccount,
} from '../../../src/services/reporting/report-service.js';
import { POLICY_CATALOG } from '../../../src/services/policy/pending-catalog.js';
import { revaluationRows } from '../../../src/cli/closing-fx-command.js';

describe('MNE-001-083 · the closing revaluation arithmetic (NIF B-15)', () => {
  it('a USD 1 000 receivable born at 17.50 gains 700 at 18.20', () => {
    expect(revalue('1000', '17500', '18.2')).toEqual({ revalued: '18200.0000', difference: '700.0000' });
  });

  it('a USD 500 payable (credit balance) loses 350 at 18.20', () => {
    expect(revalue('-500', '-8750', '18.2')).toEqual({ revalued: '-9100.0000', difference: '-350.0000' });
  });

  it('rounds the revalued balance half-up to the cent, as every converted ledger line (MNE-001-862)', () => {
    expect(revalue('0.005', '0', '1').revalued).toBe('0.0100');
  });

  it('a book residue with no foreign balance left is revalued to zero', () => {
    expect(revalue('0', '0.0100', '18.2').difference).toBe('-0.0100');
  });

  it('subtracts what earlier runs of the period already posted: only what moved since is left', () => {
    // USD 1 200 in the bank at 18.20 = 21 840, book 21 000, 140 posted by run 1.
    expect(revalue('1200', '21000', '18.2', '140').difference).toBe('700.0000');
    expect(revalue('200', '3500', '18.2', '140').difference).toBe('0.0000');
  });

  it('adds up what the earlier runs posted per account and currency', () => {
    const posted = postedSoFar([
      { lines: [{ accountId: 'a', accountCode: '1150', currency: 'USD', difference: '140.0000' }] },
      { lines: [
        { accountId: 'a', accountCode: '1150', currency: 'USD', difference: '700.0000' },
        { accountId: 'a', accountCode: '1150', currency: 'EUR', difference: '-5.0000' },
      ] },
    ]);
    expect(Object.fromEntries(posted)).toEqual({
      'a|USD': { accountCode: '1150', posted: '840.0000' },
      'a|EUR': { accountCode: '1150', posted: '-5.0000' },
    });
  });

  it('whether to reverse is a panel key, reverse_on_day_one by default, with no option left without a reader', () => {
    const spec = POLICY_CATALOG.find((p) => p.key === 'fx_revaluation_reversal');
    expect(spec?.defaultValue).toBe('reverse_on_day_one');
    expect(spec?.options.map((o) => o.value)).toEqual(['reverse_on_day_one']);
    expect(spec?.defaultRationale).toMatch(/NIF B-15/);
  });

  it('adds gains and losses apart, never netted', () => {
    expect(gainAndLoss([{ difference: '700' }, { difference: '-350' }, { difference: '140' }, { difference: '0' }]))
      .toEqual({ gain: '840.0000', loss: '350.0000' });
  });

  it('prints one row per account and currency', () => {
    const rows = revaluationRows({
      periodId: 'p', periodName: 'Agosto', closingDate: '2026-08-31', reversalDate: '2026-09-01',
      rates: [], gain: '700.0000', loss: '0.0000', alreadyRun: null, sequence: 1, entry: null, reversal: null,
      lines: [{
        accountId: 'a', accountCode: '1150', currency: 'USD', foreignBalance: '1000.0000',
        bookBalance: '17500.0000', rate: '18.2', revaluedBalance: '18200.0000', alreadyPosted: '0.0000',
        difference: '700.0000',
      }],
    });
    expect(rows).toEqual([{
      account: '1150', currency: 'USD', foreign_balance: '1000.0000', book_balance: '17500.0000',
      rate: '18.2', revalued_balance: '18200.0000', already_posted: '0.0000', difference: '700.0000',
    }]);
  });
});

describe('MNE-001-112 · a supplement measures at the source the period was first revalued with', () => {
  const run = (rates: Record<string, string>) => ({
    rates: Object.fromEntries(Object.entries(rates).map(([c, source]) => [c, { rate: '18.2', source }])),
  });

  it('keeps each currency at the source an earlier run recorded for it', () => {
    const fixed = sourcesFixedBy([run({ USD: 'dof' }), run({ USD: 'banco_mexico', EUR: 'ecb' })]);
    expect(fixed('USD')).toBe('dof');
    expect(fixed('EUR')).toBe('ecb');
  });

  it('holds a new currency to the one source the earlier runs used, and leaves it to the panel otherwise', () => {
    expect(sourcesFixedBy([run({ USD: 'dof' })])('EUR')).toBe('dof');
    expect(sourcesFixedBy([run({ USD: 'dof', EUR: 'ecb' })])('GBP')).toBeUndefined();
    expect(sourcesFixedBy([])('USD')).toBeUndefined();
  });
});

describe('MNE-001-436 · the revaluation net on an account reads report-service', () => {
  const mockQuery = query as unknown as Mock;
  const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  /** One row per revaluation entry, with the window total (by hand) over all of them. */
  const entries = (total: string, ...amounts: string[]) =>
    amounts.map((amount, i) => ({ journal_entry_id: `je-${i}`, amount, total_amount: total, total_entries: amounts.length }));

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(queryEntryMovementsOnAccount).mockClear();
  });

  it('keeps the revaluation entries and their mirrors, cut at asOf', async () => {
    // By hand: the December revaluation of 1 200 alone, before its day-1 mirror.
    mockQuery.mockResolvedValueOnce({ rows: entries('1200.0000', '1200.0000') });
    expect((await revaluationOnAccount(ENTITY, 'acc-1', '2026-12-31')).toFixed(4)).toBe('1200.0000');
    expect(queryEntryMovementsOnAccount).toHaveBeenCalledWith(ENTITY, 'acc-1', {
      onlySourceTypes: ['fx_revaluation'],
      asOf: '2026-12-31',
    });
  });

  it('a revaluation and its mirror net to zero, and with no cut no asOf is sent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: entries('0.0000', '1200.0000', '-1200.0000') });
    expect((await revaluationOnAccount(ENTITY, 'acc-1')).toFixed(4)).toBe('0.0000');
    expect(queryEntryMovementsOnAccount).toHaveBeenCalledWith(ENTITY, 'acc-1', { onlySourceTypes: ['fx_revaluation'] });
  });

  it('an account with no revaluation reads zero', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect((await revaluationOnAccount(ENTITY, 'acc-1')).isZero()).toBe(true);
  });
});

describe('MNE-001-617 · the foreign balances and the marker check read report-service, on the run\'s client', () => {
  const mockQuery = query as unknown as Mock;
  const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const CTX = { tenantId: 'ten-1', entityId: ENTITY };
  const PERIOD = { id: 'per-aug', period_name: 'Agosto 2026', period_type: 'regular', status: 'open', end_date: '2026-08-31' };
  const runOf = (sequence: number, entry: string, difference: string) => ({
    sequence,
    journal_entry_id: entry,
    reversal_entry_id: `rev-${entry}`,
    lines: [{ accountId: 'acc-1150', accountCode: '1150', currency: 'USD', difference }],
    rates: { USD: { rate: '18.2000', source: 'dof' } },
  });

  /** A transaction client that answers each statement of the run by its text, and refuses any other. */
  function fakeClient(world: { prior: unknown[]; entries: string[]; nets: unknown[]; foreign: unknown[] }) {
    const seen: string[] = [];
    const q = vi.fn(async (text: string) => {
      const s = String(text);
      seen.push(s);
      if (s.includes('FROM fiscal_periods WHERE id = $1')) return { rows: [PERIOD] };
      if (s.includes('FROM fx_revaluation_runs')) return { rows: world.prior };
      if (s.includes('SELECT id FROM journal_entries')) return { rows: world.entries.map((id) => ({ id })) };
      if (s.includes('AS net')) return { rows: world.nets };
      if (s.includes('functional_currency FROM legal_entities')) return { rows: [{ functional_currency: 'MXN' }] };
      if (s.includes('AS foreign')) return { rows: world.foreign };
      throw new Error(`unexpected statement: ${s.slice(0, 80)}`);
    });
    return { client: { query: q } as unknown as import('pg').PoolClient, seen };
  }

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(queryForeignBalancesByAccount).mockClear();
    vi.mocked(queryRevaluationNetByAccount).mockClear();
  });

  function inTransaction(client: import('pg').PoolClient): void {
    vi.mocked(withTransaction).mockImplementation(async (fn) => fn(client));
  }

  it('the foreign balances are asked once, on the run\'s client; with none and no prior run, no net is asked', async () => {
    const { client, seen } = fakeClient({ prior: [], entries: [], nets: [], foreign: [] });
    inTransaction(client);
    const run = await revalueForeignBalances(CTX, 'per-aug', 'usr-1', { dryRun: true });
    expect(vi.mocked(queryForeignBalancesByAccount).mock.calls).toEqual([[ENTITY, '2026-08-31', 'MXN', client]]);
    expect(seen.filter((s) => s.includes('AS foreign'))).toHaveLength(1);
    // No entry in the ledger and none in the marker: nothing to sum.
    expect(queryRevaluationNetByAccount).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(run.lines).toEqual([]);
    expect(run.sequence).toBeNull();
  });

  it('the marker\'s net is read once on the run\'s client, and +700.0000 − 700.0000 agrees with a ledger at 0.0000', async () => {
    // By hand: run 1 revalued USD in 1150 by +700.0000, run 2 took it back
    // (−700.0000) once the balance was paid out. The marker nets 0.0000 and
    // so does the ledger over the two entries; the balance has left the
    // ledger, so there is nothing to revalue.
    const { client } = fakeClient({
      prior: [runOf(1, 'je-r1', '700.0000'), runOf(2, 'je-r2', '-700.0000')],
      entries: ['je-r1', 'je-r2'],
      nets: [{ account_id: 'acc-1150', net: '0.0000' }],
      foreign: [],
    });
    inTransaction(client);
    const run = await revalueForeignBalances(CTX, 'per-aug', 'usr-1', { dryRun: true });
    expect(vi.mocked(queryRevaluationNetByAccount).mock.calls).toEqual([[ENTITY, ['je-r1', 'je-r2'], client]]);
    expect(vi.mocked(queryForeignBalancesByAccount).mock.calls).toEqual([[ENTITY, '2026-08-31', 'MXN', client]]);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(run.lines).toEqual([]);
  });

  it('a ledger one ten-thousandth off the marker (699.9999 against 700.0000) refuses the run', async () => {
    const { client } = fakeClient({
      prior: [runOf(1, 'je-r1', '700.0000')],
      entries: ['je-r1'],
      nets: [{ account_id: 'acc-1150', net: '699.9999' }],
      foreign: [],
    });
    inTransaction(client);
    await expect(revalueForeignBalances(CTX, 'per-aug', 'usr-1', { dryRun: true })).rejects.toMatchObject({
      code: 'FX_REVALUATION_MARKER_MISMATCH',
    });
    expect(vi.mocked(queryRevaluationNetByAccount).mock.calls).toEqual([[ENTITY, ['je-r1'], client]]);
    // Refused before the balances are read.
    expect(queryForeignBalancesByAccount).not.toHaveBeenCalled();
  });
});
