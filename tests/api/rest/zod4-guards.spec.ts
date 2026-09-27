import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { z } from 'zod';

// ============================================================
// The zod 4 grammar guards of #367, over every schema a client can reach.
//
// src/utils/zod-compat.ts restores zod 3's grammar only where it is used.
// This walks every mounted body schema and the config file schema through
// `_zod.def` and fails on any node that validates with zod 4's own grammar
// instead: a native `.uuid()`, `.url()`, `.int()` or string length, written
// as a method or as a top-level z.uuid(), z.url(), z.int() (which is its own
// check: see checksOf), or one of the shapes zod 3 and zod 4 read
// differently. The walk fails on a kind it does not walk into.
//
// The agent tools are walked too, for string lengths only: their schemas were
// already zod/v4 (the core bundled in zod 3.25.76), and the length count is
// what changed under them.
// ============================================================

// The SDK keeps no reference to a tool's Zod schema, so it is caught on its
// way into betaZodTool.
const toolSchemas = vi.hoisted(() => [] as Array<{ name: string; inputSchema: unknown }>);
vi.mock('@anthropic-ai/sdk/helpers/beta/zod', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk/helpers/beta/zod')>();
  const betaZodTool: typeof actual.betaZodTool = (options) => {
    toolSchemas.push({ name: options.name, inputSchema: options.inputSchema });
    return actual.betaZodTool(options);
  };
  return { ...actual, betaZodTool };
});

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

import { montarSuperficieCensable } from '../../../src/api/rest/montajes.js';
import { censarRutas } from '../../../src/api/rest/risk.js';
import { esquemaDeCuerpo } from '../../../src/api/rest/middleware/async-handler.js';
import { configFileSchema } from '../../../src/ai/providers/config.js';
import type { AgentContext } from '../../../src/ai/context.js';
import { buildTools } from '../../../src/ai/tools/index.js';
import { buildReaderTools } from '../../../src/ai/webhooks/reader-agent.js';
import {
  $ZodCheckLengthUnits,
  $ZodCheckMaxUnits,
  $ZodCheckMinUnits,
  $ZodCheckV3Int,
  $ZodCheckV3Url,
  V3_EMAIL_PATTERN,
  ZodV3Record,
  boundedString,
  checksOf,
  emailString,
  integerNumber,
  urlString,
  uuidString,
} from '../../../src/utils/zod-compat.js';

interface Visit {
  schema: z.core.$ZodType;
  at: string;
}

/** Kinds with nothing inside to walk into. */
const LEAVES = [
  z.core.$ZodString,
  z.core.$ZodNumber,
  z.core.$ZodBoolean,
  z.core.$ZodEnum,
  z.core.$ZodLiteral,
  z.core.$ZodUnknown,
  z.core.$ZodAny,
  z.core.$ZodNull,
  z.core.$ZodNever,
  z.core.$ZodTransform,
];

/**
 * Every node under `root`, with its path. A kind it neither walks into nor
 * knows as a leaf (intersection, lazy, tuple, catch, readonly…) fails the
 * walk: a node it skipped would be a node no guard looked at.
 */
function walk(root: z.core.$ZodType, at: string, out: Visit[] = []): Visit[] {
  out.push({ schema: root, at });
  if (root instanceof z.core.$ZodOptional || root instanceof z.core.$ZodNullable || root instanceof z.core.$ZodDefault) {
    walk(root._zod.def.innerType, at, out);
  } else if (root instanceof z.core.$ZodPipe) {
    walk(root._zod.def.in, `${at}<in>`, out);
    walk(root._zod.def.out, `${at}<out>`, out);
  } else if (root instanceof z.core.$ZodArray) {
    walk(root._zod.def.element, `${at}[]`, out);
  } else if (root instanceof z.core.$ZodObject) {
    for (const [key, value] of Object.entries(root._zod.def.shape)) walk(value, `${at}.${key}`, out);
    if (root._zod.def.catchall) walk(root._zod.def.catchall, `${at}.*`, out);
  } else if (root instanceof z.core.$ZodRecord) {
    walk(root._zod.def.keyType, `${at}<key>`, out);
    walk(root._zod.def.valueType, `${at}.*`, out);
  } else if (root instanceof z.core.$ZodUnion) {
    root._zod.def.options.forEach((option, i) => walk(option, `${at}|${i}`, out));
  } else if (!LEAVES.some((leaf) => root instanceof leaf)) {
    throw new Error(`${at}: the guards do not walk into a "${root._zod.def.type}" schema; teach walk() before using it`);
  }
  return out;
}

function everyNode(): Visit[] {
  const nodes: Visit[] = [];
  const seen = new Set<unknown>();
  for (const route of censarRutas(montarSuperficieCensable(express()))) {
    for (const handler of route.manejadores) {
      const schema = esquemaDeCuerpo(handler);
      if (schema === undefined || seen.has(schema)) continue;
      seen.add(schema);
      walk(schema, `${route.metodo.toUpperCase()} ${route.ruta}`, nodes);
    }
  }
  walk(configFileSchema, 'mnemosine.config.json', nodes);
  return nodes;
}

