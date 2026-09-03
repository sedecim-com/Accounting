import type { Command } from 'commander';
import type { Palette } from './palette.js';
import { exitCodeFor, usageError } from './kernel/index.js';

// ============================================================
// mnemosine completion
//
// `completion` was already a reserved word in the closed vocabulary
// (kernel/vocabulary.ts, OBJECTLESS_COMMANDS) and did not exist. A
// reserved verb with nothing behind it is declared surface that lies,
// and in a tree of 55 families it is the one that hurts most: with no
// completion, the only way to find a leaf is to read the help of every
// level above it.
//
// Two rules shape everything below.
//
// 1. THE SCRIPT IS GENERATED FROM THE REAL TREE. It walks the Commander
//    program it was handed, at ACTION time — not at registration time,
//    because families registered after this one would be missing — so a
//    command added tomorrow completes tomorrow. A hand-written list
//    would rot on the first commit and nobody would notice: a stale
//    completion just fails to suggest, silently.
//
// 2. THE SCRIPT IS UNTRUSTED TEXT UNTIL IT IS QUOTED. Every command
//    name and alias that reaches the emitted script is a string this
//    module did not write. A name carrying a quote would close the
//    literal and the rest would be code the shell runs on the user's
//    machine every time they press TAB. So every interpolated word goes
//    through `shellQuote`, which is why the test asserts on the
//    UNQUOTED regions of the output rather than on its looks.
//
// stdout carries the script and nothing else — no banner, no courtesy
// line — because the documented use is a redirect:
//   mnemosine completion zsh > "${fpath[1]}/_mnemosine"
// Anything else goes to stderr, through reportError.
// ============================================================

/** The shells with a generator here. Anything else is a usage error. */
export const COMPLETION_SHELLS = ['bash', 'zsh'] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export function isCompletionShell(shell: string): shell is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(shell);
}

export interface CompletionCommandDeps {
  /**
   * The palette. Two spellings for the same dependency exist in this
   * repository — most registrars take `palette`, `pending`/`sat` take
   * `color` — and this command is wired by a different hand than the one
   * that writes it, so both are accepted and neither is required: the
   * script itself is never colored (it is piped to a file, and color
   * codes in a completion script are corruption, not decoration).
   */
  palette?: Palette;
  color?: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
}

// ─── The tree, read off the live program ───

interface TreeChild {
  /** Canonical path of the child, segments joined by a space. */
  key: string;
  /** Every spelling that NAVIGATES here: name, aliases, and ASCII folds. */
  spellings: string[];
  /** The spellings OFFERED as completions: name and aliases, no folds. */
  suggestions: string[];
}

interface TreeNode {
  /** Canonical path of this command; '' for the program root. */
  key: string;
  children: TreeChild[];
  /** Option spellings valid at this node. */
  flags: string[];
}

/**
 * Normalizes a word on its way into the script.
 *
 * NFC matters and is not cosmetic: 'enseña' can arrive as U+00F1 or as
 * 'n' + U+0303 (macOS filesystems and some editors hand back the
 * decomposed form). The two are different byte strings, so a script
 * emitted in one form never matches a shell comparing against the other
 * and the accented alias silently stops completing. Control characters
 * are stripped because the word lists below are line-oriented: an
 * embedded newline would split one word into two.
 */
function shellWord(raw: string): string {
  return raw.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '');
}

/** 'antigüedad-cobrar' → 'antiguedad-cobrar'. Accepted, never suggested. */
function asciiFold(word: string): string {
  return word.normalize('NFD').replace(/[\u0300-\u036F]/g, '').normalize('NFC');
}

/**
 * A single-quoted shell literal. The ONLY way a name reaches the script.
 *
 * Inside single quotes the shell expands nothing — no $, no backtick, no
 * backslash — so the whole attack surface collapses to one character:
 * the quote that would end the literal. `'` becomes `'\''` (close, an
 * escaped literal quote, reopen), which is safe in bash and zsh alike.
 */
export function shellQuote(raw: string): string {
  return `'${raw.replace(/'/g, "'\\''")}'`;
}

/** A shell function name: identifiers cannot carry a dash or an accent. */
function shellIdentifier(raw: string): string {
  const id = raw.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(id) ? id : `c${id}`;
}

function unique(words: string[]): string[] {
  return [...new Set(words.filter((w) => w.length > 0))];
}

function isHidden(cmd: Command): boolean {
  return (cmd as unknown as { _hidden?: boolean })._hidden === true;
}

/** Every option spelling of a command, plus the help flag Commander adds. */
function flagsOf(cmd: Command): string[] {
  const flags: string[] = [];
  for (const opt of cmd.options) {
    if (opt.hidden) continue;
    if (opt.short) flags.push(shellWord(opt.short));
    if (opt.long) flags.push(shellWord(opt.long));
  }
  flags.push('--help', '-h');
  return unique(flags);
}

/**
 * Flattens the program into one node per command path.
 *
 * Called from the action, not from the registrar: at registration time
 * this command may be the first of fifty, and a tree read then would
 * describe a program that does not exist yet.
 */
