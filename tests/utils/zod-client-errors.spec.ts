import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseForClient, type ClientIssue } from '../../src/utils/zod-client-errors.js';
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
];

describe('parseForClient words every issue as zod 3 did', () => {
  it.each(ROWS)('%s', (_label, schema, input, issues) => {
    expect(parseForClient(schema, input)).toEqual({ success: false, issues });
  });

  it('returns the parsed data on success', () => {
    expect(parseForClient(z.object({ a: z.string().default('x') }), {})).toEqual({ success: true, data: { a: 'x' } });
  });
});