const NODES = everyNode();

/** The schema a wrapper validates with first: its inner type, or a pipe's input. */
const unwrap = (schema: z.core.$ZodType): z.core.$ZodType => {
  if (schema instanceof z.core.$ZodOptional || schema instanceof z.core.$ZodNullable || schema instanceof z.core.$ZodDefault) {
    return unwrap(schema._zod.def.innerType);
  }
  return schema instanceof z.core.$ZodPipe ? unwrap(schema._zod.def.in) : schema;
};

function offenders(test: (visit: Visit) => string | undefined, nodes: Visit[] = NODES): string[] {
  return nodes.map((visit) => test(visit)).filter((found): found is string => found !== undefined);
}

// Each guard reads checksOf(schema), the list zod itself runs: a format
// schema (z.url(), z.email(), z.uuid(), z.int()) IS its first check and is
// not in `_zod.def.checks`.
const GUARDS = {
  uuid: ({ schema, at }: Visit) =>
    checksOf(schema).some((c) => c instanceof z.core.$ZodCheckStringFormat && c._zod.def.format === 'uuid')
      ? at
      : undefined,
  email: ({ schema, at }: Visit) =>
    checksOf(schema).some(
      (c) =>
        c instanceof z.core.$ZodCheckStringFormat &&
        c._zod.def.format === 'email' &&
        c._zod.def.pattern !== V3_EMAIL_PATTERN
    )
      ? at
      : undefined,
  url: ({ schema, at }: Visit) =>
    checksOf(schema).some(
      (c) => c instanceof z.core.$ZodCheckStringFormat && c._zod.def.format === 'url' && !(c instanceof $ZodCheckV3Url)
    )
      ? at
      : undefined,
  lengths: ({ schema, at }: Visit) =>
    schema instanceof z.core.$ZodString &&
    checksOf(schema).some(
      (c) =>
        (c instanceof z.core.$ZodCheckMinLength && !(c instanceof $ZodCheckMinUnits)) ||
        (c instanceof z.core.$ZodCheckMaxLength && !(c instanceof $ZodCheckMaxUnits)) ||
        (c instanceof z.core.$ZodCheckLengthEquals && !(c instanceof $ZodCheckLengthUnits))
    )
      ? at
      : undefined,
  integer: ({ schema, at }: Visit) =>
    checksOf(schema).some((c) => c instanceof z.core.$ZodCheckNumberFormat && !(c instanceof $ZodCheckV3Int))
      ? at
      : undefined,
};

describe('the guards catch zod 4 grammar however it is written', () => {
  it.each([
    ['uuid', 'z.string().uuid()', z.string().uuid()],
    ['uuid', 'z.uuid()', z.uuid()],
    ['email', 'z.string().email()', z.string().email()],
    ['email', 'z.email()', z.email()],
    ['url', 'z.string().url()', z.string().url()],
    ['url', 'z.url()', z.url()],
    ['lengths', 'z.string().max(3)', z.string().max(3)],
    ['lengths', 'z.url().max(3)', z.url().max(3)],
    ['integer', 'z.number().int()', z.number().int()],
    ['integer', 'z.int()', z.int()],
    ['integer', 'z.int().min(1).max(208)', z.int().min(1).max(208)],
  ] as const)('%s: %s', (guard, _label, field) => {
    expect(offenders(GUARDS[guard], walk(z.object({ field: field.optional() }), 'probe'))).toEqual(['probe.field']);
  });

  it.each([
    ['uuid', uuidString()],
    ['email', emailString()],
    ['url', urlString()],
    ['lengths', boundedString({ min: 2, max: 3 })],
    ['integer', integerNumber()],
  ] as const)('%s: not the compat helper', (guard, field) => {
    expect(offenders(GUARDS[guard], walk(z.object({ field }), 'probe'))).toEqual([]);
  });

  it.each([
    ['an intersection', z.intersection(z.object({ a: z.string() }), z.object({ b: z.url() }))],
    ['a lazy', z.lazy(() => z.url())],
    ['a tuple', z.tuple([z.url()])],
    ['a catch', z.url().catch('x')],
    ['a readonly', z.object({ u: z.url() }).readonly()],
  ])('the walk refuses %s instead of skipping it', (_label, field) => {
    expect(() => walk(z.object({ field }), 'probe')).toThrow(/do not walk into/);
  });
});