export function collectTree(root: Command): TreeNode[] {
  const nodes: TreeNode[] = [];

  const visit = (cmd: Command, path: string[]): void => {
    const children: TreeChild[] = [];
    for (const child of cmd.commands ?? []) {
      if (isHidden(child)) continue;
      const name = shellWord(child.name());
      if (!name) continue;
      const aliases = (child.aliases?.() ?? []).map(shellWord);
      const suggestions = unique([name, ...aliases]);
      // The ASCII fold navigates but is not suggested: `memory ensena`
      // must still resolve for anyone whose keyboard has no ñ, and
      // offering both spellings of every accented alias would double the
      // menu for no information.
      const spellings = unique([...suggestions, ...suggestions.map(asciiFold)]);
      const childPath = [...path, name];
      children.push({ key: childPath.join(' '), spellings, suggestions });
      visit(child, childPath);
    }
    nodes.push({ key: path.join(' '), children, flags: flagsOf(cmd) });
  };

  visit(root, []);
  return nodes;
}

// ─── The generated tables ───

const INDENT = '        ';

/** `case "$1|$2"` arms: (parent path, typed word) → canonical child path. */
function resolveArms(nodes: TreeNode[]): string[] {
  const arms: string[] = [];
  for (const node of nodes) {
    for (const child of node.children) {
      const patterns = child.spellings
        .map((spelling) => shellQuote(`${node.key}|${spelling}`))
        .join('|');
      arms.push(`${INDENT}${patterns}) printf '%s' ${shellQuote(child.key)} ;;`);
    }
  }
  return arms;
}

/** `case "$1"` arms: canonical path → one candidate word per line. */
function wordArms(nodes: TreeNode[], pick: (node: TreeNode) => string[]): string[] {
  const arms: string[] = [];
  for (const node of nodes) {
    const words = unique(pick(node));
    if (words.length === 0) continue;
    arms.push(
      `${INDENT}${shellQuote(node.key)}) printf '%s\\n' ${words.map(shellQuote).join(' ')} ;;`
    );
  }
  return arms;
}

const subcommandsOf = (node: TreeNode): string[] =>
  node.children.flatMap((child) => child.suggestions);

function tables(fn: string, nodes: TreeNode[]): string[] {
  return [
    `${fn}_resolve() {`,
    '    case "$1|$2" in',
    ...resolveArms(nodes),
    `${INDENT}*) ;;`,
    '    esac',
    '}',
    '',
    `${fn}_subcommands() {`,
    '    case "$1" in',
    ...wordArms(nodes, subcommandsOf),
    `${INDENT}*) ;;`,
    '    esac',
    '}',
    '',
    `${fn}_flags() {`,
    '    case "$1" in',
    ...wordArms(nodes, (node) => node.flags),
    `${INDENT}*) ;;`,
    '    esac',
    '}',
    '',
  ];
}

// ─── bash ───

function bashScript(binary: string, nodes: TreeNode[]): string {
  const fn = `_${shellIdentifier(binary)}`;
  const lines = [
    `# bash completion for ${binary}.`,
    `# Generated by \`${binary} completion bash\` from the live command tree.`,
    '# Regenerate after upgrading; do not edit by hand.',
    '#',
    `#   ${binary} completion bash > /usr/local/etc/bash_completion.d/${binary}`,
    '',
    ...tables(fn, nodes),
    `${fn}_complete() {`,
    '    local cur word next list',
    '    local -a candidates',
    '    local i path',
    '    COMPREPLY=()',
    '    cur="${COMP_WORDS[COMP_CWORD]}"',
    '    path=""',
    '',
    '    # Walk what was typed so far, translating each word (canonical name,',
    '    # Spanish alias or ASCII fold) into the canonical path it names.',
    '    # Options are skipped: they never move the position in the tree.',
    '    for (( i = 1; i < COMP_CWORD; i++ )); do',
    '        word="${COMP_WORDS[i]}"',
    '        case "$word" in -*) continue ;; esac',
    `        next="$(${fn}_resolve "$path" "$word")"`,
    '        if [ -n "$next" ]; then path="$next"; fi',
    '    done',
    '',
    '    case "$cur" in',
    `        -*) list="$(${fn}_flags "$path")" ;;`,
    `        *) list="$(${fn}_subcommands "$path")" ;;`,
    '    esac',
    '',
    '    # compgen -W would EXPAND its word list, which would hand a command',
    '    # name containing $(...) to the shell at TAB time. Read the candidates',
    '    # line by line instead: nothing here is re-evaluated, and the prefix',
    '    # test quotes $cur so a glob character in it stays literal.',
    '    candidates=()',
    '    while IFS= read -r word; do',
    '        [ -n "$word" ] || continue',
    '        case "$word" in "$cur"*) candidates[${#candidates[@]}]="$word" ;; esac',
    '    done <<COMPLETION_WORDS',
    '$list',
    'COMPLETION_WORDS',
    '',
    '    if [ "${#candidates[@]}" -gt 0 ]; then',
    '        COMPREPLY=( "${candidates[@]}" )',
    '    fi',
    '}',
    '',
    `complete -F ${fn}_complete ${shellQuote(binary)}`,
    '',
  ];
  return lines.join('\n');
}

