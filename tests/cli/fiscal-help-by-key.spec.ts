import { afterEach, describe, expect, it } from 'vitest';
import { program } from '../../src/cli/mnemosine.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import type { TranslationKey } from '../../src/i18n/index.js';
import {
  describedIn,
  expectEveryKeyInFormat,
  expectSpanishHelp,
  flat,
  keyFormat,
  node,
  unkeyedInFamilies,
} from './helpers/help-by-key.js';

// ============================================================
// #314: THE FISCAL FAMILIES, HELP BY KEY IN es-MX, FAMILY BY FAMILY
//
// MNE-001-240 takes `cfdi`, `e-accounting` and `sat` whole, their roots
// included; the leaves that 054, 418, 442 and the sat download tasks keyed on
// their way (`cfdi post`, `e-accounting voucher|subledger|… seal`, `sat
// download|package|quota|census`) are checked by those tasks' own tests. The
// author prose in Castilian of `cfdi list --direction` and `cfdi status show
// --refresh` that #314's answer (a) gave to 240 already got its English with
// MNE-001-226 (#871), so here the English moves to en.ts as shown.
// ============================================================

afterEach(() => resetLanguage());

/** Top-level family → the prefix of its keys. */
const FAMILIES: Record<string, string> = {
  cfdi: 'cfdi',
  'e-accounting': 'e_accounting',
  sat: 'sat',
};

/** The key of this leaf's option, or null when the leaf has no such flag. */
function keyOf(path: string, long: string): TranslationKey | null {
  const option = node(path).options.find((o) => o.long === long);
  return option ? helpKeyOf(option) : null;
}

const option = (path: string, long: string) => node(path).options.find((o) => o.long === long);

