import { z } from 'zod';

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
// differently, so this file does three things on every parse:
//
//   legacyIssueMessage     a per-parse error map that words each zod 4 issue
//                          the way zod 3's English map (v3/locales/en.js)
//                          worded its zod 3 counterpart. Messages a schema
//                          sets itself (`.min(1, 'msg')`, a refine message,
//                          the array cap) outrank it, as they did in zod 3.
//   infinityAsZod3         zod 4's z.number() refuses ±Infinity (JSON 1e999)
//                          at its type check and skips its checks. zod 3 took
//                          it as a number and ran them, so where one of them
//                          fails (an integer, a bound) that is what the client
//                          reads, as before. Only where zod 3 accepted the
//                          value does it read 'Number must be finite' (T1).
//   normalizeLegacyIssues  restores zod 3's issue list: nothing reported on a
//                          node after its type check failed, and the size of
//                          an array before its elements. Linear in the issue
//                          count: a 10 MB body can carry millions of issues.
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
      // zod 3 said "float" for any number `.int()` refused, ±Infinity included.
      if (issue.expected === 'int' && typeof input === 'number' && !Number.isNaN(input)) {
        return 'Expected integer, received float';
      }
      if (input === undefined) return 'Required';
      // T1: zod 4's z.number() rejects ±Infinity where zod 3 accepted it (see
      // infinityAsZod3); this is zod 3's wording for the same rule
      // (`.finite()`). Any other type answers as zod 3 did, below.
      if (issue.expected === 'number' && isInfinite(input)) return 'Number must be finite';
      return `Expected ${V3_EXPECTED[issue.expected] ?? issue.expected}, received ${v3TypeName(input)}`;
    }
    case 'invalid_value':
      // zod 3 worded a literal the same whatever it received, even nothing.
      if (issue.inst instanceof z.core.$ZodLiteral && issue.values.length === 1) {
        return `Invalid literal value, expected ${JSON.stringify(issue.values[0])}`;
      }
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

/**
 * One path the issues reach, in a trie over their paths. A step is a Map key,
 * so 0 (an array index) and '0' (an object key) stay apart, as `===` keeps
 * them; the parent link makes every strict prefix of a path its ancestors.
 */
interface PathNode {
  readonly parent: PathNode | undefined;
  children: Map<PropertyKey, PathNode> | undefined;
  /** A type failure was reported at exactly this path. */
  dead: boolean;
  /** Issues kept at exactly this path. */
  kept: number;
  /** Index of the first issue kept strictly under this path, or -1. */
  firstUnder: number;
}

function pathNode(parent?: PathNode): PathNode {
  return { parent, children: undefined, dead: false, kept: 0, firstUnder: -1 };
}

function nodeAt(root: PathNode, path: readonly PropertyKey[]): PathNode {
  let node = root;
  for (const step of path) {
    node.children ??= new Map();
    let child = node.children.get(step);
    if (child === undefined) {
      child = pathNode(node);
      node.children.set(step, child);
    }
    node = child;
  }
  return node;
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
 * Linear in the number of issues times their depth: one request can carry
 * millions of them, so no step compares an issue with the others.
 */
export function normalizeLegacyIssues(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  const root = pathNode();
  const alive: Array<[z.core.$ZodIssue, PathNode]> = [];
  for (const issue of issues) {
    const node = nodeAt(root, issue.path);
    if (node.dead) continue;
    alive.push([issue, node]);
    node.kept++;
    if (isTypeFailure(issue)) node.dead = true;
  }

  const bounded = alive.filter(([issue, node]) => !isSafeIntegerBound(issue) || node.kept === 1);

  // A size issue moves in front of the first issue kept under its path. That
  // issue never moves itself: were it a size issue with an issue under its own
  // path, that issue would be under the first one's path too, and earlier.
  const inFront = new Map<number, z.core.$ZodIssue[]>();
  const moved = new Set<number>();
  bounded.forEach(([issue, node], index) => {
    if (isArraySize(issue) && node.firstUnder >= 0) {
      const group = inFront.get(node.firstUnder) ?? [];
      group.push(issue);
      inFront.set(node.firstUnder, group);
      moved.add(index);
    }
    // Marks every ancestor still unmarked. An ancestor already marked has its
    // own ancestors marked too, so the walk stops there: amortized O(1).
    for (let up = node.parent; up !== undefined && up.firstUnder < 0; up = up.parent) up.firstUnder = index;
  });

  const ordered: z.core.$ZodIssue[] = [];
  bounded.forEach(([issue], index) => {
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
  const ctx: IssueContext = { error: legacyIssueMessage, reportInput: true };
  const replaced = new Map<string, z.core.$ZodIssue[]>();
  const error = (issue: z.core.$ZodRawIssue): string | undefined => {
    const zod3 = infinityAsZod3(issue, ctx);
    if (zod3 === undefined || zod3.length === 0) return legacyIssueMessage(issue);
    const marker = `${ZOD3_ISSUES}${replaced.size}`;
    replaced.set(marker, zod3);
    return marker;
  };
  const parsed = schema.safeParse(input, { error, reportInput: true });
  if (parsed.success) return { success: true, data: parsed.data };
  const issues = parsed.error.issues.flatMap((issue) => replaced.get(issue.message) ?? [issue]);
  return {
    success: false,
    issues: normalizeLegacyIssues(issues).map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}
