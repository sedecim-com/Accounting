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
  legacyIssueMessage,
  normalizeLegacyIssues,
  parseForClient,
  type ClientIssue,
} from '../../src/utils/zod-client-errors.js';
import { arregloAcotado } from '../../src/api/rest/topes.js';
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
  // million element issues, all built before the array cap runs. zod's own
  // parse of it is the floor. The issue-list step once built a trie node and
  // a tuple per issue: about half the parse again, and with the rest of the
  // adapter a 3 GB heap ran out where zod 3 did not (#367). Ratios to zod's
  // own parse, the fastest of seven runs each taken in turns, hold on a slow
  // machine too.
  // Six parses of this body take longer than vitest's 5 s default on a CI
  // runner, and the ratio, not the wall clock, is what is judged here.
  const TIMEOUT_MS = 120_000;
  const N = 250_000;
  const schema = z.object({ xml_contents: z.array(z.string()).max(100) });
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
    expect(message.slice(0, 129)).toBe(
      'Invalid request body: xml_contents: Array must contain at most 100 element(s); xml_contents.0: Expected string, received number; '
    );
    expect(message.split('; ')).toHaveLength(N + 1);
    // Measured at 1.0 to 1.6 in turns. The regression this guards against,
    // a step per issue that grows with the issue count, lands orders of
    // magnitude above 3 at this size, so 3 leaves room for a noisy runner.
    expect(adapter / floor).toBeLessThan(3);
  }, TIMEOUT_MS);
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
          message: expect.stringContaining(`llegaron ${ELEMENTS} documentos y caben 100 por petición.`) as string,
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
