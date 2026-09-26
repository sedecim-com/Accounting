import type { z } from 'zod';

// ============================================================
// CONTRACT: the ONLY place where a Zod issue becomes prose for a client.
//
// Two surfaces show Zod issues to a person: the 422 body of the REST API
// (validateBody, middleware/async-handler.ts) and the error that rejects a
// mnemosine.config.json (ai/providers/config.ts). Both read their issues from
// here and nowhere else, so what they say is decided in one file.
//
// The owner's decision on #367 fixes that prose to the zod 3.25.76 wording,
// issue order included, pinned by tests/api/golden/rest-body.golden.json and
// tests/ai/providers/config-contract.spec.ts. Zod 4 words and orders issues
// differently, so this file does two things on every parse:
//
//   legacyIssueMessage     a per-parse error map that words each zod 4 issue
//                          the way zod 3's English map (v3/locales/en.js)
//                          worded its zod 3 counterpart. Messages a schema
//                          sets itself (`.min(1, 'msg')`, a refine message,
//                          the array cap) outrank it, as they did in zod 3.
//   normalizeLegacyIssues  restores zod 3's issue list: nothing reported on a
//                          node after its type check failed, and the size of
//                          an array before its elements.
//
// It is passed on each parse and never through `z.config`, so nothing else
// in the process (the agent tools, the SDK) changes wording. A code it does
// not know falls back to zod's own text, and the goldens catch the drift.
// Retire it with a CONTRACT PR when the 422 moves to catalog keys (#151).
// ============================================================

/** One issue as a client reads it: the dotted field path ('' at the root) and the message. */
export interface ClientIssue {
  path: string;
  message: string;
}

export type ClientParse<T> = { success: true; data: T } | { success: false; issues: ClientIssue[] };

/** zod 3's `getParsedType`, for the values JSON can carry. */
function v3TypeName(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isNaN(value) ? 'nan' : 'number';
  if (value instanceof Date) return 'date';
  return typeof value;
}

/** zod 3's `util.joinValues`. */
function joinValues(values: readonly unknown[], separator = ' | '): string {
  return values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(separator);
}

/** zod 4's `expected` names where zod 3 said something else. */
const V3_EXPECTED: Readonly<Record<string, string>> = { int: 'integer', record: 'object' };

/** zod 4 string formats zod 3 worded as `Invalid <name>`. */
const V3_FORMAT_NAMES: Readonly<Record<string, string>> = {
  guid: 'uuid',
  uuid: 'uuid',
  email: 'email',
  url: 'url',
  emoji: 'emoji',
  nanoid: 'nanoid',
  cuid: 'cuid',
  cuid2: 'cuid2',
  ulid: 'ulid',
  datetime: 'datetime',
  date: 'date',
  time: 'time',
  duration: 'duration',
  base64: 'base64',
  base64url: 'base64url',
  jwt: 'jwt',
};

