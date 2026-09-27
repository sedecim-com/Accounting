import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  $ZodCheckLengthUnits,
  $ZodCheckMaxUnits,
  $ZodCheckMinUnits,
  $ZodCheckV3Int,
  $ZodCheckV3Url,
  boundedString,
  ZodV3Record,
  integerNumber,
  recordOf,
  urlString,
  uuidString,
} from '../../src/utils/zod-compat.js';
import { parseForClient } from '../../src/utils/zod-client-errors.js';
import { arregloAcotado, cotaDeArreglo } from '../../src/api/rest/topes.js';

// The compat checks of #367 are read by the converter as the zod built-ins
// they replace, so they must keep the base traits and def fields.

function onlyCheck(schema: z.core.$ZodType): z.core.$ZodCheck {
  const checks = schema._zod.def.checks ?? [];
  expect(checks).toHaveLength(1);
  const [check] = checks;
  if (check === undefined) throw new Error('no check');
  return check;
}

describe('the compat checks are the built-ins they replace, to any reader', () => {
  it('string lengths', () => {
    const [min, max, length] = boundedString({ min: 1, max: 5, length: 3 })._zod.def.checks ?? [];
    expect(min).toBeInstanceOf($ZodCheckMinUnits);
    expect(min).toBeInstanceOf(z.core.$ZodCheckMinLength);
    expect(min?._zod.def).toMatchObject({ check: 'min_length', minimum: 1 });
    expect(max).toBeInstanceOf($ZodCheckMaxUnits);
    expect(max).toBeInstanceOf(z.core.$ZodCheckMaxLength);
    expect(max?._zod.def).toMatchObject({ check: 'max_length', maximum: 5 });
    expect(length).toBeInstanceOf($ZodCheckLengthUnits);
    expect(length).toBeInstanceOf(z.core.$ZodCheckLengthEquals);
    expect(length?._zod.def).toMatchObject({ check: 'length_equals', length: 3 });
  });

  it('url', () => {
    const check = onlyCheck(urlString());
    expect(check).toBeInstanceOf($ZodCheckV3Url);
    expect(check).toBeInstanceOf(z.core.$ZodCheckStringFormat);
    expect(check._zod.def).toMatchObject({ check: 'string_format', format: 'url' });
  });

  it('integer', () => {
    const check = onlyCheck(integerNumber());
    expect(check).toBeInstanceOf($ZodCheckV3Int);
    expect(check).toBeInstanceOf(z.core.$ZodCheckNumberFormat);
    expect(check._zod.def).toMatchObject({ check: 'number_format', format: 'safeint' });
  });

  it('uuid is guid, the zod 3 grammar', () => {
    const check = onlyCheck(uuidString());
    expect(check).toBeInstanceOf(z.core.$ZodGUID);
    expect(check._zod.def).toMatchObject({ check: 'string_format', format: 'guid' });
  });

  it('a custom message outranks the per-parse map, as `.min(n, msg)` does', () => {
    const parsed = boundedString({ min: 2 }, { min: 'too short' }).safeParse('a', { error: () => 'map' });
    expect(parsed.error?.issues[0]?.message).toBe('too short');
  });

  it('a length check measures nothing but strings', () => {
    // After a failed type check the value is still there, and zod's own
    // `when` would measure an array's length; the units checks do not.
    const parsed = boundedString({ min: 5 }).safeParse(['a']);
    expect(parsed.error?.issues.map((i) => i.code)).toEqual(['invalid_type']);
  });
});

describe('the array cap travels on its check', () => {
  const capped = arregloAcotado(z.string(), { tope: 3, plural: 'filas', salida: 'Parte el lote.', minimo: 1 });
  const inner = (schema: z.core.$ZodType): z.core.$ZodType =>
    schema instanceof z.core.$ZodOptional ? schema._zod.def.innerType : schema;

  it('survives .optional(), .describe() and .refine()', () => {
    expect(cotaDeArreglo(capped)).toBe(3);
    expect(cotaDeArreglo(inner(capped.optional()))).toBe(3);
    expect(cotaDeArreglo(capped.describe('rows'))).toBe(3);
    expect(cotaDeArreglo(capped.refine(() => true))).toBe(3);
  });

  it('is not found on an array that only looks capped', () => {
    expect(cotaDeArreglo(z.array(z.string()).max(3))).toBeUndefined();
    expect(cotaDeArreglo(z.array(z.string()).superRefine(() => undefined))).toBeUndefined();
  });

  it('reports after the element issues, and only when nothing aborted', () => {
    const rows = z.object({ rows: capped });
    const tooMany = rows.safeParse({ rows: ['a', 'b', 'c', 1] });
    expect(tooMany.error?.issues.map((i) => [i.path.join('.'), i.code])).toEqual([['rows.3', 'invalid_type']]);
    const valid = rows.safeParse({ rows: ['a', 'b', 'c', 'd'] });
    expect(valid.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['rows', 'llegaron 4 filas y caben 3 por petición. Parte el lote.'],
    ]);
  });
});

