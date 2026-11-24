import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const client = { query: vi.fn() };

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn(client)),
  currentTenant: vi.fn(() => 'tenant-1'),
}));

import {
  listFiscalPeriods,
  resolvePeriod,
  getPeriodDetail,
  openPeriod,
  listFiscalYears,
  getFiscalYear,
  ensureFiscalYear,
  createFiscalYear,
  carryForwardIntoYear,
} from '../../../src/services/accounting/fiscal-calendar-service.js';
import { query } from '../../../src/database/connection.js';
import { NotFoundError, ValidationError, ConflictError, AccountingError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PERIOD = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER = 'user-1';

beforeEach(() => {
  mockQuery.mockReset();
  client.query.mockReset();
});

const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');
const params = (call: number) => mockQuery.mock.calls[call][1];
const txSql = (call: number) => String(client.query.mock.calls[call][0]).replace(/\s+/g, ' ');
const txParams = (call: number) => client.query.mock.calls[call][1];

describe('listFiscalPeriods', () => {
  it('reads only the table’s own columns by default — the REST response must not grow', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listFiscalPeriods(ENTITY);
    expect(sql(0)).toBe('SELECT * FROM fiscal_periods fp WHERE fp.entity_id = $1 ORDER BY fp.start_date');
    expect(params(0)).toEqual([ENTITY]);
  });

  it('keeps the REST handler’s two filters in their original order', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listFiscalPeriods(ENTITY, { fiscalYearId: 'fy1', status: 'open' });
    expect(sql(0)).toMatch(/fp\.entity_id = \$1 AND fp\.fiscal_year_id = \$2 AND fp\.status = \$3/);
    expect(params(0)).toEqual([ENTITY, 'fy1', 'open']);
  });

  it('adds the year and the overdue flag only when the caller asks', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listFiscalPeriods(ENTITY, {}, { includeYear: true });
    expect(sql(0)).toMatch(/JOIN fiscal_years fy ON fy\.id = fp\.fiscal_year_id/);
    expect(sql(0)).toMatch(/\(fp\.end_date < CURRENT_DATE\) AS overdue/);
  });

  it('filters several states at once', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listFiscalPeriods(ENTITY, { status: ['open', 'soft_close'] });
    expect(sql(0)).toMatch(/fp\.status = ANY\(\$2\)/);
    expect(params(0)[1]).toEqual(['open', 'soft_close']);
  });

  it('resolves a year number through fiscal_years, still inside the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listFiscalPeriods(ENTITY, { yearNumber: 2026 });
    expect(sql(0)).toMatch(
      /fp\.fiscal_year_id IN \(SELECT id FROM fiscal_years WHERE entity_id = fp\.entity_id AND year_number = \$2\)/
    );
  });
});

describe('resolvePeriod — one period, or a refusal', () => {
  it('takes a uuid', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: PERIOD }] });
    await resolvePeriod(ENTITY, PERIOD);
    expect(sql(0)).toMatch(/WHERE fp\.id = \$1 AND fp\.entity_id = \$2/);
  });

  it('takes YYYY-MM and matches on the period start', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: PERIOD }] });
    await resolvePeriod(ENTITY, '2026-08');
    expect(sql(0)).toMatch(/EXTRACT\(YEAR FROM fp\.start_date\) = \$2/);
    expect(params(0)).toEqual([ENTITY, 2026, 8]);
  });

  it('takes part of the name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: PERIOD, period_name: 'August 2026' }] });
    const period = await resolvePeriod(ENTITY, 'august');
    expect(params(0)[1]).toBe('%august%');
    expect(period.id).toBe(PERIOD);
  });

  it('refuses an ambiguous name instead of picking one', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ period_name: 'January 2026' }, { period_name: 'January 2027' }],
    });
    await expect(resolvePeriod(ENTITY, 'january')).rejects.toThrow(
      /matches 2 periods: January 2026, January 2027/
    );
  });

  it('throws NotFound when nothing matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolvePeriod(ENTITY, 'brumario')).rejects.toThrow(NotFoundError);
  });

  const december = {
    rows: [
      { id: 'p12', period_name: 'December 2026' },
      { id: 'p13', period_name: 'Year-end adjustments 2026' },
    ],
  };

  it('YYYY-MM names the regular month when December and period 13 share it', async () => {
    mockQuery.mockResolvedValueOnce(december);
    expect((await resolvePeriod(ENTITY, '2026-12')).id).toBe('p12');
  });

  it('with refuseSharedMonth, a YYYY-MM two periods share is refused with both ids', async () => {
    mockQuery.mockResolvedValueOnce(december);
    const err = await resolvePeriod(ENTITY, '2026-12', { refuseSharedMonth: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(String(err)).toMatch(/matches 2 periods: December 2026 \(p12\), Year-end adjustments 2026 \(p13\)/);
  });
});