describe('every client-reachable schema validates with the zod 3 grammar', () => {
  it('reaches the whole surface', () => {
    expect(NODES.length).toBeGreaterThan(750);
  });

  it('checks uuids as guid, the zod 3 grammar, never as RFC 9562 uuid', () => {
    expect(offenders(GUARDS.uuid)).toEqual([]);
    const guids = NODES.flatMap(({ schema }) => checksOf(schema).filter((c) => c instanceof z.core.$ZodGUID));
    expect(guids.length).toBeGreaterThanOrEqual(45);
  });

  it('checks emails with the zod 3 regex', () => {
    expect(offenders(GUARDS.email)).toEqual([]);
  });

  it('checks urls with $ZodCheckV3Url, which neither trims nor rewrites', () => {
    expect(offenders(GUARDS.url)).toEqual([]);
  });

  it('measures string lengths in UTF-16 units', () => {
    expect(offenders(GUARDS.lengths)).toEqual([]);
  });

  it('checks integers with $ZodCheckV3Int, which does not hide the bounds', () => {
    expect(offenders(GUARDS.integer)).toEqual([]);
  });

  it('has none of the shapes zod 3 and zod 4 read differently', () => {
    expect(
      offenders(({ schema, at }) => {
        if (schema instanceof z.core.$ZodOptional && schema._zod.def.innerType instanceof z.core.$ZodDefault) {
          return `${at}: a default under optional`;
        }
        if (schema instanceof z.core.$ZodObject) {
          const bare = Object.entries(schema._zod.def.shape).find(
            ([, value]) => value instanceof z.core.$ZodUnknown || value instanceof z.core.$ZodAny
          );
          if (bare) return `${at}.${bare[0]}: a bare unknown property`;
        }
        if (schema instanceof z.core.$ZodRecord) {
          if (!(schema._zod.def.keyType instanceof z.core.$ZodString)) return `${at}: a record keyed by a non-string`;
          if (schema._zod.def.mode === 'loose') return `${at}: a loose record`;
          // zod 4 skips an own `__proto__` entry unvalidated; zod 3 checked it.
          if (!(schema._zod.def.valueType instanceof z.core.$ZodUnknown) && !(schema instanceof ZodV3Record)) {
            return `${at}: a typed record not built with recordOf`;
          }
        }
        if (schema instanceof z.core.$ZodUnion) {
          // zod 3 answered ±Infinity on a checked number branch with that
          // branch's issues; zod 4 aborts the branch and says 'Invalid input',
          // which src/utils/zod-client-errors.ts cannot turn back.
          const checked = schema._zod.def.options
            .map(unwrap)
            .some((option) => option instanceof z.core.$ZodNumber && checksOf(option).length > 0);
          if (checked) return `${at}: a union with a checked number branch`;
        }
        return undefined;
      })
    ).toEqual([]);
  });

  it('gives every default a value its own schema parses to itself, so skipping the parse changes nothing', () => {
    const defaults = NODES.filter(({ schema }) => schema instanceof z.core.$ZodDefault);
    expect(defaults.length).toBeGreaterThanOrEqual(2);
    for (const { schema, at } of defaults) {
      if (!(schema instanceof z.core.$ZodDefault)) continue;
      const value: unknown = schema._zod.def.defaultValue;
      const reparsed = z.safeParse(schema._zod.def.innerType, value);
      expect(reparsed, at).toEqual({ success: true, data: value });
    }
  });
});

describe('every agent tool input counts string lengths in UTF-16 units', () => {
  const context: AgentContext = {
    entityId: '11111111-1111-4111-8111-111111111111',
    entityName: 'Guard',
    tenantId: '22222222-2222-4222-8222-222222222222',
    currency: 'MXN',
    country: 'MX',
    accountingStandard: 'NIF',
    taxId: 'XAXX010101000',
  };
  toolSchemas.length = 0;
  const built = [...buildTools(context, { model: 'guard' }), ...buildReaderTools(context, { model: 'guard' })];
  const tools = [...toolSchemas];

  it('reaches the schema of every tool the model can call', () => {
    const custom = built.filter((tool) => 'input_schema' in tool).map((tool) => tool.name);
    expect(tools.map((tool) => tool.name).sort()).toEqual(custom.sort());
    expect(tools.length).toBeGreaterThan(20);
  });

  it('bounds no string with a native check whose count moved to code points', () => {
    // A minimum of 0 or 1 counts the same either way; any other bound does not.
    const moved = (c: z.core.$ZodCheck): boolean => {
      if (c instanceof $ZodCheckMinUnits || c instanceof $ZodCheckMaxUnits || c instanceof $ZodCheckLengthUnits) return false;
      if (c instanceof z.core.$ZodCheckMinLength) return c._zod.def.minimum > 1;
      return c instanceof z.core.$ZodCheckMaxLength || c instanceof z.core.$ZodCheckLengthEquals;
    };
    const offenders = tools
      .flatMap(({ name, inputSchema }) => walk(inputSchema as z.core.$ZodType, `tool:${name}`))
      .filter(({ schema }) => schema instanceof z.core.$ZodString && checksOf(schema).some(moved))
      .map(({ at }) => at);
    expect(offenders).toEqual([]);
  });
});