describe('recordOf checks an own __proto__ entry, as zod 3 did', () => {
  // JSON.parse keeps `__proto__` as an own key; express.json and the config
  // loader both use it. The expectations were recorded on zod 3.25.76 with
  // z.record(z.string(), value), which recordOf replaces.
  const json = (text: string): unknown => JSON.parse(text);

  it('is a record to any reader, and publishes the same JSON Schema', () => {
    const schema = recordOf(z.number());
    expect(schema).toBeInstanceOf(ZodV3Record);
    expect(schema).toBeInstanceOf(z.core.$ZodRecord);
    expect(schema).toBeInstanceOf(z.ZodRecord);
    expect(schema._zod.def.keyType).toBeInstanceOf(z.core.$ZodString);
    expect(z.toJSONSchema(schema)).toEqual(z.toJSONSchema(z.record(z.string(), z.number())));
  });

  it('reports the entry in key order, and each other key as before', () => {
    expect(parseForClient(recordOf(z.number()), json('{"a":"y","__proto__":"x","b":"z"}'))).toEqual({
      success: false,
      issues: [
        { path: 'a', message: 'Expected number, received string' },
        { path: '__proto__', message: 'Expected number, received string' },
        { path: 'b', message: 'Expected number, received string' },
      ],
    });
    expect(parseForClient(recordOf(z.number()), json('{"__proto__":"x","1":"y"}'))).toEqual({
      success: false,
      issues: [
        { path: '1', message: 'Expected number, received string' },
        { path: '__proto__', message: 'Expected number, received string' },
      ],
    });
  });

  it('keeps the check through .optional(), .nullable() and .describe()', () => {
    const body = json('{"__proto__":"x"}');
    for (const schema of [recordOf(z.number()).optional(), recordOf(z.number()).nullable(), recordOf(z.number()).describe('d')]) {
      expect(schema.safeParse(body).success).toBe(false);
    }
  });

  it('leaves a valid entry out of the output and the prototype alone', () => {
    const parsed = recordOf(z.object({ polluted: z.boolean() })).parse(json('{"__proto__":{"polluted":true},"a":{"polluted":false}}'));
    expect(Object.keys(parsed)).toEqual(['a']);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('checks the entry in an async parse too', async () => {
    const schema = recordOf(z.string().refine(async (v) => v === 'ok', 'not ok'));
    const parsed = await schema.safeParseAsync(json('{"a":"ok","__proto__":"no","b":"no"}'));
    expect(parsed.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['__proto__', 'not ok'],
      ['b', 'not ok'],
    ]);
  });
});

describe('urlString answers as `new URL` does, however warm the process is', () => {
  // Node 22's URL.canParse answers false for a Latin-1 URL with a non-ASCII
  // host once V8 optimizes the call; `new URL` still parses it (zod 3 used it).
  const IDN = ['https://señal.mx/hook', 'https://müller.de', 'https://ñ.com'];

  it('accepts an IDN host after 20k JSON-parsed bodies', () => {
    const body = z.object({ url: urlString(), events: z.array(z.enum(['a', 'b'])).min(1) });
    for (let i = 0; i < 20_000; i++) parseForClient(body, JSON.parse(`{"url":"https://a${i % 7}.com/x","events":["a"]}`));
    for (const url of IDN) expect(parseForClient(body, { url, events: ['a'] }), url).toMatchObject({ success: true });
  });

  it('does not lean on URL.canParse', () => {
    const canParse = vi.spyOn(URL, 'canParse').mockReturnValue(false);
    try {
      for (const url of ['https://a.com', ...IDN]) expect(urlString().safeParse(url).success, url).toBe(true);
      expect(urlString().safeParse('not a url').success).toBe(false);
    } finally {
      canParse.mockRestore();
    }
  });
});
