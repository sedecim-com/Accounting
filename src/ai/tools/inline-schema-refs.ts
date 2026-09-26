// ============================================================
// CONTRACT: the input schema an agent tool sends to the model.
//
// `betaZodTool` (@anthropic-ai/sdk) turns each tool's Zod schema into JSON
// Schema with `z.toJSONSchema(schema, { reused: 'ref' })`. On the zod/v4 core
// bundled in zod 3.25.76 that output has no `$ref`; on zod 4.6.5 every
// described optional field moves to `$defs/__schemaN` behind a `$ref` (#367).
// The schema says the same thing either way, but openai-compat.ts forwards it
// verbatim to OpenAI-compatible servers, and a local server that does not
// resolve `$ref` would see fields with no type at all.
//
// So both tool builders inline local refs before a schema leaves the process,
// and tests/ai/tools/tool-schemas.golden.json pins the result.
// ============================================================

export type JsonSchemaObject = { [key: string]: unknown };

const LOCAL_REF = '#/$defs/';

function isObject(value: unknown): value is JsonSchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolves every `#/$defs/<name>` in `schema` and drops `$defs`.
 *
 * A schema without `$defs` is returned as the same reference. A ref node's own
 * keys (a `description`, typically) are layered over the definition it names.
 * An unknown, non-local or cyclic ref throws: inlining must never publish a
 * schema that says less than the one it replaces.
 */
export function inlineLocalRefs(schema: JsonSchemaObject): JsonSchemaObject {
  const defs = schema.$defs;
  if (defs === undefined) return schema;
  if (!isObject(defs)) throw new Error('inlineLocalRefs: $defs is not an object');

  const resolveValue = (value: unknown, stack: readonly string[]): unknown => {
    if (Array.isArray(value)) return value.map((v: unknown) => resolveValue(v, stack));
    return isObject(value) ? resolveObject(value, stack) : value;
  };

  const resolveObject = (node: JsonSchemaObject, stack: readonly string[]): JsonSchemaObject => {
    const ref = node.$ref;
    if (typeof ref === 'string') {
      if (!ref.startsWith(LOCAL_REF)) throw new Error(`inlineLocalRefs: ${ref} is not a local $defs ref`);
      const name = ref.slice(LOCAL_REF.length);
      const target = defs[name];
      if (!isObject(target)) throw new Error(`inlineLocalRefs: ${ref} names no definition`);
      if (stack.includes(name)) {
        throw new Error(`inlineLocalRefs: cyclic ref ${[...stack, name].join(' -> ')}`);
      }
      const siblings: JsonSchemaObject = {};
      for (const [key, value] of Object.entries(node)) if (key !== '$ref') siblings[key] = value;
      return resolveObject({ ...target, ...siblings }, [...stack, name]);
    }
    const out: JsonSchemaObject = {};
    for (const [key, value] of Object.entries(node)) {
      if (key !== '$defs') out[key] = resolveValue(value, stack);
    }
    return out;
  };

  return resolveObject(schema, []);
}

/**
 * The same tool, with its input schema inlined; the same object when there was
 * nothing to inline. Server tools (memory, bash…) carry no `input_schema` and
 * pass through untouched.
 */
export function withInlinedInputSchema<T extends object>(tool: T): T {
  if (!('input_schema' in tool) || !isObject(tool.input_schema)) return tool;
  const inlined = inlineLocalRefs(tool.input_schema);
  if (inlined === tool.input_schema) return tool;
  return { ...tool, input_schema: { ...inlined, type: 'object' } };
}
