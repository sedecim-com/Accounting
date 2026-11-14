import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ============================================================
// MNE-001-290 · THE COMMANDS PRINT DAYS ON THE ENTITY'S OWN CLOCK.
//
// Nothing here mocks `today.js`: the real `zoneFor` runs over a `getPolicy`
// stub that answers the `zona_horaria` policy per test, so a command that
// hardcodes a zone (or UTC) instead of asking the panel fails. The instant is
// 31 Jan 19:00 in Mexico City = 1 Feb 01:00 UTC = 1 Feb 10:00 in Tokyo.
// ============================================================

const mundo = vi.hoisted(() => ({ zona: 'America/Mexico_City' }));

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: () => 'T1',
}));

vi.mock('../../src/services/policy/policy-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/policy/policy-service.js')>();
  return {
    ...actual,
    getPolicy: vi.fn(async () => ({ key: 'zona_horaria', value: mundo.zona, defined: true })),
    seedPolicies: vi.fn(),
    listPending: vi.fn(async () => []),
    listPolicies: vi.fn(),
  };
});

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: () => undefined,
  resolveEntity: () =>
    Promise.resolve({
      tenantId: 'T1', entityId: 'E1', entityName: 'Acme SA', currency: 'MXN', country: 'MX',
      accountingStandard: 'mx_nif', taxId: 'AAA010101AAA',
    }),
  listEntities: () => Promise.resolve([{ id: 'E1', name: 'Acme SA' }]),
}));
vi.mock('../../src/ai/draft-service.js', () => ({ resolveReviewer: vi.fn() }));
vi.mock('../../src/ai/pending-service.js', () => ({
  getPendingBoard: vi.fn(async () => ({ items: [], totalWork: 0 })),
}));
vi.mock('../../src/ai/jobs/job-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ai/jobs/job-store.js')>()),
  listJobs: vi.fn(),
  listRuns: vi.fn(),
}));
vi.mock('../../src/ai/webhooks/intake.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ai/webhooks/intake.js')>()),
  listWebhookTokens: vi.fn(),
}));
vi.mock('../../src/ai/question-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ai/question-service.js')>()),
  listQuestions: vi.fn(),
}));
vi.mock('../../src/services/accounting/batch-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/accounting/batch-service.js')>()),
  listBatches: vi.fn(),
}));

import { registerJobsCommand } from '../../src/cli/jobs-command.js';
import { registerWebhooksCommand } from '../../src/cli/webhooks-command.js';
import { registerPendingCommands } from '../../src/cli/pending-command.js';
import { registerBatchCommand } from '../../src/cli/batch-command.js';
import { listarQuestionsImpl } from '../../src/cli/mnemosine.js';
import { listJobs } from '../../src/ai/jobs/job-store.js';
import { listWebhookTokens } from '../../src/ai/webhooks/intake.js';
import { listQuestions } from '../../src/ai/question-service.js';
import { listBatches } from '../../src/services/accounting/batch-service.js';
import { listPolicies } from '../../src/services/policy/policy-service.js';

const INSTANT = new Date('2026-02-01T01:00:00Z');
const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};
const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

let out: string[];