// ─── zsh ───

function zshScript(binary: string, nodes: TreeNode[]): string {
  const fn = `_${shellIdentifier(binary)}`;
  const lines = [
    `#compdef ${binary}`,
    `# zsh completion for ${binary}.`,
    `# Generated by \`${binary} completion zsh\` from the live command tree.`,
    '# Regenerate after upgrading; do not edit by hand.',
    '#',
    `#   ${binary} completion zsh > "\${fpath[1]}/${fn}"`,
    '',
    ...tables(fn, nodes),
    `${fn}() {`,
    '    local word next',
    '    local -a candidates',
    '    local i path',
    '    path=""',
    '',
    '    # words[1] is the binary; CURRENT is the word being completed.',
    '    for (( i = 2; i < CURRENT; i++ )); do',
    '        word="${words[i]}"',
    '        if [[ "$word" == -* ]]; then continue; fi',
    `        next="$(${fn}_resolve "$path" "$word")"`,
    '        if [[ -n "$next" ]]; then path="$next"; fi',
    '    done',
    '',
    '    # compadd takes the candidates as data and expands none of them, so a',
    '    # hostile command name completes as text instead of running.',
    '    if [[ "${words[CURRENT]}" == -* ]]; then',
    `        candidates=( \${(f)"$(${fn}_flags "$path")"} )`,
    '    else',
    `        candidates=( \${(f)"$(${fn}_subcommands "$path")"} )`,
    '    fi',
    '    [[ -n "${candidates[1]}" ]] || return 1',
    '    compadd -a candidates',
    '}',
    '',
    '# Works both autoloaded from $fpath and sourced from a startup file.',
    `if [ "\${funcstack[1]}" = ${shellQuote(fn)} ]; then`,
    `    ${fn} "$@"`,
    'else',
    `    compdef ${fn} ${shellQuote(binary)}`,
    'fi',
    '',
  ];
  return lines.join('\n');
}

// ─── The command ───

/**
 * The completion script for `shell`, generated from `program`.
 *
 * Exported on its own so the generator can be tested against a synthetic
 * tree — the real one is 134 leaves and asserting on it would test the
 * catalog, not the generator.
 *
 * @throws CliError with ExitCode.USAGE (2) when the shell is missing or
 * unknown. Not code 1: "you did not tell me which shell" is a usage
 * error, and the exit-code contract is what lets a wrapper script tell
 * a typo from a failure.
 */
export function renderCompletionScript(program: Command, shell?: string): string {
  const supported = COMPLETION_SHELLS.join(', ');
  if (!shell) {
    throw usageError(
      `completion needs a shell (${supported}). Example: ${program.name()} completion zsh > "\${fpath[1]}/_${shellIdentifier(program.name())}"`
    );
  }
  if (!isCompletionShell(shell)) {
    throw usageError(`unknown shell "${shell}". Supported: ${supported}.`);
  }

  const binary = shellWord(program.name()) || 'mnemosine';
  const nodes = collectTree(program);
  return shell === 'bash' ? bashScript(binary, nodes) : zshScript(binary, nodes);
}

export function registerCompletionCommand(program: Command, deps: CompletionCommandDeps): void {
  const { shutdown, reportError } = deps;

  program
    .command('completion')
    // The Spanish alias is NOT invented here. docs/cli-command-registry.md —
    // the document kernel/vocabulary.ts declares itself generated from —
    // already pairs `completion`·`completado` in its platform noun table
    // (§2.12), and docs/cli-command-catalog.md spells the leaf `completado
    // ver`. `autocompletado` reads better in isolation and is exactly the
    // wrong answer: it would open a SECOND Spanish word for a command the
    // registry has already named, which is the one thing the bilingual
    // bijection forbids. Unaccented, like every other alias in that table
    // (`conciliacion`, `politica`, `aprobacion`).
    .alias('completado')
    .description('Print a shell completion script (bash, zsh) on stdout')
    .argument('[shell]', `Shell to generate for: ${COMPLETION_SHELLS.join(' or ')}`)
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${program.name()} completion bash > /usr/local/etc/bash_completion.d/${program.name()}`,
        `  ${program.name()} completion zsh > "\${fpath[1]}/_${shellIdentifier(program.name())}"`,
        '',
        'The script is generated from the installed command tree, so it covers',
        'the Spanish aliases too. Regenerate it after every upgrade.',
      ].join('\n')
    )
    .action(async (shell: string | undefined) => {
      try {
        // Written straight to stdout: no console.log, which would add a
        // newline the redirect target does not need, and no banner, which
        // would make the file unsourceable.
        process.stdout.write(renderCompletionScript(program, shell));
        await shutdown(0);
      } catch (err) {
        reportError(err);
        await shutdown(exitCodeFor(err));
      }
    });
}
