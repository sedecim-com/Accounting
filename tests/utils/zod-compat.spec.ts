import { describe, expect, it } from 'vitest';
import {
  boundedString,
  emailString,
  integerNumber,
  urlString,
  uuidString,
} from '../../src/utils/zod-compat.js';
import { parseForClient } from '../../src/utils/zod-client-errors.js';
import { EMAIL_EDGES, NON_RFC_UUIDS, URL_EDGES } from '../api/golden/rest-body-probes.js';

// ============================================================
// CONTRACT: each compat helper keeps the zod 3.25.76 grammar (#367).
//
// Written against literal copies of zod 3's own definitions, so this file
// passes unchanged whatever Zod major implements the helpers: on zod 3 they
// ARE those definitions, and on zod 4 they must reproduce them.
// ============================================================

// zod 3.25.76, v3/types.js:368 and v3/types.js:384, copied verbatim.
const V3_UUID = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
const V3_EMAIL = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;

/** mulberry32: a small seeded generator, so the corpus is the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random: () => number, alphabet: string): string {
  return alphabet[Math.floor(random() * alphabet.length)] ?? '';
}

/** Near-UUID strings: a random 8-4-4-4-12 in mixed case, then up to three mutations. */
function uuidCorpus(size: number): string[] {
  const random = seeded(367);
  const hex = '0123456789abcdefABCDEF';
  const noise = '0123456789abcdefABCDEFgGxXzZ-_ {}\n\t.';
  const out: string[] = [];
  for (let n = 0; n < size; n++) {
    let s = [8, 4, 4, 4, 12]
      .map((len) => Array.from({ length: len }, () => pick(random, hex)).join(''))
      .join('-');
    const mutations = Math.floor(random() * 4);
    for (let m = 0; m < mutations; m++) {
      const at = Math.floor(random() * (s.length + 1));
      const kind = Math.floor(random() * 3);
      if (kind === 0) s = s.slice(0, at) + pick(random, noise) + s.slice(at + 1);
      else if (kind === 1) s = s.slice(0, at) + s.slice(at + 1);
      else s = s.slice(0, at) + pick(random, noise) + s.slice(at);
    }
    out.push(s);
  }
  return out;
}

const NAMED_IDS = [
  ...NON_RFC_UUIDS,
  '11111111-1111-4111-8111-111111111111',
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  'A8D1F2B4-7E52-4D90-C16F-425D6E7F8091'.toLowerCase(),
  'nope',
  'gggggggg-gggg-gggg-gggg-gggggggggggg',
  '11111111-1111-1111-1111-111111111111\n',
  '{11111111-1111-1111-1111-111111111111}',
  '111111111111111111111111111111111111',
  '11111111-1111-1111-1111-11111111111',
  ' 11111111-1111-1111-1111-111111111111',
];

const accepts = (schema: Parameters<typeof parseForClient>[0], value: unknown): boolean =>
  parseForClient(schema, value).success;

describe('uuidString keeps the v3 grammar: any 8-4-4-4-12 hex', () => {
  it('agrees with v3 on every named id', () => {
    const disagreements = NAMED_IDS.filter((id) => accepts(uuidString(), id) !== V3_UUID.test(id));
    expect(disagreements).toEqual([]);
    for (const id of NON_RFC_UUIDS) expect(accepts(uuidString(), id), id).toBe(true);
  });

  it('agrees with v3 on a seeded corpus of 20 000 near-UUIDs', () => {
    const corpus = uuidCorpus(20_000);
    const schema = uuidString();
    const disagreements = corpus.filter((s) => accepts(schema, s) !== V3_UUID.test(s));
    expect(disagreements.slice(0, 10)).toEqual([]);
    // The corpus is only a test if it has both kinds in it.
    expect(corpus.filter((s) => V3_UUID.test(s)).length).toBeGreaterThan(4_000);
    expect(corpus.filter((s) => !V3_UUID.test(s)).length).toBeGreaterThan(4_000);
  });

  it('says Invalid uuid, or the message it was given', () => {
    expect(parseForClient(uuidString(), 'nope')).toEqual({ success: false, issues: [{ path: '', message: 'Invalid uuid' }] });
    expect(parseForClient(uuidString('Not an id'), 'nope')).toEqual({
      success: false,
      issues: [{ path: '', message: 'Not an id' }],
    });
  });
});

