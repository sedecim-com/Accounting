import { afterEach, describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { program } from '../../src/cli/mnemosine.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import type { MessageParams, TranslationKey } from '../../src/i18n/index.js';
import { unkeyedDescriptions } from '../../scripts/language/lanes/help.js';

// ============================================================
// #314 (MNE-001-092): THE CLOSE AND CONTROL FAMILIES, HELP BY KEY IN es-MX
//
// Same acceptance as the `period` pilot: with es-MX, `mnemosine <family>
// <leaf> --help` shows every description (command, option, argument) in
// Spanish, and each one comes from the catalog by key in the format decided
// on #152 (help.<cmd>[.<sub>…].{description,option.<flag>,argument.<name>}).
// ============================================================

afterEach(() => resetLanguage());

/** Family name → the prefix of its keys (snake_case of the command name). */
const FAMILIES: Record<string, string> = {
  close: 'close',
  closing: 'closing',
  year: 'year',
  chart: 'chart',
  'opening-balance': 'opening_balance',
  ar: 'ar',
  ap: 'ap',
  cashflow: 'cashflow',
  depreciation: 'depreciation',
  diot: 'diot',
};

function node(path: string): Command {
  let cmd: Command = program;
  for (const name of path.split(' ')) {
    const next = cmd.commands.find((c) => c.name() === name);
    if (!next) throw new Error(`no command ${path}`);
    cmd = next;
  }
  return cmd;
}

/** Every description the help screens of this subtree show, with its key. */
function describedIn(cmd: Command): Array<{ where: string; key: TranslationKey | null }> {
  const out: Array<{ where: string; key: TranslationKey | null }> = [];
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

// Commander wraps long descriptions, so compare with whitespace collapsed.
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('close and control families, help by key (#314, MNE-001-092)', () => {
  it('the lane finds no description without key in any of these families', () => {
    const families = new Set(Object.keys(FAMILIES));
    expect(unkeyedDescriptions(program).filter((hit) => families.has(hit.family))).toEqual([]);
  });

  it.each(Object.entries(FAMILIES))('every description of %s has a key in the decided format', (name, prefix) => {
    const format = new RegExp(
      `^help\\.${prefix}(\\.[a-z][a-z0-9_]*)*\\.(description|option\\.[a-z][a-z0-9_]*|argument\\.[a-z][a-z0-9_]*)$`
    );
    for (const { where, key } of describedIn(node(name))) {
      expect(key, where).not.toBeNull();
      expect(key!.startsWith('cli.') || format.test(key!), `${where}: ${key}`).toBe(true);
    }
  });

  it.each<[string, TranslationKey, MessageParams?]>([
    ['close', 'help.close.option.hard'],
    ['closing', 'help.closing.description'],
    ['closing explain', 'help.closing.explain.argument.code', { codes: '' }],
    ['closing run', 'help.closing.run.option.resume'],
    ['closing pack generate', 'help.closing.pack.generate.option.output'],
    ['closing pack verify', 'help.closing.pack.verify.argument.file'],
    ['year create', 'help.year.create.argument.year'],
    ['chart import', 'help.chart.import.option.partial'],
    ['opening-balance import', 'help.opening_balance.import.option.subledger'],
    ['ar check', 'help.ar.check.option.strict'],
    ['ap reconcile', 'help.ap.reconcile.option.as_of'],
    ['cashflow reconcile', 'help.cashflow.reconcile.option.show_candidates'],
    ['depreciation post', 'help.depreciation.post.option.file'],
    ['diot export', 'help.diot.export.option.output'],
  ])('`%s --help` in es-MX shows %s in Spanish', (path, key, params) => {
    setLanguage('es');
    const help = flat(node(path).helpInformation());
    // A parameterised message is checked by its fixed head, before the list.
    const spanish = t(key, params ?? {}, 'es').replace(/:\s*$/, ':');
    const english = t(key, params ?? {}, 'en').replace(/:\s*$/, ':');
    expect(spanish).not.toBe(english);
    expect(help).toContain(spanish);
    expect(help).not.toContain(english);
  });

  it('close reuses the generic context flags cli.flag.* (owner decision on #152)', () => {
    const keys: Record<string, TranslationKey | null> = Object.fromEntries(
      node('close').options.map((o) => [o.long ?? o.flags, helpKeyOf(o)])
    );
    expect(keys['--entity']).toBe('cli.flag.entity');
    expect(keys['--tenant']).toBe('cli.flag.tenant_scope');
    expect(keys['--user']).toBe('cli.flag.user');
  });

  it('the Spanish DIOT family description keeps "de México" and the infinitive style of its siblings', () => {
    expect(t('help.diot.description', {}, 'es')).toBe(
      'DIOT de México: armar el mes a partir de operaciones pagadas, verificarlo y exportar el papel de trabajo'
    );
  });

  it('parameters survive the translation: the check codes and the dimensions are listed in Spanish help', () => {
    setLanguage('es');
    const explain = flat(node('closing explain').helpInformation());
    expect(explain).toMatch(/código de verificación, uno de: \S+/);
    const run = flat(node('depreciation run').helpInformation());
    expect(run).toMatch(/detalle o resumen: \S+.*\(asset es el detalle por activo\)/);
  });
});
