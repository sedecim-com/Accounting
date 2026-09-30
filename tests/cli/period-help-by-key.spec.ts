import { afterEach, describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { program } from '../../src/cli/mnemosine.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import type { TranslationKey } from '../../src/i18n/index.js';
import { unkeyedDescriptions } from '../../scripts/language/lanes/help.js';

// ============================================================
// THE PILOT FAMILY OF #314: `mnemosine period --help` IN es-MX
//
// Acceptance of #314: with es-MX, `mnemosine <family> <leaf> --help` shows each
// description (command, option, argument) in Spanish, and each one comes from
// the catalog by key in the format decided on #152
// (help.<cmd>[.<sub>…].{description,option.<flag>,argument.<name>}, generic
// flags from cli.flag.*). `period` is the first family to meet it.
// ============================================================

afterEach(() => resetLanguage());

function family(name: string): Command {
  const cmd = program.commands.find((c) => c.name() === name);
  if (!cmd) throw new Error(`no family ${name}`);
  return cmd;
}

/** Every description the help screens of this subtree show, with its key. */
function describedIn(cmd: Command): Array<{ where: string; key: TranslationKey | null }> {
  const out: Array<{ where: string; key: TranslationKey | null }> = [];
  const walk = (node: Command, path: string): void => {
    if (node.description()) out.push({ where: `${path} (command)`, key: helpKeyOf(node) });
    for (const o of node.options) if (o.description) out.push({ where: `${path} ${o.flags}`, key: helpKeyOf(o) });
    for (const a of node.registeredArguments) {
      if (a.description) out.push({ where: `${path} <${a.name()}>`, key: helpKeyOf(a) });
    }
    for (const sub of node.commands) walk(sub, `${path} ${sub.name()}`);
  };
  walk(cmd, cmd.name());
  return out;
}

const KEY_FORMAT = /^help\.period(\.[a-z][a-z0-9_]*)*\.(description|option\.[a-z][a-z0-9_]*|argument\.[a-z][a-z0-9_]*)$/;

describe('mnemosine period, help by key (#314 pilot)', () => {
  it('the lane finds no description without key in the family', () => {
    expect(unkeyedDescriptions(program).filter((hit) => hit.family === 'period')).toEqual([]);
  });

  it('every description of the family has a key in the decided format, or a generic cli.* key', () => {
    const described = describedIn(family('period'));
    expect(described.length).toBeGreaterThan(10);
    for (const { where, key } of described) {
      expect(key, where).not.toBeNull();
      expect(key!.startsWith('cli.') || KEY_FORMAT.test(key!), `${where}: ${key}`).toBe(true);
    }
  });

  it('each leaf prints its command, option and argument descriptions in Spanish', () => {
    setLanguage('es');
    const period = family('period');
    // Commander wraps long descriptions, so compare with whitespace collapsed.
    const flat = (text: string): string => text.replace(/\s+/g, ' ');
    const leaf = (name: string): string => flat(period.commands.find((c) => c.name() === name)!.helpInformation());

    expect(flat(period.helpInformation())).toContain(t('help.period.description', {}, 'es'));
    expect(leaf('list')).toContain(t('help.period.list.option.year', {}, 'es'));
    expect(leaf('show')).toContain(t('help.period.show.argument.name', {}, 'es'));
    const open = leaf('open');
    expect(open).toContain(t('help.period.open.description', {}, 'es'));
    expect(open).toContain(t('help.period.open.option.reason', {}, 'es'));
    expect(open).toContain(t('cli.flag.dry_run', {}, 'es'));
    expect(leaf('reopen')).toContain(t('help.period.reopen.argument.name', {}, 'es'));
    for (const name of ['list', 'show', 'open', 'reopen']) {
      expect(leaf(name)).not.toContain(t(`help.period.${name}.description` as TranslationKey, {}, 'en'));
    }
  });

  it('the subcommand listing of `period --help` and the family row of `mnemosine --help` are in Spanish', () => {
    setLanguage('es');
    const flat = (text: string): string => text.replace(/\s+/g, ' ');
    const listing = flat(family('period').helpInformation());
    for (const name of ['list', 'show', 'open', 'reopen']) {
      expect(listing, name).toContain(t(`help.period.${name}.description` as TranslationKey, {}, 'es'));
    }
    expect(flat(program.helpInformation())).toContain(t('help.period.description', {}, 'es'));
  });
});
