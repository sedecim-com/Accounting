import { afterEach, describe, expect, it } from 'vitest';
import { program } from '../../src/cli/mnemosine.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import type { TranslationKey } from '../../src/i18n/index.js';
import { describedIn, expectEveryKeyInFormat, flat, node, unkeyedInFamilies } from './helpers/help-by-key.js';

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

describe('mnemosine period, help by key (#314 pilot)', () => {
  it('the lane finds no description without key in the family', () => {
    expect(unkeyedInFamilies(['period'])).toEqual([]);
  });

  it('every description of the family has a key in the decided format, or a generic cli.* key', () => {
    const described = describedIn(node('period'));
    expect(described.length).toBeGreaterThan(10);
    expectEveryKeyInFormat(described, 'period');
  });

  it('each leaf prints its command, option and argument descriptions in Spanish', () => {
    setLanguage('es');
    const leaf = (name: string): string => flat(node(`period ${name}`).helpInformation());

    expect(flat(node('period').helpInformation())).toContain(t('help.period.description', {}, 'es'));
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
    const listing = flat(node('period').helpInformation());
    for (const name of ['list', 'show', 'open', 'reopen']) {
      expect(listing, name).toContain(t(`help.period.${name}.description` as TranslationKey, {}, 'es'));
    }
    expect(flat(program.helpInformation())).toContain(t('help.period.description', {}, 'es'));
  });
});
