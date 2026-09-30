import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { program } from '../../../src/cli/mnemosine.js';
import { riskOf, declareRisk, resetDeclarations } from '../../../src/cli/kernel/risk.js';
import { hojasDe } from '../../../src/cli/kernel/riesgos-retrofit.js';
import { auditProgram } from '../../../src/cli/kernel/audit.js';

/**
 * `--yes` IS ONE RULE, NOT A PER-COMMAND HABIT (#327, MNE-001-088).
 *
 * The kernel injected `-y, --yes` only into irreversible and external leaves,
 * so a script that passed `--yes` to every write crashed on the reversible
 * ones: `account map import`, `rep reconcile` and `asset create` answered
 * "unknown option '--yes'". The catalog's dictionary (docs/cli-command-catalog.md
 * §3) makes `-y/--yes` universal; the kernel now applies it to every mutation.
 */
describe('--yes on every mutation', () => {
  const leaves = hojasDe(program);

  it('the three commands named in #327 accept --yes', () => {
    for (const path of ['account map import', 'rep reconcile', 'asset create']) {
      const leaf = leaves.find((h) => h.ruta === path);
      expect(leaf, `${path} is not in the program`).toBeDefined();
      expect(riskOf(leaf!.cmd)?.risk).not.toBe('lectura');
      expect(leaf!.cmd.options.map((o) => o.long), path).toContain('--yes');
    }
  });

  it('every leaf that declares a write carries -y, --yes', () => {
    const writes = leaves.filter((h) => {
      const r = riskOf(h.cmd);
      return r !== undefined && r.risk !== 'lectura';
    });
    expect(writes.length).toBeGreaterThan(50);
    const missing = writes
      .filter((h) => !h.cmd.options.some((o) => o.long === '--yes' && o.short === '-y'))
      .map((h) => h.ruta);
    expect(missing).toEqual([]);
  });

  it('a reversible write accepts --yes and -y at parse time', async () => {
    resetDeclarations();
    const p = new Command('t').exitOverride();
    let seen: Record<string, unknown> = {};
    const leaf = p.command('thing').command('set');
    declareRisk(leaf, { risk: 'escritura' });
    leaf.action((opts: Record<string, unknown>) => {
      seen = opts;
    });
    await p.parseAsync(['node', 't', 'thing', 'set', '--yes']);
    expect(seen.yes).toBe(true);
    await p.parseAsync(['node', 't', 'thing', 'set', '-y']);
    expect(seen.yes).toBe(true);
  });

  it('a read does not grow --yes', () => {
    resetDeclarations();
    const leaf = new Command('list');
    declareRisk(leaf, { risk: 'lectura', agent: true });
    expect(leaf.options.map((o) => o.long)).not.toContain('--yes');
  });

  it('the auditor flags a write that drops --yes after declaring', () => {
    resetDeclarations();
    const p = new Command('mnemosine');
    const leaf = p.command('widget').command('create').description('create a widget');
    declareRisk(leaf, { risk: 'escritura' });
    // Commander types `options` as readonly; the cast is confined to this line.
    const i = leaf.options.findIndex((o) => o.long === '--yes');
    (leaf.options as unknown as unknown[]).splice(i, 1);
    const v = auditProgram(p).filter((x) => x.rule === 'R11 yes');
    expect(v.map((x) => x.command)).toEqual(['widget create']);
  });
});
