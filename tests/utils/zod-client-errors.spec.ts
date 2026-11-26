import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The real route module is imported for its schemas; keep it off the database.
vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  withTenant: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
  getClient: vi.fn(),
  setTenantSchema: vi.fn(),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getPool: vi.fn(),
}));
import { z } from 'zod';
import type { Request, Response } from 'express';
import { validateBody } from '../../src/api/rest/middleware/async-handler.js';
import {
  legacyIssueKey,
  legacyIssueMessage,
  normalizeLegacyIssues,
  parseForClient,
  parseForClientKeyed,
  keyedIssueParams,
  schemaMessage,
  type ClientIssue,
  type KeyedClientIssue,
} from '../../src/utils/zod-client-errors.js';
import { RequestValidationError, ValidationError, type ErrorMessageKey } from '../../src/utils/errors.js';
import { bulkPreRegSchema, uploadXmlSchema } from '../../src/api/rest/routes/xml-ingestion.js';
import { boundedString, emailString, integerNumber, urlString, uuidString } from '../../src/utils/zod-compat.js';

// CONTRACT: src/utils/zod-client-errors.ts is the only place where a Zod
// issue becomes client prose (#367). A second place that reads `error.issues`
// would word its messages however the installed Zod does, and the next Zod
// upgrade would change them without touching the adapter that pins them.

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const ADAPTER = path.join(SRC, 'utils', 'zod-client-errors.ts');
// The agent tools are parsed by @anthropic-ai/sdk, not by this code, and
// their errors go to the model rather than to a client.
const SDK_PARSED = path.join(SRC, 'ai', 'tools');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === SDK_PARSED ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('zod issues reach a client only through the adapter', () => {
  it('no source file outside the adapter reads error.issues or error.errors', () => {
    const readers = sourceFiles(SRC)
      .filter((file) => file !== ADAPTER)
      .filter((file) => /\.error\.(issues|errors)\b/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));
    expect(readers).toEqual([]);
  });
});

// ============================================================
// One row per zod 3 message family, recorded on zod 3.25.76. The rows use
// ASCII only, so they hold for native checks and compat helpers alike; on
// zod 4 the adapter has to word and order every one of them the same way.
// ============================================================

const issue = (path: string, message: string): ClientIssue => ({ path, message });
const obj = z.object({ a: z.string() });
const ab = z.enum(['a', 'b']);

