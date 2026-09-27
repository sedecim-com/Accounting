import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { z } from 'zod';

// ============================================================
// CONTRACT: the Zod → JSON Schema converter, byte by byte (#367).
//
// docs/openapi.json is compared whole by `scripts/openapi.ts --check`, but a
// diff there says THAT the contract moved, not which node did it. These rows
// pin the exact serialization (keys, key order, values) of one node of every
// kind the API publishes, recorded on zod 3.25.76. The converter is rewritten
// on zod 4 internals in #367 and must reproduce every line here unchanged.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  withTransaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) })
  ),
  withTenant: vi.fn(async (_t: string, fn: () => Promise<unknown>) => fn()),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
  getClient: vi.fn(),
  setTenantSchema: vi.fn(),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getPool: vi.fn(),
}));

import { jsonSchemaDeZod } from '../../../src/api/rest/zod-a-json-schema.js';
import { arregloAcotado } from '../../../src/api/rest/topes.js';
import { montarSuperficieCensable } from '../../../src/api/rest/montajes.js';
import { construirOpenAPI } from '../../../src/api/rest/openapi.js';

const capped = (minimum?: number) =>
  arregloAcotado(z.string(), { tope: 10, plural: 'filas', salida: 'Parte el lote.', minimo: minimum });

const ROWS: Array<[string, z.ZodType, string]> = [
  ['string with min and max', z.string().min(1).max(255), '{"type":"string","minLength":1,"maxLength":255}'],
  ['string with a regex', z.string().regex(/^\d{4}-\d{2}-\d{2}/), '{"type":"string","pattern":"^\\\\d{4}-\\\\d{2}-\\\\d{2}"}'],
  ['nullable uuid', z.string().uuid().nullable(), '{"type":["string","null"],"format":"uuid"}'],
  ['email', z.string().email(), '{"type":"string","format":"email"}'],
  ['url is published as uri', z.string().url(), '{"type":"string","format":"uri"}'],
  ['exact length', z.string().length(3), '{"type":"string","minLength":3,"maxLength":3}'],
  ['bounded integer, and no safe-integer bounds', z.number().int().min(1).max(208), '{"type":"integer","minimum":1,"maximum":208}'],
  ['positive is an exclusive minimum', z.number().positive(), '{"type":"number","exclusiveMinimum":0}'],
  ['multipleOf', z.number().multipleOf(5), '{"type":"number","multipleOf":5}'],
  ['enum with a default', z.enum(['a', 'b']).default('a'), '{"type":"string","enum":["a","b"],"default":"a"}'],
  [
    'strip object',
    z.object({ a: z.string(), b: z.number().optional() }),
    '{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"number"}},"required":["a"],"additionalProperties":true,"x-claves-desconocidas":"descartadas"}',
  ],
  [
    'passthrough object',
    z.object({ a: z.string() }).passthrough(),
    '{"type":"object","properties":{"a":{"type":"string"}},"required":["a"],"additionalProperties":true,"x-claves-desconocidas":"conservadas"}',
  ],
  [
    'strict object carries no unknown-key extension',
    z.object({ a: z.string() }).strict(),
    '{"type":"object","properties":{"a":{"type":"string"}},"required":["a"],"additionalProperties":false}',
  ],
  [
    'refined object flags the refinement as its LAST key',
    z.object({ a: z.string().optional() }).refine((o) => o.a !== undefined),
    '{"type":"object","properties":{"a":{"type":"string"}},"additionalProperties":true,"x-claves-desconocidas":"descartadas","x-validacion-adicional":true}',
  ],
  ['transformed union publishes its input', z.union([z.string(), z.number()]).transform(String), '{"anyOf":[{"type":"string"},{"type":"number"}]}'],
  ['capped array with a minimum', capped(2), '{"type":"array","items":{"type":"string"},"minItems":2,"maxItems":10}'],
  [
    'capped array under optional',
    z.object({ xs: capped().optional() }),
    '{"type":"object","properties":{"xs":{"type":"array","items":{"type":"string"},"maxItems":10}},"additionalProperties":true,"x-claves-desconocidas":"descartadas"}',
  ],
  ['array of exact length', z.array(z.boolean()).length(2), '{"type":"array","items":{"type":"boolean"},"minItems":2,"maxItems":2}'],
  [
    'record with a constrained key publishes propertyNames after additionalProperties',
    z.record(z.string().min(1), z.number()),
    '{"type":"object","additionalProperties":{"type":"number"},"propertyNames":{"type":"string","minLength":1}}',
  ],
  ['record with a plain string key', z.record(z.string(), z.unknown()), '{"type":"object","additionalProperties":{}}'],
];

describe('the converter serializes each node kind exactly as on zod 3', () => {
  it.each(ROWS)('%s', (label, schema, expected) => {
    expect(JSON.stringify(jsonSchemaDeZod(schema, label))).toBe(expected);
  });
});

type JsonNode = Record<string, unknown>;

function census(): Record<string, number> {
  const counts: Record<string, number> = {
    descartadas: 0,
    conservadas: 0,
    strict: 0,
    refined: 0,
    maxItems: 0,
    uuid: 0,
    email: 0,
    uri: 0,
    integer: 0,
    default: 0,
  };
  const bump = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const n = node as JsonNode;
    if (n['x-claves-desconocidas'] === 'descartadas') bump('descartadas');
    if (n['x-claves-desconocidas'] === 'conservadas') bump('conservadas');
    if (n.additionalProperties === false) bump('strict');
    if (n['x-validacion-adicional'] === true) bump('refined');
    if ('maxItems' in n) bump('maxItems');
    if (n.format === 'uuid') bump('uuid');
    if (n.format === 'email') bump('email');
    if (n.format === 'uri') bump('uri');
    if (n.type === 'integer') bump('integer');
    if ('default' in n) bump('default');
    Object.values(n).forEach(walk);
  };
  const doc = construirOpenAPI(montarSuperficieCensable(express()));
  for (const methods of Object.values(doc.paths as Record<string, Record<string, JsonNode>>)) {
    for (const op of Object.values(methods)) {
      const body = op.requestBody as { content?: Record<string, { schema?: unknown }> } | undefined;
      walk(body?.content?.['application/json']?.schema);
    }
  }
  return counts;
}

describe('the census of every published request body', () => {
  it('keeps the counts measured on zod 3', () => {
    // Measured on the commit that added this file (zod 3.25.76). A strict
    // object that turned passthrough, or an `.int()` that lost its type, moves
    // one of these numbers even when the node that moved is hard to spot.
    expect(census()).toEqual({
      descartadas: 57,
      conservadas: 15,
      strict: 1,
      refined: 11,
      maxItems: 9,
      uuid: 59,
      email: 10,
      uri: 3,
      integer: 11,
      default: 2,
    });
  });
});
