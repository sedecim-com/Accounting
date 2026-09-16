import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { setUserLocale, userConfigPath } from '../../src/ai/providers/config.js';
import { describeLocale, type LocaleDecision } from '../../src/i18n/locale.js';
import { ExitCode } from '../../src/cli/kernel/exit.js';

// ============================================================
// `mnemosine lang` WRITES WHERE THE LOCALE IS READ (I11 · issue #153)
//
// The command used to write the key `language` into whatever file
// `loadConfigFile` considered active — project before user. The resolver reads
// the key `locale` from the USER's file ABOVE the project's, and only then
// falls back to `language` with its old order. Put those two facts together
// and the command was lying to the face of anybody who already had a `locale`:
//
//   $ cat ./mnemosine.config.json        → { "locale": "en-US" }
//   $ mnemosine lang es
//   ✔ Agent will now answer in Spanish (./mnemosine.config.json)
//   $ mnemosine lang
//   Agent response language: en          ← measured at 36663c8, before this
//
// The fix is one sentence long: the language belongs to the HUMAN, not to the
// repository, so it is written to `~/.mnemosine/config.json` — which is the
// same reason `describeLocale` reads the user's file first.
//
// TWO HALVES, AND THEY ARE TESTED DIFFERENTLY ON PURPOSE. The writer and the
// resolver are exercised IN PROCESS through the `home`/`cwd` options that
// `describeLocale` already accepts: no environment variable of the machine
// running this is touched, and the layering is the thing under test. The
// command itself is exercised by LAUNCHING THE REAL BINARY, because what is
// being claimed there — «four spellings are accepted and a fifth exits 2» — is
// a claim about the process, and a stub of the action would not make it.
// ============================================================

const REPO_ROOT = path.join(__dirname, '..', '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(REPO_ROOT, 'src', 'cli', 'mnemosine.ts');

/** The four spellings the resolver understands, and what each canonicalizes to. */
const ACCEPTED: ReadonlyArray<readonly [string, string]> = [
  ['es', 'es-MX'],
  ['en', 'en-US'],
  ['es-MX', 'es-MX'],
  ['en-US', 'en-US'],
];

let home: string;
let project: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-lang-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-lang-proj-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

/** The project's `mnemosine.config.json`, the file that is versioned and shared. */
function writeProjectConfig(contents: Record<string, unknown>): string {
  const file = path.join(project, 'mnemosine.config.json');
  fs.writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`);
  return file;
}

function readUserConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(userConfigPath(home), 'utf-8')) as Record<string, unknown>;
}

/**
 * The resolver, asked the way the binary asks it, with the two temporary
 * directories standing in for the real machine. `argv` and `env` are emptied
 * rather than defaulted: vitest pins `MNEMOSINE_LOCALE=en-US` for the whole
 * suite, and inheriting it would put an environment variable above everything
 * these cases are about.
 */
function resolve(): LocaleDecision {
  return describeLocale({
    argv: [],
    env: {},
    cwd: project,
    home,
    onWarning: () => undefined,
  });
}

/**
 * The real binary, on a machine whose HOME and working directory are the two
 * temporary ones. The database is deliberately unreachable: `lang` is in
 * `NO_DB_COMMANDS`, so if somebody ever reorders it to open a connection first,
 * these cases turn red instead of passing on whatever database is running.
 */
function run(
  args: string[],
  extraEnv: Record<string, string> = {}
): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.MNEMOSINE_LOCALE;
  delete env.MNEMOSINE_LANG;
  delete env.MNEMOSINE_TENANT;
  delete env.MNEMOSINE_ENTITY;
  const result = spawnSync(TSX, [CLI, ...args], {
    encoding: 'utf-8',
    cwd: project,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 90_000,
    env: {
      ...env,
      HOME: home,
      DATABASE_URL: 'postgresql://127.0.0.1:1/unreachable',
      MNEMOSINE_NO_BANNER: '1',
      NO_COLOR: '1',
      ...extraEnv,
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('the locale is written to the file the resolver reads first', () => {
  it('creates ~/.mnemosine/config.json, and the directory holding it, when neither exists', () => {
    // The machine of a first day: choosing a language is one of the earliest
    // things anybody does, and `~/.mnemosine/` is not there yet. Failing on the
    // DIRECTORY rather than on the file is the shape of that bug, so the empty
    // home is the precondition worth stating out loud.
    expect(fs.existsSync(path.join(home, '.mnemosine'))).toBe(false);

    const written = setUserLocale('es-MX', home);

    expect(written.file).toBe(userConfigPath(home));
    expect(written.quarantined).toBeNull();
    expect(readUserConfig()).toEqual({ locale: 'es-MX' });
  });

  // ============================================================
  // A BROKEN FILE MUST NOT TRAP THE USER IN IT
  //
  // `writeConfigPatch` reads the file before patching it, so one comma too many
  // made `mnemosine lang es` die with a bare SyntaxError that did not even name
  // the file — while the RESOLVER, two steps earlier, skipped that same file
  // with a warning that did. `src/i18n/locale.ts` states the rule for the read
  // path in writing: dying over a stray comma is a new failure worse than the
  // defect. It holds for the write too, and more so — a person whose config
  // broke cannot fix it by choosing a language, which is what they came to do.
  // ============================================================
  it('quarantines an unreadable config instead of dying on it, and says where the copy is', () => {
    fs.mkdirSync(path.join(home, '.mnemosine'), { recursive: true });
    fs.writeFileSync(userConfigPath(home), '{ "locale": "es-MX",, }', 'utf8');

    const written = setUserLocale('en-US', home);

    expect(written.file).toBe(userConfigPath(home));
    expect(written.quarantined).not.toBeNull();
    // The evidence survives: the copy holds the bytes that were rejected.
    expect(fs.readFileSync(written.quarantined as string, 'utf8')).toBe('{ "locale": "es-MX",, }');
    // And the locale the user asked for is in force, on a clean file.
    expect(readUserConfig()).toEqual({ locale: 'en-US' });
  });

  it('keeps the quarantine copy stable: the same broken bytes map to the same name', () => {
    fs.mkdirSync(path.join(home, '.mnemosine'), { recursive: true });
    const broken = '{ "locale": "es-MX",, }';
    fs.writeFileSync(userConfigPath(home), broken, 'utf8');
    const first = setUserLocale('en-US', home).quarantined;
    fs.writeFileSync(userConfigPath(home), broken, 'utf8');
    const second = setUserLocale('en-US', home).quarantined;

    // Named by content hash, so a retry does not litter the home directory.
    expect(second).toBe(first);
  });

  it('wins over a project mnemosine.config.json that names another locale', () => {
    // THE CASE THAT MOTIVATED THE CHANGE. A firm commits `locale: en-US` in the
    // repository; the accountant who reads in Spanish types `mnemosine lang
    // es`. Before I11 the write landed in that very committed file as the key
    // `language`, which the resolver only consults BELOW `locale` — so the
    // answer stayed `en-US` and the success line was false.
    const projectFile = writeProjectConfig({ locale: 'en-US' });
    expect(resolve().locale).toBe('en-US');

    setUserLocale('es-MX', home);

    const after = resolve();
    expect(after.locale).toBe('es-MX');
    expect(after.kind).toBe('user-config');
    expect(after.label).toBe(`locale in ${userConfigPath(home)}`);
    // And the repository's file is left exactly as its owner committed it: the
    // old writer used to append `language` to it, editing a shared artifact to
    // express one person's preference.
    expect(JSON.parse(fs.readFileSync(projectFile, 'utf-8'))).toEqual({ locale: 'en-US' });
  });

  it('preserves the unrelated keys of the user config it updates', () => {
    fs.mkdirSync(path.dirname(userConfigPath(home)), { recursive: true });
    fs.writeFileSync(userConfigPath(home), JSON.stringify({ default_provider: 'ollama' }));

    setUserLocale('en-US', home);

    expect(readUserConfig()).toEqual({ default_provider: 'ollama', locale: 'en-US' });
  });

  it('never writes the legacy `language` key again, and that key is still READ', () => {
    // The key stops being WRITTEN; it does not stop being honoured. Anybody who
    // ran `mnemosine lang es` last week has `language` in a file and must keep
    // reading in Spanish until I24 retires the readers.
    writeProjectConfig({ language: 'en' });
    const beforeWrite = resolve();
    expect(beforeWrite.locale).toBe('en-US');
    expect(beforeWrite.kind).toBe('legacy-config');

    setUserLocale('es-MX', home);

    // The new key outranks the old one, which is the only way one command can
    // overrule what another one wrote years earlier...
    expect(resolve().locale).toBe('es-MX');
    // ...and nothing anywhere grew a `language` key to do it.
    expect(readUserConfig()).toEqual({ locale: 'es-MX' });
    expect(readUserConfig().language).toBeUndefined();
  });
});

