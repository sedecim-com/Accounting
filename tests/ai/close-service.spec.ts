import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(), enterTenant: vi.fn(), currentTenant: vi.fn(),
}));
vi.mock('../../src/services/accounting/period-close.js', () => ({
  getPeriodCloseStatus: vi.fn(),
}));

import {
  listClosablePeriods, nextPeriodToClose, getAiBlockers, getCloseReadiness,
  type ClosablePeriod,
} from '../../src/ai/close-service.js';
import { query } from '../../src/database/connection.js';
import { getPeriodCloseStatus } from '../../src/services/accounting/period-close.js';
import type { AgentContext } from '../../src/ai/context.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockStatus = getPeriodCloseStatus as unknown as ReturnType<typeof vi.fn>;

const CTX: AgentContext = {
  entityId: 'entity-1', entityName: 'Acme', tenantId: 'tenant-a',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AME010101AAA',
};

const PERIOD: ClosablePeriod = {
  id: 'fp-1', period_name: 'July 2026', period_number: 7,
  start_date: '2026-07-01', end_date: '2026-07-31',
  status: 'open', year_number: 2026, overdue: true,
};

const CLEAN_ENGINE = {
  can_close: true, blocking_issues: [], warnings: [],
  checklist: [{ item: 'Trial balance balanced', is_complete: true }],
};

function mockBlockers(b: { drafts?: string; questions?: string; ops?: string } = {}) {
  mockQuery.mockResolvedValue({
    rows: [{ drafts: b.drafts ?? '0', questions: b.questions ?? '0', ops: b.ops ?? '0' }],
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockStatus.mockReset();
});

describe('listClosablePeriods', () => {
  it('only returns open/soft_close, oldest first, scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [PERIOD] });
    await listClosablePeriods(CTX);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/status IN \('open', 'soft_close'\)/);
    expect(sql).toMatch(/ORDER BY fp\.start_date ASC/);
    expect(sql).toMatch(/entity_id = \$1/);
    expect(params).toEqual(['entity-1']);
  });
});

describe('nextPeriodToClose', () => {
  it('prefers the oldest OVERDUE period', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { ...PERIOD, period_name: 'August 2026', overdue: false },
        { ...PERIOD, period_name: 'July 2026', overdue: true },
      ],
    });
    const p = await nextPeriodToClose(CTX);
    expect(p?.period_name).toBe('July 2026');
  });

  it('falls back to the first open one when none is overdue', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...PERIOD, period_name: 'August 2026', overdue: false }],
    });
    expect((await nextPeriodToClose(CTX))?.period_name).toBe('August 2026');
  });

  it('returns null when there is nothing to close', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await nextPeriodToClose(CTX)).toBeNull();
  });
});

describe('getAiBlockers', () => {
  it('counts drafts ONLY inside the period date range', async () => {
    mockBlockers({ drafts: '2' });
    const b = await getAiBlockers(CTX, PERIOD);
    expect(b.pendingDrafts).toBe(2);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/BETWEEN \$2::date AND \$3::date/);
    expect(params).toEqual(['entity-1', '2026-07-01', '2026-07-31']);
  });
});

describe('getCloseReadiness', () => {
  it('passes through the engine checklist and can close when clean', async () => {
    mockStatus.mockResolvedValue(CLEAN_ENGINE);
    mockBlockers();
    const r = await getCloseReadiness(CTX, PERIOD);
    expect(r.canClose).toBe(true);
    expect(r.checklist).toEqual(CLEAN_ENGINE.checklist);
    expect(r.blockingIssues).toEqual([]);
  });

  it('pending drafts inside the period BLOCK the close', async () => {
    mockStatus.mockResolvedValue(CLEAN_ENGINE);
    mockBlockers({ drafts: '3' });
    const r = await getCloseReadiness(CTX, PERIOD);
    expect(r.canClose).toBe(false);
    expect(r.blockingIssues[0]).toMatch(/3 AI draft\(s\)/);
    expect(r.blockingIssues[0]).toMatch(/mnemosine review/);
  });

  it('questions and queued writes only WARN (they may be from other periods)', async () => {
    mockStatus.mockResolvedValue(CLEAN_ENGINE);
    mockBlockers({ questions: '2', ops: '1' });
    const r = await getCloseReadiness(CTX, PERIOD);
    expect(r.canClose).toBe(true); // does not block
    expect(r.warnings.some((w) => w.includes('mnemosine questions'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('mnemosine outbox'))).toBe(true);
  });

  it('keeps the engine blocking issues and adds its own', async () => {
    mockStatus.mockResolvedValue({
      ...CLEAN_ENGINE,
      can_close: false,
      blocking_issues: ['2 unposted journal entries'],
      warnings: ['1 bank account not reconciled'],
    });
    mockBlockers({ drafts: '1' });
    const r = await getCloseReadiness(CTX, PERIOD);
    expect(r.blockingIssues).toHaveLength(2);
    expect(r.blockingIssues[0]).toMatch(/unposted journal entries/);
    expect(r.blockingIssues[1]).toMatch(/AI draft/);
    expect(r.warnings[0]).toMatch(/bank account/);
  });

  it('does not mutate the engine arrays (copies them)', async () => {
    const engine = { ...CLEAN_ENGINE, blocking_issues: [] as string[], warnings: [] as string[] };
    mockStatus.mockResolvedValue(engine);
    mockBlockers({ drafts: '1', questions: '1' });
    await getCloseReadiness(CTX, PERIOD);
    expect(engine.blocking_issues).toEqual([]);
    expect(engine.warnings).toEqual([]);
  });
});
