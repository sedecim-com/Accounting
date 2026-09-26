import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TOOL_SCHEMAS_GOLDEN,
  agentToolSchemas,
  canonical,
  readerToolSchemas,
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
