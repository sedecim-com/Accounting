import { z } from 'zod';
import { t, type TranslationKey } from '../i18n/index.js';
import type { ErrorMessageKey } from './errors.js';

// ============================================================
// CONTRACT: the ONLY place where a Zod issue becomes prose for a client.
//
// Two surfaces show Zod issues to a person: the 422 body of the REST API
// (validateBody and validateQuery, middleware/async-handler.ts) and the error
// that rejects a mnemosine.config.json (ai/providers/config.ts). Both read
// their issues from here and nowhere else, so what they say is decided in one
// file.
//
// THE 422 IS WRITTEN BY CATALOG KEY (MNE-001-152, #151). Each issue this file
// words is one `error.VALIDATION_ERROR.issue.*` key of src/i18n/en.ts with the
// issue's parameters, and the REST 422 renders it in the language the request
// named. The English of those keys is not a translation of anything: it is the
// zod 3.25.76 wording the owner fixed on #367, issue order included, pinned by
// tests/api/golden/rest-body.golden.json and
// tests/ai/providers/config-contract.spec.ts. That English contract stays, so
// this adapter stays: Zod 4 words and orders issues differently, and on every
// parse this file does three things:
//
//   legacyIssueKey         the key and parameters of each zod 4 issue, chosen
//                          the way zod 3's English map (v3/locales/en.js)
//                          worded its zod 3 counterpart; `legacyIssueMessage`
//                          is that key in English. Messages a schema sets
//                          itself (`.min(1, 'msg')`, a refine message, the
//                          array cap) outrank it, as they did in zod 3. They
//                          are keys too when the schema wrote them through
//                          `schemaMessage` or `keyedIssueParams`
//                          (MNE-001-588); any other one has no key and reads
//                          the same in every language.
//   infinityAsZod3         zod 4's z.number() refuses ±Infinity (JSON 1e999)
//                          at its type check and skips its checks. zod 3 took
//                          it as a number and ran them, so where one of them
//                          fails (an integer, a bound) that is what the client
//                          reads, as before. Only where zod 3 accepted the
//                          value does it read 'Number must be finite' (T1).
//   normalizeLegacyIssues  restores zod 3's issue list: nothing reported on a
//                          node after its type check failed, and the size of
//                          an array before its elements. Linear in the issue
//                          count, and nothing allocated per issue beyond the
//                          list: a 10 MB body can carry millions of issues.
//
// It is passed on each parse and never through `z.config`, so nothing else
// in the process (the agent tools, the SDK) changes wording. A code it does
// not know falls back to zod's own text, with no key, and the goldens catch
// the drift.
// ============================================================

/** One issue as a client reads it: the dotted field path ('' at the root) and the message. */
export interface ClientIssue {
  path: string;
  message: string;
}

export type ClientParse<T> = { success: true; data: T } | { success: false; issues: ClientIssue[] };

/** An issue with the catalog key its message was rendered from, when it was (MNE-001-152). */
export interface KeyedClientIssue extends ClientIssue {
  key?: ErrorMessageKey;
}

export type KeyedClientParse<T> = { success: true; data: T } | { success: false; issues: KeyedClientIssue[] };

/** zod 3's `getParsedType`, for the values JSON can carry. */
function v3TypeName(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isNaN(value) ? 'nan' : 'number';
  if (value instanceof Date) return 'date';
  return typeof value;
}

const isInfinite = (value: unknown): value is number =>
  typeof value === 'number' && !Number.isNaN(value) && !Number.isFinite(value);

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

/** The paramless keys, built once: a body full of `Required` allocates no key per issue. */
const REQUIRED: ErrorMessageKey = { key: 'error.VALIDATION_ERROR.issue.required' };
const INTEGER_RECEIVED_FLOAT: ErrorMessageKey = { key: 'error.VALIDATION_ERROR.issue.integer_received_float' };
const NOT_FINITE: ErrorMessageKey = { key: 'error.VALIDATION_ERROR.issue.not_finite' };
const INVALID_INPUT: ErrorMessageKey = { key: 'error.VALIDATION_ERROR.issue.invalid_input' };

