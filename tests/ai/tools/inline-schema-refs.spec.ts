import { describe, expect, it } from 'vitest';
import { inlineLocalRefs, withInlinedInputSchema } from '../../../src/ai/tools/inline-schema-refs.js';

describe('inlineLocalRefs', () => {
  it('returns the same reference when there is nothing to inline', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(inlineLocalRefs(schema)).toBe(schema);
  });

  it('resolves nested refs, layers the ref node over its definition, and drops $defs', () => {
    const schema = {
      type: 'object',
      properties: {
        options: { description: 'choices', $ref: '#/$defs/__schema1' },
        plain: { type: 'boolean' },
      },
      $defs: {
        __schema1: { type: 'array', items: { $ref: '#/$defs/__schema2' }, description: 'overridden' },
        __schema2: { type: 'string', minLength: 1 },
      },
    };
    expect(inlineLocalRefs(schema)).toEqual({
      type: 'object',
      properties: {
        options: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'choices' },
        plain: { type: 'boolean' },
      },
    });
  });

  it('refuses an unknown ref', () => {
    expect(() => inlineLocalRefs({ $defs: {}, properties: { a: { $ref: '#/$defs/missing' } } })).toThrow(
      /names no definition/
    );
  });

  it('refuses a cyclic ref', () => {
    const schema = {
      properties: { a: { $ref: '#/$defs/x' } },
      $defs: { x: { items: { $ref: '#/$defs/y' } }, y: { items: { $ref: '#/$defs/x' } } },
    };
    expect(() => inlineLocalRefs(schema)).toThrow(/cyclic ref x -> y -> x/);
  });

  it('refuses a ref it cannot resolve locally', () => {
    expect(() => inlineLocalRefs({ $defs: {}, properties: { a: { $ref: 'https://x/y.json' } } })).toThrow(
      /not a local \$defs ref/
    );
  });
});

describe('withInlinedInputSchema', () => {
  it('keeps a tool with no refs as the same object, and a server tool untouched', () => {
    const tool = { name: 't', input_schema: { type: 'object' as const, properties: {} } };
    expect(withInlinedInputSchema(tool)).toBe(tool);
    const server = { name: 'memory', type: 'memory_20250818' };
    expect(withInlinedInputSchema(server)).toBe(server);
  });

  it('replaces only the input schema, keeping every other key', () => {
    const run = () => 'ok';
    const tool = {
      name: 't',
      run,
      input_schema: { type: 'object' as const, properties: { a: { $ref: '#/$defs/s' } }, $defs: { s: { type: 'string' } } },
    };
    const out = withInlinedInputSchema(tool);
    expect(out.run).toBe(run);
    expect(out.input_schema).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
  });
});