beforeEach(() => {
  out = [];
  mundo.zona = 'America/Mexico_City';
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const text = (): string => out.join('\n');

async function parse(register: (p: Command) => void, ...argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  register(program);
  await program.parseAsync(argv, { from: 'user' });
}

describe('question list --format csv', () => {
  const row = { id: 'q1', status: 'pending', question: 'Which account?', options: null, topic: null, created_at: INSTANT };

  it('31 Jan 19:00 CDMX reads 2026-01-31', async () => {
    mocked(listQuestions).mockResolvedValue([row]);
    await listarQuestionsImpl({ format: 'csv' });
    expect(text()).toContain('2026-01-31');
    expect(text()).not.toContain('2026-02-01');
  });

  it("an entity whose zona_horaria is Asia/Tokyo reads 2026-02-01: the entity's zone wins", async () => {
    mundo.zona = 'Asia/Tokyo';
    mocked(listQuestions).mockResolvedValue([row]);
    await listarQuestionsImpl({ format: 'csv' });
    expect(text()).toContain('2026-02-01');
    expect(text()).not.toContain('2026-01-31');
  });
});

describe('jobs list', () => {
  const job = {
    id: 'J1', name: 'nightly', kind: 'review_queue', schedule: 'daily', enabled: true,
    consecutive_failures: 0, max_failures: 3, next_run_at: INSTANT,
  };
  const reg = (p: Command) =>
    registerJobsCommand(p, {
      palette: plain,
      shutdown: async () => undefined as never,
      reportError: (e) => { throw e; },
      makeRunAgentTurn: vi.fn(),
    });

  it.each([
    ['America/Mexico_City', '2026-01-31 19:00'],
    ['Asia/Tokyo', '2026-02-01 10:00'],
  ])('next run in %s is %s', async (zona, expected) => {
    mundo.zona = zona;
    mocked(listJobs).mockResolvedValue([job]);
    await parse(reg, 'jobs', 'list');
    expect(text()).toContain(expected);
  });
});

describe('webhooks list', () => {
  const token = {
    id: 't1', name: 'bank-bbva', source_kind: 'bank_notification', enabled: true,
    created_by: 'ops', created_at: INSTANT, last_used_at: INSTANT,
  };
  const reg = (p: Command) =>
    registerWebhooksCommand(p, {
      palette: plain,
      shutdown: async () => undefined as never,
      reportError: (e) => { throw e; },
    });

  it.each([
    ['America/Mexico_City', '2026-01-31'],
    ['Asia/Tokyo', '2026-02-01'],
  ])('last use in %s is %s', async (zona, expected) => {
    mundo.zona = zona;
    mocked(listWebhookTokens).mockResolvedValue([token]);
    await parse(reg, 'webhooks', 'list');
    expect(text()).toContain(expected);
  });
});

describe('pending --all', () => {
  const closed = {
    key: 'zona_horaria', status: 'resolved', resolved_value: 'America/Mexico_City',
    resolved_by: 'ana', resolved_at: INSTANT, resolution_notes: null,
  };
  const reg = (p: Command) =>
    registerPendingCommands(p, {
      color: plain,
      colorErr: plain,
      shutdown: async () => undefined as never,
      reportError: (e) => { throw e; },
      ask: async () => '',
    });

  it.each([
    ['America/Mexico_City', 'ana · 2026-01-31'],
    ['Asia/Tokyo', 'ana · 2026-02-01'],
  ])('a definition resolved at the instant in %s reads %s', async (zona, expected) => {
    mundo.zona = zona;
    mocked(listPolicies).mockResolvedValue([closed]);
    await parse(reg, 'pending', '--all');
    expect(text()).toContain(expected);
  });
});

describe('batch list', () => {
  const batchRow = {
    id: 'B1', kind: 'import', status: 'staged', rows_total: 1, rows_invalid: 0, entries_posted: 0,
    layout: 'generic', file_name: 'a.csv', file_hash: 'abc', created_by: 'ana', created_at: INSTANT,
  };
  const reg = (p: Command) =>
    registerBatchCommand(p, {
      palette: plain,
      shutdown: () => undefined,
      reportError: (e: unknown) => { throw e; },
    } as never);

  it.each([
    ['America/Mexico_City', '2026-01-31'],
    ['Asia/Tokyo', '2026-02-01'],
  ])('a batch prepared at the instant in %s is dated %s', async (zona, expected) => {
    mundo.zona = zona;
    mocked(listBatches).mockResolvedValue([batchRow]);
    await parse(reg, 'batch', 'list', '--format', 'csv');
    expect(text()).toContain(expected);
  });

  it('a timestamptz that arrives as ISO text is read in the zone too, not cut at the UTC day', async () => {
    mocked(listBatches).mockResolvedValue([{ ...batchRow, created_at: '2026-02-01T01:00:00.000Z' }]);
    await parse(reg, 'batch', 'list', '--format', 'csv');
    expect(text()).toContain('2026-01-31');
    expect(text()).not.toContain('2026-02-01');
  });
});
