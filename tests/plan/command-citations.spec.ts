import { describe, expect, it } from 'vitest';
import { commandCitations, type CliNode } from '../../src/plan/criteria/e5-1.js';

// The heuristics behind `messages-cite-live-commands` (#300), on a toy tree:
// which `mnemosine …` mentions are invocations to check and which are prose.
const node = (name: string, children: CliNode[] = [], args = 0, aliases: string[] = []): CliNode => ({
  name: () => name,
  aliases: () => aliases,
  commands: children,
  registeredArguments: Array.from({ length: args }),
});

const root = node('mnemosine', [
  node('pending', [node('define', [], 2, ['definir']), node('reopen', [], 1)], 0, ['pendientes']),
  node('review'),
  node('close'),
]);

const scan = (code: string) => commandCitations('x.ts', code, root);

describe('commandCitations', () => {
  it('flags a verb a live menu does not have', () => {
    expect(scan("const m = 'run `mnemosine pending " + "resolve x`';").dead).toEqual([
      'mnemosine pending resolve',
    ]);
  });

  it('accepts live paths, their aliases and their arguments', () => {
    const r = scan("const m = '`mnemosine pending define x 1` or `mnemosine pendientes definir x`';");
    expect(r).toEqual({ live: 2, dead: [] });
  });

  it('flags an extra word after an argument-less leaf only when it is shaped like a command', () => {
    expect(scan("const m = 'Recházalo con `mnemosine review " + "reject abc`';").dead).toEqual([
      'mnemosine review reject',
    ]);
    expect(scan("const m = 'mnemosine close the month first';").dead).toEqual([]);
  });

  it('flags an unknown family in backticks or with a flag, and leaves prose alone', () => {
    expect(scan("const m = 'Cárgalo con mnemosine inpc import --file <f>';").dead).toEqual(['mnemosine inpc']);
    expect(scan("const m = 'mnemosine does not transmit to the SAT';").dead).toEqual([]);
  });

  it('leaves alone a citation that declares itself absent', () => {
    expect(scan("const m = '`mnemosine inpc import`, que todavía no existe, es el comando';").dead).toEqual([]);
  });

  it('reads template literals and ignores comments', () => {
    const code = [
      '// `mnemosine pending ' + 'resolve x` in a comment is history',
      'const k = 1;',
      "const m = `${k} \\`mnemosine review " + "reject ${k}\\``;",
    ].join('\n');
    expect(scan(code).dead).toEqual(['mnemosine review reject']);
  });
});
