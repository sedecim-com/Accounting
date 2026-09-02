import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import {
  registerCompletionCommand,
  renderCompletionScript,
  COMPLETION_SHELLS,
} from '../../src/cli/completion-command.js';
import { program as shippedProgram } from '../../src/cli/mnemosine.js';

// ============================================================
// `mnemosine completion bash|zsh`
//
// FOUR batteries, because the piece has four ways of being wrong and no
// single fixture sees all of them.
//
//   1. THE SYNTHETIC TREE pins the generator's hard cases — Spanish
//      aliases with accents, the decomposed form macOS hands back, a
//      hostile name — on a tree small enough to read. What it CANNOT see
//      is depth: it is two levels deep, so a generator that stops one
//      level short loses nothing here.
//   2. THE SHIPPED TREE covers exactly that. It is 237 nodes and 53 of
//      its leaves live at the THIRD level (`sat cred add`, `bank match
//      apply`, `account map import`). It is walked by this file's own
//      recursion and compared set-against-set with the tables in the
//      script, so a rename moves both sides and a lost level moves one.
//   3. THE BODY. The tables can be perfectly quoted and the code that
//      READS them can still hand them back to the shell to expand. Every
//      assertion in (1) scans the tables; none of them scans the
//      consumer, and that is where `compgen -W` would go.
//   4. A REAL BASH. The three above are claims about text. This one
//      sources the script into bash and looks for a file that only the
//      payload could have created.
// ============================================================

/** The payload. Distinctive so the assertions cannot match it by accident. */
const PAYLOAD = '$(touch /tmp/mnemosine-pwned)';
const HOSTILE_NAME = "ev'il";
const HOSTILE_ALIAS = `x${PAYLOAD}`;
/**
 * TWO quotes, with the payload behind the second one.
 *
 * One quote cannot see the bug this fixture exists for. `raw.replace(/'/,
 * …)` — the same escape with the global flag dropped — produces a
 * BYTE-IDENTICAL string for a name carrying a single quote, so a
 * one-quote fixture is blind to it. With two, the second survives
 * unescaped, closes the literal, and everything after it is shell code.
 *
 * It goes in as an ALIAS and not as a name because `.command()` splits
 * its argument on whitespace: commander would read `$(touch` as the
 * command name and `/tmp/mnemosine-pwned)` as an argument declaration.
 */
const HOSTILE_MULTIQUOTE = `a'b'c${PAYLOAD}`;

/** The same alias composed (U+00F1) and decomposed (n + U+0303, what macOS hands back). */
const COMPOSED = 'enseña'.normalize('NFC');
const DECOMPOSED = COMPOSED.normalize('NFD');

function syntheticProgram(): Command {
  const program = new Command();
  program.name('mnemosine').exitOverride().option('-e, --entity <idOrName>', 'Legal entity');

  const memory = program.command('memory').alias('memoria').description('Memory');
  memory.command('teach').aliases([DECOMPOSED, 'ensena']).description('Teach');

  const report = program.command('report').alias('reporte').description('Reports');
  report
    .command('aged-receivable')
    .alias('antigüedad-cobrar')
    .option('-n, --limit <n>', 'Rows')
    .description('Aged receivable');

  const period = program.command('period').alias('período').description('Periods');
  period.command('list').alias('listar').option('--format <fmt>', 'Output format');

  program.command(HOSTILE_NAME).aliases([HOSTILE_ALIAS, HOSTILE_MULTIQUOTE]).description('Hostile');

  return program;
}

/**
 * The parts of a shell script the shell would EXPAND — everything outside
 * single quotes, reading `\'` as an escaped literal quote rather than as a
 * quote that opens one.
 *
 * This is the assertion that matters. Eyeballing the script for a
 * backslash proves nothing: what has to be true is that no byte of an
 * attacker-chosen name ever lands where the shell would evaluate it.
 */
function unquotedRegions(script: string): string {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (!inQuote && ch === '\\') {
      i++; // the escaped character is a literal, never a quote delimiter
      continue;
    }
    if (ch === "'") {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote) out += ch;
  }
  return out;
}

describe('unquotedRegions — the scanner the security assertions lean on', () => {
  it("reads \\' as a literal, so a correctly escaped payload counts as quoted", () => {
    expect(unquotedRegions("a'b'\\''c'd")).toBe('ad');
    expect(unquotedRegions("'ev'\\''il$(x)'")).toBe('');
  });

  it('an UNescaped quote does reopen: the payload lands outside', () => {
    expect(unquotedRegions("'ev'il$(x)'")).toBe('il$(x)');
  });

  it('a SECOND unescaped quote reopens too, which is the missing-/g bug', () => {
    // What `raw.replace(/'/, …)` emits for `a'b'c$(x)`: first quote
    // escaped, second left alone. The scanner has to see the payload.
    expect(unquotedRegions("'a'\\''b'c$(x)'")).toBe('c$(x)');
    // ...and what the correct, global escape emits for the same name.
    expect(unquotedRegions("'a'\\''b'\\''c$(x)'")).toBe('');
  });
});

