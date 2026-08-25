import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(), enterTenant: vi.fn(), currentTenant: vi.fn(),
}));

import {
  parseCronField, parseCronSchedule, cronMatches, nextRunAt,
  createJob, listJobs, setEnabled, claimDueJobs, recordRun, listRuns,
  type JobRow,
} from '../../../src/ai/jobs/job-store.js';
import { query } from '../../../src/database/connection.js';
import type { AgentContext } from '../../../src/ai/context.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

const CTX: AgentContext = {
  entityId: 'entity-1', entityName: 'Acme', tenantId: 'tenant-a',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AME010101AAA',
};

const JOB: JobRow = {
  id: 'job-1', entity_id: 'entity-1', name: 'nightly-close', kind: 'close_verification',
  schedule: '0 2 * * *', enabled: true, consecutive_failures: 0, max_failures: 3,
  last_run_at: null, next_run_at: new Date('2026-08-25T02:00:00'), created_by: 'ops@acme.mx',
  created_at: new Date('2026-08-01T00:00:00'),
};

beforeEach(() => {
  mockQuery.mockReset();
});

// ─── Cron matcher ───

describe('parseCronField', () => {
  it('parses * as wildcard', () => {
    expect(parseCronField('*', 0, 59, 'minute').values).toBeNull();
  });

  it('parses a plain number', () => {
    expect([...parseCronField('15', 0, 59, 'minute').values!]).toEqual([15]);
  });

  it('parses comma lists', () => {
    expect([...parseCronField('1,15,30', 0, 59, 'minute').values!].sort((a, b) => a - b)).toEqual([1, 15, 30]);
  });

  it('parses */n steps from the field minimum', () => {
    expect([...parseCronField('*/15', 0, 59, 'minute').values!].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...parseCronField('*/5', 1, 12, 'month').values!].sort((a, b) => a - b)).toEqual([1, 6, 11]);
  });

  it('mixes steps and numbers in one list', () => {
    expect([...parseCronField('*/30,7', 0, 59, 'minute').values!].sort((a, b) => a - b)).toEqual([0, 7, 30]);
  });

  it('maps day-of-week 7 to Sunday (0)', () => {
    expect([...parseCronField('7', 0, 7, 'day-of-week').values!]).toEqual([0]);
  });

  it('rejects out-of-range values, ranges and garbage', () => {
    expect(() => parseCronField('60', 0, 59, 'minute')).toThrow(/outside 0-59/);
    expect(() => parseCronField('1-5', 0, 59, 'minute')).toThrow(/only \*/);
    expect(() => parseCronField('mon', 0, 7, 'day-of-week')).toThrow(/only \*/);
    expect(() => parseCronField('*/0', 0, 59, 'minute')).toThrow(/step must be positive/);
  });
});

describe('parseCronSchedule', () => {
  it('requires exactly 5 fields', () => {
    expect(() => parseCronSchedule('0 2 * *')).toThrow(/expected 5 fields/);
    expect(() => parseCronSchedule('0 2 * * * *')).toThrow(/expected 5 fields/);
  });
});

describe('cronMatches', () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);

  it('matches nightly "0 2 * * *" only at 02:00', () => {
    const s = parseCronSchedule('0 2 * * *');
    expect(cronMatches(s, at(2026, 8, 24, 2, 0))).toBe(true);
    expect(cronMatches(s, at(2026, 8, 24, 2, 1))).toBe(false);
    expect(cronMatches(s, at(2026, 8, 24, 3, 0))).toBe(false);
  });

  it('matches month and day-of-month restrictions', () => {
    const s = parseCronSchedule('0 0 1 1 *'); // Jan 1st, midnight
    expect(cronMatches(s, at(2027, 1, 1, 0, 0))).toBe(true);
    expect(cronMatches(s, at(2027, 2, 1, 0, 0))).toBe(false);
  });

  it('matches day-of-week only (dom wildcard)', () => {
    const s = parseCronSchedule('0 9 * * 1'); // Mondays 09:00
    expect(cronMatches(s, at(2026, 8, 24, 9, 0))).toBe(true); // 2026-08-24 is a Monday
    expect(cronMatches(s, at(2026, 8, 25, 9, 0))).toBe(false);
  });

  it('ORs dom and dow when both are restricted (standard cron)', () => {
    const s = parseCronSchedule('0 0 15 * 1'); // the 15th OR any Monday
    expect(cronMatches(s, at(2026, 8, 15, 0, 0))).toBe(true); // 15th (a Saturday)
    expect(cronMatches(s, at(2026, 8, 24, 0, 0))).toBe(true); // a Monday, not the 15th
    expect(cronMatches(s, at(2026, 8, 25, 0, 0))).toBe(false); // neither
  });
});

