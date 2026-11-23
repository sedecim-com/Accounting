/**
 * ENGLISH RUN-TIME STRINGS THE CLI PRINTS WITHOUT A CATALOG KEY (MNE-001-476, #150)
 *
 *   npx tsx scripts/language/lanes/cli-strings.ts           one line per string: file:line, text
 *   npx tsx scripts/language/lanes/cli-strings.ts | wc -l   the lane's number
 *   npx tsx scripts/language/lanes/cli-strings.ts <path>    the same for one file or folder
 *
 * D14 made English the source and Spanish a translation by key. Since then a
 * string written in English at a call site of `src/cli/` (`console.log('No
 * pending external operations.')`, `throw new CliError('… is not a four-digit
 * year.')`, `out.write(…)`) is read in English whatever `--locale` says. This
 * lane counts those literals, per file, so I8b (MNE-001-479) can pay them one
 * family at a time and no new leaf can add more without the ratchet seeing it.
 * The decision is the owner's answer 3 of 2026-11-16 on #141; the lane is step
 * S12 of the D14 plan there.
 *
 * THE SAME WALKER AS `spanish-user-strings-cli`, WITH ANOTHER LANGUAGE TEST.
 * `userStringsWhere` in `../extract.ts` is the walker that lane uses. Sharing
 * it means sharing every exclusion it writes down, with its reason: a message
 * split with `+` is one string, and a literal in a data position (an import
 * specifier, a property key, a literal type, a `case` label, a side of `===`,
 * a member of a compared list, the first argument of `t()`) or SQL is not a
 * message. The two lanes are disjoint by construction: this test refuses what
 * `judgeLanguage` calls Spanish.
 *
 * WHAT COUNTS AS ENGLISH (`isEnglishProse`): two words or more, not Spanish,
 * at least one English grammar word, and at least as many English markers as
 * Spanish ones. It is the Spanish lane's rule turned around: grammar words are
 * a closed class and give the language away. Measured when this lane was
 * written, and the price is stated: a label with no grammar word ("Balance
 * sheet", "Open invoices") is not counted. Counting every non-Spanish pair of
 * words raised the figure by about 400 and brought in shell code, command
 * paths and SQL fragments with it. Widening the population is a decision with
 * its own numbers, not a tweak.
 *
 * WHAT IS NOT RUN-TIME TEXT, and so is not counted here:
 *
 *   · HELP REGISTRATION. `help-descriptions-without-key` (`help.ts`) counts the
 *     descriptions of commands, options and arguments, and the Examples blocks
 *     have their own lane (MNE-001-477). A literal inside the arguments of a
 *     Commander method that registers help (`HELP_METHODS`), of a kernel
 *     helper that registers it by key (`HELP_FUNCTIONS`), assigned to
 *     `x.description`, or inside a constant or function this file hands to
 *     `addHelpText`, belongs to them. The walk up from the literal stops at
 *     the first function: an `argParser` arrow's error message is printed at
 *     run time and counts.
 *   · `writes:`, the risk metadata of `declareRisk`. No screen prints it, and
 *     it stays English and out of the catalog by the convention written in
 *     `src/cli/kernel/riesgos-retrofit.ts`.
 *   · SQL FRAGMENTS (`SQL_FRAGMENT`). The shared walker drops a statement by
 *     its first word; a `WHERE` built piece by piece (`' AND pr.status =
 *     ANY($2::text[])'`) starts with a condition instead, and the `AND`, `OR`
 *     and `ANY` in it read as English. A Postgres cast, a positional parameter
 *     or a leading upper-case condition keyword marks it.
 *   · GENERATED PROGRAMS (`GENERATED_PROGRAMS`). `mnemosine completion bash`
 *     prints a script for the shell to evaluate; its text is code and its
 *     comments are code comments. Named by file and function, so a new message
 *     anywhere else in that file still counts.
 *
 * What it does not reach, so nobody assumes it: the help-text analysis is per
 * file, like `comparedValues` in `extract.ts` (`kernel/line-spec.ts` builds a
 * help footer that `entry-command.ts` hands to `addHelpText`, and it counts
 * where it is written). An invariant error thrown at registration time
 * (`kernel/risk.ts`) counts like any other `throw`: one rule for every throw,
 * and I8b rules on the few that only a developer can see.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Lane, LaneMeter } from '../lane.js';
import { CLI_SURFACE, judgeLanguage, tsFilesUnder, userStringsWhere, type UserString } from '../extract.js';
import { exitWhenDrained } from '../../lib/exit-when-drained.js';

/** The repository root: this file lives in `scripts/language/lanes/`. */
const ROOT = path.resolve(__dirname, '..', '..', '..');

