import { expect } from 'vitest';
import type { Command } from 'commander';
import { program } from '../../../src/cli/mnemosine.js';
import { helpKeyOf } from '../../../src/cli/kernel/help.js';
import { setLanguage, t } from '../../../src/i18n/index.js';
import type { MessageParams, TranslationKey } from '../../../src/i18n/index.js';
import { unkeyedDescriptions, type UnkeyedDescription } from '../../../scripts/language/lanes/help.js';

// ============================================================
// HELP BY KEY: WHAT EVERY FAMILY SPEC OF #314 CHECKS (MNE-001-092)
//
// With es-MX, `mnemosine <family> <leaf> --help` shows each description
// (command, option, argument) in Spanish, rendered from the catalog by a key in
// the format decided on #152. A family spec checks that the lane
// `help-descriptions-without-key` finds nothing in it (`unkeyedInFamilies`;
// `unkeyedUnder` for a group such as `bank account`; `unkeyedAt` for what a
// command shows of its own), that every description has a key in that format
// (`expectEveryKeyInFormat`), and that sampled leaves show the key's Spanish
// and not its English (`expectSpanishHelp`). Extracted from
// `period-help-by-key.spec.ts` and `close-families-help-by-key.spec.ts` with
// their semantics; what is new is tested in `help-by-key-helper.spec.ts`.
//
// THE RECIPE OF EACH FAMILY PULL REQUEST (MNE-001-231 to 244), from the plan
// approved on #314 and the owner's answers to it. It lives here and in that
// plan, not in AGENTS.md.
//  1. Test first: `tests/cli/<group>-help-by-key.spec.ts` on this helper, red
//     because the lane still lists the group and `helpKeyOf` returns null.
//     231 also keys the `bank` root's own description, which `describedIn` and
//     `unkeyedUnder` would take with the whole family: `unkeyedAt(['bank'])`,
//     and `helpKeyOf(node('bank'))` against `keyFormat('bank')`.
//  2. In the family's `src/cli/*-command.ts`, the prose of `.description()`,
//     `.option()` and `.argument()` becomes `describeCommand`, `optionByKey` and
//     `argumentByKey` (`src/cli/kernel/index.ts`), keyed
//     `help.<cmd>[.<sub>…].{description,option.<flag>,argument.<name>}` in
//     snake_case (`pay-run` is `pay_run`); an interpolated list becomes a
//     message parameter. The four overwrites of a kernel flag move to
//     `describeOption`: `--output` in `src/cli/e-accounting-command.ts` (240),
//     `--all` and `--status` of `tax-deposit list`, which lives in
//     `src/cli/payroll-isn-command.ts` (239), `--user` in
//     `src/cli/audit-command.ts` (244).
//  3. Flags: a key per leaf, English unchanged. `cli.flag.*` only where the
//     leaf's flag does exactly what the kernel text says; in doubt, per leaf, as
//     `close --json` and `year create --json` are. No `--json` still without a
//     key qualifies for `cli.flag.json` ("shorthand for --format json"): none
//     of those leaves has an output `--format` (`bank statement import` and
//     `bank reconciliation run` have one, but for the file they read). By the
//     same rule 238 moves `bill approve --json`, which has no `--format`, off
//     it. The braces of `bill create --from-file` go in as a message parameter.
//  4. Each key in `src/i18n/en.ts` and `src/i18n/es.ts`, same order, inside a
//     `// ==== MNE-001-2xx · help by key, … (issue #314) ====` block. Spanish
//     only in `es.ts`.
//  5. Regenerate, never by hand. `npm run language:status -- --tighten`
//     rewrites `docs/language-baseline.json` (and lowers unrelated lanes with
//     slack), then `-- --write` the block of `docs/language.md` and its `.es.md`
//     twin. 231 and 232 only lower the baseline's `bank` entry; 233 removes it.
//     `npx tsx scripts/generate-cli-reference.ts`:
//     `src/ai/docs/cli-reference.md` changes only for flags entering or leaving
//     `cli.flag.*`, and the pull request lists them. A manual that
//     `src/ai/docs/manifiesto.json` hashes against the family's file
//     (`banking.md`, `accounting.md`) is reread, then sealed with
//     `npx tsx scripts/corpus-manifiesto.ts --actualizar <manual>`. A file that
//     crosses 1000 lines: `npx tsx scripts/repo-map.ts`.
//  6. `scripts/verify.sh` green. CI also requires English commit subjects.
//  7. The pull request is mechanical. Its body splits the lines into written
//     by hand (new calls, Spanish, parameters, test: under ~400, or the task
//     splits by subcommand group under a new ID), English moved to `en.ts`, and
//     generated; and it lists the options with a parser of their own, which
//     `cli-reference.md` cannot see. It says `Part of #314`: only the task
//     after 244 that brings the lane to 0, with its criterion in E0.0, says
//     `Closes #314`.
//  8. Untouched: the `Examples:` blocks; the lines a plan mutant anchors on
//     (`archivo` and `de` in `src/plan/criteria/`, such as `.command('assign')`
//     in `src/cli/bank-command.ts`, 233); `docs/backlog/`, where each task is
//     marked done after it merges; `.github/workflows/ci.yml` (the closing
//     criterion goes in E0.0, already in its `--exigir`); and the paths that
//     need human approval (the list in AGENTS.md, section Límites, which
//     includes `.github/CODEOWNERS`).
//     Leaving the recipe (another kernel-flag overwrite, English changed
//     outside rule 3, one of those paths) is a stop: comment on #314 and wait,
//     as `docs/PROCESS.md` §5 says.
// ============================================================