/** zod 3's three ways to word a bound: the `bound` select of the size keys. */
function boundOf(inclusive: boolean | undefined, exact: boolean | undefined): string {
  return exact ? 'exact' : inclusive ? 'inclusive' : 'exclusive';
}

function tooSmall(issue: z.core.$ZodRawIssue<z.core.$ZodIssueTooSmall>): ErrorMessageKey | undefined {
  const params = { bound: boundOf(issue.inclusive, issue.exact), minimum: String(issue.minimum) };
  switch (issue.origin) {
    case 'array':
      return { key: 'error.VALIDATION_ERROR.issue.too_small.array', params };
    case 'string':
      return { key: 'error.VALIDATION_ERROR.issue.too_small.string', params };
    case 'number':
    case 'int':
    case 'bigint':
      return { key: 'error.VALIDATION_ERROR.issue.too_small.number', params };
    default:
      return undefined;
  }
}

function tooBig(issue: z.core.$ZodRawIssue<z.core.$ZodIssueTooBig>): ErrorMessageKey | undefined {
  const params = { bound: boundOf(issue.inclusive, issue.exact), maximum: String(issue.maximum) };
  switch (issue.origin) {
    case 'array':
      return { key: 'error.VALIDATION_ERROR.issue.too_big.array', params };
    case 'string':
      return { key: 'error.VALIDATION_ERROR.issue.too_big.string', params };
    case 'number':
    case 'int':
      return { key: 'error.VALIDATION_ERROR.issue.too_big.number', params };
    case 'bigint':
      return { key: 'error.VALIDATION_ERROR.issue.too_big.bigint', params };
    default:
      return undefined;
  }
}

/**
 * The catalog key of a zod 4 issue, with its parameters, worded as zod 3
 * worded it; undefined to keep zod's own text.
 *
 * Source of truth: zod 3.25.76 `v3/locales/en.js`, case by case. The English
 * of every key in src/i18n/en.ts is that file's sentence.
 */
export function legacyIssueKey(issue: z.core.$ZodRawIssue): ErrorMessageKey | undefined {
  const input = issue.input;
  switch (issue.code) {
    case 'invalid_type': {
      // zod 3 said "float" for any number `.int()` refused, ±Infinity included.
      if (issue.expected === 'int' && typeof input === 'number' && !Number.isNaN(input)) return INTEGER_RECEIVED_FLOAT;
      if (input === undefined) return REQUIRED;
      // T1: zod 4's z.number() rejects ±Infinity where zod 3 accepted it (see
      // infinityAsZod3); this is zod 3's wording for the same rule
      // (`.finite()`). Any other type answers as zod 3 did, below.
      if (issue.expected === 'number' && isInfinite(input)) return NOT_FINITE;
      return {
        key: 'error.VALIDATION_ERROR.issue.invalid_type',
        params: { expected: V3_EXPECTED[issue.expected] ?? issue.expected, received: v3TypeName(input) },
      };
    }
    case 'invalid_value':
      // zod 3 worded a literal the same whatever it received, even nothing.
      if (issue.inst instanceof z.core.$ZodLiteral && issue.values.length === 1) {
        return { key: 'error.VALIDATION_ERROR.issue.invalid_literal', params: { expected: String(JSON.stringify(issue.values[0])) } };
      }
      // zod 3 checked an enum's TYPE first (`Expected 'a' | 'b', received
      // number`) and only then its value.
      if (input === undefined) return REQUIRED;
      if (typeof input !== 'string') {
        return {
          key: 'error.VALIDATION_ERROR.issue.invalid_type',
          params: { expected: joinValues(issue.values), received: v3TypeName(input) },
        };
      }
      return { key: 'error.VALIDATION_ERROR.issue.invalid_enum_value', params: { expected: joinValues(issue.values), received: input } };
    case 'invalid_format': {
      if (issue.format === 'regex') return { key: 'error.VALIDATION_ERROR.issue.invalid_format', params: { format: 'regex' } };
      const affix =
        issue.format === 'starts_with' && 'prefix' in issue
          ? issue.prefix
          : issue.format === 'ends_with' && 'suffix' in issue
            ? issue.suffix
            : issue.format === 'includes' && 'includes' in issue
              ? issue.includes
              : undefined;
      if (typeof affix === 'string') {
        return { key: 'error.VALIDATION_ERROR.issue.invalid_affix', params: { affix: issue.format, value: affix } };
      }
      const name = V3_FORMAT_NAMES[issue.format];
      return name === undefined ? undefined : { key: 'error.VALIDATION_ERROR.issue.invalid_format', params: { format: name } };
    }
    case 'too_small':
      return tooSmall(issue);
    case 'too_big':
      return tooBig(issue);
    case 'not_multiple_of':
      return { key: 'error.VALIDATION_ERROR.issue.not_multiple_of', params: { divisor: String(issue.divisor) } };
    case 'unrecognized_keys':
      return { key: 'error.VALIDATION_ERROR.issue.unrecognized_keys', params: { keys: joinValues(issue.keys, ', ') } };
    case 'invalid_union':
    case 'custom':
      return INVALID_INPUT;
    default:
      return undefined;
  }
}

