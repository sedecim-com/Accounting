/**
 * HELP «EXAMPLES» BLOCKS THE CLI WRITES WITHOUT A CATALOG KEY (MNE-001-477, #150)
 *
 *   npx tsx scripts/language/lanes/help-examples.ts           one line per block: file:line, text
 *   npx tsx scripts/language/lanes/help-examples.ts | wc -l   the lane's number
 *   npx tsx scripts/language/lanes/help-examples.ts <path>    the same for one file or folder
 *
 * Most leaves end their `--help` with an `Examples:` block: a few commented
 * command lines, handed to `addHelpText('after', …)`. Today almost all of them
 * are literals written at the call site (`EXAMPLES.show`, `EJEMPLOS.list`, an
 * array joined with `\n`), so a reader in `es-MX` sees the comments in English
 * whatever `--locale` says. The keyed form exists: `filing workpaper generate`
 * and `annual figure record` hand `t('help.<…>.footer')` to `addHelpText`, and
 * the block lives in `src/i18n/en.ts` and its Spanish twin. This lane counts
 * the blocks that are not drawn from a key, per file, so the Examples series
 * (S22 of the D14 plan) can pay them one family at a time and no new leaf can
 * add more without the ratchet seeing it. The decision is the owner's answer 3
 * of 2026-11-16 on #141; the lane is step S12 of the D14 plan there, next to
 * `cli-user-strings-without-key` (`cli-strings.ts`, MNE-001-476).
 *
 * THE UNIT IS THE LITERAL THAT OPENS A BLOCK. A string or template literal of
 * `src/cli/` with a line that is only `Examples:` (or `Ejemplos:`: a Spanish
 * header written at the call site is just as unkeyed) is one block, whatever
 * shape carries it: an object of templates, an array element joined later, the
 * head of a `+` chain, a template with `${program.name()}` in it. The lines
 * that follow the header are part of the same block and are not counted again.
 * A block drawn from a key has no literal header in `src/cli/` (the header is
 * in the catalog), so it is not counted, with no list of exceptions to keep.
 *
 * WHAT IS NOT A BLOCK: a comment (the walk reads the syntax tree, not lines);
 * a sentence that only ends in "Examples:" (`mnemosine ai`'s run-time hint,
 * which `cli-user-strings-without-key` already counts); and any other help
 * text, which `help-descriptions-without-key` or nobody counts.
 *
 * What it does not reach, so nobody assumes it: it counts source, not screens.
 * A block built once and shown under several commands counts once, where it
 * is written; that is where it is paid. A footer that is not an Examples block
 * (`lineKeysHelp`, the notes after a block in the same literal) rides with
 * the block or is outside this lane.
 *
 * The two CLI lanes are disjoint: `cli-strings.ts` leaves out every literal
 * inside `addHelpText` or in a constant handed to it, which is where these are.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Lane, LaneMeter } from '../lane.js';
import { CLI_SURFACE, tsFilesUnder } from '../extract.js';
import { exitWhenDrained } from '../../lib/exit-when-drained.js';

/** The repository root: this file lives in `scripts/language/lanes/`. */
const ROOT = path.resolve(__dirname, '..', '..', '..');

const LANE_ID = 'help-examples-without-key';
const EXAMPLE_COUNT = 8;

/** A line that is only the header of an Examples block. */
const EXAMPLES_HEADER = /(?:^|\n)[ \t]*(?:Examples|Ejemplos):[ \t]*(?:\n|$)/;

/**
 * What the ratchet tells the author of a CLI PR that trips this lane, appended
 * to the finding (the surrounding message is `language-status.ts`'s, in Spanish).
 */
export const HELP_EXAMPLES_PER_ENTRY_RULE =
  'un bloque de Examples nuevo nace con clave: t(\'help.<familia>.<hoja>.footer\') de src/i18n/en.ts ' +
  'en addHelpText, no un literal (docs/language.md)';

export interface ExamplesBlock {
  file: string;
  /** The line where the literal that opens the block starts. */
  line: number;
  /** The literal's text; a template's substitutions read `${…}`. */
  text: string;
}

/** The text of a string-like literal, or `null` when the node is not one. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `\${…}${span.literal.text}`).join('');
  }
  return null;
}

/** The Examples blocks of ONE file, in reading order. */
export function examplesBlocks(code: string, file: string): ExamplesBlock[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: ExamplesBlock[] = [];
  const visit = (node: ts.Node): void => {
    const text = literalText(node);
    if (text !== null && EXAMPLES_HEADER.test(text)) {
      out.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** The same for a path, file or folder, in walk order. */
export function examplesBlocksUnder(target: string): ExamplesBlock[] {
  const out: ExamplesBlock[] = [];
  for (const file of tsFilesUnder(target)) {
    out.push(...examplesBlocks(fs.readFileSync(path.join(ROOT, file), 'utf8'), file));
  }
  return out;
}

/** One line per block, as the command prints it and `wc -l` counts it. */
function row(hit: ExamplesBlock): string {
  return `${hit.file}:${hit.line}\t${JSON.stringify(hit.text)}`;
}

/** An example names the block by its first command line, cut at 64 characters. */
function example(hit: ExamplesBlock): string {
  const after = hit.text.split(EXAMPLES_HEADER)[1] ?? '';
  const first = after.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#')) ?? '';
  return `${hit.file}:${hit.line} ${first.length > 64 ? `${first.slice(0, 63)}…` : first}`;
}

export const helpExamplesLanes: LaneMeter = () => {
  const hits = examplesBlocksUnder(CLI_SURFACE);
  const tally: Record<string, number> = {};
  for (const hit of hits) tally[hit.file] = (tally[hit.file] ?? 0) + 1;
  const perFile: Record<string, number> = {};
  for (const file of Object.keys(tally).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) perFile[file] = tally[file];
  return [
    {
      id: LANE_ID,
      title: `CLI help Examples blocks written in ${CLI_SURFACE}/ instead of drawn from a catalog key, per file`,
      value: hits.length,
      target: 0,
      command: 'npx tsx scripts/language/lanes/help-examples.ts | wc -l',
      examples: hits.slice(0, EXAMPLE_COUNT).map(example),
      perFile,
      perEntryRule: HELP_EXAMPLES_PER_ENTRY_RULE,
    } satisfies Lane,
  ];
};

function main(args: string[]): number {
  const target = args[0] ?? CLI_SURFACE;
  // One write for the whole list, not one per line (#659).
  process.stdout.write(examplesBlocksUnder(target).map((hit) => `${row(hit)}\n`).join(''));
  return 0;
}

if (require.main === module) {
  exitWhenDrained(main(process.argv.slice(2)));
}
