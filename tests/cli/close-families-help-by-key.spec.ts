import { afterEach, describe, expect, it } from 'vitest';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import type { MessageParams, TranslationKey } from '../../src/i18n/index.js';
import {
  describedIn,
  expectEveryKeyInFormat,
  expectSpanishHelp,
  flat,
  node,
  unkeyedInFamilies,
} from './helpers/help-by-key.js';

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

describe('close and control families, help by key (#314, MNE-001-092)', () => {
  it('the lane finds no description without key in any of these families', () => {
    expect(unkeyedInFamilies(Object.keys(FAMILIES))).toEqual([]);
  });

  it.each(Object.entries(FAMILIES))('every description of %s has a key in the decided format', (name, prefix) => {
    expectEveryKeyInFormat(describedIn(node(name)), prefix);
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
    ['opening-balance import', 'help.opening_balance.import.option.chart'],
    ['opening-balance check', 'help.opening_balance.check.option.chart'],
    ['ar check', 'help.ar.check.option.strict'],
    ['ap reconcile', 'help.ap.reconcile.option.as_of'],
    ['cashflow reconcile', 'help.cashflow.reconcile.option.show_candidates'],
    ['depreciation post', 'help.depreciation.post.option.file'],
    ['diot export', 'help.diot.export.option.output'],
  ])('`%s --help` in es-MX shows %s in Spanish', (path, key, params) => {
    expectSpanishHelp(path, key, params);
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