/** The zod 3 English message for a zod 4 issue, or undefined to keep zod's own: `legacyIssueKey` in English. */
export function legacyIssueMessage(issue: z.core.$ZodRawIssue): string | undefined {
  const key = legacyIssueKey(issue);
  return key && t(key.key, key.params ?? {}, 'en');
}

/**
 * The error map of one parse, and the way back from a message to its key.
 *
 * A body can carry millions of issues and only a handful of distinct
 * messages, so each distinct key and parameters is rendered once, and its
 * text remembers the key it came from: after the parse, `keyOf(message)`
 * finds the key of an issue whose message the map wrote. A message a schema
 * set itself, or zod's own text, was never written here: `schemaKeyOf` finds
 * the key of the first, and the second has none. Both
 * maps live for one parse only, so a hostile body cannot grow them for the
 * life of the process.
 */
function keyedWording(): { message: (issue: z.core.$ZodRawIssue) => string | undefined; keyOf: (message: string) => ErrorMessageKey | undefined } {
  const english = new Map<string, string>();
  const keys = new Map<string, ErrorMessageKey>();
  return {
    message(issue) {
      const key = legacyIssueKey(issue);
      if (key === undefined) return undefined;
      const id = key.params === undefined ? key.key : `${key.key}\u0000${JSON.stringify(key.params)}`;
      let text = english.get(id);
      if (text === undefined) {
        text = t(key.key, key.params ?? {}, 'en');
        english.set(id, text);
        if (!keys.has(text)) keys.set(text, key);
      }
      return text;
    },
    keyOf: (message) => keys.get(message),
  };
}

/**
 * The keys of the messages schemas set themselves, by their English
 * (MNE-001-588). Filled by `schemaMessage` while the schemas are built, at
 * module load: one entry per key a schema names, never one per request.
 */
const SCHEMA_MESSAGE_KEYS = new Map<string, ErrorMessageKey>();

/**
 * The English of `key`, for a message a schema sets itself (a refine, `.min(n,
 * msg)`, a regex, an error map), remembered so the 422 can render it in the
 * reader's language. Call it where the schema is built, never per parse. The
 * key takes no parameters: a message with per-request values is a custom
 * issue with `keyedIssueParams`.
 */
export function schemaMessage(key: TranslationKey): string {
  const english = t(key, {}, 'en');
  if (!SCHEMA_MESSAGE_KEYS.has(english)) SCHEMA_MESSAGE_KEYS.set(english, { key });
  return english;
}

/** Where a custom issue carries the key of its message (MNE-001-588). */
const ISSUE_KEY_PARAM = 'messageKey';

/**
 * The message and the `params` of a custom issue whose message is `key` with
 * per-request values, such as the REST array cap (`arregloAcotado`): the
 * message is its English, and the key travels in `params` to the 422.
 */
