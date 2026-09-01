import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));
vi.mock('../../../src/services/integrations/accounting/registry.js', () => ({
  getExternalAdapter: vi.fn(),
  listExternalSystems: vi.fn(() => ['contalink']),
}));

import { buildExternalTools } from '../../../src/ai/tools/external-tools.js';
import { getExternalAdapter } from '../../../src/services/integrations/accounting/registry.js';
import type { AgentContext } from '../../../src/ai/context.js';
import type { BetaTool, BetaToolResultContentBlockParam } from '@anthropic-ai/sdk/resources/beta';

// A3: los resultados con datos de terceros viajan envueltos en marcadores
// UNTRUSTED; parsear = des-envolver primero. Los sin envoltura pasan igual.
function parseResultado(r: string): any {
  const abre = r.indexOf('<<<UNTRUSTED_CFDI_DATA>>>');
  if (abre < 0) return JSON.parse(r);
  const cuerpo = r.slice(
    abre + '<<<UNTRUSTED_CFDI_DATA>>>'.length,
    r.lastIndexOf('<<<END_UNTRUSTED_CFDI_DATA>>>')
  );
  return JSON.parse(cuerpo);
}


/**
 * The concrete shape `betaZodTool` produces: a plain `BetaTool` plus `run`.
 * The builders return a union over many different input schemas and a tool is
 * looked up here by a runtime name string, which TypeScript cannot map back to
 * a single union member — so `run` on the raw union demands the intersection of
 * every tool's schema at once.
 */
type ToolHandle<Input = Record<string, unknown>> = BetaTool & {
  run: (input: Input) => Promise<string | BetaToolResultContentBlockParam[]>;
};

const mockGetAdapter = getExternalAdapter as unknown as Mock;

const CTX: AgentContext = {
  entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  entityName: 'Acme MX',
  tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'AME010101AAA',
};

function getTool(name: string): ToolHandle {
  const tool = buildExternalTools(CTX, { model: 'claude-opus-5' }).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool as ToolHandle;
}

const PULL_INPUT = {
  provider: 'contalink',
  resource: 'trial_balance',
  start_date: '2026-01-01',
  end_date: '2026-06-30',
};

function fakeBalance(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    account_code: String(1000 + i),
    account_name: `Account ${i} ${'x'.repeat(120)}`,
    initial_balance: i * 10,
    debits: i * 2,
    credits: i,
    final_balance: i * 11,
  }));
}

describe('external_pull trial_balance (sized to the tool-result cap, not a fixed row count)', () => {
  beforeEach(() => mockGetAdapter.mockReset());

  it('an oversized balance is cut to fit, stays valid JSON, and says exactly what was omitted', async () => {
    const rows = fakeBalance(2000); // far past any character cap
    mockGetAdapter.mockReturnValue({ getTrialBalance: vi.fn(async () => rows) });

    const out = (await getTool('external_pull').run(PULL_INPUT)) as string;

    // never cut mid-JSON: the whole result parses
    const parsed = parseResultado(out);
    expect(parsed.count).toBe(2000);
    expect(parsed.shown).toBeGreaterThan(0);
    expect(parsed.shown).toBeLessThan(parsed.count);
    expect(parsed.omitted).toBe(parsed.count - parsed.shown);
    expect(parsed.omitted).toBeGreaterThan(0);
    expect(parsed.trial_balance).toHaveLength(parsed.shown);
    // the guidance names tools that actually exist for this resource (it has
    // no pagination or filters, so no "refine your query" dead end)
    expect(parsed.note).toMatch(/external_diff_trial_balance/);
    expect(parsed.note).toMatch(/account_balance/);
    expect(parsed.note).not.toMatch(/pagination to see the rest/);
    // fits under the generic truncation cap so the marker never mangles it
    expect(out.length).toBeLessThanOrEqual(32_000);
  });

  it('a small balance is returned whole: shown=count, omitted=0, no note', async () => {
    const rows = fakeBalance(5);
    mockGetAdapter.mockReturnValue({ getTrialBalance: vi.fn(async () => rows) });

    const parsed = parseResultado((await getTool('external_pull').run(PULL_INPUT)) as string);
    expect(parsed.count).toBe(5);
    expect(parsed.shown).toBe(5);
    expect(parsed.omitted).toBe(0);
    expect(parsed.note).toBeUndefined();
    expect(parsed.trial_balance).toHaveLength(5);
  });
});