describe('getPeriodDetail', () => {
  const period = {
    id: PERIOD, period_name: 'January 2026', status: 'soft_close', closed_by: USER,
  };

  it('counts the period’s entries by state and names who closed it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [period] });
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'posted', count: '12' }, { status: 'draft', count: '3' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ email: 'ana@despacho.mx' }] });

    const detail = await getPeriodDetail(ENTITY, 'January');
    expect(detail.entry_counts).toEqual({ posted: 12, draft: 3 });
    expect(detail.entry_count).toBe(15);
    expect(detail.closed_by_email).toBe('ana@despacho.mx');
    expect(sql(1)).toMatch(/WHERE fiscal_period_id = \$1 AND entity_id = \$2 GROUP BY status/);
  });

  it('does not look up a closer when nobody closed it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...period, closed_by: null, status: 'open' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const detail = await getPeriodDetail(ENTITY, 'January');
    expect(detail.closed_by_email).toBeNull();
    expect(mockQuery.mock.calls).toHaveLength(2);
  });
});

describe('openPeriod — the transition that had no driver', () => {
  it('opens a future period and records the reason in the audit trail', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ id: PERIOD, status: 'future', period_name: 'March 2026' }] });
    client.query.mockResolvedValueOnce({ rows: [{ id: PERIOD, status: 'open' }] });
    client.query.mockResolvedValueOnce({ rows: [] });

    const opened = await openPeriod(ENTITY, PERIOD, USER, 'capturing March in advance');

    expect(opened.status).toBe('open');
    // Locked while it is read, so two callers cannot both see 'future'.
    expect(txSql(0)).toMatch(/FOR UPDATE/);
    expect(txSql(1)).toMatch(/SET status = 'open'.*WHERE id = \$1 AND entity_id = \$2 AND status = 'future'/);
    expect(txSql(2)).toMatch(/INSERT INTO audit_log/);
    expect(txParams(2)).toContain('capturing March in advance');
    expect(txParams(2)).toContain(USER);
  });

  it('refuses a period that is already open', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ id: PERIOD, status: 'open', period_name: 'March 2026' }] });
    await expect(openPeriod(ENTITY, PERIOD, USER)).rejects.toThrow(
      expect.objectContaining({ code: 'PERIOD_ALREADY_OPEN' })
    );
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('refuses to reopen a closed period through this door', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ id: PERIOD, status: 'hard_close', period_name: 'March 2026' }] });
    await expect(openPeriod(ENTITY, PERIOD, USER)).rejects.toThrow(
      expect.objectContaining({ code: 'PERIOD_NOT_FUTURE' })
    );
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('throws NotFound for a period of another entity', async () => {
    client.query.mockResolvedValueOnce({ rows: [] });
    await expect(openPeriod(ENTITY, PERIOD, USER)).rejects.toThrow(NotFoundError);
  });
});

describe('fiscal years', () => {
  it('lists years newest first with their close progress', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listFiscalYears(ENTITY);
    expect(sql(0)).toMatch(/ORDER BY fy\.year_number DESC/);
    expect(sql(0)).toMatch(/p\.status IN \('hard_close', 'locked'\)\)::int AS closed_period_count/);
  });

  it('reads a year with its periods', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'fy1', year_number: 2026 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: PERIOD }] });
    const result = await getFiscalYear(ENTITY, 2026);
    expect(result.periods).toHaveLength(1);
    expect(params(1)).toEqual([ENTITY, 'fy1']);
  });

  it('throws NotFound for a year the entity does not have', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getFiscalYear(ENTITY, 1999)).rejects.toThrow(NotFoundError);
  });
});

