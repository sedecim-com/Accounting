import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import {
  recordUsage,
  estimateCostUsd,
  summarizeUsage,
  clampTokenCount,
  type TurnUsage,
} from '../../src/ai/usage-ledger.js';
import { lookupPrice } from '../../src/ai/providers/prices.js';
import { query } from '../../src/database/connection.js';
import type { AgentContext } from '../../src/ai/context.js';

const mockQuery = query as unknown as Mock;

const CTX: AgentContext = {
  entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  entityName: 'Acme MX',
  tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'AME010101AAA',
};

describe('lookupPrice', () => {
  it('matches by prefix (dated model variants map to the family)', () => {
    const price = lookupPrice('claude-opus-5-20260101');
    expect(price).not.toBeNull();
    expect(price!.inputPerMTok).toBe(5);
    expect(price!.outputPerMTok).toBe(25);
  });

  it('prefers the longest matching prefix', () => {
    // "gpt-4o-mini" must not resolve to the "gpt-4o" entry.
    const mini = lookupPrice('gpt-4o-mini-2024-07-18');
    expect(mini!.prefix).toBe('gpt-4o-mini');
    expect(mini!.inputPerMTok).toBe(0.15);
    const full = lookupPrice('gpt-4o-2024-08-06');
    expect(full!.prefix).toBe('gpt-4o');
    expect(full!.inputPerMTok).toBe(2.5);
  });

  it('is case-insensitive', () => {
    expect(lookupPrice('Claude-Opus-5')).not.toBeNull();
    expect(lookupPrice('GPT-4.1')).not.toBeNull();
  });

  it('returns null for unknown models (local, agent gateways, wizards)', () => {
    expect(lookupPrice('llama3.1')).toBeNull();
    expect(lookupPrice('hermes-agent')).toBeNull();
    expect(lookupPrice('openrouter/auto')).toBeNull();
    expect(lookupPrice('onboarding-wizard')).toBeNull();
  });

  it('carries anthropic cache rates (read 0.1x, write 1.25x input)', () => {
    const price = lookupPrice('claude-sonnet-5');
    expect(price!.cacheReadPerMTok).toBeCloseTo(0.3, 10);
    expect(price!.cacheWritePerMTok).toBeCloseTo(3.75, 10);
  });

  it('never underprices a real model id via an ambiguous or dead prefix (overestimate invariant)', () => {
    // Every known real id must resolve to AT LEAST its own family's price —
    // ambiguity is always resolved toward the EXPENSIVE family.
    const floor: Array<[string, number, number]> = [
      // Legacy Opus 4/4.1 bill $15/$75 — the cheaper claude-opus-4 (4.5+)
      // family entry must never capture them.
      ['claude-opus-4-20250514', 15, 75],
      ['claude-opus-4-0', 15, 75],
      ['claude-opus-4-1', 15, 75],
      ['claude-opus-4-1-20250805', 15, 75],
      ['claude-opus-4-5', 5, 25],
      // gpt-5-pro bills far above the gpt-5 family rate.
      ['gpt-5-pro', 15, 120],
      ['gpt-5-pro-2025-10-06', 15, 120],
      ['gpt-5-2025-08-07', 1.25, 10],
      // Claude 3-generation haiku ids put the generation BEFORE the family
      // name; a 'claude-haiku-3' prefix would be dead and leave them unpriced.
      ['claude-3-5-haiku-20241022', 0.8, 4],
      ['claude-3-haiku-20240307', 0.25, 1.25],
    ];
    for (const [id, minInput, minOutput] of floor) {
      const price = lookupPrice(id);
      expect(price, `expected a price for ${id}`).not.toBeNull();
      expect(price!.inputPerMTok, `input rate for ${id}`).toBeGreaterThanOrEqual(minInput);
      expect(price!.outputPerMTok, `output rate for ${id}`).toBeGreaterThanOrEqual(minOutput);
    }
  });

  it('has no dead claude-haiku-3 style prefix in the table', () => {
    // The real ids are claude-3-haiku-* / claude-3-5-haiku-*; a prefix with
    // the generation AFTER the family name matches nothing that exists.
    expect(lookupPrice('claude-3-5-haiku-20241022')!.prefix).toBe('claude-3-5-haiku');
    expect(lookupPrice('claude-3-haiku-20240307')!.prefix).toBe('claude-3-haiku');
  });
});

