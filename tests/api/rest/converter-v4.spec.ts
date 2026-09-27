import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonSchemaDeZod, ZodNoTraducible } from '../../../src/api/rest/zod-a-json-schema.js';
import { emailString, integerNumber, uuidString } from '../../../src/utils/zod-compat.js';

// The converter against constructs that only exist, or only mean something
// else, on zod 4 (#367).

const convert = (schema: z.core.$ZodType) => jsonSchemaDeZod(schema, 'body');
const refuses = (schema: z.core.$ZodType) => () => convert(schema);

describe('the converter refuses what zod 4 added under familiar classes', () => {
  it.each([
    ['z.xor', z.xor([z.string(), z.number()])],
    ['z.enum of an object with numeric values', z.enum({ A: 1, B: 2 })],
    ['z.looseRecord', z.looseRecord(z.string(), z.number())],
    ['z.partialRecord', z.partialRecord(z.string(), z.number())],
    ['.pipe() to another schema', z.string().pipe(z.string().min(1))],
    ['.catchall() with a type', z.object({ a: z.string() }).catchall(z.string())],
  ])('%s', (_label, schema) => {
    expect(refuses(schema)).toThrow(ZodNoTraducible);
  });
});

describe('the converter reads a format schema (z.url(), z.int()…) as its own first check, as zod runs it', () => {
  // Such a schema IS its check: `_zod.def.checks` does not hold it, and a
  // converter reading that list alone published z.url() as a bare string.
  it.each([
    ['z.url()', z.url(), { type: 'string', format: 'uri' }],
    ['z.url().max(10)', z.url().max(10), { type: 'string', format: 'uri', maxLength: 10 }],
    ['z.email()', z.email(), { type: 'string', format: 'email' }],
    ['z.uuid()', z.uuid(), { type: 'string', format: 'uuid' }],
    ['z.guid()', z.guid(), { type: 'string', format: 'uuid' }],
    ['z.int()', z.int(), { type: 'integer' }],
    ['z.int().min(1).max(208)', z.int().min(1).max(208), { type: 'integer', minimum: 1, maximum: 208 }],
  ])('%s', (_label, schema, expected) => {
    expect(convert(schema)).toEqual(expected);
  });

  it.each([
    ['z.url() with a protocol', z.url({ protocol: /^https$/ })],
    ['z.iso.datetime()', z.iso.datetime()],
    ['z.int32()', z.int32()],
  ])('refuses %s, which it cannot publish', (_label, schema) => {
    expect(refuses(schema)).toThrow(ZodNoTraducible);
  });
});

describe('the converter publishes the compat grammar as the contract always said', () => {
  it('guid is published as format uuid', () => {
    expect(convert(uuidString())).toEqual({ type: 'string', format: 'uuid' });
    expect(convert(z.string().guid())).toEqual({ type: 'string', format: 'uuid' });
  });

  it('an email with its zod 3 pattern is published as the format only', () => {
    expect(convert(emailString())).toEqual({ type: 'string', format: 'email' });
  });

  it('an integer never leaks the safe-integer bounds', () => {
    expect(convert(integerNumber())).toEqual({ type: 'integer' });
    expect(convert(z.number().int())).toEqual({ type: 'integer' });
    expect(convert(integerNumber().min(0))).toEqual({ type: 'integer', minimum: 0 });
  });

  it('a refinement on a transformed value is still flagged', () => {
    expect(convert(z.union([z.string(), z.number()]).transform(String).refine(() => true))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
      'x-validacion-adicional': true,
    });
  });
});
