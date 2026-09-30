import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { program } from '../../src/cli/mnemosine.js';

// ============================================================
// THE EXAMPLES OF --help, ONCE (#327, MNE-001-089)
//
// The end-to-end walk of 2026-09-25 saw `invoice create --help` print its
// examples twice. The examples of a command can reach its help from several
// places: an `addHelpText('after', …)` registered twice, an ancestor's
// `afterAllHelp`, or a description that repeats them. So this renders the
// help the way `--help` does (`outputHelp`, every event included) for every
// node of the shipped tree, instead of reading one listener.
// ============================================================

function nodes(cmd: Command, prefix: string[] = []): { path: string; cmd: Command }[] {
  return (cmd.commands as Command[]).flatMap((child) => {
    const path = [...prefix, child.name()];
    return [{ path: path.join(' '), cmd: child }, ...nodes(child, path)];
  });
}

/** What `<path> --help` writes to stdout. */
function renderedHelp(cmd: Command): string {
  const config = cmd.configureOutput();
  const saved = { ...config };
  const chunks: string[] = [];
  cmd.configureOutput({ writeOut: (s: string) => { chunks.push(s); } });
  try {
    cmd.outputHelp();
  } finally {
    cmd.configureOutput(saved);
  }
  return chunks.join('');
}

/** Lines that appear more than once among the header and the example invocations. */
function repeated(help: string): string[] {
  const lines = help
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l === 'Examples:' || l.startsWith('mnemosine '));
  return [...new Set(lines.filter((l, i) => lines.indexOf(l) !== i))];
}

describe('--help prints its examples once', () => {
  const all = nodes(program);

  it('the whole shipped tree is walked', () => {
    // Measured 2026-09-30: 351 nodes, 259 of them leaves. The floor is that
    // count, so losing a single branch turns this red instead of letting the
    // check below pass over the commands it no longer sees. Raise it when the
    // tree grows.
    expect(all.length).toBeGreaterThanOrEqual(351);
  });

  it('the harness sees a repetition when there is one', () => {
    expect(repeated('Examples:\n  mnemosine a\nExamples:\n  mnemosine a\n')).toEqual([
      'Examples:',
      'mnemosine a',
    ]);
  });

  it('invoice create shows its examples once', () => {
    const invoiceCreate = all.find((n) => n.path === 'invoice create');
    expect(invoiceCreate).toBeDefined();
    const help = renderedHelp(invoiceCreate!.cmd);
    expect(help.match(/^Examples:$/gm)).toHaveLength(1);
    expect(repeated(help)).toEqual([]);
  });

  it('no command repeats its examples', () => {
    const offenders = all
      .map((n) => ({ path: n.path, lines: repeated(renderedHelp(n.cmd)) }))
      .filter((o) => o.lines.length > 0)
      .map((o) => `${o.path}: ${o.lines.join(' | ')}`);
    expect(offenders).toEqual([]);
  });
});