describe('nextRunAt', () => {
  it('finds the next match strictly after `from`', () => {
    const next = nextRunAt('0 2 * * *', new Date(2026, 7, 24, 2, 0)); // exactly 02:00
    expect(next).toEqual(new Date(2026, 7, 25, 2, 0)); // strictly after → next day
  });

  it('handles */n minute steps', () => {
    const next = nextRunAt('*/15 * * * *', new Date(2026, 7, 24, 10, 3));
    expect(next).toEqual(new Date(2026, 7, 24, 10, 15));
  });
});

// ─── Store ───

describe('createJob', () => {
  it('validates the cron, seeds next_run_at and scopes the INSERT to tenant + entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [JOB], rowCount: 1 });
    await createJob(CTX, { name: 'nightly-close', kind: 'close_verification', schedule: '0 2 * * *', createdBy: 'ops@acme.mx' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_jobs/);
    expect(params[1]).toBe('tenant-a');
    expect(params[2]).toBe('entity-1');
    expect(params[4]).toBe('close_verification');
    expect(params[7]).toBeInstanceOf(Date); // next_run_at computed up front
  });

  it('rejects an invalid cron BEFORE touching the database', async () => {
    await expect(createJob(CTX, { name: 'x', kind: 'ar_reminders', schedule: 'not a cron' })).rejects.toThrow(/expected 5 fields/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind', async () => {
    await expect(
      createJob(CTX, { name: 'x', kind: 'delete_ledger' as never, schedule: '0 2 * * *' })
    ).rejects.toThrow(/Unknown job kind/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('listJobs', () => {
  it('scopes to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [JOB] });
    await listJobs(CTX);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM ai_jobs WHERE entity_id = \$1/);
    expect(params).toEqual(['entity-1']);
  });
});

describe('setEnabled', () => {
  it('enabling resets the failure counter and recomputes next_run_at', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...JOB, enabled: false, consecutive_failures: 3 }] }); // getJob
    mockQuery.mockResolvedValueOnce({ rows: [{ ...JOB, enabled: true }], rowCount: 1 });
    await setEnabled(CTX, 'job-1', true);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toMatch(/UPDATE ai_jobs/);
    expect(sql).toMatch(/consecutive_failures = CASE WHEN \$1 THEN 0 ELSE consecutive_failures END/);
    expect(params[0]).toBe(true);
    expect(params[1]).toBeInstanceOf(Date); // recomputed, not the stale one
    expect(params[2]).toBe('job-1');
    expect(params[3]).toBe('entity-1');
  });

  it('throws when the guarded UPDATE hits no row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [JOB] });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(setEnabled(CTX, 'job-1', false)).rejects.toThrow(/does not exist/);
  });
});

describe('claimDueJobs', () => {
  const DUE_AT = new Date('2026-08-24T02:00:00');

  it('claims each due job with a guarded UPDATE (due + enabled + expected-value predicates, RETURNING)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'job-1', schedule: '0 2 * * *', next_run_at: DUE_AT }] });
    mockQuery.mockResolvedValueOnce({ rows: [JOB], rowCount: 1 });
    const claimed = await claimDueJobs(CTX, new Date(2026, 7, 24, 2, 0));
    expect(claimed).toEqual([JOB]);

    const [selectSql, selectParams] = mockQuery.mock.calls[0];
    expect(selectSql).toMatch(/enabled = true AND next_run_at <= NOW\(\)/);
    expect(selectParams).toEqual(['entity-1']);

    const [updateSql, updateParams] = mockQuery.mock.calls[1];
    expect(updateSql).toMatch(/UPDATE ai_jobs/);
    expect(updateSql).toMatch(/SET last_run_at = NOW\(\)/);
    // DB-clock clamp: the replacement next_run_at can never land in the DB's
    // past even when this process's clock trails the database's.
    expect(updateSql).toMatch(
      /next_run_at = GREATEST\(\$1::timestamptz, date_trunc\('minute', NOW\(\)\) \+ interval '1 minute'\)/
    );
    // Guards: still due, still enabled, AND claim-by-expected-value.
    expect(updateSql).toMatch(/WHERE id = \$2 AND entity_id = \$3 AND enabled = true/);
    expect(updateSql).toMatch(/AND next_run_at <= NOW\(\) AND next_run_at = \$4/);
    expect(updateSql).toMatch(/RETURNING/);
    expect(updateParams[0]).toEqual(new Date(2026, 7, 25, 2, 0)); // next occurrence
    expect(updateParams[1]).toBe('job-1');
    expect(updateParams[2]).toBe('entity-1');
    expect(updateParams[3]).toEqual(DUE_AT); // the exact value this runner read
  });

  it('a job claimed by a concurrent runner (rowCount 0) is NOT returned', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'job-1', schedule: '0 2 * * *', next_run_at: DUE_AT },
        { id: 'job-2', schedule: '0 3 * * *', next_run_at: DUE_AT },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // job-1 stolen
    mockQuery.mockResolvedValueOnce({ rows: [{ ...JOB, id: 'job-2' }], rowCount: 1 });
    const claimed = await claimDueJobs(CTX);
    expect(claimed.map((j) => j.id)).toEqual(['job-2']);
  });

  it('skips (and does not crash on) a job with an unparseable schedule', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'job-1', schedule: 'garbage' }] });
    const claimed = await claimDueJobs(CTX);
    expect(claimed).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1); // no UPDATE attempted
  });
});