export function keyedIssueParams(key: ErrorMessageKey): { message: string; params: { [ISSUE_KEY_PARAM]: ErrorMessageKey } } {
  return { message: t(key.key, key.params ?? {}, 'en'), params: { [ISSUE_KEY_PARAM]: key } };
}

/** The key a schema wrote a message with: `schemaMessage`, or a custom issue's `keyedIssueParams`. */
function schemaKeyOf(issue: z.core.$ZodIssue): ErrorMessageKey | undefined {
  const known = SCHEMA_MESSAGE_KEYS.get(issue.message);
  if (known !== undefined || issue.code !== 'custom') return known;
  const carried: unknown = issue.params?.[ISSUE_KEY_PARAM];
  return typeof carried === 'object' && carried !== null && 'key' in carried ? (carried as ErrorMessageKey) : undefined;
}

type Path = readonly PropertyKey[];

/** Same steps, compared with `===`: 0 (an array index) and '0' (an object key) stay apart. */
function samePath(a: Path, b: Path): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** `path` starts with every step of `prefix` (or is it). */
function startsWith(path: Path, prefix: Path): boolean {
  if (path.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (path[i] !== prefix[i]) return false;
  return true;
}

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
 *  (b) zod 3 checked an array's size BEFORE its elements; zod 4 after. Each
 *      size issue moves in front of the first issue reported under its path,
 *      and an outer array's in front of an inner one's.
 *
 * NOTE: it relies on the order zod 4 reports in. A node's checks run right
 * after its own type check, and an array's right after its elements, so the
 * issues at one path are consecutive, and the issues under an array's path
 * run up to the array's own checks. (An intersection parses one path twice;
 * tests/api/rest/zod4-guards.spec.ts and the converter refuse one on any
 * client-reachable schema.) Leaning on that order is what keeps this cheap:
 * one request can carry millions of issues, so it compares each issue only
 * with its neighbours (and a size issue with the issues under its path),
 * and allocates nothing per issue beyond the list it returns.
 */
export function normalizeLegacyIssues(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  // (a) and (a2), one run of issues at the same path at a time.
  const kept: z.core.$ZodIssue[] = [];
  let sizes = false;
  for (let start = 0; start < issues.length; ) {
    const first = issues[start];
    let end = start + 1;
    while (end < issues.length && samePath((issues[end]).path, first.path)) end++;
    const from = kept.length;
    for (let i = start; i < end; i++) {
      const issue = issues[i];
      kept.push(issue);
      if (isTypeFailure(issue)) break;
    }
    if (kept.length - from > 1) {
      let to = from;
      for (let i = from; i < kept.length; i++) {
        const issue = kept[i];
        if (!isSafeIntegerBound(issue)) kept[to++] = issue;
      }
      kept.length = to;
    }
    for (let i = from; i < kept.length && !sizes; i++) sizes = isArraySize(kept[i]);
    start = end;
  }
  if (!sizes) return kept;

  // (b) A size issue moves in front of the first issue kept under its path:
  // the start of the run of issues at or under that path that ends at it.
  // That issue never moves itself: were it a size issue with an issue under
  // its own path, that issue would be under the first one's path too, and
  // earlier.
  const inFront = new Map<number, z.core.$ZodIssue[]>();
  const moved = new Set<number>();
  kept.forEach((issue, index) => {
    if (!isArraySize(issue)) return;
    let under = -1;
    for (let i = index - 1; i >= 0; i--) {
      const path = (kept[i]).path;
      if (!startsWith(path, issue.path)) break;
      if (path.length > issue.path.length) under = i;
    }
    if (under < 0) return;
    const group = inFront.get(under) ?? [];
    group.push(issue);
    inFront.set(under, group);
    moved.add(index);
  });
  if (moved.size === 0) return kept;

  const ordered: z.core.$ZodIssue[] = [];
  kept.forEach((issue, index) => {
    // Outer arrays first; the sort is stable, so equal depths keep their order.
    const group = inFront.get(index);
    if (group) ordered.push(...group.sort((a, b) => a.path.length - b.path.length));
    if (!moved.has(index)) ordered.push(issue);
  });
  return ordered;
}