const EMAIL_CORPUS = [
  ...EMAIL_EDGES,
  'a@b.co',
  'a@b',
  'a@',
  '@b.co',
  'a b@c.co',
  'a@b..co',
  'a@-b.co',
  'a@b-.co',
  'a-@b.co',
  'a.@b.co',
  'a_b@c.co',
  '"a"@b.co',
  'a@b.c0',
  'a@b.co.',
  'a@[127.0.0.1]',
  'a@sub.b.co',
  'a@B.CO',
  'a@b.comm',
  "a'b@c.co",
  'a%b@c.co',
];

describe('emailString keeps the v3 grammar', () => {
  it('agrees with the v3 regex on every sample', () => {
    const disagreements = EMAIL_CORPUS.filter((s) => accepts(emailString(), s) !== V3_EMAIL.test(s));
    expect(disagreements).toEqual([]);
  });
});

function parsesAsUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

const URL_CORPUS = [
  ...URL_EDGES,
  'https://a.com',
  ' https://a.com',
  'https://a.com ',
  '\nhttps://a.com',
  'https://a.com/\tpath',
  'not a url',
  '',
  'a',
  '//a.com',
  'http://',
  'http://[::1]',
  'javascript:alert(1)',
  'ftp://x',
  'https://exa mple.com',
  'HTTPS://A.COM',
];

describe('urlString keeps the v3 grammar: whatever new URL() parses, kept as sent', () => {
  it('accepts exactly what new URL() accepts', () => {
    const disagreements = URL_CORPUS.filter((s) => accepts(urlString(), s) !== parsesAsUrl(s));
    expect(disagreements).toEqual([]);
  });

  it('returns every accepted value exactly as it arrived', () => {
    for (const s of URL_CORPUS.filter(parsesAsUrl)) {
      expect(parseForClient(urlString(), s), JSON.stringify(s)).toEqual({ success: true, data: s });
    }
  });

  it('says Invalid url', () => {
    expect(parseForClient(urlString(), ' https://a.com')).toEqual({
      success: false,
      issues: [{ path: '', message: 'Invalid url' }],
    });
  });
});

describe('boundedString counts UTF-16 units, as every published maxLength does', () => {
  it('rejects two astral characters under max 3', () => {
    expect(parseForClient(boundedString({ max: 3 }), '\u{1F600}\u{1F600}')).toEqual({
      success: false,
      issues: [{ path: '', message: 'String must contain at most 3 character(s)' }],
    });
  });

  it('accepts one astral character and one letter as length 3', () => {
    expect(accepts(boundedString({ length: 3 }), '\u{1F600}a')).toBe(true);
    expect(accepts(boundedString({ length: 3 }), '\u{1F600}\u{1F600}\u{1F600}')).toBe(false);
  });

  it('accepts two astral characters as min 4', () => {
    expect(accepts(boundedString({ min: 4 }), '\u{1F600}\u{1F600}')).toBe(true);
  });

  it('checks min, then max, then length, with the messages it was given', () => {
    expect(parseForClient(boundedString({ min: 3, max: 1 }, { min: 'short', max: 'long' }), 'ab')).toEqual({
      success: false,
      issues: [
        { path: '', message: 'short' },
        { path: '', message: 'long' },
      ],
    });
  });
});

describe('integerNumber reports the bounds after a failed integer check', () => {
  it('gives both v3 messages, in order', () => {
    expect(parseForClient(integerNumber().min(1).max(208), 0.5)).toEqual({
      success: false,
      issues: [
        { path: '', message: 'Expected integer, received float' },
        { path: '', message: 'Number must be greater than or equal to 1' },
      ],
    });
    expect(parseForClient(integerNumber().min(1).max(208), 208.5)).toEqual({
      success: false,
      issues: [
        { path: '', message: 'Expected integer, received float' },
        { path: '', message: 'Number must be less than or equal to 208' },
      ],
    });
  });

  it('accepts an integer in range', () => {
    expect(parseForClient(integerNumber().min(1).max(208), 208)).toEqual({ success: true, data: 208 });
  });
});