describe('ensureFiscalYear — the calendar, extracted from the wizard', () => {
  it('is idempotent: an existing year is reported, never duplicated', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'fy1', n: '12' }] });
    const result = await ensureFiscalYear(ENTITY, 2026);
    expect(result).toEqual({ created: false, fiscalYearId: 'fy1', yearNumber: 2026, periods: 12 });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('creates the year, its twelve monthly periods and the year-end adjustment period', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValue({ rows: [{ id: 'fy1' }] });

    const result = await ensureFiscalYear(ENTITY, 2026, new Date('2026-08-25T12:00:00Z'));

    expect(result).toMatchObject({ created: true, fiscalYearId: 'fy1', yearNumber: 2026, periods: 13 });
    expect(txSql(0)).toMatch(/INSERT INTO fiscal_years/);
    expect(txParams(0)).toEqual([ENTITY, 2026, '2026-01-01', '2026-12-31']);
    // The year, its thirteen periods, and the look at the period before it (#594).
    expect(client.query).toHaveBeenCalledTimes(15);
    // Period 3 of 2026: March, named in English, with its real month end.
    expect(txParams(3).slice(2, 7)).toEqual([3, 'March 2026', '2026-03-01', '2026-03-31', 'open']);
  });

  it('period 13 is the adjustment period on the last day of the year, where the closing balance looks for it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValue({ rows: [{ id: 'fy1' }] });

    await ensureFiscalYear(ENTITY, 2026, new Date('2026-08-25T12:00:00Z'));

    // Without it, `e-accounting balance generate --closing` refuses for every
    // entity: it reads period_number 13 of type 'adjustment' or 'closing'.
    expect(txSql(13)).toMatch(/INSERT INTO fiscal_periods .*'adjustment'/);
    expect(txParams(13)).toEqual([
      ENTITY, 'fy1', 13, 'Year-end adjustments 2026', '2026-12-31', '2026-12-31', 'future',
    ]);
  });

  it('opens the months already lived and leaves the rest future', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValue({ rows: [{ id: 'fy1' }] });

    await ensureFiscalYear(ENTITY, 2026, new Date('2026-08-25T12:00:00Z'));

    const statuses = client.query.mock.calls.slice(1, 14).map((call) => call[1][6]);
    expect(statuses).toEqual([
      'open', 'open', 'open', 'open', 'open', 'open', 'open', // Jan–Jul: past
      'open', // August: the month we are in
      'future', 'future', 'future', 'future',
      'future', // period 13 follows December
    ]);
  });

  it('does not open a random month of a future year (the wizard’s bug, fixed by extraction)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValue({ rows: [{ id: 'fy2' }] });

    await ensureFiscalYear(ENTITY, 2027, new Date('2026-08-25T12:00:00Z'));

    const statuses = client.query.mock.calls.slice(1, 14).map((call) => call[1][6]);
    expect(statuses.every((s) => s === 'future')).toBe(true);
  });

  it('opens every month of a year that is already over', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValue({ rows: [{ id: 'fy0' }] });

    await ensureFiscalYear(ENTITY, 2025, new Date('2026-08-25T12:00:00Z'));

    const statuses = client.query.mock.calls.slice(1, 14).map((call) => call[1][6]);
    expect(statuses.every((s) => s === 'open')).toBe(true);
  });
});

describe('ensureFiscalYear — a year born after its predecessor was sealed opens with its balances (#594)', () => {
  /** The thirteen-period calendar, then whatever the period before the year answers. */
  function born(previous: Array<{ id: string; period_name: string; status: string }>) {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    client.query.mockImplementation(async (text: string) => {
      if (/FOR SHARE OF fp/.test(text)) return { rows: previous };
      if (/INSERT INTO account_balances/.test(text)) return { rows: [], rowCount: 3 };
      if (/closed\.start_date/.test(text)) return { rows: [{ id: 'jan', period_name: 'January 2028', status: 'open' }] };
      return { rows: [{ id: 'fy1' }] };
    });
    return ensureFiscalYear(ENTITY, 2028, new Date('2029-02-01T12:00:00Z'));
  }
  const P13 = { id: 'p13', period_name: 'Year-end adjustments 2027' };

  it.each(['hard_close', 'locked'])('carries from the period before it when that one is %s', async (status) => {
    const result = await born([{ ...P13, status }]);

    expect(result.opening).toEqual({
      previous: { period_name: 'Year-end adjustments 2027', status },
      carry: { carried: 3, periods: ['January 2028'], stopped_at_locked: null },
    });
    // The look at the previous period: once, after the calendar, inside the
    // transaction, bounded by the entity and locked against a hard close in flight.
    expect(txSql(14)).toMatch(/FROM fiscal_periods fp WHERE fp\.entity_id = \$1 .*FOR SHARE OF fp/);
    expect(txParams(14)).toEqual([ENTITY, 'fy1']);
    // One set-based carry out of that period, whatever the size of the chart.
    expect(client.query).toHaveBeenCalledTimes(17);
    expect(txSql(16)).toMatch(/INSERT INTO account_balances/);
    expect(txParams(16)).toEqual([ENTITY, 'p13', 'jan']);
  });

  it.each(['open', 'soft_close', 'future'])('carries nothing when it is %s: its own hard close will', async (status) => {
    const result = await born([{ ...P13, status }]);

    expect(result.opening).toEqual({ previous: { period_name: 'Year-end adjustments 2027', status }, carry: null });
    expect(client.query).toHaveBeenCalledTimes(15);
  });

  it('carries nothing for the first year of an entity', async () => {
    const result = await born([]);

    expect(result.opening).toEqual({ previous: null, carry: null });
    expect(client.query).toHaveBeenCalledTimes(15);
  });
});