const LANE_ID = 'cli-user-strings-without-key';
const EXAMPLE_COUNT = 8;

/**
 * What the ratchet tells the author of a CLI PR that trips this lane, appended
 * to the finding (the surrounding message is `language-status.ts`'s, in Spanish).
 */
export const CLI_STRINGS_PER_ENTRY_RULE =
  'el texto inglés nuevo que el CLI imprime nace con clave: t(\'…\') de src/i18n/en.ts, ' +
  'no un literal (docs/language.md)';

/** Commander methods whose string arguments are help, not run-time output. */
const HELP_METHODS: ReadonlySet<string> = new Set([
  'description', 'summary', 'usage', 'command', 'alias', 'aliases', 'name', 'version',
  'argument', 'arguments', 'option', 'requiredOption', 'addHelpText', 'helpOption', 'helpCommand',
  'addHelpCommand', 'createOption', 'createArgument', 'default', 'choices', 'env',
]);

/** Constructors and kernel helpers (`src/cli/kernel/help.ts`) that register help. */
const HELP_FUNCTIONS: ReadonlySet<string> = new Set([
  'Option', 'Argument', 'describeCommand', 'describeOption', 'describeLastOption',
  'describeArgument', 'optionByKey', 'argumentByKey',
]);

/** Functions whose literals are a program another tool runs, by file. */
const GENERATED_PROGRAMS: Readonly<Record<string, ReadonlySet<string>>> = {
  // `mnemosine completion bash|zsh`: the script the shell evaluates.
  'src/cli/completion-command.ts': new Set(['resolveArms', 'wordArms', 'tables', 'bashScript', 'zshScript']),
};

/** A piece of a SQL `WHERE`: a cast, a `$n` parameter, or a leading condition keyword. */
const SQL_FRAGMENT = /::[a-z_]+|\$\d+(?![\d,.])|^\s*(AND|OR|WHERE|ORDER BY|GROUP BY)\s/;

/** English prose by the rule in the header. */
export function isEnglishProse(text: string): boolean {
  const verdict = judgeLanguage(text);
  return (
    !verdict.spanish &&
    verdict.words >= 2 &&
    verdict.englishMarkers >= 1 &&
    verdict.englishMarkers >= verdict.spanishMarkers
  );
}