function tooSmall(origin: string, minimum: number | bigint, inclusive: boolean, exact: boolean): string | undefined {
  const bound = String(minimum);
  switch (origin) {
    case 'array':
      return `Array must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${bound} element(s)`;
    case 'string':
      return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${bound} character(s)`;
    case 'number':
    case 'int':
    case 'bigint':
      return `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${bound}`;
    default:
      return undefined;
  }
}

function tooBig(origin: string, maximum: number | bigint, inclusive: boolean, exact: boolean): string | undefined {
  const bound = String(maximum);
  switch (origin) {
    case 'array':
      return `Array must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${bound} element(s)`;
    case 'string':
      return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${bound} character(s)`;
    case 'number':
    case 'int':
      return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${bound}`;
    case 'bigint':
      return `BigInt must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${bound}`;
    default:
      return undefined;
  }
}

/**
 * The zod 3 English message for a zod 4 issue, or undefined to keep zod's own.
 *
 * Source of truth: zod 3.25.76 `v3/locales/en.js`, case by case.
 */
export function legacyIssueMessage(issue: z.core.$ZodRawIssue): string | undefined {
  const input = issue.input;
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.expected === 'int' && typeof input === 'number' && Number.isFinite(input)) {
        return 'Expected integer, received float';
      }
      if (input === undefined) return 'Required';
      // T1: zod 4's z.number() rejects ±Infinity, which zod 3 accepted; this
      // is zod 3's wording for the same rule (`.finite()`).
      if (typeof input === 'number' && !Number.isNaN(input) && !Number.isFinite(input)) {
        return 'Number must be finite';
      }
      return `Expected ${V3_EXPECTED[issue.expected] ?? issue.expected}, received ${v3TypeName(input)}`;
    }
    case 'invalid_value':
      // zod 3 checked an enum's TYPE first (`Expected 'a' | 'b', received
      // number`) and only then its value.
      if (input === undefined) return 'Required';
      if (typeof input !== 'string') return `Expected ${joinValues(issue.values)}, received ${v3TypeName(input)}`;
      return `Invalid enum value. Expected ${joinValues(issue.values)}, received '${input}'`;
    case 'invalid_format': {
      if (issue.format === 'regex') return 'Invalid';
      if (issue.format === 'starts_with' && 'prefix' in issue) return `Invalid input: must start with "${String(issue.prefix)}"`;
      if (issue.format === 'ends_with' && 'suffix' in issue) return `Invalid input: must end with "${String(issue.suffix)}"`;
      if (issue.format === 'includes' && 'includes' in issue) return `Invalid input: must include "${String(issue.includes)}"`;
      const name = V3_FORMAT_NAMES[issue.format];
      return name === undefined ? undefined : `Invalid ${name}`;
    }
    case 'too_small':
      return tooSmall(issue.origin, issue.minimum, issue.inclusive ?? false, issue.exact ?? false);
    case 'too_big':
      return tooBig(issue.origin, issue.maximum, issue.inclusive ?? false, issue.exact ?? false);
    case 'not_multiple_of':
      return `Number must be a multiple of ${String(issue.divisor)}`;
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${joinValues(issue.keys, ', ')}`;
    case 'invalid_union':
    case 'custom':
      return 'Invalid input';
    default:
      return undefined;
  }
}

const samePath = (a: readonly PropertyKey[], b: readonly PropertyKey[]): boolean =>
  a.length === b.length && a.every((step, i) => step === b[i]);

const isUnder = (parent: readonly PropertyKey[], child: readonly PropertyKey[]): boolean =>
  parent.length < child.length && parent.every((step, i) => step === child[i]);

/** A failure of the node's TYPE: zod 3 stopped checking that node right there. */
function isTypeFailure(issue: z.core.$ZodIssue): boolean {
  if (issue.code === 'invalid_type') return issue.expected !== 'int';
  return issue.code === 'invalid_value' && typeof issue.input !== 'string';
}

/** The safe-integer bound of $ZodCheckV3Int (T2), which zod 3 did not have. */
function isSafeIntegerBound(issue: z.core.$ZodIssue): boolean {
  if (issue.code === 'too_big') return issue.origin === 'int' && issue.maximum === Number.MAX_SAFE_INTEGER;
  if (issue.code === 'too_small') return issue.origin === 'int' && issue.minimum === Number.MIN_SAFE_INTEGER;
  return false;
}

/** A built-in array size check (not the cap of topes.ts, which is `custom`). */
function isArraySize(issue: z.core.$ZodIssue): boolean {
  return (issue.code === 'too_small' || issue.code === 'too_big') && issue.origin === 'array';
}

/**
 * zod 3's issue list, from zod 4's.
 *
 *  (a) After a type failure at a path, zod 4 still runs the length checks
 *      guarded by `when` on the raw value; zod 3 reported nothing more there.
 *  (a2) The safe-integer bound (T2) is dropped when the same field already
 *      reports another issue, so a field with its own bound answers as before.
 *  (b) zod 3 checked an array's size BEFORE its elements; zod 4 after.
 */
export function normalizeLegacyIssues(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  const dead: Array<readonly PropertyKey[]> = [];
  const alive: z.core.$ZodIssue[] = [];
  for (const issue of issues) {
    if (dead.some((path) => samePath(path, issue.path))) continue;
    alive.push(issue);
    if (isTypeFailure(issue)) dead.push(issue.path);
  }

  const bounded = alive.filter(
    (issue) => !isSafeIntegerBound(issue) || !alive.some((other) => other !== issue && samePath(other.path, issue.path))
  );

  const ordered: z.core.$ZodIssue[] = [];
  for (const issue of bounded) {
    const firstElement = isArraySize(issue) ? ordered.findIndex((o) => isUnder(issue.path, o.path)) : -1;
    if (firstElement >= 0) ordered.splice(firstElement, 0, issue);
    else ordered.push(issue);
  }
  return ordered;
}

/** `schema.safeParse(input)`, with its issues in the wording and order clients are promised. */
export function parseForClient<T>(schema: z.ZodType<T>, input: unknown): ClientParse<T> {
  const parsed = schema.safeParse(input, { error: legacyIssueMessage, reportInput: true });
  if (parsed.success) return { success: true, data: parsed.data };
  return {
    success: false,
    issues: normalizeLegacyIssues(parsed.error.issues).map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}
