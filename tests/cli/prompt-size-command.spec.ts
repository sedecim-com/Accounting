import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';

// The command module pulls in context/system-prompt, which import the pool
// module; mock it so importing never needs a database (the pool is lazy, but
// the mock also protects against future import-time side effects).
vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  computePromptBudget,
  formatPromptBudget,
  splitStableBlock,
  registerPromptSizeCommand,
  type PromptSections,
  type ToolLike,
} from '../../src/cli/prompt-size-command.js';
import { docsIndex } from '../../src/ai/tools/docs-tools.js';

// Identity palette: assertions read plain text.
const plain = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };

const BLOCKS: PromptSections = {
  role: 'R'.repeat(400),
  docsIndex: 'D'.repeat(100),
  chartOfAccounts: 'C'.repeat(200),
  volatile: 'V'.repeat(41), // odd length: exercises the ceil in chars/4
};

const tool = (name: string, padding: number): ToolLike => ({
  name,
  description: 'd',
  input_schema: { type: 'object', properties: { x: { type: 'string', description: 'p'.repeat(padding) } } },
});

describe('computePromptBudget', () => {
  it('counts each section with ~chars/4 tokens and marks only the volatile block uncached', () => {
    const b = computePromptBudget(BLOCKS, []);
    expect(b.sections.map((s) => [s.label, s.chars, s.tokens, s.cached])).toEqual([
      ['role instructions (stable)', 400, 100, true],
      ['docs index (stable)', 100, 25, true],
      ['chart of accounts (stable)', 200, 50, true],
      ['volatile block (entity + date)', 41, 11, false], // ceil(41/4)
    ]);
  });

  it('sizes each tool by its serialized wire form and sorts descending', () => {
    const tools = [tool('small', 10), tool('big', 500), tool('medium', 100)];
    const b = computePromptBudget(BLOCKS, tools);
    expect(b.tools.map((t) => t.name)).toEqual(['big', 'medium', 'small']);
    // wire form = JSON of {name, description, input_schema}
    const expected = JSON.stringify({ name: 'big', description: 'd', input_schema: tools[1].input_schema }).length;
    expect(b.tools[0].chars).toBe(expected);
    expect(b.tools[0].tokens).toBe(Math.ceil(expected / 4));
    expect(b.toolsTotal.chars).toBe(b.tools.reduce((s, t) => s + t.chars, 0));
  });

  it('splits cached (stable sections + tools) from uncached (volatile) and totals them', () => {
    const tools = [tool('a', 10), tool('b', 20)];
    const b = computePromptBudget(BLOCKS, tools);
    expect(b.cached.chars).toBe(400 + 100 + 200 + b.toolsTotal.chars);
    expect(b.uncached.chars).toBe(41);
    expect(b.total.chars).toBe(b.cached.chars + b.uncached.chars);
    expect(b.total.tokens).toBe(Math.ceil(b.total.chars / 4));
  });

  it('handles a toolless (chat-only) profile: zero tool bytes, budget still valid', () => {
    const b = computePromptBudget(BLOCKS, []);
    expect(b.tools).toEqual([]);
    expect(b.toolsTotal).toEqual({ chars: 0, tokens: 0 });
    expect(b.cached.chars).toBe(700);
  });
});

describe('formatPromptBudget', () => {
  it('lists at most the top 10 tools plus an aggregate line', () => {
    const tools = Array.from({ length: 14 }, (_, i) => tool(`tool_${String(i).padStart(2, '0')}`, (14 - i) * 50));
    const lines = formatPromptBudget(computePromptBudget(BLOCKS, tools), plain);
    const text = lines.join('\n');
    // largest 10 shown, the 4 smallest folded into the "… more" line
    expect(text).toContain('tool_00');
    expect(text).toContain('tool_09');
    expect(text).not.toMatch(/^\s+tool_13 /m);
    expect(text).toContain('… 4 more tools');
    expect(text).toContain('all tools (14)');
  });

  it('renders sections, cache markers, and the cached/uncached/TOTAL rows', () => {
    const lines = formatPromptBudget(computePromptBudget(BLOCKS, [tool('a', 10)]), plain);
    const text = lines.join('\n');
    expect(text).toContain('role instructions (stable)');
    expect(text).toContain('[cached]');
    expect(text).toContain('volatile block (entity + date)');
    expect(text).toContain('[uncached]');
    expect(text).toContain('cached prefix (tools + stable)');
    expect(text).toContain('uncached (volatile)');
    expect(text).toContain('TOTAL');
    // no API/LLM involvement: it is labeled as an offline estimate
    expect(text).toContain('offline estimate');
  });
});

describe('splitStableBlock', () => {
  it('splits role / docs index / chart of accounts around the embedded docs index', () => {
    const docs = docsIndex();
    const stable = `ROLE HEADER\n${docs}\nChart of accounts:\n1000 | Caja`;
    const parts = splitStableBlock(stable);
    expect(parts.role).toBe('ROLE HEADER\n');
    expect(parts.docsIndex).toBe(docs);
    expect(parts.chartOfAccounts).toBe('\nChart of accounts:\n1000 | Caja');
    // lossless: the three parts reassemble the original block exactly
    expect(parts.role + parts.docsIndex + parts.chartOfAccounts).toBe(stable);
  });

  it('falls back to attributing everything to role when the anchor is absent', () => {
    const parts = splitStableBlock('no docs index here');
    expect(parts).toEqual({ role: 'no docs index here', docsIndex: '', chartOfAccounts: '' });
  });
});

describe('registerPromptSizeCommand', () => {
  it('registers a thin prompt-size command on the program', () => {
    const program = new Command();
    registerPromptSizeCommand(program, {
      palette: plain,
      shutdown: vi.fn(),
      reportError: vi.fn(),
    });
    const cmd = program.commands.find((c) => c.name() === 'prompt-size');
    expect(cmd).toBeDefined();
    const optionNames = cmd!.options.map((o) => o.long);
    expect(optionNames).toEqual(expect.arrayContaining(['--entity', '--tenant', '--json']));
  });
});
