import { z } from 'zod';

// ============================================================
// CONTRACT: one helper per validation whose grammar zod 4 changed (#367).
//
// The owner's decision on #367 is that the move to Zod 4 accepts and rejects
// exactly what zod 3.25.76 did, and parses to the same output. Zod 4 changed
// six grammars the REST bodies and the config file use, and each one is
// restored here:
//
//   uuidString     `.uuid()` became RFC 9562 (version and variant nibbles).
//                  `.guid()` is zod 3's grammar: v3's regex is
//                  /^[0-9a-fA-F]{8}\b-…{12}$/i and its `\b` and `i` are both
//                  redundant next to explicit hex classes, so the two match
//                  the same strings (tests/utils/zod-compat.spec.ts fuzzes it).
//   emailString    the email regex was rewritten; zod 3's is passed back in
//                  as the pattern, verbatim.
//   urlString      `.url()` trims its input before parsing and returns the
//                  normalized URL; $ZodCheckV3Url parses the raw string with
//                  `new URL` in a try/catch, as zod 3 did, and never rewrites
//                  the value. NOT `URL.canParse`: on Node 22 it answers false
//                  for a Latin-1 URL with a non-ASCII host (https://señal.mx)
//                  once V8 optimizes the call, so what it accepted would
//                  depend on how warm the process is.
//   boundedString  lengths count code points; the units checks below count
//                  UTF-16 units, as zod 3 did and as every maxLength that
//                  docs/openapi.json publishes says. The agent tools use it
//                  too: the zod/v4 core bundled in zod 3.25.76 counted units.
//   integerNumber  a failed `.int()` stops the checks after it; $ZodCheckV3Int
//                  lets the bounds report too, in zod 3's order.
//   recordOf       `z.record` skips an own `__proto__` entry (JSON.parse keeps
//                  one) without validating it; ZodV3Record validates it in
//                  key order, as zod 3 did, and still leaves it out.
//   toolRecordOf   the agent tools ran on the zod/v4 core bundled in zod
//                  3.25.76, whose record refused an object with an own
//                  `constructor` that is not a function with a prototype
//                  ({"constructor":"x"}); zod 4 accepts it. ZodToolRecord
//                  refuses it again, with the record's own issue.
//
// The checks subclass zod's own ($ZodCheckMaxLength, $ZodCheckStringFormat,
// $ZodCheckNumberFormat…) and ZodV3Record and ZodToolRecord subclass
// ZodRecord, so they keep the base traits and `def`: the converter
// (src/api/rest/zod-a-json-schema.ts) and the tool schema export read them as
// the built-ins they replace. They rely on `z.core.$constructor`,
// the base `init`, `_zod.check` and `_zod.parse`; tests/api/rest/zod4-guards.spec.ts
// and the goldens fail loudly on a Zod minor that reshapes any of them.
//
// CONTRACT: the ONE deliberate tightening this file owns (T2 in #367): an
// integer beyond ±(2^53 − 1), which JSON cannot carry exactly, is rejected
// (declared with T1 in catalog-info.yaml, under provides.api for the REST
// bodies and provides.cli for mnemosine.config.json).
// To revert it, delete the range branch of $ZodCheckV3Int.
// ============================================================

/**
 * The checks zod runs on `schema`, in its order. A format schema (z.url(),
 * z.email(), z.uuid(), z.int()) is itself its first check and is not in
 * `_zod.def.checks`, so a reader of that list alone would not see it.
 */
export function checksOf(schema: z.core.$ZodType): z.core.$ZodCheck[] {
  const own = schema._zod.traits.has('$ZodCheck') ? [schema as unknown as z.core.$ZodCheck] : [];
  return [...own, ...(schema._zod.def.checks ?? [])];
}

/** zod 3.25.76, v3/types.js:384, verbatim. */
export const V3_EMAIL_PATTERN =
  /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;

/** Length checks run on strings only: after a failed type check there is nothing to measure. */
const onStrings = (payload: z.core.ParsePayload): boolean => typeof payload.value === 'string';

export const $ZodCheckMaxUnits = z.core.$constructor(
  '$ZodCheckMaxUnits',
  (inst: z.core.$ZodCheckMaxLength<string>, def: z.core.$ZodCheckMaxLengthDef) => {
    def.when ??= onStrings;
    z.core.$ZodCheckMaxLength.init(inst, def);
    inst._zod.check = (payload) => {
      const input = payload.value;
      if (input.length <= def.maximum) return;
      payload.issues.push({
        origin: 'string',
        code: 'too_big',
        maximum: def.maximum,
        inclusive: true,
        input,
        inst,
        continue: !def.abort,
      });
    };
  }
);

