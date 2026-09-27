import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { listProfiles, loadConfigFile, writeConfigPatch } from '../../../src/ai/providers/config.js';

// ============================================================
// CONTRACT: what the config loader tells a person whose config is wrong (#367).
//
// mnemosine.config.json is validated by a strict Zod schema and a rejected
// file is reported by its issues, verbatim. These rows were recorded on zod
// 3.25.76; the Zod 4 migration must reproduce them unchanged, because the
// message is the only thing that tells the person which key to fix. The only
// exceptions are the tightenings T1 and T2 at the end, which carry both
// expectations so the owner reviews them before the bump.
// ============================================================

/** True once `zod` resolves to a v4 runtime; the tightening rows pick their expectation with it. */
const ZOD4 = '_zod' in z.string();

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A project whose config file holds `config`: JSON text as is (1e999, an own __proto__), anything else stringified. */
function projectWith(config: unknown): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-config-contract-'));
  dirs.push(dir);
  const file = path.join(dir, 'mnemosine.config.json');
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
  return { dir, file };
}

/** The exact error loadConfigFile throws for a file the schema rejects. */
function loadError(config: unknown): { message: string; expected: (issues: string) => string } {
  const { dir, file } = projectWith(config);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  let message = '';
  try {
    loadConfigFile(dir);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  return {
    message,
    expected: (issues) =>
      `Invalid configuration in ${file}: ${issues} (rejected copy kept at ${file}.rejected-${hash})`,
  };
}

const profile = (extra: Record<string, unknown>) => ({
  providers: { p: { type: 'openai-compatible', model: 'm', ...extra } },
});

describe('the loader reports every rejected key verbatim', () => {
  const rows: Array<[string, unknown, string]> = [
    ['a header value that is not a string', profile({ headers: { 'X-A': 1 } }), 'providers.p.headers.X-A: Expected string, received number'],
    ['providers as an array', { providers: [] }, 'providers: Expected object, received array'],
    ['an unknown key in a strict profile', profile({ api_key_evn: 'X' }), "providers.p: Unrecognized key(s) in object: 'api_key_evn'"],
    ['a base_url behind a no-break space', profile({ base_url: ' https://a.com' }), 'providers.p.base_url: Invalid url'],
    ['max_iterations 1.5', profile({ max_iterations: 1.5 }), 'providers.p.max_iterations: Expected integer, received float'],
    [
      'max_iterations 0.5 reports the integer AND the bound',
      profile({ max_iterations: 0.5 }),
      'providers.p.max_iterations: Expected integer, received float; providers.p.max_iterations: Number must be greater than or equal to 1',
    ],
    ['an empty model', profile({ model: '' }), 'providers.p.model: String must contain at least 1 character(s)'],
    [
      'an unknown provider type',
      profile({ type: 'x' }),
      "providers.p.type: Invalid enum value. Expected 'anthropic' | 'openai-compatible', received 'x'",
    ],
    ['a missing provider type', { providers: { p: { model: 'm' } } }, 'providers.p.type: Required'],
    // The config format has no '<root>' label: a root issue starts with ': '.
    ['an unknown key at the strict root', { extra: 1 }, ": Unrecognized key(s) in object: 'extra'"],
    [
      'a profile keyed __proto__ is checked like any other',
      '{"providers":{"__proto__":{"type":"bogus","model":""}}}',
      "providers.__proto__.type: Invalid enum value. Expected 'anthropic' | 'openai-compatible', received 'bogus'; " +
        'providers.__proto__.model: String must contain at least 1 character(s)',
    ],
    [
      'a header keyed __proto__ is checked like any other',
      '{"providers":{"p":{"type":"openai-compatible","model":"m","headers":{"__proto__":1}}}}',
      'providers.p.headers.__proto__: Expected string, received number',
    ],
    ['1e999 as a string', '{"tenant":1e999}', 'tenant: Expected string, received number'],
    ['-1e999 under a lower bound', '{"budget":{"daily_usd":-1e999}}', 'budget.daily_usd: Number must be greater than 0'],
    [
      '1e999 over an upper bound',
      '{"ingest":{"auto_post_min_confidence":1e999}}',
      'ingest.auto_post_min_confidence: Number must be less than or equal to 1',
    ],
    ['1e999 as an integer', '{"compaction":{"threshold_tokens":1e999}}', 'compaction.threshold_tokens: Expected integer, received float'],
    [
      '-1e999 as a bounded integer',
      '{"compaction":{"keep_recent_tokens":-1e999}}',
      'compaction.keep_recent_tokens: Expected integer, received float; ' +
        'compaction.keep_recent_tokens: Number must be greater than or equal to 1',
    ],
  ];

  it.each(rows)('%s', (_label, config, issues) => {
    const { message, expected } = loadError(config);
    expect(message).toBe(expected(issues));
  });
});

describe('the loader accepts what zod 3 accepted, and keeps it as written', () => {
  it('keeps a base_url with a leading ASCII space, which the URL parser strips', () => {
    const { dir } = projectWith(profile({ base_url: ' https://a.com' }));
    expect(listProfiles(dir).profiles.p?.base_url).toBe(' https://a.com');
  });

  it('keeps a base_url with an IDN host, however warm the process is', () => {
    // Node 22's URL.canParse turns false for these once V8 optimizes the call;
    // zod 3 ran `new URL`, which still parses them.
    const { dir, file } = projectWith(profile({ base_url: 'https://a.com' }));
    for (let i = 0; i < 20_000; i++) listProfiles(dir);
    for (const url of ['https://señal.mx/hook', 'https://müller.de', 'https://ñ.com']) {
      fs.writeFileSync(file, JSON.stringify(profile({ base_url: url })));
      expect(listProfiles(dir).profiles.p?.base_url).toBe(url);
    }
  });

  it('returns typed profiles from a record of profiles', () => {
    const { dir } = projectWith(profile({ headers: { 'X-A': 'b' }, max_iterations: 3 }));
    const p = listProfiles(dir).profiles.p;
    expect(p?.model).toBe('m');
    expect(p?.headers).toEqual({ 'X-A': 'b' });
    expect(p?.max_iterations).toBe(3);
  });

  it('leaves a valid profile keyed __proto__ out of the profiles', () => {
    const { dir } = projectWith(
      '{"providers":{"__proto__":{"type":"anthropic","model":"m"},"p":{"type":"anthropic","model":"n"}}}'
    );
    const providers = loadConfigFile(dir).config.providers ?? {};
    expect(Object.keys(providers)).toEqual(['p']);
    expect(Object.getPrototypeOf(providers)).toBe(Object.prototype);
  });
});

describe('T1/T2 · the tightenings of the Zod 4 migration reach the config file too', () => {
  // The same two as the REST body (tests/api/rest/body-contract.spec.ts):
  // JSON 1e999 (Infinity) where zod 3 took it as a number, and an integer
  // beyond 2^53 - 1. A file zod 3 loaded is refused, and every command that
  // reads the config says why. null: the file loads.
  const rows: Array<[string, string, string | null, string]> = [
    [
      'T1 · 1e999 as a daily budget',
      '{"budget":{"daily_usd":1e999}}',
      null,
      'budget.daily_usd: Number must be finite',
    ],
    [
      'T1 · 1e999 as a monthly budget',
      '{"budget":{"monthly_usd":1e999}}',
      null,
      'budget.monthly_usd: Number must be finite',
    ],
    [
      'T1 · 1e999 as the auto-post ceiling',
      '{"ingest":{"auto_post_max_amount":1e999}}',
      null,
      'ingest.auto_post_max_amount: Number must be finite',
    ],
    [
      'T2 · 1e21 as max_memory_flushes',
      '{"compaction":{"max_memory_flushes":1e21}}',
      null,
      'compaction.max_memory_flushes: Number must be less than or equal to 9007199254740991',
    ],
    [
      'T2 · 2^53 + 1 as threshold_tokens',
      '{"compaction":{"threshold_tokens":9007199254740993}}',
      null,
      'compaction.threshold_tokens: Number must be less than or equal to 9007199254740991',
    ],
    [
      'T2 · 1e300 as keep_recent_tokens',
      '{"compaction":{"keep_recent_tokens":1e300}}',
      null,
      'compaction.keep_recent_tokens: Number must be less than or equal to 9007199254740991',
    ],
    [
      'T2 · 2^53 under a tighter bound answers as before',
      '{"providers":{"p":{"type":"anthropic","model":"m","max_iterations":9007199254740992}}}',
      'providers.p.max_iterations: Number must be less than or equal to 100',
      'providers.p.max_iterations: Number must be less than or equal to 100',
    ],
  ];

  it.each(rows)('%s', (_label, raw, onZod3, onZod4) => {
    const issues = ZOD4 ? onZod4 : onZod3;
    const { message, expected } = loadError(raw);
    expect(message).toBe(issues === null ? '' : expected(issues));
  });
});

describe('the writer refuses an invalid merge with the same prose', () => {
  it('names the key and every issue on it', () => {
    const { file } = projectWith({});
    expect(() => writeConfigPatch({ compaction: { threshold_tokens: -0.5 } }, undefined, file)).toThrow(
      new Error(
        `Refusing to write an invalid configuration to ${file}: ` +
          'compaction.threshold_tokens: Expected integer, received float; ' +
          'compaction.threshold_tokens: Number must be greater than or equal to 0'
      )
    );
  });
});
