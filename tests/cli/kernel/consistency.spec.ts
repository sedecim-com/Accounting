import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { VERBS, isVerb } from '../../../src/cli/kernel/vocabulary.js';
import { FLAG_DICTIONARY, withReadFlags, withContext, withOutput, withSelection } from '../../../src/cli/kernel/flags.js';
import { declareRisk, resetDeclarations, riskOf } from '../../../src/cli/kernel/risk.js';
import { auditProgram } from '../../../src/cli/kernel/audit.js';

// ============================================================
// LAS REGLAS DE `auditProgram`, UNA POR UNA.
//
// La función vive en src/cli/kernel/audit.ts, no aquí. Vivía aquí, y eso
// hacía que el binario que se embarca no pasara nunca por ella — y que
// importarla desde otra prueba arrastrara esta suite, cuyos
// `resetDeclarations()` vacían el registro de riesgo para el resto del
// proceso, dejando el programa real con cero declaraciones.
//
// Lo que se prueba aquí es que cada regla DETECTE lo suyo. Que el programa
// embarcado las cumpla lo comprueba auditoria-programa.spec.ts, contra el
// `program` real.
// ============================================================

/**
 * Builds a multi-token command the way Commander actually models one:
 * as nested subcommands. `.command('account list')` would declare a
 * command named "account" taking a positional argument, which is a
 * different thing entirely — and an easy mistake to make when writing
 * these, which is part of why the audit walks the real tree.
 */
function mk(program: Command, path: string): Command {
  let node = program;
  for (const token of path.split(' ')) {
    const existing = node.commands.find((c) => c.name() === token);
    node = existing ?? node.command(token).description(`${token}`);
  }
  return node;
}

describe('auditProgram — the rules it enforces', () => {
  it('accepts a command built from the kernel', () => {
    const program = new Command('mnemosine');
    withReadFlags(mk(program, 'account list'));
    expect(auditProgram(program)).toEqual([]);
  });

  it('rejects a verb outside the closed list', () => {
    const program = new Command('mnemosine');
    withReadFlags(mk(program, 'account fetch'));
    const v = auditProgram(program);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('R3 closed verb list');
    expect(v[0].detail).toMatch(/"fetch" is not a verb/);
  });

  it('rejects a plural noun', () => {
    const program = new Command('mnemosine');
    withReadFlags(mk(program, 'accounts list'));
    expect(auditProgram(program).some((x) => x.rule === 'R2 singular nouns')).toBe(true);
  });

  it('tolerates the plurals the repo already shipped', () => {
    const program = new Command('mnemosine');
    withReadFlags(mk(program, 'drafts list'));
    expect(auditProgram(program).some((x) => x.rule === 'R2 singular nouns')).toBe(false);
  });

  it('rejects a banned spelling', () => {
    const program = new Command('mnemosine');
    mk(program, 'entry post').option('--dryrun', 'nope');
    expect(auditProgram(program).some((x) => x.rule === 'R6 banned spelling')).toBe(true);
  });

  it('rejects -f, which reads as both --file and --force', () => {
    const program = new Command('mnemosine');
    mk(program, 'entry post').option('-f, --force', 'nope');
    expect(auditProgram(program).some((x) => x.rule === 'R6 -f is reserved')).toBe(true);
  });

  it('rejects a dictionary flag that drifted to another short form', () => {
    const program = new Command('mnemosine');
    mk(program, 'entry list').option('-l, --limit <n>', 'wrong short');
    expect(auditProgram(program).some((x) => x.rule === 'R6 short flag')).toBe(true);
  });

  it('requires a list command to be pageable and formattable', () => {
    const program = new Command('mnemosine');
    mk(program, 'entry list');
    const rules = auditProgram(program).filter((x) => x.rule === 'list contract').map((x) => x.detail);
    expect(rules).toEqual(['missing --limit', 'missing --format']);
  });

  it('requires depth to stay within three tokens', () => {
    const program = new Command('mnemosine');
    withReadFlags(mk(program, 'sat download request list'));
    expect(auditProgram(program).some((x) => x.rule === 'R1 depth')).toBe(true);
  });

  it('requires an irreversible command to carry its safety flags', () => {
    resetDeclarations();
    const program = new Command('mnemosine');
    const cmd = mk(program, 'entry post');
    declareRisk(cmd, { risk: 'irreversible' });
    // Simulate a hand-rolled command that lost one of its required flags.
    // Commander types `options` as a readonly property holding a readonly
    // array, so neither reassigning it nor splicing it typechecks as written;
    // both fail `npm run typecheck:tests`. The cast is confined to this one
    // line, and the mutation is what the simulation needs: the live array
    // auditProgram will walk loses --yes.
    const yesIndex = cmd.options.findIndex((o) => o.long === '--yes');
    (cmd.options as unknown as unknown[]).splice(yesIndex, 1);
    const risky = auditProgram(program).filter((x) => x.rule === 'R11 risk flags');
    expect(risky.map((x) => x.detail)).toEqual(['risk "irreversible" requires --yes']);
    resetDeclarations();
  });
});

