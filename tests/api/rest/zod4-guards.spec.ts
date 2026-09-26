import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { z } from 'zod';

// ============================================================
// The zod 4 grammar guards of #367, over every schema a client can reach.
//
// src/utils/zod-compat.ts restores zod 3's grammar only where it is used.
// This walks every mounted body schema and the config file schema through
// `_zod.def` and fails on any node that validates with zod 4's own grammar
// instead: a native `.uuid()`, `.url()`, `.int()` or string length, or one
// of the shapes zod 3 and zod 4 read differently.
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

import { montarSuperficieCensable } from '../../../src/api/rest/montajes.js';
import { censarRutas } from '../../../src/api/rest/risk.js';
import { esquemaDeCuerpo } from '../../../src/api/rest/middleware/async-handler.js';
import { configFileSchema } from '../../../src/ai/providers/config.js';
import {
  $ZodCheckLengthUnits,
  $ZodCheckMaxUnits,
  $ZodCheckMinUnits,
  $ZodCheckV3Int,
  $ZodCheckV3Url,
  V3_EMAIL_PATTERN,
} from '../../../src/utils/zod-compat.js';

interface Visit {
  schema: z.core.$ZodType;
  at: string;
}

/** Every node under `root`, with its path. */
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

function offenders(test: (visit: Visit) => string | undefined): string[] {
  return NODES.map((visit) => test(visit)).filter((found): found is string => found !== undefined);
}

describe('every client-reachable schema validates with the zod 3 grammar', () => {
  it('reaches the whole surface', () => {
    expect(NODES.length).toBeGreaterThan(750);
  });

  it('checks uuids as guid, the zod 3 grammar, never as RFC 9562 uuid', () => {
    const formats = NODES.flatMap(({ schema, at }) =>
      (schema._zod.def.checks ?? [])
        .filter((c) => c instanceof z.core.$ZodCheckStringFormat)
        .filter((c) => c._zod.def.format === 'uuid')
        .map(() => at)
    );
    expect(formats).toEqual([]);
    const guids = NODES.flatMap(({ schema }) =>
      (schema._zod.def.checks ?? []).filter((c) => c instanceof z.core.$ZodGUID)
    );
    expect(guids.length).toBeGreaterThanOrEqual(45);
  });

  it('checks emails with the zod 3 regex', () => {
    expect(
      offenders(({ schema, at }) =>
        (schema._zod.def.checks ?? []).some(
          (c) =>
            c instanceof z.core.$ZodCheckStringFormat &&
            c._zod.def.format === 'email' &&
            c._zod.def.pattern !== V3_EMAIL_PATTERN
        )
          ? at
          : undefined
      )
    ).toEqual([]);
  });

  it('checks urls with $ZodCheckV3Url, which neither trims nor rewrites', () => {
    expect(
      offenders(({ schema, at }) =>
        (schema._zod.def.checks ?? []).some(
          (c) =>
            c instanceof z.core.$ZodCheckStringFormat && c._zod.def.format === 'url' && !(c instanceof $ZodCheckV3Url)
        )
          ? at
          : undefined
      )
    ).toEqual([]);
  });

  it('measures string lengths in UTF-16 units', () => {
    expect(
      offenders(({ schema, at }) =>
        schema instanceof z.core.$ZodString &&
        (schema._zod.def.checks ?? []).some(
          (c) =>
            (c instanceof z.core.$ZodCheckMinLength && !(c instanceof $ZodCheckMinUnits)) ||
            (c instanceof z.core.$ZodCheckMaxLength && !(c instanceof $ZodCheckMaxUnits)) ||
            (c instanceof z.core.$ZodCheckLengthEquals && !(c instanceof $ZodCheckLengthUnits))
        )
          ? at
          : undefined
      )
    ).toEqual([]);
  });

  it('checks integers with $ZodCheckV3Int, which does not hide the bounds', () => {
    expect(
      offenders(({ schema, at }) =>
        (schema._zod.def.checks ?? []).some(
          (c) => c instanceof z.core.$ZodCheckNumberFormat && !(c instanceof $ZodCheckV3Int)
        )
          ? at
          : undefined
      )
    ).toEqual([]);
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