type IssueContext = z.core.ParseContext<z.core.$ZodIssue>;

/**
 * T1, and what it does not cover. The issues zod 3 reported for a ±Infinity
 * that zod 4's z.number() refused at its type check: zod 3 took it as a
 * number and ran the node's checks on it (`.int()`, the bounds, a refine), all
 * of them, in order. An empty list means zod 3 accepted the value, and the
 * tightening answers 'Number must be finite'. Undefined for any other issue.
 *
 * A number branch of a union is out of reach: zod 4 answers the union as a
 * whole ('Invalid input'), so tests/api/rest/zod4-guards.spec.ts refuses a
 * union whose number branch carries checks on any client-reachable schema.
 */
function infinityAsZod3(issue: z.core.$ZodRawIssue, ctx: IssueContext): z.core.$ZodIssue[] | undefined {
  const inst = issue.inst;
  if (issue.code !== 'invalid_type' || issue.expected !== 'number' || !isInfinite(issue.input)) return undefined;
  if (!(inst instanceof z.core.$ZodNumber)) return undefined;
  // The same list zod runs: a number format (z.int()) is its own first check.
  const checks = [...(inst._zod.def.checks ?? [])] as Array<z.core.$ZodCheck<number>>;
  if (inst._zod.traits.has('$ZodCheck')) checks.unshift(inst as unknown as z.core.$ZodCheck<number>);
  const payload: z.core.ParsePayload<number> = { value: issue.input, issues: [] };
  for (const check of checks) {
    if (check._zod.def.when && !check._zod.def.when(payload)) continue;
    void check._zod.check(payload);
  }
  const at = issue.path ?? [];
  return payload.issues.map((raw) =>
    z.core.util.finalizeIssue({ ...raw, path: [...at, ...(raw.path ?? [])] }, ctx, z.core.config())
  );
}

/**
 * Marks the message of an issue that zod 3 reported as several: an error map
 * returns one message per issue, so the list travels beside the parse and
 * replaces the issue after it. A schema's own message never starts with NUL.
 */
const ZOD3_ISSUES = '\u0000zod3-issues:';

/** `schema.safeParse(input)`, with its issues in the wording and order clients are promised. */
export function parseForClient<T>(schema: z.ZodType<T>, input: unknown): ClientParse<T> {
  const parsed = parseForClientKeyed(schema, input);
  if (parsed.success) return parsed;
  return { success: false, issues: parsed.issues.map(({ path, message }) => ({ path, message })) };
}

/**
 * `parseForClient`, with the catalog key behind each message it worded
 * (MNE-001-152), and behind each message a schema wrote by key (MNE-001-588).
 * The REST 422 renders those keys in the reader's language; an issue with no
 * key travels with its message as it is.
 */
export function parseForClientKeyed<T>(schema: z.ZodType<T>, input: unknown): KeyedClientParse<T> {
  const wording = keyedWording();
  const ctx: IssueContext = { error: wording.message, reportInput: true };
  const replaced = new Map<string, z.core.$ZodIssue[]>();
  const error = (issue: z.core.$ZodRawIssue): string | undefined => {
    const zod3 = infinityAsZod3(issue, ctx);
    if (zod3 === undefined || zod3.length === 0) return wording.message(issue);
    const marker = `${ZOD3_ISSUES}${replaced.size}`;
    replaced.set(marker, zod3);
    return marker;
  };
  const parsed = schema.safeParse(input, { error, reportInput: true });
  if (parsed.success) return { success: true, data: parsed.data };
  // Read the issues first: zod words them (and so fills `replaced`) when they are read.
  const worded = parsed.error.issues;
  const issues = replaced.size === 0 ? worded : worded.flatMap((issue) => replaced.get(issue.message) ?? [issue]);
  return {
    success: false,
    issues: normalizeLegacyIssues(issues).map((issue): KeyedClientIssue => {
      const path = issue.path.map(String).join('.');
      const key = wording.keyOf(issue.message) ?? schemaKeyOf(issue);
      return key === undefined ? { path, message: issue.message } : { path, message: issue.message, key };
    }),
  };
}