describe('clampTokenCount', () => {
  it('clamps provider-reported garbage into [0, 2^31-1] and keeps sane values', () => {
    const MAX = 2_147_483_647;
    const table: Array<[unknown, number]> = [
      [0, 0],
      [1234, 1234],
      [1234.9, 1234],           // truncated, never rounded up
      [-1, 0],                  // hostile negatives can't drive totals down
      [-1e12, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
      [Number.NEGATIVE_INFINITY, 0],
      ['not-a-number', 0],
      [undefined, 0],
      [null, 0],                // Number(null) === 0
      [MAX, MAX],
      [MAX + 1, MAX],           // caps at the INTEGER column max
      [2 ** 53, MAX],           // unsafe integers cap instead of overflowing
      [9.9e307, MAX],
      ['5000', 5000],           // numeric strings off the wire still count
    ];
    for (const [input, expected] of table) {
      expect(clampTokenCount(input), `clampTokenCount(${String(input)})`).toBe(expected);
    }
  });

  it('recordUsage inserts the CLAMPED counts, never the raw garbage', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await recordUsage(CTX, null, {
      provider: 'openai_compat', model: 'llama3.1',
      inputTokens: -50, outputTokens: Number.NaN,
      cacheReadInputTokens: 2 ** 60, cacheCreationInputTokens: 7.9,
    });
    const [, params] = mockQuery.mock.calls[0];
    expect(params[6]).toBe(0); // input clamped from -50
    expect(params[7]).toBe(0); // output clamped from NaN
    expect(params[8]).toBe(2_147_483_647); // cache read capped
    expect(params[9]).toBe(7); // truncated
    // The row is still recorded: garbage in one field never loses the entry.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('estimateCostUsd', () => {
  it('computes input + output + cache read + cache write for claude', () => {
    const usage: TurnUsage = {
      provider: 'anthropic',
      model: 'claude-opus-5',
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cacheReadInputTokens: 500_000,
      cacheCreationInputTokens: 100_000,
    };
    // 1M×$5 + 0.2M×$25 + 0.5M×$0.50 + 0.1M×$6.25 = 5 + 5 + 0.25 + 0.625
    expect(estimateCostUsd(usage)).toBeCloseTo(10.875, 6);
  });

  it('falls back to the input rate for cache tokens without a listed rate', () => {
    const usage: TurnUsage = {
      provider: 'xai',
      model: 'grok-3',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    };
    // grok-3 lists no cache rates: both sides priced at input ($3/MTok).
    expect(estimateCostUsd(usage)).toBeCloseTo(6, 6);
  });

  it('returns null for unknown models', () => {
    expect(
      estimateCostUsd({ provider: 'ollama', model: 'llama3.1', inputTokens: 100, outputTokens: 100 })
    ).toBeNull();
  });
});

describe('recordUsage', () => {
  beforeEach(() => mockQuery.mockReset());

  it('inserts a tenant- and entity-scoped row with the estimated cost', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const id = await recordUsage(CTX, 'ssssssss-ssss-ssss-ssss-ssssssssssss', {
      provider: 'anthropic',
      model: 'claude-opus-5',
      inputTokens: 2000,
      outputTokens: 1000,
      cacheReadInputTokens: 10_000,
      cacheCreationInputTokens: 4000,
    });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_usage/);
    expect(sql).toMatch(/tenant_id, entity_id, session_id/);
    expect(params[1]).toBe(CTX.tenantId);
    expect(params[2]).toBe(CTX.entityId);
    expect(params[3]).toBe('ssssssss-ssss-ssss-ssss-ssssssssssss');
    expect(params[4]).toBe('anthropic');
    expect(params[5]).toBe('claude-opus-5');
    expect(params[6]).toBe(2000);
    expect(params[7]).toBe(1000);
    expect(params[8]).toBe(10_000);
    expect(params[9]).toBe(4000);
    // 0.002×5 + 0.001×25 + 0.01×0.5 + 0.004×6.25 = 0.01 + 0.025 + 0.005 + 0.025
    expect(params[10]).toBe('0.065000');
  });

  it('records unknown models with a NULL cost and defaulted cache tokens', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await recordUsage(CTX, null, {
      provider: 'ollama',
      model: 'llama3.1',
      inputTokens: 500,
      outputTokens: 300,
    });
    const [, params] = mockQuery.mock.calls[0];
    expect(params[3]).toBeNull();
    expect(params[8]).toBe(0);
    expect(params[9]).toBe(0);
    expect(params[10]).toBeNull();
  });
});