const ROWS: Array<[string, z.ZodType, unknown, ClientIssue[]]> = [
  ['Required', obj, {}, [issue('a', 'Required')]],
  ['Required on a number', z.object({ n: z.number() }), {}, [issue('n', 'Required')]],
  ['Required on an enum', z.object({ e: ab }), {}, [issue('e', 'Required')]],
  ['Expected string, received number', obj, { a: 1 }, [issue('a', 'Expected string, received number')]],
  ['Expected object, received array', obj, [], [issue('', 'Expected object, received array')]],
  ['Expected object, received null', obj, null, [issue('', 'Expected object, received null')]],
  ['a record is reported as an object', z.record(z.string(), z.number()), [], [issue('', 'Expected object, received array')]],
  ['a record value', z.record(z.string(), z.number()), { k: 'x' }, [issue('k', 'Expected number, received string')]],
  ['Expected array, received string', z.array(z.string()), 'x', [issue('', 'Expected array, received string')]],
  ['Expected number, received string', z.number(), 'x', [issue('', 'Expected number, received string')]],
  ['Expected boolean, received null', z.boolean(), null, [issue('', 'Expected boolean, received null')]],
  ['a nullable keeps the inner type in its message', uuidString().nullable(), 1, [issue('', 'Expected string, received number')]],
  ['an enum given a string', ab, 'c', [issue('', "Invalid enum value. Expected 'a' | 'b', received 'c'")]],
  ['an enum given a non-string', ab, 1, [issue('', "Expected 'a' | 'b', received number")]],
  ['Invalid uuid', uuidString(), 'nope', [issue('', 'Invalid uuid')]],
  ['Invalid email', emailString(), 'a@', [issue('', 'Invalid email')]],
  ['Invalid url', urlString(), 'not a url', [issue('', 'Invalid url')]],
  ['a regex without a message is Invalid', z.string().regex(/^a$/), 'b', [issue('', 'Invalid')]],
  ['a regex with a message', z.string().regex(/^a$/, 'YYYY-MM-DD'), 'b', [issue('', 'YYYY-MM-DD')]],
  ['string at least', boundedString({ min: 2 }), 'a', [issue('', 'String must contain at least 2 character(s)')]],
  ['string at most', boundedString({ max: 1 }), 'ab', [issue('', 'String must contain at most 1 character(s)')]],
  ['string exactly, too short', boundedString({ length: 3 }), 'ab', [issue('', 'String must contain exactly 3 character(s)')]],
  ['string exactly, too long', boundedString({ length: 3 }), 'abcd', [issue('', 'String must contain exactly 3 character(s)')]],
  ['a type failure hides the length checks', boundedString({ min: 2 }), ['a', 'b', 'c'], [issue('', 'Expected string, received array')]],
  ['array at least', z.array(z.string()).min(2), ['a'], [issue('', 'Array must contain at least 2 element(s)')]],
  ['array at most', z.array(z.string()).max(1), ['a', 'b'], [issue('', 'Array must contain at most 1 element(s)')]],
  ['array exactly, too short', z.array(z.string()).length(2), ['a'], [issue('', 'Array must contain exactly 2 element(s)')]],
  ['array exactly, too long', z.array(z.string()).length(2), ['a', 'b', 'c'], [issue('', 'Array must contain exactly 2 element(s)')]],
  ['a type failure hides the array size', z.array(z.string()).min(2), 'x', [issue('', 'Expected array, received string')]],
  ['number greater than or equal', z.number().min(1), 0, [issue('', 'Number must be greater than or equal to 1')]],
  ['number greater than', z.number().positive(), 0, [issue('', 'Number must be greater than 0')]],
  ['number less than or equal', z.number().max(1), 2, [issue('', 'Number must be less than or equal to 1')]],
  ['number less than', z.number().lt(1), 1, [issue('', 'Number must be less than 1')]],
  ['not a multiple', z.number().multipleOf(5), 7, [issue('', 'Number must be a multiple of 5')]],
  ['Expected integer, received float', integerNumber(), 1.5, [issue('', 'Expected integer, received float')]],
  ['an integer given a string', integerNumber(), 'x', [issue('', 'Expected number, received string')]],
  [
    'unrecognized keys, two of them, in one issue',
    z.object({}).strict(),
    { a: 1, b: 2 },
    [issue('', "Unrecognized key(s) in object: 'a', 'b'")],
  ],
  ['a union with no match', z.union([z.string(), z.number()]), true, [issue('', 'Invalid input')]],
  ['a refine without a message', z.string().refine((v) => v === 'a'), 'b', [issue('', 'Invalid input')]],
  ['a refine with a message', z.string().refine((v) => v === 'a', { message: 'Must be a' }), 'b', [issue('', 'Must be a')]],
  [
    'an array minimum comes BEFORE its element issues',
    z.array(uuidString()).min(3),
    ['x'],
    [issue('', 'Array must contain at least 3 element(s)'), issue('0', 'Invalid uuid')],
  ],
  [
    'numeric index paths',
    z.object({ lines: z.array(z.object({ a: z.string() })) }),
    { lines: [{ a: 'ok' }, { a: 1 }] },
    [issue('lines.1.a', 'Expected string, received number')],
  ],
  [
    'several fields, in shape order',
    z.object({ a: z.string(), b: z.number(), c: ab }),
    { c: 'z', b: 'x' },
    [
      issue('a', 'Required'),
      issue('b', 'Expected number, received string'),
      issue('c', "Invalid enum value. Expected 'a' | 'b', received 'z'"),
    ],
  ],
  [
    'nested array sizes: the outer first, each before its own elements',
    z.array(z.array(uuidString()).min(2)).min(3),
    [['x']],
    [
      issue('', 'Array must contain at least 3 element(s)'),
      issue('0', 'Array must contain at least 2 element(s)'),
      issue('0.0', 'Invalid uuid'),
    ],
  ],
  [
    'sibling array sizes stay with their own elements',
    z.object({ a: z.array(z.array(uuidString()).min(2)) }),
    { a: [['x'], [], ['y', 'z']] },
    [
      issue('a.0', 'Array must contain at least 2 element(s)'),
      issue('a.0.0', 'Invalid uuid'),
      issue('a.1', 'Array must contain at least 2 element(s)'),
      issue('a.2.0', 'Invalid uuid'),
      issue('a.2.1', 'Invalid uuid'),
    ],
  ],
  ['a literal given another type', z.literal('x'), 1, [issue('', 'Invalid literal value, expected "x"')]],
  ['a literal given another value', z.literal(5), '5', [issue('', 'Invalid literal value, expected 5')]],
  ['a missing literal', z.object({ a: z.literal(true) }), {}, [issue('a', 'Invalid literal value, expected true')]],
];

