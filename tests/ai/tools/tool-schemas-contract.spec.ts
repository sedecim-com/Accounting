import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TOOL_SCHEMAS_GOLDEN,
  agentToolSchemas,
  agentTools,
  canonical,
  readerToolSchemas,
  readerTools,
  recordToolSchemas,
} from './tool-schema-snapshot.js';

// CONTRACT: the tool definitions the model (and any OpenAI-compatible server)
// receives are the ones recorded on zod 3.25.76, with no `$ref` left for a
// server to resolve (#367). A difference here is a change to what the agent is
// told it may send; it is regenerated only with its own CONTRACT PR.

function refsIn(value: unknown, at: string, found: string[]): string[] {
  if (Array.isArray(value)) {
    value.forEach((v, i) => refsIn(v, `${at}[${i}]`, found));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' || key === '$defs') found.push(`${at}.${key}`);
      refsIn(child, `${at}.${key}`, found);
    }
  }
  return found;
}

describe('agent tool input schemas', () => {
  it('carry no $ref or $defs at any depth, in either builder', () => {
    const found: string[] = [];
    for (const [name, schema] of Object.entries(agentToolSchemas())) refsIn(schema, name, found);
    for (const [name, schema] of Object.entries(readerToolSchemas())) refsIn(schema, `reader:${name}`, found);
    expect(found).toEqual([]);
  });

  it('say exactly what tests/ai/tools/tool-schemas.golden.json says', () => {
    const golden = JSON.parse(fs.readFileSync(TOOL_SCHEMAS_GOLDEN, 'utf8')) as Record<string, unknown>;
    expect(recordToolSchemas()).toEqual(golden);
  });

  it('give the webhook reader the same schema as the full session, tool by tool', () => {
    const golden = JSON.parse(fs.readFileSync(TOOL_SCHEMAS_GOLDEN, 'utf8')) as Record<string, unknown>;
    const reader = readerToolSchemas();
    expect(Object.keys(reader).length).toBeGreaterThan(0);
    for (const [name, schema] of Object.entries(reader)) {
      expect(canonical(schema), name).toEqual(golden[name]);
    }
  });
});

describe('agent tool inputs count string lengths in UTF-16 units', () => {
  // The SDK validates what the model sends with the tool's own schema
  // (`parse`). On the zod/v4 core bundled in zod 3.25.76 a maximum counted
  // UTF-16 units; zod 4 counts code points, which lets twice as much astral
  // text through (#367). Each row is at the bound and one astral past it.
  const EMOJI = '\u{1F600}';
  const draft = (extra: Record<string, unknown>, line: Record<string, unknown> = {}) => ({
    entry_date: '2024-01-15',
    description: 'd',
    confidence: 0.5,
    reasoning: 'r',
    lines: [{ account_code: '1', debit: 1, ...line }, { account_code: '2', credit: 1 }],
    ...extra,
  });
  const rows: Array<[string, string, (text: string) => unknown, number]> = [
    ['draft_journal_entry description', 'draft_journal_entry', (text) => draft({ description: text }), 500],
    ['draft_journal_entry reference', 'draft_journal_entry', (text) => draft({ reference: text }), 255],
    ['draft_journal_entry line description', 'draft_journal_entry', (text) => draft({}, { description: text }), 500],
    ['ask_user question', 'ask_user', (text) => ({ question: text }), 1000],
    ['ask_user context', 'ask_user', (text) => ({ question: 'q', context: text }), 2000],
    ['ask_user topic', 'ask_user', (text) => ({ question: 'q', topic: text }), 255],
  ];

  it.each(rows)('%s', (_label, name, input, max) => {
    const atBound = EMOJI.repeat(Math.floor(max / 2)) + 'a'.repeat(max % 2);
    for (const [builder, tools] of [['session', agentTools()], ['reader', readerTools()]] as const) {
      const tool = tools.find((t) => t.name === name);
      if (tool === undefined) throw new Error(`the ${builder} has no tool named ${name}`);
      expect(() => tool.parse(input(atBound)), builder).not.toThrow();
      expect(() => tool.parse(input(`${atBound}${EMOJI}`)), builder).toThrow();
      expect(() => tool.parse(input(EMOJI.repeat(max))), builder).toThrow();
    }
  });
});
