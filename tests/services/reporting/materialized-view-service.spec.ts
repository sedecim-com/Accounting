import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));

import {
  REPORTING_VIEWS,
  assertKnownViews,
  refreshReportingViews,
  getReportingViewStatus,
} from '../../../src/services/reporting/materialized-view-service.js';
import { query } from '../../../src/database/connection.js';
import { ValidationError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => mockQuery.mockReset());

const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');
const params = (call: number) => mockQuery.mock.calls[call][1];

describe('assertKnownViews — a view name is never interpolated on trust', () => {
  it('accepts the two reporting views', () => {
    expect(assertKnownViews([...REPORTING_VIEWS])).toEqual([...REPORTING_VIEWS]);
  });

  it('rejects anything else, naming what is allowed', () => {
    expect(() => assertKnownViews(['pg_class'])).toThrow(ValidationError);
    expect(() => assertKnownViews(['pg_class'])).toThrow(/Known: mv_trial_balance/);
  });

  it('rejects a mixed list rather than refreshing the half it recognises', () => {
    expect(() => assertKnownViews(['mv_trial_balance', 'evil'])).toThrow(/evil/);
  });
});

describe('refreshReportingViews', () => {
  it('goes through the SECURITY DEFINER function, never a bare REFRESH', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await refreshReportingViews({ views: ['mv_trial_balance'] });
    // A direct REFRESH from the runtime role dies with "must be owner".
    expect(sql(0)).toBe('SELECT refresh_reporting_views($1, $2)');
    expect(params(0)).toEqual([['mv_trial_balance'], true]);
  });

  it('refreshes both views by default, one call each', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const results = await refreshReportingViews();
    expect(results.map((r) => r.view)).toEqual([...REPORTING_VIEWS]);
    expect(mockQuery.mock.calls).toHaveLength(2);
  });

  it('passes the concurrency choice through instead of deciding for the caller', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await refreshReportingViews({ views: ['mv_trial_balance'], concurrently: false });
    expect(params(0)).toEqual([['mv_trial_balance'], false]);
  });

  it('refuses an unknown view before touching the database', async () => {
    await expect(refreshReportingViews({ views: ['mv_trial_balance; DROP TABLE accounts'] }))
      .rejects.toThrow(ValidationError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('treats an empty list as "all", not as "none"', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const results = await refreshReportingViews({ views: [] });
    expect(results).toHaveLength(REPORTING_VIEWS.length);
  });
});

describe('getReportingViewStatus — staleness has to be visible', () => {
  /** The live trial balance the status compares against. */
  const ledgerRows = [
    { account_id: 'a', account_code: '1', account_name: 'x', account_type: 'asset',
      debit_total: '100.0000', credit_total: '100.0000', ending_balance: '0.0000' },
  ];

  it('flags a view that no longer agrees with the ledger, and by how much', async () => {
    mockQuery.mockResolvedValueOnce({ rows: ledgerRows });
    mockQuery.mockResolvedValueOnce({ rows: [{ rows: '10', debits: '800.0000', credits: '800.0000' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ rows: '5', debits: '100.0000', credits: '100.0000' }] });

    const statuses = await getReportingViewStatus(ENTITY);
    expect(statuses[0]).toMatchObject({
      view: 'mv_trial_balance',
      view_debits: '800.0000',
      ledger_debits: '100.0000',
      drift_debits: '700.0000',
      is_stale: true,
    });
    expect(statuses[1].is_stale).toBe(false);
  });

  it('does not call a one-cent rounding difference staleness', async () => {
    mockQuery.mockResolvedValueOnce({ rows: ledgerRows });
    mockQuery.mockResolvedValueOnce({ rows: [{ rows: '10', debits: '100.0100', credits: '100.0000' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ rows: '5', debits: '100.0000', credits: '100.0000' }] });
    expect((await getReportingViewStatus(ENTITY))[0].is_stale).toBe(false);
  });

  it('scopes every view query to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: ledgerRows });
    mockQuery.mockResolvedValue({ rows: [{ rows: '0', debits: '0', credits: '0' }] });
    await getReportingViewStatus(ENTITY);
    expect(sql(1)).toMatch(/FROM mv_trial_balance WHERE entity_id = \$1/);
    expect(sql(2)).toMatch(/FROM mv_account_balance_summary WHERE entity_id = \$1/);
    expect(params(1)).toEqual([ENTITY]);
    expect(params(2)).toEqual([ENTITY]);
  });

  it('reports every amount as a string at the ledger scale', async () => {
    mockQuery.mockResolvedValueOnce({ rows: ledgerRows });
    mockQuery.mockResolvedValue({ rows: [{ rows: '0', debits: '0', credits: '0' }] });
    const [first] = await getReportingViewStatus(ENTITY);
    expect(first.view_debits).toBe('0.0000');
    expect(typeof first.drift_credits).toBe('string');
  });
});