describe.each(COMPLETION_SHELLS)('completion %s — the tree is really there', (shell) => {
  const script = renderCompletionScript(syntheticProgram(), shell);

  it('names every canonical command and subcommand', () => {
    for (const word of ['memory', 'teach', 'report', 'aged-receivable', 'period', 'list']) {
      expect(script, `${word} is missing from the ${shell} script`).toContain(`'${word}'`);
    }
  });

  it('names the Spanish aliases, accents and all', () => {
    for (const alias of ['memoria', 'reporte', 'listar', COMPOSED, 'antigüedad-cobrar', 'período']) {
      expect(script, `${alias} is missing from the ${shell} script`).toContain(`'${alias}'`);
    }
  });

  it('normalizes to NFC: the decomposed alias is not emitted as it arrived', () => {
    // The synthetic tree registers the alias DECOMPOSED. Emitted as it
    // arrived, no shell comparing against the composed form would ever
    // match it, and the accented alias would be quietly uncompletable.
    expect(DECOMPOSED).not.toBe(COMPOSED);
    expect(script).toContain(`'${COMPOSED}'`);
    expect(script).not.toContain(DECOMPOSED);
  });

  it('accepts the ASCII fold of an accented alias as a way in', () => {
    // Whoever has no ü on the keyboard still has to be able to type the
    // command; the fold navigates even though it is never suggested.
    expect(script).toContain("'report|antiguedad-cobrar'");
    expect(script).toContain("'|periodo'");
    // ...and is never OFFERED: two spellings of every accented alias would
    // double the menu and teach nothing.
    expect(script).not.toContain("'periodo'");
  });

  it('carries the flags of each node, including the root', () => {
    expect(script).toContain("'--entity'");
    expect(script).toContain("'--format'");
    expect(script).toContain("'--help'");
  });

  it('is clean stdout: no banner, no ANSI, one trailing newline', () => {
    expect(script.startsWith('#')).toBe(true);
    expect(script.includes(String.fromCharCode(27)), 'an ANSI escape would corrupt the sourced file').toBe(false);
    expect(script.endsWith('\n')).toBe(true);
  });
});

describe.each(COMPLETION_SHELLS)('completion %s — a hostile name cannot inject', (shell) => {
  const script = renderCompletionScript(syntheticProgram(), shell);

  it('emits the hostile name rather than dropping it', () => {
    // Silently discarding it would make this test pass for the wrong
    // reason: the command has to be completable, just not executable.
    expect(script).toContain(PAYLOAD);
    expect(script).toContain('x' + PAYLOAD.slice(0, 8));
  });

  it('escapes the embedded quote instead of letting it close the literal', () => {
    expect(script).toContain("'ev'\\''il'");
    expect(script).not.toContain(HOSTILE_NAME);
  });

  it('escapes EVERY quote of a name, not only the first', () => {
    // The escape is `replace(/'/g, …)`. Drop the g and this is the name
    // that notices: the second quote closes the literal and the payload
    // behind it becomes code. `ev'il` alone cannot notice — with a single
    // quote both spellings are the same bytes.
    expect(HOSTILE_MULTIQUOTE.split("'")).toHaveLength(3);
    expect(script).toContain(`'a'\\''b'\\''c${PAYLOAD}'`);
    expect(script).not.toContain(`'a'\\''b'c${PAYLOAD}'`);
  });

  it('leaves no byte of the payload where the shell would expand it', () => {
    const exposed = unquotedRegions(script);
    expect(exposed).not.toContain('mnemosine-pwned');
    expect(exposed).not.toContain('touch');
    expect(exposed).not.toContain(HOSTILE_NAME);
    expect(exposed).not.toContain(HOSTILE_MULTIQUOTE);
  });
});

// ============================================================
// THE BODY, not just the tables.
//
// Every assertion above scans the generated word TABLES, and they are
// quoted correctly. None of them looks at the code that CONSUMES those
// tables — and that is where the whole defence comes undone in one line,
// with all of the above still green.
//
// `compgen -W` is the specific trap: bash EXPANDS its word list, so a
// name carrying `$(...)` runs the moment the user presses TAB. That is
// why the emitted body reads the candidates line by line instead, and why
// the module says so in a comment. A comment is not a test; this is.
// ============================================================

