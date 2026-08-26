import { describe, it, expect, vi, beforeEach } from 'vitest';

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
} from '../../../src/services/accounting/fiscal-calendar-service.js';
import { query } from '../../../src/database/connection.js';
import { NotFoundError, ValidationError, ConflictError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
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

  it('creates the year and twelve monthly periods', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValue({ rows: [{ id: 'fy1' }] });

    const result = await ensureFiscalYear(ENTITY, 2026, new Date('2026-08-25T12:00:00Z'));

    expect(result).toEqual({ created: true, fiscalYearId: 'fy1', yearNumber: 2026, periods: 12 });
    expect(txSql(0)).toMatch(/INSERT INTO fiscal_years/);
    expect(txParams(0)).toEqual([ENTITY, 2026, '2026-01-01', '2026-12-31']);
    expect(client.query).toHaveBeenCalledTimes(13);
    // Period 3 of 2026: March, named in English, with its real month end.
    expect(txParams(3).slice(2, 7)).toEqual([3, 'March 2026', '2026-03-01', '2026-03-31', 'open']);
  });

  it('opens the months already lived and leaves the rest future', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValue({ rows: [{ id: 'fy1' }] });

    await ensureFiscalYear(ENTITY, 2026, new Date('2026-08-25T12:00:00Z'));

    const statuses = client.query.mock.calls.slice(1).map((call) => call[1][6]);
    expect(statuses).toEqual([
      'open', 'open', 'open', 'open', 'open', 'open', 'open', // Jan–Jul: past
      'open', // August: the month we are in
      'future', 'future', 'future', 'future',
    ]);
  });

  it('does not open a random month of a future year (the wizard’s bug, fixed by extraction)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValue({ rows: [{ id: 'fy2' }] });

    await ensureFiscalYear(ENTITY, 2027, new Date('2026-08-25T12:00:00Z'));

    const statuses = client.query.mock.calls.slice(1).map((call) => call[1][6]);
    expect(statuses.every((s) => s === 'future')).toBe(true);
  });

  it('opens every month of a year that is already over', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValue({ rows: [{ id: 'fy0' }] });

    await ensureFiscalYear(ENTITY, 2025, new Date('2026-08-25T12:00:00Z'));

    const statuses = client.query.mock.calls.slice(1).map((call) => call[1][6]);
    expect(statuses.every((s) => s === 'open')).toBe(true);
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