describe('createFiscalYear — the same calendar, but existing is a conflict', () => {
  it('refuses a year that already exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'fy1', n: '12' }] });
    await expect(createFiscalYear(ENTITY, 2026)).rejects.toThrow(ConflictError);
  });

  it('refuses something that is not a four-digit year, before touching the database', async () => {
    await expect(createFiscalYear(ENTITY, 26)).rejects.toThrow(ValidationError);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('carryForwardIntoYear — a year created without opening balances is repaired by the same carry (#594)', () => {
  const JANUARY = { fiscal_year_id: 'fy28', id: 'jan', period_name: 'January 2028', status: 'open' };
  const P13 = { id: 'p13', period_name: 'Year-end adjustments 2027', status: 'hard_close' };
  const ZERO = [{ code: '1111', beginning: '0.0000' }];
  const CARRIED = [{ code: '1111', beginning: '10000.0000' }, { code: '3300', beginning: '-10000.0000' }];

  /** The books: the year's first period, the period before it, and the two readings of its beginnings. */
  function books(over: {
    first?: Array<typeof JANUARY>; previous?: Array<typeof P13>; before?: typeof ZERO; after?: typeof ZERO;
  } = {}) {
    const first = over.first ?? [JANUARY];
    const readings = [over.before ?? ZERO, over.after ?? CARRIED];
    // The cascade: the year's first period, then February, which is open.
    const next = [
      { id: 'jan', period_name: 'January 2028', status: first[0]?.status },
      { id: 'feb', period_name: 'February 2028', status: 'open' },
    ];
    client.query.mockImplementation(async (text: string) => {
      if (/FOR UPDATE OF fp/.test(text)) return { rows: first };
      if (/FOR SHARE OF fp/.test(text)) return { rows: over.previous ?? [P13] };
      if (/SELECT a\.code, ab\.beginning_balance/.test(text)) return { rows: readings.shift() };
      if (/closed\.start_date/.test(text)) return { rows: [next.shift()] };
      if (/INSERT INTO account_balances/.test(text)) return { rows: [], rowCount: 2 };
      return { rows: [] };
    });
  }
  const statements = () => client.query.mock.calls.map((call) => String(call[0]).replace(/\s+/g, ' '));
  const audits = () => statements().filter((text) => /INSERT INTO audit_log/.test(text));

  it('corrects in seven statements, none per account, and leaves its audit row', async () => {
    books();
    const result = await carryForwardIntoYear(ENTITY, 2028, USER);

    expect(result).toEqual({
      year_number: 2028,
      period: { id: 'jan', period_name: 'January 2028', status: 'open' },
      carried_from: 'Year-end adjustments 2027',
      corrections: [
        { code: '1111', before: '0.0000', after: '10000.0000' },
        { code: '3300', before: '0.0000', after: '-10000.0000' },
      ],
      written: true,
    });
    const ran = statements();
    expect(ran).toHaveLength(7);
    // The year's first period, by entity and year, locked against its own hard close and a second repair.
    expect(ran[0]).toMatch(/FROM fiscal_years fy JOIN fiscal_periods fp .*fy\.entity_id = \$1 AND fy\.year_number = \$2 .*LIMIT 1 FOR UPDATE OF fp/);
    expect(txParams(0)).toEqual([ENTITY, 2028]);
    // The same reading before and after the carry, bounded by period and entity.
    expect(ran[1]).toBe(ran[5]);
    expect(ran[1]).toMatch(/WHERE ab\.fiscal_period_id = \$2 AND ab\.entity_id = \$1/);
    expect(txParams(1)).toEqual([ENTITY, 'jan']);
    // The carry is the one `year create` runs: its lookup with its lock, then one set-based statement.
    expect(ran[2]).toMatch(/FOR SHARE OF fp/);
    expect(txParams(2)).toEqual([ENTITY, 'fy28']);
    expect(ran[4]).toMatch(/INSERT INTO account_balances/);
    expect(txParams(4)).toEqual([ENTITY, 'p13', 'jan']);
    expect(ran[6]).toMatch(/INSERT INTO audit_log/);
    const audit = txParams(6) as unknown[];
    expect(audit.slice(1, 7)).toEqual([USER, 'tenant-1', ENTITY, 'update', 'fiscal_period', 'jan']);
    expect(JSON.parse(audit[7] as string)).toEqual({ beginning_balances: { '1111': '0.0000', '3300': '0.0000' } });
    expect(JSON.parse(audit[8] as string)).toEqual({
      beginning_balances: { '1111': '10000.0000', '3300': '-10000.0000' },
      carried_from: 'Year-end adjustments 2027',
      fiscal_year: 2028,
    });
  });

  it('a second run finds the balances right: it reports no corrections, rolls back and writes no audit row', async () => {
    books({ before: CARRIED, after: CARRIED });
    const result = await carryForwardIntoYear(ENTITY, 2028, USER);

    expect(result).toMatchObject({ corrections: [], written: false });
    expect(statements()).toHaveLength(6);
    expect(audits()).toEqual([]);
  });

  it('a dry run is the same run, rolled back: the corrections, and no audit row', async () => {
    books();
    const result = await carryForwardIntoYear(ENTITY, 2028, USER, { dryRun: true });

    expect(result.corrections).toHaveLength(2);
    expect(result.written).toBe(false);
    expect(statements()).toHaveLength(6);
    expect(audits()).toEqual([]);
  });

  it.each(['open', 'soft_close', 'future'])('refuses when the period before the year is %s, naming it', async (status) => {
    books({ previous: [{ ...P13, status }] });
    const err = await carryForwardIntoYear(ENTITY, 2028, USER).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AccountingError);
    expect(err).toMatchObject({
      code: 'CARRY_SOURCE_NOT_SEALED',
      messageKey: {
        key: 'error.CARRY_SOURCE_NOT_SEALED',
        params: { previous: 'Year-end adjustments 2027', status, year: 2028, period: 'January 2028' },
      },
    });
    expect(statements()).toHaveLength(3);
    expect(audits()).toEqual([]);
  });

  it('refuses the first year of the books: nothing comes before it', async () => {
    books({ previous: [] });
    const err = await carryForwardIntoYear(ENTITY, 2028, USER).catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: 'CARRY_SOURCE_MISSING',
      messageKey: { key: 'error.CARRY_SOURCE_MISSING', params: { year: 2028, period: 'January 2028' } },
    });
    expect(audits()).toEqual([]);
  });

  it('refuses a locked first period at once: the carry never writes one', async () => {
    books({ first: [{ ...JANUARY, status: 'locked' }] });
    const err = await carryForwardIntoYear(ENTITY, 2028, USER).catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: 'CARRY_TARGET_SEALED',
      messageKey: { key: 'error.CARRY_TARGET_SEALED.locked', params: { period: 'January 2028' } },
    });
    expect(statements()).toHaveLength(1);
  });

  it('refuses a hard-closed first period whose openings differ, with the count, on a dry run too', async () => {
    for (const dryRun of [false, true]) {
      client.query.mockReset();
      books({ first: [{ ...JANUARY, status: 'hard_close' }] });
      const err = await carryForwardIntoYear(ENTITY, 2028, USER, { dryRun }).catch((e: unknown) => e);

      expect(err).toMatchObject({
        code: 'CARRY_TARGET_SEALED',
        messageKey: {
          key: 'error.CARRY_TARGET_SEALED.hard_close',
          params: { period: 'January 2028', previous: 'Year-end adjustments 2027', count: 2 },
        },
      });
      expect(audits()).toEqual([]);
    }
  });

  it('a hard-closed first period whose openings are right is not a refusal: there is nothing to correct', async () => {
    books({ first: [{ ...JANUARY, status: 'hard_close' }], before: CARRIED, after: CARRIED });
    const result = await carryForwardIntoYear(ENTITY, 2028, USER);

    expect(result).toMatchObject({ period: { status: 'hard_close' }, corrections: [], written: false });
    expect(audits()).toEqual([]);
  });

  it('a year that does not exist is not found, after one statement', async () => {
    books({ first: [] });
    await expect(carryForwardIntoYear(ENTITY, 2031, USER)).rejects.toThrow(NotFoundError);
    expect(statements()).toHaveLength(1);
  });
});