/**
 * The script minus its comment lines: what bash would actually RUN.
 *
 * The module explains its own defence in a comment that names `compgen
 * -W`, so a scan of the raw text would find the trap in the very sentence
 * warning against it — and would go green for a script that both explains
 * the danger and walks into it.
 */
function shellCode(script: string): string {
  return script
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/** Everything from the completion function onwards: the consumer, not the data. */
function consumerBody(script: string, opener: string): string {
  const start = script.indexOf(opener);
  expect(start, `${opener} is missing from the script`).toBeGreaterThanOrEqual(0);
  return script.slice(start);
}

describe('completion bash — the consumer may not re-expand the word list', () => {
  const code = shellCode(renderCompletionScript(syntheticProgram(), 'bash'));
  const body = consumerBody(code, '_mnemosine_complete() {');

  it('never reaches for compgen -W, which expands the list it is handed', () => {
    expect(code).not.toMatch(/compgen\s+-W/);
  });

  it('never evals', () => {
    expect(code).not.toMatch(/\beval\b/);
  });

  it('builds the candidates with the line-by-line reader', () => {
    expect(body).toContain('while IFS= read -r word; do');
    expect(body).toContain('done <<COMPLETION_WORDS');
    // The here-doc terminator is unquoted on purpose — `$list` has to
    // expand exactly once, as data — and the loop re-evaluates nothing.
    expect(body).toMatch(/done <<COMPLETION_WORDS\n\$list\nCOMPLETION_WORDS\n/);
  });

  it('never builds the array from an unquoted expansion', () => {
    // `candidates=( $(…) )` and `candidates=( $list )` both word-split AND
    // glob whatever comes out. The only safe right-hand side is a quoted
    // one, or nothing at all.
    const assignments = body.split('\n').filter((line) => line.includes('candidates=('));
    expect(assignments.length, 'the candidate array is never built').toBeGreaterThan(0);
    for (const line of assignments) {
      expect(line.trim(), 'this line expands its right-hand side').not.toMatch(/candidates=\(\s*\$/);
    }
  });
});

describe('completion zsh — the consumer may not re-expand the word list', () => {
  const code = shellCode(renderCompletionScript(syntheticProgram(), 'zsh'));

  it('never reaches for compgen -W, and never evals', () => {
    expect(code).not.toMatch(/compgen\s+-W/);
    expect(code).not.toMatch(/\beval\b/);
  });

  it('hands the candidates to compadd as data', () => {
    expect(code).toContain('compadd -a candidates');
    // ${(f)"$(…)"}: the substitution is QUOTED, so the only splitting is
    // (f)'s, on newlines. Unquoted it would word-split and glob as well.
    expect(code).toMatch(/candidates=\(\s*\$\{\(f\)"\$\(/);
  });
});

// ============================================================
// AND THEN, IN A REAL SHELL.
//
// Everything above is a claim about text. This sources the script into
// bash, asks it to complete an empty word, and looks for a file that only
// the payload could have created.
//
// The positive control is not optional: a script that fails to source
// runs no payload either, so without it the case would pass for the worst
// possible reason. So it also demands the hostile word back VERBATIM,
// which is what a completion is supposed to do with a name it cannot
// vouch for: offer it as text.
//
// Guarded on bash being present. If it ever is not, the four structural
// cases above are what stands, and they are the ones that kill the
// mutants; this one is the demonstration.
// ============================================================

const BASH_AVAILABLE = ((): boolean => {
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(BASH_AVAILABLE)('completion bash — sourced into a real bash', () => {
  it('offers the hostile name as text and executes nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-completion-'));
    try {
      const sentinel = path.join(dir, 'pwned');
      const hostile = `a'b'c$(touch ${sentinel})`;

      // ONE hostile word and no other quote in the tree, deliberately:
      // bash abandons the expansion of a word list at the first unbalanced
      // quote it meets, so a sibling like `ev'il` earlier in the list would
      // shield the payload from `compgen -W` and hide the very bug this
      // case exists to catch — while still passing.
      const program = new Command();
      program.name('mnemosine').exitOverride();
      program.command('memory').alias('memoria');
      program.command('quoted').alias(hostile);

      const scriptPath = path.join(dir, 'completion.bash');
      fs.writeFileSync(scriptPath, renderCompletionScript(program, 'bash'));

      const harness = [
        `source ${JSON.stringify(scriptPath)}`,
        'COMP_WORDS=(mnemosine "")',
        'COMP_CWORD=1',
        '_mnemosine_complete',
        'printf "%s\\n" "${COMPREPLY[@]}"',
      ].join('\n');

      const out = execFileSync('bash', ['-c', harness], {
        encoding: 'utf-8',
        timeout: 30_000,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      });

      // The fact under test, first, so it is the one the failure names.
      expect(fs.existsSync(sentinel), 'pressing TAB executed the command name').toBe(false);

      // The positive control, second, and a killer in its own right: under
      // `compgen -W` the word comes back as `abc` — the substitution ran
      // and swallowed itself — so this fails even on a machine where
      // `touch` is not on PATH and the sentinel check passed for free.
      expect(out.split('\n'), 'the hostile name was not offered verbatim').toContain(hostile);
      expect(out).toContain('memoria');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// THE SHIPPED TREE.
//
// Every battery above runs on a four-family, two-level toy. The tree that
// ships is 237 nodes, and 53 of its leaves live at the THIRD level: `sat
// cred add`, `bank match apply`, `account map import`, `entry line list`.
// A generator that stops one level short drops all 53 flag tables — the
// bash script goes from 597 lines to 544 — and not one assertion on the
// synthetic tree moves, because the synthetic tree has no third level to
// lose.
//
// This battery does NOT pin the catalog. It walks the real program with
// its OWN recursion and demands that the set of tables in the script
// equal the set of nodes it walked. Rename a family and both sides move
// together; lose a level and only one does.
//
// The program is imported, never spawned — the same door
// scripts/generate-cli-reference.ts and tests/cli/codigos-de-salida.spec.ts
// use. mnemosine.ts only runs itself when `require.main === module`.
// ============================================================

interface WalkedNode {
  /** Canonical path, segments joined by a space; '' for the root. */
  key: string;
  childNames: string[];
}

/**
 * The shipped tree, walked here. Deliberately NOT `collectTree`: a bug in
 * that traversal would corrupt both sides of the comparison and the test
 * would end up agreeing with itself. The two rules it mirrors — hidden
 * commands skipped, nameless ones skipped — are the contract, not the
 * code.
 */
function walkShippedTree(): WalkedNode[] {
  const out: WalkedNode[] = [];
  const visit = (cmd: Command, chain: string[]): void => {
    const kids = (cmd.commands ?? []).filter(
      (c) => (c as unknown as { _hidden?: boolean })._hidden !== true && c.name().length > 0
    );
    out.push({ key: chain.join(' '), childNames: kids.map((k) => k.name()) });
    for (const kid of kids) visit(kid, [...chain, kid.name()]);
  };
  visit(shippedProgram, []);
  return out;
}

/**
 * The paths one generated table answers to, read off its `case` arms.
 *
 * Only `_flags` and `_subcommands` are single-pattern per arm; `_resolve`
 * joins its spellings with `|` and is checked separately.
 */
function armKeys(script: string, table: string): string[] {
  const opener = `_mnemosine_${table}() {`;
  const start = script.indexOf(opener);
  expect(start, `${opener} is missing from the script`).toBeGreaterThanOrEqual(0);
  const end = script.indexOf('\n}\n', start);
  return script
    .slice(start, end)
    .split('\n')
    .map((line) => /^\s+'([^']*)'\) printf/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
}

describe('completion bash — the SHIPPED tree, all three levels of it', () => {
  const script = renderCompletionScript(shippedProgram, 'bash');
  const walked = walkShippedTree();
  const depthOf = (key: string): number => (key === '' ? 0 : key.split(' ').length);

  it('the shipped tree is three levels deep — otherwise this battery proves nothing', () => {
    const third = walked.filter((n) => depthOf(n.key) === 3);
    expect(walked.length, 'the shipped tree shrank past what this battery can vouch for')
      .toBeGreaterThan(200);
    expect(third.length, 'no third-level nodes left to lose').toBeGreaterThanOrEqual(40);
    // The arm parser assumes no path carries a quote. Say it out loud, so
    // that the day one does, the failure names the reason.
    for (const node of walked) expect(node.key).not.toContain("'");
  });

  it('every node of the real tree has its flag table — third level included', () => {
    // `flagsOf` always appends --help/-h, so EVERY node earns an arm and
    // the two sets are equal, not merely one inside the other. A generator
    // that stops at depth 2 loses 53 of them, and this says which.
    expect(new Set(armKeys(script, 'flags'))).toEqual(new Set(walked.map((n) => n.key)));
  });

  it('every node with children has its subcommand table', () => {
    const parents = walked.filter((n) => n.childNames.length > 0).map((n) => n.key);
    expect(new Set(armKeys(script, 'subcommands'))).toEqual(new Set(parents));
  });

  it('and the count of third-level tables matches the count of third-level nodes', () => {
    const emitted = armKeys(script, 'flags').filter((key) => depthOf(key) === 3);
    const walkedThird = walked.filter((n) => depthOf(n.key) === 3);
    expect(emitted).toHaveLength(walkedThird.length);
    expect(emitted.length).toBeGreaterThanOrEqual(40);
    expect(armKeys(script, 'flags')).toHaveLength(walked.length);
  });

  it('every parent → child step of the real tree resolves', () => {
    for (const node of walked) {
      for (const child of node.childNames) {
        const step = `${node.key}|${child}`;
        expect(script, `'${step}' is not a way into ${[node.key, child].join(' ').trim()}`)
          .toContain(`'${step}'`);
      }
    }
  });

  it('the third-level leaves the audit named still suggest their own flags', () => {
    // Named one by one on purpose: these four are what a reader checks by
    // hand after a change, and the set comparison above goes red saying
    // "53 elements missing" while this one says which command lost what.
    const named: Array<[string, string]> = [
      ['sat cred add', '--dry-run'],
      ['bank match apply', '--dry-run'],
      ['account map import', '--dry-run'],
      ['entry line list', '--json'],
    ];
    const lines = script.split('\n');
    for (const [leaf, flag] of named) {
      const arm = lines.find((line) => line.trimStart().startsWith(`'${leaf}') printf`));
      expect(arm, `${leaf} has no flag table at all`).toBeDefined();
      expect(arm, `${leaf} stopped suggesting ${flag}`).toContain(`'${flag}'`);
    }
  });

  it('the Spanish surface of the shipped tree reaches the script too', () => {
    // The reason the command exists at all. `completado` is the alias the
    // command registry assigns to `completion` itself, so the script
    // completes the command that wrote it.
    for (const alias of ['memoria', 'reporte', 'completado', 'poliza']) {
      expect(script, `${alias} is missing from the shipped script`).toContain(`'${alias}'`);
    }
  });
});

describe('completion — the tree is read when the command RUNS', () => {
  it('covers a family registered after registerCompletionCommand', () => {
    // Reading the tree at registration time would describe a program that
    // does not exist yet: `completion` is registered among fifty families
    // and cannot know which of them come after it.
    const program = new Command();
    program.name('mnemosine').exitOverride();
    registerCompletionCommand(program, { shutdown: () => undefined, reportError: () => undefined });
    program.command('bank').alias('banco');

    expect(renderCompletionScript(program, 'bash')).toContain("'banco'");
  });

  it('registers its own Spanish alias, the one the registry assigns', () => {
    const program = new Command();
    program.name('mnemosine').exitOverride();
    registerCompletionCommand(program, { shutdown: () => undefined, reportError: () => undefined });

    const completion = program.commands.find((cmd) => cmd.name() === 'completion');
    expect(completion?.aliases()).toContain('completado');
  });
});

describe('completion — the exit-code contract', () => {
  let stdoutSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  /** Runs the registered command and returns the codes shutdown saw. */
  async function run(...argv: string[]): Promise<{ codes: number[]; errors: unknown[] }> {
    const codes: number[] = [];
    const errors: unknown[] = [];
    const program = syntheticProgram();
    registerCompletionCommand(program, {
      shutdown: (code: number) => {
        codes.push(code);
      },
      reportError: (err: unknown) => {
        errors.push(err);
      },
    });
    await program.parseAsync(['node', 'mnemosine', 'completion', ...argv]);
    return { codes, errors };
  }

  it('an unknown shell exits 2 (USAGE), not 1', async () => {
    // 1 would say "it failed"; 2 says "you typed it wrong", which is the
    // difference a wrapper script needs to tell a typo from a breakage.
    const { codes, errors } = await run('fish');
    expect(codes).toEqual([2]);
    expect((errors[0] as Error).message).toContain('fish');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('no shell at all exits 2 as well, and says which are supported', async () => {
    const { codes, errors } = await run();
    expect(codes).toEqual([2]);
    expect((errors[0] as Error).message).toMatch(/bash/);
    expect((errors[0] as Error).message).toMatch(/zsh/);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('a known shell exits 0 and writes the script and nothing else', async () => {
    const { codes, errors } = await run('zsh');
    expect(errors).toEqual([]);
    expect(codes).toEqual([0]);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(String(stdoutSpy.mock.calls[0][0])).toMatch(/^#compdef mnemosine\n/);
  });
});
