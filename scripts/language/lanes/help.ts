/**
 * HELP DESCRIPTIONS THAT DO NOT COME FROM THE CATALOG (#314)
 *
 *   npx tsx scripts/language/lanes/help.ts           one line per description: family, command, what
 *   npx tsx scripts/language/lanes/help.ts | wc -l   the lane's number
 *
 * `mnemosine <family> <leaf> --help` shows three kinds of description: the
 * command's, each option's and each positional argument's. Only the ones
 * registered by key (`describeCommand`, `optionByKey`, `argumentByKey` in
 * `src/cli/kernel/help.ts`) are rendered in the accountant's locale; every
 * other one prints the English written at the call site, whatever `--locale`
 * says. This lane counts those.
 *
 * WHY IT ASKS `helpKeyOf` AND NOT THE PROSE. AGENTS.md: the surface is
 * translated by KEY, not by prose. A meter that looked at the rendered text
 * would go green the day someone wrote Spanish at the call site, which is the
 * mistake the rule exists to prevent. `helpKeyOf` is the same test the `Help`
 * hooks apply before rendering a key, so "counted as keyed" and "rendered in
 * the viewer's locale" cannot drift apart. A description a leaf overwrote
 * after registering its key counts as without key, because that is what the
 * screen shows.
 *
 * WHAT IS NOT COUNTED. An empty description (there is nothing to translate;
 * a missing description is `scripts/ux-status.ts`'s business), and hidden
 * commands and options, which no help screen shows. The `(default: …)`
 * suffixes and the `Examples:` blocks are not descriptions either; they are
 * outside this lane and outside #314's acceptance.
 *
 * THE BREAKDOWN IS BY FAMILY, not by file. `perFile` is the ratchet's unit of
 * payment, and #314 pays this debt one family per PR; a family is also what a
 * new command is born into, so a new family with unkeyed help shows up as
 * "0 → n, no entry in the baseline" exactly like a new file would. The root
 * program and its global options are the family `mnemosine`.
 */
import '../../english-locale.js';
import type { Command } from 'commander';
import type { Lane, LaneMeter } from '../lane.js';
import { program } from '../../../src/cli/mnemosine.js';
import { helpKeyOf } from '../../../src/cli/kernel/help.js';

const EXAMPLE_COUNT = 8;
const ROOT_FAMILY = 'mnemosine';

export interface UnkeyedDescription {
  /** The top-level command it belongs to, or `mnemosine` for the root. */
  family: string;
  /** The command path without the binary, e.g. `period open`. */
  command: string;
  /** Which of the three descriptions of that command. */
  kind: 'command' | 'option' | 'argument';
  /** The option's flags or the argument's name; empty for the command itself. */
  term: string;
}

/** Commander marks `{ hidden: true }` commands with a private field and filters them out of every help screen. */
function isHiddenCommand(cmd: Command): boolean {
  return (cmd as unknown as { _hidden?: boolean })._hidden === true;
}

/**
 * Every visible help description under `root` that is not rendered by key,
 * in tree order. Takes the root as a parameter so the tests can hand it a
 * small tree of their own.
 */
export function unkeyedDescriptions(root: Command): UnkeyedDescription[] {
  const hits: UnkeyedDescription[] = [];
  const walk = (cmd: Command, family: string, pathNames: string[]): void => {
    const command = pathNames.join(' ');
    if (cmd.description() && helpKeyOf(cmd) === null) {
      hits.push({ family, command, kind: 'command', term: '' });
    }
    for (const option of cmd.options) {
      if (option.hidden || !option.description || helpKeyOf(option) !== null) continue;
      hits.push({ family, command, kind: 'option', term: option.flags });
    }
    for (const argument of cmd.registeredArguments) {
      if (!argument.description || helpKeyOf(argument) !== null) continue;
      hits.push({ family, command, kind: 'argument', term: argument.name() });
    }
    for (const sub of cmd.commands) {
      if (isHiddenCommand(sub)) continue;
      walk(sub, pathNames.length === 0 ? sub.name() : family, [...pathNames, sub.name()]);
    }
  };
  walk(root, ROOT_FAMILY, []);
  return hits;
}

function line(hit: UnkeyedDescription): string {
  const where = hit.command === '' ? ROOT_FAMILY : hit.command;
  return `${where} ${hit.kind}${hit.term ? ` ${hit.term}` : ''}`;
}

export const helpLanes: LaneMeter = () => {
  const hits = unkeyedDescriptions(program);
  const perFile: Record<string, number> = {};
  for (const hit of hits) perFile[hit.family] = (perFile[hit.family] ?? 0) + 1;
  const sorted: Record<string, number> = {};
  for (const family of Object.keys(perFile).sort()) sorted[family] = perFile[family];
  return [
    {
      id: 'help-descriptions-without-key',
      title: 'CLI help descriptions (commands, options, arguments) not rendered from a catalog key, by family',
      value: hits.length,
      target: 0,
      command: 'npx tsx scripts/language/lanes/help.ts | wc -l',
      examples: hits.slice(0, EXAMPLE_COUNT).map(line),
      perFile: sorted,
    } satisfies Lane,
  ];
};

if (require.main === module) {
  for (const hit of unkeyedDescriptions(program)) process.stdout.write(`${hit.family}\t${line(hit)}\n`);
}
