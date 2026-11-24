import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LanguageSection } from '../../../src/cli/init/language.js';
import type { SectionContext } from '../../../src/cli/init/section.js';
import { userConfigPath } from '../../../src/ai/providers/config.js';
import { DEFAULT_LOCALE, languageOfLocale } from '../../../src/i18n/locale.js';
import { getLanguage, resetLanguage, setLanguage } from '../../../src/i18n/index.js';

// ============================================================
// INIT'S FIRST STEP, «Language / Idioma» (MNE-001-470 · #653, part 3 of 3)
//
// The step offers the other language before anything else is asked. An answer
// goes through `setUserLocale` into the person's own ~/.mnemosine/config.json,
// never into a `.env` (an environment variable would outrank that file), and
// the rest of the run follows it. Enter writes nothing. Every case runs in a
// temporary HOME and working directory, with the locale variables removed:
// vitest pins MNEMOSINE_LOCALE for the whole suite, and it would sit above
// every rung these cases are about. Expected strings are written by hand.
// ============================================================

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(REPO_ROOT, 'src', 'cli', 'mnemosine.ts');

const ENV = { ...process.env };
let home: string;
let cwd: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'init-lang-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'init-lang-cwd-'));
  delete process.env.MNEMOSINE_LOCALE;
  delete process.env.MNEMOSINE_LANG;
});

afterEach(() => {
  process.env = { ...ENV };
  resetLanguage();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

/** A context that answers a fixed script and keeps what the step printed. */
function makeCtx(answers: (string | null)[], flags: { yes?: boolean } = {}): SectionContext & { lines: string[] } {
  const lines: string[] = [];
  const queue = [...answers];
  return {
    rl: null,
    flags,
    lines,
    print: (l?: string) => lines.push(l ?? ''),
    askText: async (_p: string, fallback?: string) =>
      flags.yes ? (fallback ?? null) : queue.length ? queue.shift()! : (fallback ?? null),
    askSecret: async () => null,
    confirm: async (_p: string, d = true) => d,
  };
}

function section(): LanguageSection {
  return new LanguageSection({ cwd, home });
}

/** Every `.env` either directory holds, so a case can prove none was written. */
function envFiles(): string[] {
  return [path.join(cwd, '.env'), path.join(home, '.mnemosine', '.env')].filter((f) => fs.existsSync(f));
}

describe('the status asks only while nothing chose a language', () => {
  it('is missing on an empty machine, where the default decides', async () => {
    expect(await section().status()).toBe('missing');
  });

  it('is ok once the person saved a locale', async () => {
    fs.mkdirSync(path.join(home, '.mnemosine'));
    fs.writeFileSync(userConfigPath(home), JSON.stringify({ locale: 'en-US' }));
    expect(await section().status()).toBe('ok');
  });

  it('is required, so the runner never hides it behind a default-no question', () => {
    expect(section().required).toBe(true);
    expect(section().id).toBe('idioma');
  });
});

describe('the title is one key, in the run language first and then the other', () => {
  it('under English: Language / Idioma', () => {
    setLanguage('en');
    expect(section().title).toBe('Language / Idioma');
  });

  it('under Spanish: Idioma / Language', () => {
    setLanguage('es');
    expect(section().title).toBe('Idioma / Language');
  });
});

describe('answering the step', () => {
  it('es writes locale: es-MX into that HOME, keeps the other keys, and the rest of the run is Spanish', async () => {
    fs.mkdirSync(path.join(home, '.mnemosine'));
    fs.writeFileSync(userConfigPath(home), JSON.stringify({ default_provider: 'anthropic' }));
    setLanguage('en');
    const ctx = makeCtx(['es']);

    await section().configure(ctx);

    const saved = JSON.parse(fs.readFileSync(userConfigPath(home), 'utf-8')) as Record<string, unknown>;
    expect(saved).toEqual({ default_provider: 'anthropic', locale: 'es-MX' });
    expect(getLanguage()).toBe('es');
    expect(ctx.lines.join('\n')).toContain(
      '✔ Idioma fijado en español (es-MX) para el CLI y el agente, en ~/.mnemosine/config.json'
    );
    expect(envFiles()).toEqual([]);
  });

  it('first says the language in effect, then asks in both languages with the choices', async () => {
    setLanguage('en');
    const prompts: string[] = [];
    const ctx = makeCtx([]);
    ctx.askText = async (p: string) => {
      prompts.push(p);
      return null;
    };

    await section().configure(ctx);

    const language = languageOfLocale(DEFAULT_LOCALE);
    expect(ctx.lines[0]).toContain(`(${DEFAULT_LOCALE}), for the CLI and the agent. Decided by the system default`);
    expect(prompts).toEqual([`  Which language? / ¿Qué idioma? [es|en] (${language}): `]);
  });

  it('Enter writes nothing, and no .env gains MNEMOSINE_LOCALE', async () => {
    // `askText` without a fallback answers Enter with null.
    const ctx = makeCtx([null]);

    await section().configure(ctx);

    expect(fs.existsSync(userConfigPath(home))).toBe(false);
    expect(envFiles()).toEqual([]);
  });

  it('--yes asks nothing and writes nothing', async () => {
    await section().configure(makeCtx(['es'], { yes: true }));
    expect(fs.existsSync(userConfigPath(home))).toBe(false);
    expect(envFiles()).toEqual([]);
  });

  it('an unusable answer is refused and asked again; Enter then writes nothing', async () => {
    setLanguage('en');
    const ctx = makeCtx(['pt-BR']);

    await section().configure(ctx);

    expect(ctx.lines.join('\n')).toContain('Unsupported language "pt-BR". Options: es-MX, en-US, or es, en');
    expect(fs.existsSync(userConfigPath(home))).toBe(false);
  });

  it('with MNEMOSINE_LOCALE set, it still writes the file and says the variable takes precedence', async () => {
    process.env.MNEMOSINE_LOCALE = 'en-US';
    setLanguage('en');
    const ctx = makeCtx(['es']);

    await section().configure(ctx);

    expect(JSON.parse(fs.readFileSync(userConfigPath(home), 'utf-8'))).toEqual({ locale: 'es-MX' });
    expect(getLanguage()).toBe('en');
    expect(ctx.lines.join('\n')).toContain(
      'MNEMOSINE_LOCALE=en-US is set and takes precedence — unset it for this change to apply.'
    );
  });

  it('after the answer es, the next --help of the real binary in that HOME prints Uso:', async () => {
    await section().configure(makeCtx(['es']));

    const env = { ...ENV };
    delete env.MNEMOSINE_LOCALE;
    delete env.MNEMOSINE_LANG;
    const result = spawnSync(TSX, [CLI, '--help'], {
      encoding: 'utf-8',
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 90_000,
      env: { ...env, HOME: home, DATABASE_URL: 'postgresql://127.0.0.1:1/unreachable', NO_COLOR: '1' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toMatch(/^Uso: mnemosine /);
  }, 120_000);
});
