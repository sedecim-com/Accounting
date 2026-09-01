import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { getEntityStatus, buildStatusTools } from '../../../src/ai/tools/status-tools.js';
import { query } from '../../../src/database/connection.js';
import type { AgentContext } from '../../../src/ai/context.js';
import type { BetaTool, BetaToolResultContentBlockParam } from '@anthropic-ai/sdk/resources/beta';

/**
 * The concrete shape `betaZodTool` produces: a plain `BetaTool` plus `run`.
 * The builders return a union over many different input schemas and a tool is
 * looked up here by a runtime name string, which TypeScript cannot map back to
 * a single union member — so `run` on the raw union demands the intersection of
 * every tool's schema at once.
 */
type ToolHandle<Input = Record<string, never>> = BetaTool & {
  run: (input: Input) => Promise<string | BetaToolResultContentBlockParam[]>;
};

const mockQuery = query as unknown as Mock;

const CTX: AgentContext = {
  entityId: 'entity-1', entityName: 'Nueva Empresa SA', tenantId: 'tenant-a',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'NUE010101AAA',
};

function mockCounts(over: Partial<Record<string, string>> = {}) {
  mockQuery.mockResolvedValueOnce({
    rows: [{
      accounts: '0', periods: '0', posted: '0', opening: 'false',
      drafts: '0', questions: '0', ops: '0',
      customers: '0', vendors: '0', creds: '0',
      ...over,
    }],
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  delete process.env.CONTALINK_API_KEY;
});
afterEach(() => {
  delete process.env.CONTALINK_API_KEY;
});

describe('getEntityStatus — lifecycle stages (first unmet requirement wins)', () => {
  it('no_catalog: zero accounts, and the next step names init AND onboard', async () => {
    mockCounts();
    const s = await getEntityStatus(CTX);
    expect(s.stage).toBe('no_catalog');
    expect(s.next_step).toMatch(/mnemosine onboard/);
    expect(s.next_step).toMatch(/mnemosine init/);
  });

  it('no_fiscal_year: accounts exist but no open/future periods', async () => {
    mockCounts({ accounts: '38' });
    const s = await getEntityStatus(CTX);
    expect(s.stage).toBe('no_fiscal_year');
    expect(s.next_step).toMatch(/init --section identity/);
  });

  it('no_opening_balance: structure ready, nothing posted', async () => {
    mockCounts({ accounts: '38', periods: '12' });
    const s = await getEntityStatus(CTX);
    expect(s.stage).toBe('no_opening_balance');
    expect(s.next_step).toMatch(/opening/);
    expect(s.has_opening_balance).toBe(false);
  });

  it('operating: has posted entries, next step is the daily flow', async () => {
    mockCounts({ accounts: '38', periods: '12', posted: '6' });
    const s = await getEntityStatus(CTX);
    expect(s.stage).toBe('operating');
    expect(s.next_step).toMatch(/ingest/);
    expect(s.next_step).toMatch(/review/);
  });

  it('ordering: no accounts wins over no periods (both missing)', async () => {
    mockCounts({ posted: '0', periods: '0', accounts: '0' });
    expect((await getEntityStatus(CTX)).stage).toBe('no_catalog');
  });

  it('never regresses: posted history with all periods closed stays operating', async () => {
    mockCounts({ accounts: '38', periods: '0', posted: '120' });
    const s = await getEntityStatus(CTX);
    expect(s.stage).toBe('operating');
    expect(s.next_step).toMatch(/NO postable fiscal periods/);
    expect(s.next_step).toMatch(/init --section identity/);
    expect(s.next_step).not.toMatch(/onboard/);
  });

  it('steers to review when the opening balance is already drafted', async () => {
    mockCounts({ accounts: '38', periods: '12', posted: '0', drafts: '1' });
    const s = await getEntityStatus(CTX);
    expect(s.stage).toBe('no_opening_balance');
    expect(s.next_step).toMatch(/mnemosine review/);
    expect(s.next_step).toMatch(/Do NOT run onboard/);
  });

  it('counts soft_close periods as postable (only hard_close/locked block)', async () => {
    mockCounts();
    await getEntityStatus(CTX);
    const [sql] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/status IN \('open','future','soft_close'\)/);
  });
});

describe('getEntityStatus — truthful has_opening_balance', () => {
  it('is false even with posted entries when none is an onboarding entry', async () => {
    mockCounts({ accounts: '38', periods: '12', posted: '6', opening: 'false' });
    expect((await getEntityStatus(CTX)).has_opening_balance).toBe(false);
  });

  it('is true only when a posted onboarding:% entry exists', async () => {
    mockCounts({ accounts: '38', periods: '12', posted: '6', opening: 'true' });
    expect((await getEntityStatus(CTX)).has_opening_balance).toBe(true);
    const [sql] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/reference LIKE 'onboarding:%'/);
  });
});

describe('getEntityStatus — payload for guidance', () => {
  it('carries entity identity, pending work and setup signals', async () => {
    process.env.CONTALINK_API_KEY = 'k';
    mockCounts({
      accounts: '38', periods: '12', posted: '6',
      drafts: '2', questions: '1', ops: '3',
      customers: '5', vendors: '7', creds: '1',
    });
    const s = await getEntityStatus(CTX);
    expect(s.entity).toEqual({
      name: 'Nueva Empresa SA', rfc: 'NUE010101AAA', country: 'MX',
      currency: 'MXN', accounting_standard: 'mx_nif',
    });
    expect(s.pending).toEqual({ drafts: 2, questions: 1, external_ops: 3 });
    expect(s.customers).toBe(5);
    expect(s.vendors).toBe(7);
    expect(s.fiscal_credentials_active).toBe(1);
    expect(s.external_accounting_configured).toBe(true);
  });

  it('single round-trip, scoped to the entity', async () => {
    mockCounts();
    await getEntityStatus(CTX);
    expect(mockQuery.mock.calls).toHaveLength(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['entity-1']);
    // every subquery is entity-scoped
    expect((String(sql).match(/entity_id = \$1/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });
});

describe('get_entity_status tool', () => {
  it('returns the status as JSON and notifies the observer', async () => {
    mockCounts({ accounts: '38', periods: '12' });
    const seen: string[] = [];
    const tool = buildStatusTools(CTX, {
      model: 'm', observe: (name) => seen.push(name),
    }).find((t) => t.name === 'get_entity_status')!;
    const parsed = JSON.parse((await tool.run({})) as string);
    expect(parsed.stage).toBe('no_opening_balance');
    expect(seen).toEqual(['get_entity_status']);
  });

  it('its description pins ONE ordering: playbooks doc, then this tool, then answer', () => {
    const tool = buildStatusTools(CTX, { model: 'm' })[0] as ToolHandle;
    expect(tool.description).toMatch(/read the "playbooks" doc/);
    expect(tool.description).toMatch(/then call this tool BEFORE answering/);
    expect(tool.description).toMatch(/instead of asking/);
  });
});