export const $ZodCheckMinUnits = z.core.$constructor(
  '$ZodCheckMinUnits',
  (inst: z.core.$ZodCheckMinLength<string>, def: z.core.$ZodCheckMinLengthDef) => {
    def.when ??= onStrings;
    z.core.$ZodCheckMinLength.init(inst, def);
    inst._zod.check = (payload) => {
      const input = payload.value;
      if (input.length >= def.minimum) return;
      payload.issues.push({
        origin: 'string',
        code: 'too_small',
        minimum: def.minimum,
        inclusive: true,
        input,
        inst,
        continue: !def.abort,
      });
    };
  }
);

export const $ZodCheckLengthUnits = z.core.$constructor(
  '$ZodCheckLengthUnits',
  (inst: z.core.$ZodCheckLengthEquals<string>, def: z.core.$ZodCheckLengthEqualsDef) => {
    def.when ??= onStrings;
    z.core.$ZodCheckLengthEquals.init(inst, def);
    inst._zod.check = (payload) => {
      const input = payload.value;
      if (input.length === def.length) return;
      const bound =
        input.length > def.length
          ? { code: 'too_big' as const, maximum: def.length }
          : { code: 'too_small' as const, minimum: def.length };
      payload.issues.push({
        origin: 'string',
        ...bound,
        inclusive: true,
        exact: true,
        input,
        inst,
        continue: !def.abort,
      });
    };
  }
);

export const $ZodCheckV3Url = z.core.$constructor(
  '$ZodCheckV3Url',
  (inst: z.core.$ZodCheckStringFormat, def: z.core.$ZodCheckStringFormatDef<'url'>) => {
    z.core.$ZodCheckStringFormat.init(inst, def);
    inst._zod.check = (payload) => {
      try {
        new URL(payload.value);
        return;
      } catch {
        // falls through to the issue
      }
      payload.issues.push({
        origin: 'string',
        code: 'invalid_format',
        format: 'url',
        input: payload.value,
        inst,
        continue: !def.abort,
      });
    };
  }
);

export const $ZodCheckV3Int = z.core.$constructor(
  '$ZodCheckV3Int',
  (inst: z.core.$ZodCheckNumberFormat, def: z.core.$ZodCheckNumberFormatDef) => {
    z.core.$ZodCheckNumberFormat.init(inst, def);
    inst._zod.check = (payload) => {
      const input = payload.value;
      if (!Number.isInteger(input)) {
        // `continue: true`, unlike zod's own: zod 3 went on to the bounds.
        payload.issues.push({ expected: 'int', format: def.format, code: 'invalid_type', input, inst, continue: true });
        return;
      }
      // T2: beyond the safe range, JSON has already rounded the number.
      if (input > Number.MAX_SAFE_INTEGER) {
        payload.issues.push({
          origin: 'int',
          code: 'too_big',
          maximum: Number.MAX_SAFE_INTEGER,
          inclusive: true,
          input,
          inst,
          continue: true,
        });
      } else if (input < Number.MIN_SAFE_INTEGER) {
        payload.issues.push({
          origin: 'int',
          code: 'too_small',
          minimum: Number.MIN_SAFE_INTEGER,
          inclusive: true,
          input,
          inst,
          continue: true,
        });
      }
    };
  }
);

/** Any 8-4-4-4-12 hex string, in either case. */
export function uuidString(message?: string): z.ZodString {
  return z.string().guid(message);
}

export function emailString(): z.ZodString {
  return z.string().email({ pattern: V3_EMAIL_PATTERN });
}

/** Whatever `new URL()` parses, kept exactly as sent. */
export function urlString(): z.ZodString {
  return z.string().check(new $ZodCheckV3Url({ check: 'string_format', format: 'url' }));
}

export interface StringBounds {
  min?: number;
  max?: number;
  length?: number;
}

export interface StringBoundMessages {
  min?: string;
  max?: string;
  length?: string;
}

/** A string whose bounds count UTF-16 units, checked in the fixed order min, max, length. */
export function boundedString(bounds: StringBounds, messages: StringBoundMessages = {}): z.ZodString {
  const checks: z.core.$ZodCheck<string>[] = [];
  if (bounds.min !== undefined) {
    checks.push(
      new $ZodCheckMinUnits({ check: 'min_length', ...z.core.util.normalizeParams({ error: messages.min }), minimum: bounds.min })
    );
  }
  if (bounds.max !== undefined) {
    checks.push(
      new $ZodCheckMaxUnits({ check: 'max_length', ...z.core.util.normalizeParams({ error: messages.max }), maximum: bounds.max })
    );
  }
  if (bounds.length !== undefined) {
    checks.push(
      new $ZodCheckLengthUnits({
        check: 'length_equals',
        ...z.core.util.normalizeParams({ error: messages.length }),
        length: bounds.length,
      })
    );
  }
  return z.string().check(...checks);
}

