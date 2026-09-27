import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonSchemaDeZod, ZodNoTraducible } from '../../../src/api/rest/zod-a-json-schema.js';

// ============================================================
// Three shapes zod 3 and zod 4 validate DIFFERENTLY, refused on both (#367).
//
// None is mounted today (`scripts/openapi.ts --check` proves it). The day a
// route writes one, the contract test fails here, naming the field, instead
// of the Zod upgrade silently changing what the route accepts or returns.
// ============================================================

function refusal(schema: z.ZodType): string {
  try {
    jsonSchemaDeZod(schema, 'body');
  } catch (err) {
    if (err instanceof ZodNoTraducible) return `${err.donde}: ${err.message}`;
    throw err;
  }
  return 'translated';
}

describe('the converter refuses what the two Zod majors read differently', () => {
  it('a bare z.unknown() or z.any() property, which only zod 4 requires', () => {
    expect(refusal(z.object({ a: z.unknown() }))).toMatch(/^body\.a: .*bare `z\.unknown\(\)` or `z\.any\(\)`/);
    expect(refusal(z.object({ a: z.any() }))).toMatch(/^body\.a: .*bare `z\.unknown\(\)` or `z\.any\(\)`/);
    expect(refusal(z.object({ a: z.unknown().optional() }))).toBe('translated');
    expect(refusal(z.record(z.string(), z.unknown()))).toBe('translated');
  });

  it('a default under optional, which only zod 4 fills in', () => {
    expect(refusal(z.object({ a: z.string().default('x').optional() }))).toMatch(
      /^body\.a: .*`\.default\(\)` wrapped in `\.optional\(\)`/
    );
    expect(refusal(z.object({ a: z.string().default('x') }).partial())).toMatch(/wrapped in `\.optional\(\)`/);
    expect(refusal(z.object({ a: z.string().default('x') }))).toBe('translated');
  });

  it('an enum-keyed record, which only zod 4 makes exhaustive', () => {
    expect(refusal(z.record(z.enum(['a', 'b']), z.number()))).toMatch(/^body: .*llaves del diccionario/);
  });
});
