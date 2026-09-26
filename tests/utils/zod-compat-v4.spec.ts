import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  $ZodCheckLengthUnits,
  $ZodCheckMaxUnits,
  $ZodCheckMinUnits,
  $ZodCheckV3Int,
  $ZodCheckV3Url,
  boundedString,
  integerNumber,
  urlString,
  uuidString,
} from '../../src/utils/zod-compat.js';
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