// JSON 1e999 parses to Infinity, and express.json delivers it. Where zod 3
// already rejected it, it must answer as zod 3 did, whatever the field.
const INFINITY_ROWS: Array<[string, z.ZodType, unknown, ClientIssue[]]> = [
  [
    'Infinity on a string, a boolean, an object and an array field',
    z.object({ code: z.string(), flag: z.boolean(), o: z.object({}), arr: z.array(z.string()) }),
    { code: Infinity, flag: -Infinity, o: Infinity, arr: Infinity },
    [
      issue('code', 'Expected string, received number'),
      issue('flag', 'Expected boolean, received number'),
      issue('o', 'Expected object, received number'),
      issue('arr', 'Expected array, received number'),
    ],
  ],
  ['Infinity on an enum', ab, Infinity, [issue('', "Expected 'a' | 'b', received number")]],
  ['Infinity on a nullable id', uuidString().nullable(), -Infinity, [issue('', 'Expected string, received number')]],
  ['Infinity on an integer', integerNumber(), Infinity, [issue('', 'Expected integer, received float')]],
  [
    'Infinity through a nullable reaches the checks of the number inside',
    z.object({ n: integerNumber().max(5).nullable().optional() }),
    { n: Infinity },
    [issue('n', 'Expected integer, received float'), issue('n', 'Number must be less than or equal to 5')],
  ],
  [
    'Infinity on an integer reports the integer AND the upper bound',
    integerNumber().min(1).max(208),
    Infinity,
    [issue('', 'Expected integer, received float'), issue('', 'Number must be less than or equal to 208')],
  ],
  [
    '-Infinity on an integer reports the integer AND the lower bound',
    integerNumber().min(1).max(208),
    -Infinity,
    [issue('', 'Expected integer, received float'), issue('', 'Number must be greater than or equal to 1')],
  ],
  ['-Infinity under a lower bound', z.number().positive(), -Infinity, [issue('', 'Number must be greater than 0')]],
  ['Infinity over an upper bound', z.number().lt(1), Infinity, [issue('', 'Number must be less than 1')]],
  ['Infinity is not a multiple', z.number().multipleOf(5), Infinity, [issue('', 'Number must be a multiple of 5')]],
  ['Infinity runs a refine', z.number().refine((n) => n < 10, { message: 'under 10' }), Infinity, [issue('', 'under 10')]],
  [
    'Infinity deep in a body keeps its path',
    z.object({ lines: z.array(z.object({ n: integerNumber().max(5) })) }),
    { lines: [{ n: Infinity }] },
    [issue('lines.0.n', 'Expected integer, received float'), issue('lines.0.n', 'Number must be less than or equal to 5')],
  ],
  [
    'Infinity in two elements',
    z.array(integerNumber().min(0)),
    [-Infinity, 1, Infinity],
    [
      issue('0', 'Expected integer, received float'),
      issue('0', 'Number must be greater than or equal to 0'),
      issue('2', 'Expected integer, received float'),
    ],
  ],
];

describe('parseForClient words every issue as zod 3 did', () => {
  it.each([...ROWS, ...INFINITY_ROWS])('%s', (_label, schema, input, issues) => {
    expect(parseForClient(schema, input)).toEqual({ success: false, issues });
  });

  it('returns the parsed data on success', () => {
    expect(parseForClient(z.object({ a: z.string().default('x') }), {})).toEqual({ success: true, data: { a: 'x' } });
  });
});

describe('T1 · where zod 3 accepted ±Infinity as a number, zod 4 rejects it', () => {
  const ZOD4 = '_zod' in z.string();
  const rows: Array<[string, z.ZodType, number]> = [
    ['a bare number', z.number(), Infinity],
    ['under a lower bound it does not break', z.number().positive(), Infinity],
    ['under an upper bound it does not break', z.number().max(1), -Infinity],
  ];

  it.each(rows)('%s', (_label, schema, input) => {
    expect(parseForClient(schema, input)).toEqual(
      ZOD4 ? { success: false, issues: [issue('', 'Number must be finite')] } : { success: true, data: input }
    );
  });
});