describe('the `lang` command, launched as the binary', () => {
  it(
    'accepts the four spellings and canonicalizes each one into the user file',
    () => {
      for (const [typed, canonical] of ACCEPTED) {
        const result = run(['lang', typed]);
        expect(result.status, `\`lang ${typed}\` failed: ${result.stderr}`).toBe(ExitCode.OK);
        expect(result.stdout).toContain(canonical);
        expect(readUserConfig()).toEqual({ locale: canonical });
      }
    },
    180_000
  );

  it(
    'refuses a fifth value with a usage error that names what it would take',
    () => {
      const result = run(['lang', 'klingon']);

      // USAGE and not the generic 1: the contract of `src/cli/kernel/exit.ts`,
      // which this leaf is the historic example of.
      expect(result.status).toBe(ExitCode.USAGE);
      const said = result.stdout + result.stderr;
      expect(said).toContain('Unsupported language "klingon"');
      // A rejection that does not say what WOULD be accepted sends the reader
      // to `--help` to find out; the four spellings are four words.
      for (const [typed] of ACCEPTED) expect(said).toContain(typed);
      // And nothing was written on the way out.
      expect(fs.existsSync(userConfigPath(home))).toBe(false);
    },
    90_000
  );

  it(
    'reports back the language it just set, inside a project pinned to the other one',
    () => {
      // The end-to-end shape of the defect, through the process: two
      // invocations, the second one asking the question the first one answered.
      writeProjectConfig({ locale: 'en-US' });

      expect(run(['lang', 'es']).status).toBe(ExitCode.OK);
      const shown = run(['lang']);

      expect(shown.status).toBe(ExitCode.OK);
      expect(shown.stdout).toContain('Agent response language: es');
    },
    180_000
  );

  it(
    'still warns when the environment outranks the file it just wrote, and only then',
    () => {
      // The warning has to stay TRUE for the new key. Two config files can no
      // longer beat what was written — the user's file is the top of the file
      // ladder — so the environment and the flag are all that is left, and the
      // environment is the one worth a line: it survives the process.
      const shadowed = run(['lang', 'es'], { MNEMOSINE_LOCALE: 'en-US' });

      expect(shadowed.status).toBe(ExitCode.OK);
      expect(shadowed.stdout).toContain('MNEMOSINE_LOCALE=en-US is set and takes precedence');
      // The write itself happened; it is shadowed, not skipped. Unsetting the
      // variable is all the warning asks for, and it has to be enough.
      expect(readUserConfig()).toEqual({ locale: 'es-MX' });
      expect(run(['lang']).stdout).toContain('Agent response language: es');
    },
    180_000
  );
});