describe('the fiscal families, help by key, family by family (#314, MNE-001-240)', () => {
  it('the lane finds nothing in these families, and each root has a key of its own', () => {
    expect(unkeyedInFamilies(Object.keys(FAMILIES))).toEqual([]);
    for (const [family, prefix] of Object.entries(FAMILIES)) {
      expect(helpKeyOf(node(family)) ?? 'no key', family).toMatch(keyFormat(prefix));
    }
  });

  it.each(Object.entries(FAMILIES))('every description of %s has a key in the decided format', (path, prefix) => {
    expectEveryKeyInFormat(describedIn(node(path)), prefix);
  });

  it('the family rows of `mnemosine --help` are in Spanish', () => {
    setLanguage('es');
    const help = flat(program.helpInformation());
    expect(help).toContain(t('help.cfdi.description', {}, 'es'));
    expect(help).toContain(t('help.e_accounting.description', {}, 'es'));
    expect(help).toContain(t('help.sat.description', {}, 'es'));
  });

  it.each<[string, TranslationKey]>([
    ['cfdi', 'help.cfdi.list.description'],
    ['cfdi', 'help.cfdi.show.description'],
    ['cfdi', 'help.cfdi.status.description'],
    ['cfdi', 'help.cfdi.explain.description'],
    ['cfdi list', 'help.cfdi.list.option.direction'],
    ['cfdi list', 'help.cfdi.list.option.type'],
    ['cfdi show', 'help.cfdi.show.argument.uuid'],
    ['cfdi status', 'help.cfdi.status.show.description'],
    ['cfdi status', 'help.cfdi.status.sync.description'],
    ['cfdi status show', 'help.cfdi.status.show.argument.uuid'],
    ['cfdi status show', 'help.cfdi.status.show.option.refresh'],
    ['cfdi status sync', 'help.cfdi.status.sync.option.limit'],
    ['cfdi status sync', 'help.cfdi.status.sync.option.stale_hours'],
    ['cfdi explain', 'help.cfdi.explain.argument.uuid'],
    ['e-accounting', 'help.e_accounting.catalog.description'],
    ['e-accounting', 'help.e_accounting.balance.description'],
    ['e-accounting catalog', 'help.e_accounting.catalog.generate.description'],
    ['e-accounting catalog generate', 'help.e_accounting.catalog.generate.option.output'],
    ['e-accounting catalog generate', 'help.e_accounting.catalog.generate.option.period'],
    ['e-accounting catalog generate', 'help.e_accounting.catalog.generate.option.dry_run'],
    ['e-accounting catalog generate', 'help.e_accounting.catalog.generate.option.yes'],
    ['e-accounting balance', 'help.e_accounting.balance.generate.description'],
    ['e-accounting balance', 'help.e_accounting.balance.check.description'],
    ['e-accounting balance generate', 'help.e_accounting.balance.generate.option.output'],
    ['e-accounting balance generate', 'help.e_accounting.balance.generate.option.period'],
    ['e-accounting balance generate', 'help.e_accounting.balance.generate.option.type'],
    ['e-accounting balance generate', 'help.e_accounting.balance.generate.option.closing'],
    ['e-accounting balance generate', 'help.e_accounting.balance.generate.option.modified'],
    ['e-accounting balance generate', 'help.e_accounting.balance.generate.option.dry_run'],
    ['e-accounting balance generate', 'help.e_accounting.balance.generate.option.yes'],
    ['e-accounting balance check', 'help.e_accounting.balance.check.option.period'],
    ['e-accounting balance check', 'help.e_accounting.balance.check.option.closing'],
    ['e-accounting balance check', 'help.e_accounting.balance.check.option.check'],
    ['sat', 'help.sat.cred.description'],
    ['sat cred', 'help.sat.cred.add.description'],
    ['sat cred', 'help.sat.cred.status.description'],
    ['sat cred', 'help.sat.cred.audit.description'],
    ['sat cred', 'help.sat.cred.revoke.description'],
    ['sat cred add', 'help.sat.cred.add.option.cer'],
    ['sat cred add', 'help.sat.cred.add.option.key'],
    ['sat cred add', 'help.sat.cred.add.option.entity'],
    ['sat cred add', 'help.sat.cred.add.option.user'],
    ['sat cred add', 'help.sat.cred.add.option.no_unattended'],
    ['sat cred add', 'help.sat.cred.add.option.max_diario'],
    ['sat cred status', 'help.sat.cred.status.option.entity'],
    ['sat cred audit', 'help.sat.cred.audit.option.entity'],
    ['sat cred audit', 'help.sat.cred.audit.option.limit'],
    ['sat cred revoke', 'help.sat.cred.revoke.option.entity'],
    ['sat cred revoke', 'help.sat.cred.revoke.option.user'],
  ])('`%s --help` in es-MX shows %s in Spanish', (path, key) => {
    expectSpanishHelp(path, key);
  });

  it('every generic flag a 240 leaf declares is worded for it and keeps a key of its own', () => {
    const own: Record<string, string[]> = {
      // «maximum CFDIs to consult in this run» (100), not cli.flag.limit's «maximum rows to return».
      'cfdi status sync': ['--limit'],
      // -o names the XML, not the rendered output: withOutput's flag reworded through describeOption.
      // --dry-run and -y are the leaf's own, about the archive and the overwrite prompt.
      'e-accounting catalog generate': ['--output', '--period', '--dry-run', '--yes'],
      'e-accounting balance generate': ['--output', '--period', '--dry-run', '--yes'],
      'e-accounting balance check': ['--period'],
      // «Legal entity», «Who grants the consent», «Who revokes», «How many events to show».
      'sat cred add': ['--entity', '--user'],
      'sat cred status': ['--entity'],
      'sat cred audit': ['--entity', '--limit'],
      'sat cred revoke': ['--entity', '--user'],
    };
    for (const [path, flags] of Object.entries(own)) {
      const prefix = `help.${path.replace(/ /g, '.').replace(/-/g, '_')}.option`;
      for (const flag of flags) expect(keyOf(path, flag), path).toBe(`${prefix}.${flag.slice(2).replace(/-/g, '_')}`);
    }
    // What the kernel adds stays on cli.flag.*.
    const injected = [
      keyOf('cfdi list', '--json'),
      keyOf('cfdi list', '--limit'),
      keyOf('cfdi show', '--output'),
      keyOf('cfdi status sync', '--dry-run'),
      keyOf('e-accounting balance check', '--json'),
      keyOf('sat cred add', '--yes'),
      keyOf('sat cred add', '--dry-run'),
      keyOf('sat cred revoke', '--reason'),
    ];
    expect(injected).toEqual([
      'cli.flag.json',
      'cli.flag.limit',
      'cli.flag.output',
      'cli.flag.dry_run',
      'cli.flag.json',
      'cli.flag.yes',
      'cli.flag.dry_run',
      'cli.flag.reason',
    ]);
  });

  it('the 240 leaves keep their machine contract: mandatory options, defaults, parsers and the negated flag', () => {
    expect(option('sat cred add', '--cer')?.mandatory).toBe(true);
    expect(option('sat cred add', '--key')?.mandatory).toBe(true);
    expect(option('sat cred add', '--entity')?.short).toBe('-e');
    expect(option('sat cred add', '--no-unattended')?.negate).toBe(true);
    expect(option('sat cred add', '--max-diario')?.parseArg?.('5', undefined)).toBe(5);
    expect(option('sat cred audit', '--limit')?.defaultValue).toBe(30);
    expect(option('sat cred audit', '--limit')?.parseArg?.('7', undefined)).toBe(7);
    expect(option('cfdi status sync', '--limit')?.defaultValue).toBe('100');
    expect(option('cfdi status sync', '--limit')?.short).toBe('-n');
    expect(option('cfdi status sync', '--stale-hours')?.defaultValue).toBe('24');
    expect(option('e-accounting balance generate', '--type')?.defaultValue).toBe('N');
    expect(option('e-accounting balance generate', '--output')?.short).toBe('-o');
    expect(option('e-accounting balance check', '--check')?.optional).toBe(true);
  });
});