describe('parseForClient stays linear in the number of issues', () => {
  // express.json takes 10 MB: two bytes per element is millions of issues in
  // one request, and a quadratic step there blocks the event loop for hours.
  const BUDGET_MS = 5000;
  const N = 100_000;

  it.each([
    ['wrong-type elements', z.object({ tags: z.array(z.string()) }), { tags: Array<number>(N).fill(0) }],
    [
      'arrays too short, each with its own element issue',
      z.object({ rows: z.array(z.array(boundedString({ min: 1 })).min(2)) }),
      { rows: Array.from({ length: N / 2 }, () => ['']) },
    ],
    // On zod 4 each element also fails the safe-integer bound (T2), which
    // the adapter drops because the field reports its own bound.
    ['integers beyond 2^53 under a tighter bound', z.array(integerNumber().max(5)), Array<number>(N).fill(2 ** 60)],
  ] as Array<[string, z.ZodType, unknown]>)('%s', (_label, schema, input) => {
    const started = performance.now();
    const parsed = parseForClient(schema, input);
    const elapsed = performance.now() - started;
    expect(parsed.success ? 0 : parsed.issues.length).toBe(N);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});

describe('the 422 adapter costs little next to zod itself on a body full of issues', () => {
  // A body at express.json's 10 MB limit, {"xml_contents":[1,1,…]}, is five
  // million element issues. zod's own parse of it is the floor. The
  // issue-list step once built a trie node and a tuple per issue: about half
  // the parse again, and with the rest of the adapter a 3 GB heap ran out
  // where zod 3 did not (#367). Ratios to zod's own parse, the fastest of
  // seven runs each taken in turns, hold on a slow machine too.
  //
  // The array here is too SHORT for its floor, not too long for a cap: since
  // zod 4.6.6 (GHSA-mrhx-c7xc-m3w5) an array past its `.max()` answers with
  // the cap alone and its elements are never read, so a capped array no
  // longer fills a body with issues. One under its `.min()` still does, and
  // so does an array with no bound at all (src/api/rest/topes.ts lists them);
  // the size issue is kept in the picture because moving it in front of its
  // element issues is the step that once cost a node per issue.
  // Six parses of this body take longer than vitest's 5 s default on a CI
  // runner, and the ratio, not the wall clock, is what is judged here.
  const TIMEOUT_MS = 120_000;
  const N = 250_000;
  const schema = z.object({ xml_contents: z.array(z.string()).min(N + 1) });
  const body: unknown = JSON.parse(`{"xml_contents":[${Array<string>(N).fill('1').join(',')}]}`);
  // The fastest of seven runs of each, taken in turns, so a collection of
  // this body's garbage lands on both sides of the ratio alike. One run at a
  // time put it anywhere between 0.8 and 1.9 on the same machine, and 1.87
  // on a CI runner.
  const fastestInTurns = (a: () => void, b: () => void): [number, number] => {
    let bestA = Infinity;
    let bestB = Infinity;
    for (let i = 0; i < 7; i++) {
      let started = performance.now();
      a();
      bestA = Math.min(bestA, performance.now() - started);
      started = performance.now();
      b();
      bestB = Math.min(bestB, performance.now() - started);
    }
    return [bestA, bestB];
  };

  it('restores the zod 3 issue list for well under half the parse', () => {
    // In turns, like the test below, so a garbage collection lands on both
    // sides of the ratio alike.
    let issues: z.core.$ZodIssue[] = [];
    const [floor, normalize] = fastestInTurns(
      () => {
        const parsed = schema.safeParse(body, { error: legacyIssueMessage, reportInput: true });
        if (!parsed.success) issues = parsed.error.issues;
      },
      () => void normalizeLegacyIssues(issues),
    );
    expect(issues).toHaveLength(N + 1);
    // Measured at 0.25 to 0.28 on CI runners in turns, and 0.35 on a loaded
    // machine: a bound of 0.25 sat on the measurement and failed PRs that
    // touch neither zod nor the adapter. The regression this guards against,
    // a trie node and a tuple per issue, cost about half the parse (0.5), so
    // 0.4 still catches it and leaves room for a noisy runner, as the test
    // below does with its bound of 3.
    expect(normalize / floor).toBeLessThan(0.4);
  }, TIMEOUT_MS);

  it('answers through validateBody for three times the parse at most', () => {
    const handler = validateBody(schema);
    let message = '';
    const next = (error?: unknown): void => {
      message = error instanceof Error ? error.message : '';
    };
    const [adapter, floor] = fastestInTurns(
      () => void handler({ body } as Request, {} as Response, next),
      () => {
        const parsed = schema.safeParse(body, { error: legacyIssueMessage });
        if (!parsed.success) void parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      }
    );
    const head = `Invalid request body: xml_contents: Array must contain at least ${N + 1} element(s); xml_contents.0: Expected string, received number; `;
    expect(message.slice(0, head.length)).toBe(head);
    expect(message.split('; ')).toHaveLength(N + 1);
    // Measured at 1.0 to 1.6 in turns. The regression this guards against,
    // a step per issue that grows with the issue count, lands orders of
    // magnitude above 3 at this size, so 3 leaves room for a noisy runner.
    expect(adapter / floor).toBeLessThan(3);
  }, TIMEOUT_MS);
});

describe('an array past its cap answers with the cap alone', () => {
  // zod 3 reported the cap and then every element; so did zod 4 up to 4.6.5,
  // after the elements. From 4.6.6 (GHSA-mrhx-c7xc-m3w5) the elements of an
  // array past its `.max()` are not validated at all: the 422 names the cap
  // and nothing under it. That is the one place the client contract moved
  // with the upgrade, and it is pinned here so a later zod cannot move it
  // back, or further, in silence.
  it.each([
    ['at the top level', z.array(z.string()).max(1), [1, 2], [issue('', 'Array must contain at most 1 element(s)')]],
    [
      'under a field, next to another field that still reports',
      z.object({ tags: z.array(z.string()).max(1), name: z.string() }),
      { tags: [1, 2], name: 3 },
      [issue('tags', 'Array must contain at most 1 element(s)'), issue('name', 'Expected string, received number')],
    ],
    [
      'while an array within its cap still reports its elements',
      z.array(z.string()).max(2),
      [1, 2],
      [issue('0', 'Expected string, received number'), issue('1', 'Expected string, received number')],
    ],
  ] as Array<[string, z.ZodType, unknown, ClientIssue[]]>)('%s', (_label, schema, input, issues) => {
    expect(parseForClient(schema, input)).toEqual({ success: false, issues });
  });
});

describe('a body far past an array cap is refused at once (#407)', () => {
  // express.json's 10 MB limit holds ~5.2 million `1,` elements. Zod used to
  // build an issue per element before the cap applied: ~11-24 s for the 422.
  const ELEMENTS = 5_200_000;
  const ones = Array<string>(ELEMENTS).fill('1').join(',');

  it('answers the 10 MB xml_contents body of invalid elements, on the real upload schema, in under a second', () => {
    const text = `{"xml_contents":[${ones}]}`;
    expect(text.length).toBeGreaterThan(10_000_000);
    const body: unknown = JSON.parse(text);
    const started = performance.now();
    const parsed = parseForClient(uploadXmlSchema, body);
    const elapsed = performance.now() - started;
    expect(parsed).toEqual({
      success: false,
      issues: [
        {
          path: 'xml_contents',
          message: expect.stringContaining(`${ELEMENTS} documents arrived and 100 fit in one request.`) as string,
        },
      ],
    });
    expect(elapsed).toBeLessThan(1000);
  }, 120_000);

  it('does the same for the bulk pre-registration ids', () => {
    const body: unknown = JSON.parse(`{"action":"approve","ids":[${ones}]}`);
    const started = performance.now();
    const parsed = parseForClient(bulkPreRegSchema, body);
    const elapsed = performance.now() - started;
    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.issues.map((i) => i.path)).toEqual(['ids']);
    expect(elapsed).toBeLessThan(1000);
  }, 120_000);
});

// ============================================================
// THE 422 IS WRITTEN BY CATALOG KEY (MNE-001-152, #151)
//
// Every message the adapter words now comes from one key of src/i18n/en.ts,
// with the issue's parameters. The rows above are the byte proof that the
// English did not move; the rows below pin the key and the parameters behind
// each message, and what the same issues read in Spanish. Every literal is
// written by hand.
// ============================================================

const VE = 'error.VALIDATION_ERROR.issue';
const keyed = (path: string, message: string, key: ErrorMessageKey): KeyedClientIssue => ({ path, message, key });

describe('parseForClientKeyed names the key and the parameters of every issue it words', () => {
  const KEYED_ROWS: Array<[string, z.ZodType, unknown, KeyedClientIssue[]]> = [
    ['Required', obj, {}, [keyed('a', 'Required', { key: `${VE}.required` })]],
    ['an integer given a float', integerNumber(), 1.5, [keyed('', 'Expected integer, received float', { key: `${VE}.integer_received_float` })]],
    ['a number given Infinity', z.number(), Infinity, [keyed('', 'Number must be finite', { key: `${VE}.not_finite` })]],
    [
      'the wrong type',
      obj,
      { a: 1 },
      [keyed('a', 'Expected string, received number', { key: `${VE}.invalid_type`, params: { expected: 'string', received: 'number' } })],
    ],
    [
      'a literal',
      z.literal('x'),
      1,
      [keyed('', 'Invalid literal value, expected "x"', { key: `${VE}.invalid_literal`, params: { expected: '"x"' } })],
    ],
    [
      'an enum given a string',
      ab,
      'c',
      [
        keyed('', "Invalid enum value. Expected 'a' | 'b', received 'c'", {
          key: `${VE}.invalid_enum_value`,
          params: { expected: "'a' | 'b'", received: 'c' },
        }),
      ],
    ],
    [
      'an enum given a number is a type failure',
      ab,
      1,
      [keyed('', "Expected 'a' | 'b', received number", { key: `${VE}.invalid_type`, params: { expected: "'a' | 'b'", received: 'number' } })],
    ],
    ['a regex', z.string().regex(/^a$/), 'b', [keyed('', 'Invalid', { key: `${VE}.invalid_format`, params: { format: 'regex' } })]],
    ['a named format', uuidString(), 'nope', [keyed('', 'Invalid uuid', { key: `${VE}.invalid_format`, params: { format: 'uuid' } })]],
    [
      'a prefix',
      z.string().startsWith('ab'),
      'x',
      [keyed('', 'Invalid input: must start with "ab"', { key: `${VE}.invalid_affix`, params: { affix: 'starts_with', value: 'ab' } })],
    ],
    [
      'array at least',
      z.array(z.string()).min(2),
      ['a'],
      [keyed('', 'Array must contain at least 2 element(s)', { key: `${VE}.too_small.array`, params: { bound: 'inclusive', minimum: '2' } })],
    ],
    [
      'array exactly, too short',
      z.array(z.string()).length(2),
      ['a'],
      [keyed('', 'Array must contain exactly 2 element(s)', { key: `${VE}.too_small.array`, params: { bound: 'exact', minimum: '2' } })],
    ],
    [
      'string at least',
      boundedString({ min: 2 }),
      'a',
      [keyed('', 'String must contain at least 2 character(s)', { key: `${VE}.too_small.string`, params: { bound: 'inclusive', minimum: '2' } })],
    ],
    [
      'string exactly, too short',
      boundedString({ length: 3 }),
      'ab',
      [keyed('', 'String must contain exactly 3 character(s)', { key: `${VE}.too_small.string`, params: { bound: 'exact', minimum: '3' } })],
    ],
    [
      'number greater than or equal',
      z.number().min(1),
      0,
      [keyed('', 'Number must be greater than or equal to 1', { key: `${VE}.too_small.number`, params: { bound: 'inclusive', minimum: '1' } })],
    ],
    [
      'number greater than',
      z.number().positive(),
      0,
      [keyed('', 'Number must be greater than 0', { key: `${VE}.too_small.number`, params: { bound: 'exclusive', minimum: '0' } })],
    ],
    [
      'array at most',
      z.array(z.string()).max(1),
      ['a', 'b'],
      [keyed('', 'Array must contain at most 1 element(s)', { key: `${VE}.too_big.array`, params: { bound: 'inclusive', maximum: '1' } })],
    ],
    [
      'array exactly, too long',
      z.array(z.string()).length(2),
      ['a', 'b', 'c'],
      [keyed('', 'Array must contain exactly 2 element(s)', { key: `${VE}.too_big.array`, params: { bound: 'exact', maximum: '2' } })],
    ],
    [
      'string at most',
      boundedString({ max: 1 }),
      'ab',
      [keyed('', 'String must contain at most 1 character(s)', { key: `${VE}.too_big.string`, params: { bound: 'inclusive', maximum: '1' } })],
    ],
    [
      'string exactly, too long',
      boundedString({ length: 3 }),
      'abcd',
      [keyed('', 'String must contain exactly 3 character(s)', { key: `${VE}.too_big.string`, params: { bound: 'exact', maximum: '3' } })],
    ],
    [
      'number less than or equal',
      z.number().max(1),
      2,
      [keyed('', 'Number must be less than or equal to 1', { key: `${VE}.too_big.number`, params: { bound: 'inclusive', maximum: '1' } })],
    ],
    [
      'number less than',
      z.number().lt(1),
      1,
      [keyed('', 'Number must be less than 1', { key: `${VE}.too_big.number`, params: { bound: 'exclusive', maximum: '1' } })],
    ],
    [
      'a bigint over its bound',
      z.bigint().max(5n),
      6n,
      [keyed('', 'BigInt must be less than or equal to 5', { key: `${VE}.too_big.bigint`, params: { bound: 'inclusive', maximum: '5' } })],
    ],
    [
      'not a multiple',
      z.number().multipleOf(5),
      7,
      [keyed('', 'Number must be a multiple of 5', { key: `${VE}.not_multiple_of`, params: { divisor: '5' } })],
    ],
    [
      'unrecognized keys',
      z.object({}).strict(),
      { a: 1, b: 2 },
      [keyed('', "Unrecognized key(s) in object: 'a', 'b'", { key: `${VE}.unrecognized_keys`, params: { keys: "'a', 'b'" } })],
    ],
    ['a union with no match', z.union([z.string(), z.number()]), true, [keyed('', 'Invalid input', { key: `${VE}.invalid_input` })]],
    ['a refine without a message', z.string().refine((v) => v === 'a'), 'b', [keyed('', 'Invalid input', { key: `${VE}.invalid_input` })]],
    [
      'Infinity on a bounded integer keeps both issues, each keyed',
      z.object({ count: integerNumber().max(208) }),
      { count: Infinity },
      [
        keyed('count', 'Expected integer, received float', { key: `${VE}.integer_received_float` }),
        keyed('count', 'Number must be less than or equal to 208', { key: `${VE}.too_big.number`, params: { bound: 'inclusive', maximum: '208' } }),
      ],
    ],
    // What a schema writes itself, and what zod words for a code the map does
    // not know, travels verbatim and has no key.
    ['a message the schema sets', z.string().min(1, 'msg'), '', [{ path: '', message: 'msg' }]],
    ['a refine with a message', z.string().refine((v) => v === 'a', { message: 'Must be a' }), 'b', [{ path: '', message: 'Must be a' }]],
    // Not 'YYYY-MM-DD': a schema writes that one by key since MNE-001-588.
    ['a regex with a message', z.string().regex(/^a$/, 'Not a date'), 'b', [{ path: '', message: 'Not a date' }]],
    ['a format zod 3 had no name for', z.ipv4(), 'x', [{ path: '', message: 'Invalid IPv4 address' }]],
    ['a code the map does not know', z.record(z.string().regex(/^a/), z.number()), { b: 1 }, [{ path: 'b', message: 'Invalid key in record' }]],
  ];

  it.each(KEYED_ROWS)('%s', (_label, schema, input, issues) => {
    expect(parseForClientKeyed(schema, input)).toStrictEqual({ success: false, issues });
  });

  it('parseForClient answers the same issues without their keys', () => {
    const schema = z.object({ a: z.string(), b: z.string().min(1, 'msg') });
    expect(parseForClient(schema, { b: '' })).toStrictEqual({
      success: false,
      issues: [issue('a', 'Required'), issue('b', 'msg')],
    });
  });

  it('a success is the parsed data, as from parseForClient', () => {
    expect(parseForClientKeyed(z.object({ a: z.string().default('x') }), {})).toStrictEqual({ success: true, data: { a: 'x' } });
  });
});

describe('a message a schema sets by key is keyed in the 422 too (MNE-001-588)', () => {
  const SCHEMA = 'error.VALIDATION_ERROR.schema';

  it('schemaMessage is the English of the key, and the issue it words carries that key', () => {
    const message = schemaMessage(`${SCHEMA}.date_format`);
    expect(message).toBe('YYYY-MM-DD');
    expect(parseForClientKeyed(z.object({ d: z.string().regex(/^\d{4}$/, message) }), { d: 'x' })).toStrictEqual({
      success: false,
      issues: [keyed('d', 'YYYY-MM-DD', { key: `${SCHEMA}.date_format` })],
    });
  });

  it('a refine, an array minimum and an error map written by key are keyed alike', () => {
    const empty = schemaMessage(`${SCHEMA}.at_least_one_field`);
    const lines = schemaMessage(`${SCHEMA}.entry_min_lines`);
    const amount = schemaMessage(`${SCHEMA}.matched_amount_positive`);
    const schema = z.object({
      patch: z.object({ a: z.string().optional() }).refine((o) => Object.keys(o).length > 0, { message: empty }),
      lines: z.array(z.string()).min(2, lines),
      amount: z.union([z.string(), z.number()], { error: () => amount }),
    });
    expect(parseForClientKeyed(schema, { patch: {}, lines: [], amount: true })).toStrictEqual({
      success: false,
      issues: [
        keyed('patch', 'At least one field must be provided', { key: `${SCHEMA}.at_least_one_field` }),
        keyed('lines', 'At least 2 lines required', { key: `${SCHEMA}.entry_min_lines` }),
        keyed('amount', 'matched_amount must be a positive decimal', { key: `${SCHEMA}.matched_amount_positive` }),
      ],
    });
  });

  it('a custom issue carries a key with per-request values in its params', () => {
    const cap = { key: `${VE}.too_big.array`, params: { bound: 'inclusive', maximum: '1' } } as const;
    const schema = z.array(z.string()).superRefine((rows, ctx) => {
      if (rows.length > 1) ctx.addIssue({ code: 'custom', ...keyedIssueParams(cap) });
    });
    const parsed = parseForClientKeyed(schema, ['a', 'b']);
    expect(parsed).toStrictEqual({ success: false, issues: [keyed('', 'Array must contain at most 1 element(s)', cap)] });
    const err = new RequestValidationError({ kind: 'body' }, parsed.success ? [] : parsed.issues);
    expect(err.localized('es')).toBe('Cuerpo de la petición inválido: <root>: El arreglo debe tener como máximo 1 elemento');
  });

  it('a message written as prose still has no key', () => {
    expect(parseForClientKeyed(z.string().min(1, 'Not by key'), '')).toStrictEqual({
      success: false,
      issues: [{ path: '', message: 'Not by key' }],
    });
  });
});

describe('legacyIssueKey covers the bounds no zod 4 helper of this code produces', () => {
  // zod 3 worded an exclusive array or string bound ("more than", "over",
  // "less than", "under") and an exact number. No schema of this API builds
  // one, so the raw issues are written by hand.
  const raw = (fields: Record<string, unknown>): z.core.$ZodRawIssue => ({ path: [], input: undefined, ...fields }) as unknown as z.core.$ZodRawIssue;
  const ROWS_RAW: Array<[string, z.core.$ZodRawIssue, ErrorMessageKey, string]> = [
    [
      'array more than',
      raw({ code: 'too_small', origin: 'array', minimum: 2, inclusive: false }),
      { key: `${VE}.too_small.array`, params: { bound: 'exclusive', minimum: '2' } },
      'Array must contain more than 2 element(s)',
    ],
    [
      'string over',
      raw({ code: 'too_small', origin: 'string', minimum: 2, inclusive: false }),
      { key: `${VE}.too_small.string`, params: { bound: 'exclusive', minimum: '2' } },
      'String must contain over 2 character(s)',
    ],
    [
      'number exactly equal to',
      raw({ code: 'too_small', origin: 'number', minimum: 3, inclusive: true, exact: true }),
      { key: `${VE}.too_small.number`, params: { bound: 'exact', minimum: '3' } },
      'Number must be exactly equal to 3',
    ],
    [
      'array less than',
      raw({ code: 'too_big', origin: 'array', maximum: 2, inclusive: false }),
      { key: `${VE}.too_big.array`, params: { bound: 'exclusive', maximum: '2' } },
      'Array must contain less than 2 element(s)',
    ],
    [
      'string under',
      raw({ code: 'too_big', origin: 'string', maximum: 2, inclusive: false }),
      { key: `${VE}.too_big.string`, params: { bound: 'exclusive', maximum: '2' } },
      'String must contain under 2 character(s)',
    ],
    [
      'number exactly',
      raw({ code: 'too_big', origin: 'number', maximum: 3, inclusive: true, exact: true }),
      { key: `${VE}.too_big.number`, params: { bound: 'exact', maximum: '3' } },
      'Number must be exactly 3',
    ],
    [
      'a bigint under its lower bound reads as a number, as in zod 3',
      raw({ code: 'too_small', origin: 'bigint', minimum: 5n, inclusive: true }),
      { key: `${VE}.too_small.number`, params: { bound: 'inclusive', minimum: '5' } },
      'Number must be greater than or equal to 5',
    ],
    [
      'a suffix',
      raw({ code: 'invalid_format', format: 'ends_with', suffix: 'z' }),
      { key: `${VE}.invalid_affix`, params: { affix: 'ends_with', value: 'z' } },
      'Invalid input: must end with "z"',
    ],
    [
      'an infix',
      raw({ code: 'invalid_format', format: 'includes', includes: 'q' }),
      { key: `${VE}.invalid_affix`, params: { affix: 'includes', value: 'q' } },
      'Invalid input: must include "q"',
    ],
  ];

  it.each(ROWS_RAW)('%s', (_label, rawIssue, key, english) => {
    expect(legacyIssueKey(rawIssue)).toStrictEqual(key);
    expect(legacyIssueMessage(rawIssue)).toBe(english);
  });

  it('a code it does not know has no key, and keeps zod its own text', () => {
    expect(legacyIssueKey(raw({ code: 'invalid_key', origin: 'record', issues: [] }))).toBeUndefined();
    expect(legacyIssueMessage(raw({ code: 'invalid_key', origin: 'record', issues: [] }))).toBeUndefined();
  });
});

describe('RequestValidationError: the English of today in err.message, the language of the reader on the wire', () => {
  const issuesOf = (schema: z.ZodType, input: unknown): KeyedClientIssue[] => {
    const parsed = parseForClientKeyed(schema, input);
    if (parsed.success) throw new Error('the row expects a failure');
    return parsed.issues;
  };

  it('a body: the zod 3 sentence in English, its key, and the Spanish frame and issues', () => {
    const schema = z.object({ entity_id: uuidString(), entry_date: z.string(), lines: z.array(z.object({})) });
    const err = new RequestValidationError({ kind: 'body' }, issuesOf(schema, {}));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.field).toBeUndefined();
    expect(err.message).toBe('Invalid request body: entity_id: Required; entry_date: Required; lines: Required');
    expect(err.messageKey?.key).toBe('error.VALIDATION_ERROR.body');
    expect(err.localized('en')).toBe(err.message);
    expect(err.localized('es')).toBe(
      'Cuerpo de la petición inválido: entity_id: Obligatorio; entry_date: Obligatorio; lines: Obligatorio'
    );
  });

  it('a query parameter: no path in the list, and `field` is the parameter', () => {
    const err = new RequestValidationError(
      { kind: 'query', name: 'status' },
      issuesOf(z.enum(['pending_review', 'approved', 'rejected']), 'bogus')
    );
    expect(err.field).toBe('status');
    expect(err.message).toBe(
      "Invalid query parameter: status: Invalid enum value. Expected 'pending_review' | 'approved' | 'rejected', received 'bogus'"
    );
    expect(err.messageKey?.key).toBe('error.VALIDATION_ERROR.query');
    expect(err.localized('en')).toBe(err.message);
    expect(err.localized('es')).toBe(
      "Parámetro de consulta inválido: status: Valor no admitido. Se esperaba 'pending_review' | 'approved' | 'rejected' y llegó 'bogus'"
    );
  });

  it('a keyed issue next to a message the schema wrote, at the root', () => {
    const err = new RequestValidationError({ kind: 'body' }, [
      keyed('name', 'String must contain at most 255 character(s)', {
        key: `${VE}.too_big.string`,
        params: { bound: 'inclusive', maximum: '255' },
      }),
      { path: '', message: 'At least one field must be provided' },
    ]);
    expect(err.message).toBe(
      'Invalid request body: name: String must contain at most 255 character(s); <root>: At least one field must be provided'
    );
    expect(err.localized('es')).toBe(
      'Cuerpo de la petición inválido: name: La cadena debe tener como máximo 255 caracteres; <root>: At least one field must be provided'
    );
  });

  const SPANISH: Array<[string, z.ZodType, unknown, string]> = [
    [
      'Infinity on a bounded integer',
      z.object({ count: integerNumber().max(208) }),
      { count: Infinity },
      'count: Se esperaba un número entero y llegó uno con decimales; count: El número debe ser menor o igual que 208',
    ],
    [
      'the JSON type names stay as docs/openapi.json writes them',
      z.object({ tags: z.array(z.string()) }),
      { tags: [0, 0] },
      'tags.0: Se esperaba string y llegó number; tags.1: Se esperaba string y llegó number',
    ],
    ['a regex', z.object({ code: z.string().regex(/^a$/) }), { code: 'b' }, 'code: Formato inválido'],
    ['a named format', z.object({ id: uuidString() }), { id: 'x' }, 'id: Formato uuid inválido'],
    ['a string too short', z.object({ name: boundedString({ min: 2 }) }), { name: 'a' }, 'name: La cadena debe tener al menos 2 caracteres'],
    ['one element, in the singular', z.object({ lines: z.array(z.string()).min(1) }), { lines: [] }, 'lines: El arreglo debe tener al menos 1 elemento'],
    ['a union with no match', z.object({ v: z.union([z.string(), z.number()]) }), { v: true }, 'v: Entrada inválida'],
    ['a number given Infinity', z.object({ w: z.number() }), { w: Infinity }, 'w: El número debe ser finito'],
  ];

  it.each(SPANISH)('in Spanish · %s', (_label, schema, input, issues) => {
    const err = new RequestValidationError({ kind: 'body' }, issuesOf(schema, input));
    expect(err.localized('es')).toBe(`Cuerpo de la petición inválido: ${issues}`);
  });
});
