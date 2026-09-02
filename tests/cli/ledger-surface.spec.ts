import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { riskOf, resetDeclarations } from '../../src/cli/kernel/risk.js';
import { VERBS } from '../../src/cli/kernel/vocabulary.js';
import { registerEntryCommand } from '../../src/cli/entry-command.js';
import { registerPeriodCommand, registerYearCommand } from '../../src/cli/period-command.js';

// ============================================================
// THE LEDGER SURFACE — entry / period / year
//
// Builds the three families into a throwaway program and holds them
// to the kernel's rules. The one that matters most is the last block:
// the agent may read the ledger and DRAFT into it, and may do nothing
// else. If a later edit marks `entry post` agent-invocable, declareRisk
// throws at registration and this suite fails to even build the program.
// ============================================================

const deps = {
  palette: {
    dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
    red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
  },
  shutdown: async () => {},
  reportError: () => {},
};

/**
 * A fresh program per assertion. The risk registry is keyed by Command
 * instance and other suites reset it, so building here — rather than once —
 * keeps this file honest no matter what order the runner picks.
 */
function build(): Command {
  resetDeclarations();
  const program = new Command('mnemosine');
  registerEntryCommand(program, deps);
  registerPeriodCommand(program, deps);
  registerYearCommand(program, deps);
  return program;
}

const find = (path: string, program: Command = build()): Command => {
  let node: Command = program;
  for (const token of path.split(' ')) {
    const next = node.commands.find((c) => c.name() === token);
    if (!next) throw new Error(`command "${path}" is not registered`);
    node = next;
  }
  return node;
};

describe('the surface obeys the kernel', () => {
  it('has no violations of the consistency rules', () => {
    expect(auditProgram(build())).toEqual([]);
  });

  it('names every family in English with its Spanish alias', () => {
    const program = build();
    expect(find('entry', program).aliases()).toContain('poliza');
    expect(find('entry', program).aliases()).toContain('asiento');
    expect(find('period', program).aliases()).toContain('periodo');
    expect(find('year', program).aliases()).toContain('ejercicio');
  });

  it('gives every subcommand the one Spanish verb from the vocabulary', () => {
    // F01: un hijo puede ser un SUBGRUPO-sustantivo (entry line …) — su alias
    // es el sustantivo español y sus hojas siguen la regla del verbo.
    const SUBGRUPOS: Record<string, string> = { line: 'renglon' };
    const program = build();
    for (const family of ['entry', 'period', 'year']) {
      for (const sub of find(family, program).commands) {
        if (sub.commands.length > 0) {
          expect(sub.aliases(), `${family} ${sub.name()}`).toEqual([SUBGRUPOS[sub.name()]]);
          for (const hoja of sub.commands) {
            expect(hoja.aliases(), `${family} ${sub.name()} ${hoja.name()}`).toEqual([VERBS[hoja.name()]]);
          }
          continue;
        }
        expect(sub.aliases(), `${family} ${sub.name()}`).toEqual([VERBS[sub.name()]]);
      }
    }
  });
});

describe('what the agent may and may not do with the ledger', () => {
  const reads = ['entry list', 'entry show', 'entry check', 'period list', 'period show', 'year list', 'year show'];
  // F06b: `period reopen` entra directo a la lista negra — el catálogo la
  // marca irreversible e IA ✗ sin excepción, como toda reapertura.
  const forbidden = ['entry post', 'entry reverse', 'entry void', 'period open', 'year create', 'period reopen'];

  it.each(reads)('%s is a read the agent may run', (path) => {
    const risk = riskOf(find(path));
    expect(risk?.risk).toBe('lectura');
    expect(risk?.agentAllowed).toBe(true);
  });

  it.each(forbidden)('%s is never agent-invocable', (path) => {
    expect(riskOf(find(path))?.agentAllowed).toBe(false);
  });

  it('lets the agent draft an entry, and only as a draft', () => {
    const risk = riskOf(find('entry create'));
    expect(risk?.risk).toBe('escritura');
    expect(risk?.agentAllowed).toBe(true);
    expect(risk?.draftOnly).toBe(true);
  });

  it('exposes no way for `entry create` to post', () => {
    const longs = find('entry create').options.map((o) => o.long);
    expect(longs).not.toContain('--post');
    expect(longs).not.toContain('--auto-post');
    expect(longs).not.toContain('--yes');
  });

  it('makes post, reverse and void irreversible, with their safety flags', () => {
    const program = build();
    for (const path of ['entry post', 'entry reverse', 'entry void']) {
      const cmd = find(path, program);
      expect(riskOf(cmd)?.risk, path).toBe('irreversible');
      const longs = cmd.options.map((o) => o.long);
      expect(longs, path).toEqual(expect.arrayContaining(['--dry-run', '--yes', '--idempotency-key']));
    }
    // reverse and void undo something: the kernel makes them justify it.
    expect(find('entry reverse', program).options.map((o) => o.long)).toContain('--reason');
    expect(find('entry void', program).options.map((o) => o.long)).toContain('--reason');
  });

  it('has no `period close`: `close` is the single close orchestrator', () => {
    expect(find('period').commands.map((c) => c.name())).not.toContain('close');
  });

  // F06b · `period reopen` — la otra puerta del calendario, y la que un
  // auditor más pregunta: irreversible por catálogo, con las tres banderas
  // del núcleo, el --reason que el verbo exige y el --force para hard_close.
  it('declares `period reopen` irreversible, with every safety flag it promises', () => {
    const reopen = find('period reopen');
    expect(riskOf(reopen)?.risk).toBe('irreversible');
    const longs = reopen.options.map((o) => o.long);
    expect(longs).toEqual(
      expect.arrayContaining(['--dry-run', '--yes', '--idempotency-key', '--reason', '--force'])
    );
  });

  it('gives `period reopen` the vocabulary alias `reabrir`', () => {
    expect(find('period reopen').aliases()).toEqual([VERBS.reopen]);
  });
});