/** The identifier an expression hangs from: `EXAMPLES.show` and `footer()` give `EXAMPLES` and `footer`. */
function rootIdentifier(expression: ts.Expression): string | null {
  let current: ts.Expression = expression;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isCallExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

/** The names this file hands to `addHelpText`: its help text lives in them. */
function helpTextNames(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'addHelpText'
    ) {
      for (const argument of node.arguments) {
        const name = rootIdentifier(argument);
        if (name !== null) names.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** The name a function is known by: its own, or the variable or method that holds it. */
function functionName(fn: ts.SignatureDeclaration): string | null {
  if (fn.name !== undefined && ts.isIdentifier(fn.name)) return fn.name.text;
  const holder = fn.parent;
  if (holder !== undefined && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
    return holder.name.text;
  }
  return null;
}

/** The callee's name, when it is a plain function or a method. */
function calleeName(callee: ts.Expression): { name: string; method: boolean } | null {
  if (ts.isIdentifier(callee)) return { name: callee.text, method: false };
  if (ts.isPropertyAccessExpression(callee)) return { name: callee.name.text, method: true };
  return null;
}

/**
 * Why a literal is not run-time text, or `null` when it is. Walks up from the
 * literal to the first function around it; see the header for each reason.
 */
export function notRunTimeReason(
  node: ts.Node,
  file: string,
  helpNames: ReadonlySet<string>
): string | null {
  const generated = GENERATED_PROGRAMS[file];
  let child: ts.Node = node;
  let up: ts.Node | undefined = node.parent;
  while (up !== undefined) {
    if (ts.isFunctionLike(up)) {
      const name = functionName(up);
      if (name !== null && helpNames.has(name)) return 'help text';
      if (name !== null && generated?.has(name)) return 'generated program';
      return null;
    }
    if ((ts.isCallExpression(up) || ts.isNewExpression(up)) && up.arguments?.some((arg) => arg === child)) {
      const callee = calleeName(up.expression);
      if (callee !== null) {
        if (callee.method && HELP_METHODS.has(callee.name)) return 'help registration';
        if (!callee.method && HELP_FUNCTIONS.has(callee.name)) return 'help registration';
      }
    }
    if (
      ts.isBinaryExpression(up) &&
      up.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      up.right === child &&
      ts.isPropertyAccessExpression(up.left) &&
      up.left.name.text === 'description'
    ) {
      return 'help registration';
    }
    if (ts.isPropertyAssignment(up) && up.initializer === child && ts.isIdentifier(up.name) && up.name.text === 'writes') {
      return 'risk metadata';
    }
    if (ts.isVariableDeclaration(up) && ts.isIdentifier(up.name) && helpNames.has(up.name.text)) {
      return 'help text';
    }
    child = up;
    up = up.parent;
  }
  return null;
}

/** The English run-time strings of ONE file, in reading order. */
export function englishUserStrings(code: string, file: string): UserString[] {
  return userStringsWhere(code, file, (source) => {
    const helpNames = helpTextNames(source);
    return (text, node) =>
      !SQL_FRAGMENT.test(text) && isEnglishProse(text) && notRunTimeReason(node, file, helpNames) === null;
  });
}

/** The same for a path, file or folder, in walk order. */
export function englishUserStringsUnder(target: string): UserString[] {
  const out: UserString[] = [];
  for (const file of tsFilesUnder(target)) {
    out.push(...englishUserStrings(fs.readFileSync(path.join(ROOT, file), 'utf8'), file));
  }
  return out;
}

/** One line per string, as the command prints it and `wc -l` counts it. */
function row(hit: UserString): string {
  return `${hit.file}:${hit.line}\t${JSON.stringify(hit.text)}`;
}

/** An example fits in one line: collapsed whitespace, cut at 64 characters (as in `code.ts`). */
function example(hit: UserString): string {
  const flat = hit.text.replace(/\s+/g, ' ').trim();
  return `${hit.file}:${hit.line} ${flat.length > 64 ? `${flat.slice(0, 63)}…` : flat}`;
}

export const cliStringsLanes: LaneMeter = () => {
  const hits = englishUserStringsUnder(CLI_SURFACE);
  const tally: Record<string, number> = {};
  for (const hit of hits) tally[hit.file] = (tally[hit.file] ?? 0) + 1;
  const perFile: Record<string, number> = {};
  for (const file of Object.keys(tally).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) perFile[file] = tally[file];
  return [
    {
      id: LANE_ID,
      title: `English run-time strings printed from ${CLI_SURFACE}/ without a catalog key, per file`,
      value: hits.length,
      target: 0,
      command: 'npx tsx scripts/language/lanes/cli-strings.ts | wc -l',
      examples: hits.slice(0, EXAMPLE_COUNT).map(example),
      perFile,
      perEntryRule: CLI_STRINGS_PER_ENTRY_RULE,
    } satisfies Lane,
  ];
};

function main(args: string[]): number {
  const target = args[0] ?? CLI_SURFACE;
  // One write for the whole list, not one per line (#659): the listing is
  // larger than a pipe buffer.
  process.stdout.write(englishUserStringsUnder(target).map((hit) => `${row(hit)}\n`).join(''));
  return 0;
}

if (require.main === module) {
  exitWhenDrained(main(process.argv.slice(2)));
}