/** An integer whose failure does not hide the bounds chained after it. */
export function integerNumber(): z.ZodNumber {
  return z.number().check(new $ZodCheckV3Int({ check: 'number_format', format: 'safeint' }));
}

const PROTO = '__proto__';

/**
 * zod 4's ZodRecord, plus the check zod 3 ran on an own `__proto__` entry.
 * The entry's issues take its place in key order; the entry itself stays out
 * of the output, as it does on both majors. Built by recordOf.
 */
export const ZodV3Record = z.core.$constructor('ZodV3Record', (inst: z.ZodRecord, def: z.core.$ZodRecordDef) => {
  z.ZodRecord.init(inst, def);
  const parse = inst._zod.parse.bind(inst._zod);
  inst._zod.parse = (payload, ctx) => {
    const input: unknown = payload.value;
    if (!z.core.util.isPlainObject(input) || !Object.prototype.hasOwnProperty.call(input, PROTO)) {
      return parse(payload, ctx);
    }
    const start = payload.issues.length;
    const entry = def.valueType._zod.run({ value: input[PROTO], issues: [] }, ctx);
    const rest = parse(payload, ctx);
    // zod 3 walked the keys with for-in, the string order of Reflect.ownKeys:
    // the entry's issues go after those of the keys before it.
    const merge = (own: z.core.ParsePayload): z.core.ParsePayload => {
      if (own.issues.length === 0) return payload;
      const keys = Reflect.ownKeys(input);
      const after = new Set<PropertyKey>(keys.slice(keys.indexOf(PROTO) + 1));
      const issues = payload.issues;
      let at = start;
      while (at < issues.length && !after.has(issues[at]?.path?.[0] ?? PROTO)) at++;
      const tail = issues.splice(at);
      for (const issue of z.core.util.prefixIssues(PROTO, own.issues)) issues.push(issue);
      for (const issue of tail) issues.push(issue);
      return payload;
    };
    if (entry instanceof Promise || rest instanceof Promise) {
      return Promise.all([entry, rest]).then(([own]) => merge(own));
    }
    return merge(entry);
  };
});

/**
 * `z.record(z.string(), value)` that validates an own `__proto__` entry, as
 * zod 3 did: JSON.parse keeps that key, zod 4's record skips it unvalidated,
 * and zod 3 checked it in key order and then left it out of the output.
 */
export function recordOf<V extends z.ZodType>(value: V): z.ZodRecord<z.ZodString, V> {
  return new ZodV3Record({ type: 'record', keyType: z.string(), valueType: value }) as unknown as z.ZodRecord<
    z.ZodString,
    V
  >;
}

const isObject = (o: unknown): o is Record<PropertyKey, unknown> =>
  typeof o === 'object' && o !== null && !Array.isArray(o);

/**
 * `util.isPlainObject` of the zod/v4 core bundled in zod 3.25.76, which read
 * `constructor.prototype` whatever `constructor` was. One difference: an own
 * `constructor: null` threw a TypeError there and is simply "not plain" here.
 */
function wasPlainObject(o: unknown): boolean {
  if (!isObject(o)) return false;
  const ctor: unknown = o.constructor;
  if (ctor === undefined) return true;
  const prot: unknown = ctor === null ? undefined : (ctor as { prototype?: unknown }).prototype;
  if (!isObject(prot)) return false;
  return Object.prototype.hasOwnProperty.call(prot, 'isPrototypeOf');
}

/** zod 4's ZodRecord, refusing what the 3.25.76 core did not take for a plain object. Built by toolRecordOf. */
export const ZodToolRecord = z.core.$constructor('ZodToolRecord', (inst: z.ZodRecord, def: z.core.$ZodRecordDef) => {
  z.ZodRecord.init(inst, def);
  const parse = inst._zod.parse.bind(inst._zod);
  inst._zod.parse = (payload, ctx) => {
    const input: unknown = payload.value;
    if (z.core.util.isPlainObject(input) && !wasPlainObject(input)) {
      payload.issues.push({ expected: 'record', code: 'invalid_type', input, inst });
      return payload;
    }
    return parse(payload, ctx);
  };
});

/**
 * `z.record(z.string(), value)` for an agent tool input: it refuses an object
 * with an own `constructor` that is not a function with a prototype, as the
 * zod/v4 core bundled in zod 3.25.76 did (#367).
 */
export function toolRecordOf<V extends z.ZodType>(value: V): z.ZodRecord<z.ZodString, V> {
  return new ZodToolRecord({ type: 'record', keyType: z.string(), valueType: value }) as unknown as z.ZodRecord<
    z.ZodString,
    V
  >;
}