/** One description a help screen shows, and the key that renders it. */
export interface Described {
  where: string;
  key: TranslationKey | null;
}

/** The command at this path, such as `closing pack verify`; throws if there is none. */
export function node(path: string, root: Command = program): Command {
  let cmd = root;
  for (const name of path.split(' ')) {
    const next = cmd.commands.find((c) => c.name() === name);
    if (!next) throw new Error(`no command ${path}`);
    cmd = next;
  }
  return cmd;
}

/** Every description the help screens of this subtree show, with its key. */
export function describedIn(cmd: Command): Described[] {
  const out: Described[] = [];
  const walk = (current: Command, path: string): void => {
    if (current.description()) out.push({ where: `${path} (command)`, key: helpKeyOf(current) });
    for (const o of current.options) if (o.description) out.push({ where: `${path} ${o.flags}`, key: helpKeyOf(o) });
    for (const a of current.registeredArguments) {
      if (a.description) out.push({ where: `${path} <${a.name()}>`, key: helpKeyOf(a) });
    }
    for (const sub of current.commands) walk(sub, `${path} ${sub.name()}`);
  };
  walk(cmd, cmd.name());
  return out;
}

/** Commander wraps long descriptions, so help is compared with whitespace collapsed. */
export const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** The key format decided on #152 under a key prefix (`period`, `opening_balance`, `bank.account`). */
export function keyFormat(prefix: string): RegExp {
  const literal = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^help\\.${literal}(\\.[a-z][a-z0-9_]*)*\\.(description|option\\.[a-z][a-z0-9_]*|argument\\.[a-z][a-z0-9_]*)$`
  );
}

/** Every description has a key: in the format of `prefix`, or a generic `cli.*` one. */
export function expectEveryKeyInFormat(described: readonly Described[], prefix: string): void {
  const format = keyFormat(prefix);
  for (const { where, key } of described) {
    expect(key, where).not.toBeNull();
    expect(key!.startsWith('cli.') || format.test(key!), `${where}: ${key}`).toBe(true);
  }
}

/** The lane's descriptions without key in these top-level families. */
export function unkeyedInFamilies(families: readonly string[], root: Command = program): UnkeyedDescription[] {
  const wanted = new Set(families);
  return unkeyedDescriptions(root).filter((hit) => wanted.has(hit.family));
}

/**
 * The lane's descriptions without key at or under these command paths:
 * `bank account` takes itself and `bank account list`, never a sibling whose
 * name only starts the same way. A path that names no command throws, instead
 * of passing as an empty list.
 */
export function unkeyedUnder(paths: readonly string[], root: Command = program): UnkeyedDescription[] {
  for (const path of paths) node(path, root);
  return unkeyedDescriptions(root).filter((hit) =>
    paths.some((path) => hit.command === path || hit.command.startsWith(`${path} `))
  );
}

/**
 * The lane's descriptions without key that these commands show of their own
 * (description, options, arguments), not those of the commands under them:
 * `bank` takes the root's description, which 231 keys, and none of its groups.
 * A path that names no command throws, as in `unkeyedUnder`.
 */
export function unkeyedAt(paths: readonly string[], root: Command = program): UnkeyedDescription[] {
  for (const path of paths) node(path, root);
  return unkeyedDescriptions(root).filter((hit) => paths.includes(hit.command));
}

/**
 * With the language set to es, `<path> --help` shows the key's Spanish and not
 * its English, and the two differ. A parameterised message is checked by its
 * fixed head, before the list: pass the list parameter empty, and the space
 * left after the colon is dropped. Leaves the language at es, so the spec
 * resets it in `afterEach`.
 */
export function expectSpanishHelp(path: string, key: TranslationKey, params: MessageParams = {}): void {
  setLanguage('es');
  const help = flat(node(path).helpInformation());
  const spanish = t(key, params, 'es').replace(/:\s*$/, ':');
  const english = t(key, params, 'en').replace(/:\s*$/, ':');
  expect(spanish).not.toBe(english);
  expect(help).toContain(spanish);
  expect(help).not.toContain(english);
}