describe('the verb table is a bijection', () => {
  it('maps every English verb to exactly one Spanish word, never shared', () => {
    const spanish = Object.values(VERBS);
    const duplicated = spanish.filter((w, i) => spanish.indexOf(w) !== i);
    expect(duplicated).toEqual([]);
  });

  it('has no empty or multi-word entries', () => {
    for (const [en, es] of Object.entries(VERBS)) {
      expect(en, `English verb "${en}"`).toMatch(/^[a-z][a-z-]*$/);
      expect(es, `Spanish alias for "${en}"`).toMatch(/^[a-zá-úñ][a-zá-úñ-]*$/);
    }
  });
});

describe('declareRisk refuses unsafe declarations at registration time', () => {
  it('refuses to give the agent an irreversible command', () => {
    resetDeclarations();
    const cmd = new Command('entry post');
    expect(() => declareRisk(cmd, { risk: 'irreversible', agent: true })).toThrow(
      /permission must never depend on the value of a flag/
    );
  });

  it('refuses to give the agent an external command', () => {
    resetDeclarations();
    const cmd = new Command('cfdi stamp');
    expect(() => declareRisk(cmd, { risk: 'externo', agent: true })).toThrow(/may never post to the ledger/);
  });

  it('refuses an agent write that does not assert draftOnly', () => {
    resetDeclarations();
    const cmd = new Command('entry create');
    expect(() => declareRisk(cmd, { risk: 'escritura', agent: true })).toThrow(/without asserting draftOnly/);
  });

  it('allows an agent write that lands in a review queue', () => {
    resetDeclarations();
    const cmd = new Command('entry create');
    expect(() => declareRisk(cmd, { risk: 'escritura', agent: true, draftOnly: true })).not.toThrow();
    expect(riskOf(cmd)?.agentAllowed).toBe(true);
  });

  it('applies the safety flags an irreversible command requires', () => {
    resetDeclarations();
    const cmd = new Command('entry post');
    declareRisk(cmd, { risk: 'irreversible' });
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--dry-run');
    expect(longs).toContain('--yes');
    expect(longs).toContain('--idempotency-key');
    expect(longs).not.toContain('--live');
  });

  it('adds the live gate only to external commands', () => {
    resetDeclarations();
    const cmd = new Command('cfdi stamp');
    declareRisk(cmd, { risk: 'externo' });
    expect(cmd.options.map((o) => o.long)).toContain('--live');
  });

  it('adds --reason to undo verbs', () => {
    resetDeclarations();
    const cmd = new Command('reverse');
    declareRisk(cmd, { risk: 'irreversible' });
    expect(cmd.options.map((o) => o.long)).toContain('--reason');
  });
});

describe('flag appliers stay inside the dictionary', () => {
  it('every flag the kernel applies is in FLAG_DICTIONARY', () => {
    const program = new Command('t');
    const cmd = withOutput(withSelection(withContext(program.command('account list'))));
    const unknown = cmd.options
      .map((o) => o.long)
      .filter((l): l is string => !!l && !Object.prototype.hasOwnProperty.call(FLAG_DICTIONARY, l));
    expect(unknown).toEqual([]);
  });
});