describe('summarizeUsage', () => {
  beforeEach(() => mockQuery.mockReset());

  const dbRow = {
    key: 'claude-opus-5',
    provider: 'anthropic',
    turns: '3',
    input_tokens: '3000',
    output_tokens: '1500',
    cache_read_tokens: '600',
    cache_write_tokens: '90',
    cost_usd: '0.123456',
    unpriced_turns: '0',
  };

  it('groups by model with entity scoping and no since filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [dbRow] });
    const summary = await summarizeUsage(CTX, { groupBy: 'model' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM ai_usage/);
    expect(sql).toMatch(/entity_id = \$1/);
    expect(sql).toMatch(/GROUP BY model, provider/);
    expect(sql).not.toMatch(/created_at >=/);
    expect(params).toEqual([CTX.entityId]);
    expect(summary.rows[0]).toEqual({
      key: 'claude-opus-5',
      provider: 'anthropic',
      turns: 3,
      inputTokens: 3000,
      outputTokens: 1500,
      cacheReadTokens: 600,
      cacheWriteTokens: 90,
      costUsd: 0.123456,
      unpricedTurns: 0,
    });
  });

  it('adds the since bound as a parameter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const since = new Date('2026-08-01T00:00:00Z');
    await summarizeUsage(CTX, { groupBy: 'provider', since });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/created_at >= \$2/);
    expect(sql).toMatch(/GROUP BY provider/);
    expect(params).toEqual([CTX.entityId, since]);
  });

  it('groups by day and by session with whitelisted expressions', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await summarizeUsage(CTX, { groupBy: 'day' });
    expect(mockQuery.mock.calls[0][0]).toMatch(/to_char\(created_at, 'YYYY-MM-DD'\)/);
    await summarizeUsage(CTX, { groupBy: 'session' });
    expect(mockQuery.mock.calls[1][0]).toMatch(/COALESCE\(session_id::text/);
  });

  it('totals across rows and treats NULL group cost as zero with unpriced count', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        dbRow,
        { ...dbRow, key: 'llama3.1', provider: 'ollama', turns: '2', cost_usd: null, unpriced_turns: '2' },
      ],
    });
    const summary = await summarizeUsage(CTX, { groupBy: 'model' });
    expect(summary.rows[1].costUsd).toBe(0);
    expect(summary.rows[1].unpricedTurns).toBe(2);
    expect(summary.totals.turns).toBe(5);
    expect(summary.totals.inputTokens).toBe(6000);
    expect(summary.totals.costUsd).toBeCloseTo(0.123456, 6);
    expect(summary.totals.unpricedTurns).toBe(2);
  });

  it('rejects an unknown grouping without touching the database', async () => {
    await expect(
      summarizeUsage(CTX, { groupBy: 'DROP TABLE' as never })
    ).rejects.toThrow(/Unknown grouping/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
