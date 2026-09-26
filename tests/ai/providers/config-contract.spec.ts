import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listProfiles, loadConfigFile, writeConfigPatch } from '../../../src/ai/providers/config.js';

// ============================================================
// CONTRACT: what the config loader tells a person whose config is wrong (#367).
//
// mnemosine.config.json is validated by a strict Zod schema and a rejected
// file is reported by its issues, verbatim. These rows were recorded on zod
// 3.25.76; the Zod 4 migration must reproduce them unchanged, because the
// message is the only thing that tells the person which key to fix.
// ============================================================

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function projectWith(config: unknown): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-config-contract-'));
  dirs.push(dir);
  const file = path.join(dir, 'mnemosine.config.json');
  fs.writeFileSync(file, JSON.stringify(config));
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

  it('returns typed profiles from a record of profiles', () => {
    const { dir } = projectWith(profile({ headers: { 'X-A': 'b' }, max_iterations: 3 }));
    const p = listProfiles(dir).profiles.p;
    expect(p?.model).toBe('m');
    expect(p?.headers).toEqual({ 'X-A': 'b' });
    expect(p?.max_iterations).toBe(3);
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
