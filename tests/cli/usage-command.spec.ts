import { describe, it, expect } from 'vitest';

import {
  parseSince,
  parseGroupBy,
  formatUsageTable,
} from '../../src/cli/usage-command.js';
import type { UsageSummary } from '../../src/ai/usage-ledger.js';

const plain = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };

describe('parseSince', () => {
  const NOW = new Date('2026-08-24T12:00:00Z');

  it('returns undefined when the flag is absent', () => {
    expect(parseSince(undefined, NOW)).toBeUndefined();
  });

  it('parses relative day windows (7d, 30d)', () => {
    expect(parseSince('7d', NOW)!.toISOString()).toBe('2026-08-17T12:00:00.000Z');
    expect(parseSince('30d', NOW)!.toISOString()).toBe('2026-07-25T12:00:00.000Z');
  });

  it('parses absolute YYYY-MM-DD dates', () => {
    const since = parseSince('2026-08-01', NOW)!;
    expect(since.getFullYear()).toBe(2026);
    expect(since.getMonth()).toBe(7);
    expect(since.getDate()).toBe(1);
  });

  it('rejects anything else with an actionable message', () => {
    expect(() => parseSince('yesterday', NOW)).toThrow(/Nd .* or YYYY-MM-DD/);
    expect(() => parseSince('7w', NOW)).toThrow(/Invalid --since/);
  });

  it('caps relative windows at 3650d with a friendly error', () => {
    // The cap itself is still accepted…
    const decade = parseSince('3650d', NOW)!;
    expect(Number.isNaN(decade.getTime())).toBe(false);
    // …and anything beyond it fails HERE with a clear message, not deep in
    // query parameter serialization with an Invalid Date.
    expect(() => parseSince('3651d', NOW)).toThrow(/capped at 3650d/);
    expect(() => parseSince('99999999d', NOW)).toThrow(/capped at 3650d/);
    // Overflowing day counts (would produce an Invalid Date) are rejected too.
    expect(() => parseSince('99999999999999999999d', NOW)).toThrow(/Invalid --since/);
  });

  it('never returns an Invalid Date', () => {
    for (const input of ['1d', '365d', '3650d', '2020-01-01']) {
      const d = parseSince(input, NOW);
      expect(d).toBeInstanceOf(Date);
      expect(Number.isNaN(d!.getTime())).toBe(false);
    }
  });
});

describe('parseGroupBy', () => {
  it('defaults to model', () => {
    expect(parseGroupBy(undefined)).toBe('model');
  });

  it('accepts every dimension, case-insensitively', () => {
    expect(parseGroupBy('provider')).toBe('provider');
    expect(parseGroupBy('DAY')).toBe('day');
    expect(parseGroupBy('session')).toBe('session');
  });

  it('rejects unknown dimensions listing the valid ones', () => {
    expect(() => parseGroupBy('week')).toThrow(/model, provider, day, session/);
  });
});

describe('formatUsageTable', () => {
  const summary: UsageSummary = {
    rows: [
      {
        key: 'claude-opus-5',
        provider: 'anthropic',
        turns: 3,
        inputTokens: 3000,
        outputTokens: 1500,
        cacheReadTokens: 600,
        cacheWriteTokens: 90,
        costUsd: 0.1234,
        unpricedTurns: 0,
      },
      {
        key: 'llama3.1',
        provider: 'ollama',
        turns: 2,
        inputTokens: 400,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        unpricedTurns: 2,
      },
    ],
    totals: {
      turns: 5,
      inputTokens: 3400,
      outputTokens: 1700,
      cacheReadTokens: 600,
      cacheWriteTokens: 90,
      costUsd: 0.1234,
      unpricedTurns: 2,
    },
  };

  it('renders one aligned line per group plus a totals line', () => {
    const lines = formatUsageTable(summary, 'model', plain);
    const text = lines.join('\n');
    expect(text).toContain('claude-opus-5 (anthropic)');
    expect(text).toContain('$0.1234');
    expect(text).toContain('TOTAL');
    expect(text).toMatch(/3,400/);
  });

  it('marks fully-unpriced groups and footnotes the excluded turns', () => {
    const lines = formatUsageTable(summary, 'model', plain);
    const text = lines.join('\n');
    expect(text).toContain('unpriced');
    expect(text).toMatch(/2 turn\(s\) on models missing from the local price table/);
  });

  it('says so when there is nothing to report', () => {
    const empty: UsageSummary = {
      rows: [],
      totals: { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, unpricedTurns: 0 },
    };
    const text = formatUsageTable(empty, 'day', plain).join('\n');
    expect(text).toMatch(/No usage recorded/);
  });
});