describe('recordRun', () => {
  it('inserts the run scoped to tenant + entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // reset counter
    await recordRun(CTX, 'job-1', {
      status: 'ok', startedAt: new Date(), detail: { gate: { x: 1 } }, draftsCreated: 2,
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_job_runs/);
    expect(params[2]).toBe('tenant-a');
    expect(params[3]).toBe('entity-1');
    expect(params[6]).toBe('ok');
    expect(params[8]).toBe(2);
  });

  it('success resets consecutive_failures', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const r = await recordRun(CTX, 'job-1', { status: 'ok', startedAt: new Date() });
    expect(r.autoDisabled).toBe(false);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toMatch(/SET consecutive_failures = 0/);
    expect(params).toEqual(['job-1', 'entity-1']);
  });

  it('skipped_no_work touches NOTHING: no counter reset, no counter increment', async () => {
    // An empty gate says nothing about job health — resetting here would let
    // alternating error/skip cycles evade max_failures forever.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT only
    const r = await recordRun(CTX, 'job-1', { status: 'skipped_no_work', startedAt: new Date() });
    expect(r.autoDisabled).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO ai_job_runs/);
  });

  it('error increments the counter and auto-disables at max_failures in ONE guarded UPDATE', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT
    mockQuery.mockResolvedValueOnce({ rows: [{ enabled: false, consecutive_failures: 3 }], rowCount: 1 });
    const r = await recordRun(CTX, 'job-1', { status: 'error', startedAt: new Date(), detail: { error: 'boom' } });
    expect(r.autoDisabled).toBe(true);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toMatch(/consecutive_failures = consecutive_failures \+ 1/);
    expect(sql).toMatch(/WHEN consecutive_failures \+ 1 >= max_failures THEN false/);
    expect(sql).toMatch(/WHERE id = \$1 AND entity_id = \$2 AND enabled = true/);
    expect(params).toEqual(['job-1', 'entity-1']);
  });

  it('error below max_failures leaves the job enabled', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [{ enabled: true, consecutive_failures: 1 }], rowCount: 1 });
    const r = await recordRun(CTX, 'job-1', { status: 'error', startedAt: new Date() });
    expect(r.autoDisabled).toBe(false);
  });

  it('error on an ALREADY-disabled job (rowCount 0) never reports autoDisabled', async () => {
    // The enabled = true guard means an already-off job matches no row —
    // autoDisabled must only ever report a flip THIS call made.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no row matched
    const r = await recordRun(CTX, 'job-1', { status: 'error', startedAt: new Date() });
    expect(r.autoDisabled).toBe(false);
  });
});

describe('listRuns', () => {
  it('scopes to the entity, newest first, with an optional job filter and a parameterized LIMIT', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listRuns(CTX, { jobId: 'job-1', limit: 5 });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/r\.entity_id = \$1/);
    expect(sql).toMatch(/r\.job_id = \$2/);
    expect(sql).toMatch(/ORDER BY r\.started_at DESC/);
    expect(sql).toMatch(/LIMIT \$3/); // bind parameter, never interpolated
    expect(params).toEqual(['entity-1', 'job-1', 5]);
  });

  it('falls back to the default limit on NaN/Infinity and clamps the range', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await listRuns(CTX, { limit: Number.NaN });
    expect(mockQuery.mock.calls[0][1]).toEqual(['entity-1', 20]);
    await listRuns(CTX, { limit: Number.POSITIVE_INFINITY });
    expect(mockQuery.mock.calls[1][1]).toEqual(['entity-1', 20]);
    await listRuns(CTX, { limit: -3 });
    expect(mockQuery.mock.calls[2][1]).toEqual(['entity-1', 1]);
    await listRuns(CTX, { limit: 1e9 });
    expect(mockQuery.mock.calls[3][1]).toEqual(['entity-1', 500]);
    for (const [sql] of mockQuery.mock.calls) {
      expect(sql).toMatch(/LIMIT \$2/);
    }
  });
});
