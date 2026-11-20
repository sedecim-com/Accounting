import { afterEach, describe, expect, it } from 'vitest';
import { program } from '../../src/cli/mnemosine.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { RETIRED_OPTION_PREFIX } from '../../src/cli/kernel/index.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import type { MessageParams, TranslationKey } from '../../src/i18n/index.js';
import { ACCOUNT_TYPES, MAPPING_SCHEMES } from '../../src/services/accounting/account-service.js';
import { rolesValidos } from '../../src/services/accounting/account-roles-service.js';
import { LEDGER_CHECK_NAMES } from '../../src/services/accounting/ledger-checks.js';
import { CATEGORIAS_DE_HALLAZGO, CLASES_DE_LOTE } from '../../src/services/accounting/batch-service.js';
import { censar } from '../../scripts/ux-status.js';
import {
  describedIn,
  expectEveryKeyInFormat,
  expectSpanishHelp,
  flat,
  node,
  unkeyedInFamilies,
} from './helpers/help-by-key.js';

// ============================================================
// #314: THE LEDGER FAMILIES, HELP BY KEY IN es-MX, FAMILY BY FAMILY
//
// Same acceptance as the `period` pilot. The ledger series is keyed in three
// tasks: MNE-001-234 takes `account` and `ledger`, MNE-001-235 adds `entry`,
// and MNE-001-426 adds `batch` and `fx` (split from 235 by answer 2 on #314).
// ============================================================

afterEach(() => resetLanguage());

/** Family name → the prefix of its keys. */
const FAMILIES: Record<string, string> = {
  account: 'account',
  ledger: 'ledger',
  batch: 'batch',
  fx: 'fx',
};

/** The key of this leaf's option, or null when the leaf has no such flag. */
function keyOf(path: string, long: string): TranslationKey | null {
  const option = node(path).options.find((o) => o.long === long);
  return option ? helpKeyOf(option) : null;
}

describe('the ledger families, help by key (#314, MNE-001-234)', () => {
  it('the lane finds no description without key in these families', () => {
    expect(unkeyedInFamilies(Object.keys(FAMILIES))).toEqual([]);
  });

  it.each(Object.entries(FAMILIES))('every description of %s has a key in the decided format', (name, prefix) => {
    expectEveryKeyInFormat(describedIn(node(name)), prefix);
  });

  // Every group screen and every leaf at least once.
  it.each<[string, TranslationKey]>([
    ['account', 'help.account.description'],
    ['account', 'help.account.role.description'],
    ['account balance', 'help.account.balance.show.description'],
    ['account role', 'help.account.role.seed.description'],
    ['account map', 'help.account.map.check.description'],
    ['account list', 'help.account.list.option.parent'],
    ['account show', 'help.account.show.option.no_balance'],
    ['account create', 'help.account.create.option.normal_balance'],
    ['account create', 'help.account.create.option.header'],
    ['account create', 'help.account.create.option.json'],
    ['account edit', 'help.account.edit.option.fs_category'],
    ['account archive', 'help.account.archive.description'],
    ['account set', 'help.account.set.argument.pairs'],
    ['account balance show', 'help.account.balance.show.option.as_of'],
    ['account role list', 'help.account.role.list.option.qualifier'],
    ['account role set', 'help.account.role.set.option.qualifier'],
    ['account role seed', 'help.account.role.seed.description'],
    ['account role sync', 'help.account.role.sync.description'],
    ['account map set', 'help.account.map.set.option.year'],
    ['account map list', 'help.account.map.list.option.scheme'],
    ['account map import', 'help.account.map.import.argument.file'],
    ['account map check', 'help.account.map.check.option.check'],
    ['account restore', 'help.account.restore.option.reason'],
    ['ledger', 'help.ledger.description'],
    ['ledger stale-draft', 'help.ledger.stale_draft.list.description'],
    ['ledger auxiliary', 'help.ledger.auxiliary.show.description'],
    ['ledger balance', 'help.ledger.balance.description'],
    ['ledger check', 'help.ledger.check.option.account'],
    ['ledger stale-draft list', 'help.ledger.stale_draft.list.option.days'],
    ['ledger auxiliary show', 'help.ledger.auxiliary.show.option.period'],
    ['ledger balance show', 'help.ledger.balance.show.option.dim'],
  ])('`%s --help` in es-MX shows %s in Spanish', (path, key) => {
    expectSpanishHelp(path, key);
  });

  it('the family rows of `mnemosine --help` are in Spanish', () => {
    setLanguage('es');
    const root = flat(program.helpInformation());
    for (const prefix of Object.values(FAMILIES)) {
      expect(root, prefix).toContain(t(`help.${prefix}.description` as TranslationKey, {}, 'es'));
    }
  });

  it('every generic flag an account or ledger leaf declares is worded for it and keeps a key of its own', () => {
    const own: Record<string, string[]> = {
      'account create': ['--json'],
      'account archive': ['--dry-run'],
      'account set': ['--dry-run', '--reason'],
      'account balance show': ['--period', '--as-of'],
      'account role set': ['--note', '--dry-run'],
      'account map set': ['--dry-run'],
      'account map import': ['--dry-run', '--idempotency-key'],
      'account map check': ['--check'],
      'account restore': ['--reason'],
      'ledger check': ['--check', '--account', '--period'],
      'ledger stale-draft list': ['--period'],
      'ledger auxiliary show': ['--account', '--period'],
      'ledger balance show': ['--account', '--as-of', '--period'],
    };
    for (const [path, flags] of Object.entries(own)) {
      const prefix = `help.${path.replace(/ /g, '.').replace(/-/g, '_')}.option`;
      for (const flag of flags) expect(keyOf(path, flag), path).toBe(`${prefix}.${flag.slice(2).replace(/-/g, '_')}`);
    }
    // What the kernel adds is the kernel's and stays on cli.flag.*: `account
    // list --json` is the shorthand of the --format that leaf has.
    expect(['--force', '--reason', '--yes'].map((flag) => keyOf('account archive', flag))).toEqual([
      'cli.flag.force',
      'cli.flag.reason',
      'cli.flag.yes',
    ]);
    expect([keyOf('account list', '--json'), keyOf('account map check', '--strict')]).toEqual([
      'cli.flag.json',
      'cli.flag.strict',
    ]);
  });

  it('the interpolated lists travel as parameters, so the Spanish help lists them too', () => {
    const types = ACCOUNT_TYPES.join(', ');
    const schemes = Object.keys(MAPPING_SCHEMES).join(', ');
    const cases: Array<[string, TranslationKey, MessageParams]> = [
      ['account list', 'help.account.list.option.type', { types }],
      ['account create', 'help.account.create.option.type', { types }],
      ['account role set', 'help.account.role.set.argument.role', { roles: rolesValidos().slice(0, 6).join(', ') }],
      ['account map set', 'help.account.map.set.option.scheme', { schemes }],
      ['account map import', 'help.account.map.import.option.scheme', { schemes }],
      ['ledger check', 'help.ledger.check.option.check', { checks: LEDGER_CHECK_NAMES.join(', ') }],
    ];
    for (const [path, key, params] of cases) expectSpanishHelp(path, key, params);
  });

  it('the retired --level opens with the kernel marker in English, and with its own Spanish in es-MX', () => {
    // The tools read the marker from `option.description`, which is always English.
    const level = node('account map check').options.find((o) => o.long === '--level');
    expect(level?.description.startsWith(RETIRED_OPTION_PREFIX)).toBe(true);
    setLanguage('es');
    expect(flat(node('account map check').helpInformation())).not.toContain(RETIRED_OPTION_PREFIX);
    expectSpanishHelp('account map check', 'help.account.map.check.option.level');
  });
});

describe('the batch and fx families, help by key (#314, MNE-001-426)', () => {
  // Every group screen and every leaf at least once.
  it.each<[string, TranslationKey]>([
    ['batch', 'help.batch.description'],
    ['batch', 'help.batch.check.description'],
    ['batch list', 'help.batch.list.description'],
    ['batch show', 'help.batch.show.option.errors_only'],
    ['batch show', 'help.batch.show.argument.id'],
    ['batch check', 'help.batch.check.argument.id'],
    ['batch post', 'help.batch.post.option.partial'],
    ['batch post', 'help.batch.post.option.json'],
    ['batch reverse', 'help.batch.reverse.option.as_of'],
    ['batch reverse', 'help.batch.reverse.description'],
    ['fx', 'help.fx.description'],
    ['fx', 'help.fx.rate.description'],
    ['fx rate', 'help.fx.rate.download.description'],
    ['fx rate list', 'help.fx.rate.list.option.pair'],
    ['fx rate list', 'help.fx.rate.list.option.since'],
    ['fx rate show', 'help.fx.rate.show.argument.date'],
    ['fx rate show', 'help.fx.rate.show.option.source'],
    ['fx rate set', 'help.fx.rate.set.argument.rate'],
    ['fx rate set', 'help.fx.rate.set.option.dry_run'],
    ['fx rate set', 'help.fx.rate.set.option.until'],
    ['fx rate download', 'help.fx.rate.download.option.as_of'],
    ['fx rate download', 'help.fx.rate.download.option.source'],
  ])('`%s --help` in es-MX shows %s in Spanish', (path, key) => {
    expectSpanishHelp(path, key);
  });

  it('every generic flag a batch or fx leaf declares is worded for it and keeps a key of its own', () => {
    const own: Record<string, string[]> = {
      'batch post': ['--json'],
      'batch reverse': ['--as-of', '--json'],
      'fx rate list': ['--since', '--until'],
      'fx rate set': ['--until', '--dry-run'],
      'fx rate download': ['--as-of', '--since', '--until'],
    };
    for (const [path, flags] of Object.entries(own)) {
      const prefix = `help.${path.replace(/ /g, '.').replace(/-/g, '_')}.option`;
      for (const flag of flags) expect(keyOf(path, flag), path).toBe(`${prefix}.${flag.slice(2).replace(/-/g, '_')}`);
    }
    // `fx rate list --since` says the kernel's words, but the kernel's flag
    // validates the date at parse time (kernel/flags.ts) and this one does not:
    // not exactly what the kernel text promises, so per leaf, English intact.
    expect(t('help.fx.rate.list.option.since', {}, 'en')).toBe(t('cli.flag.since', {}, 'en'));
    // What the kernel adds is the kernel's and stays on cli.flag.*.
    expect(['--yes', '--dry-run', '--idempotency-key', '--reason'].map((flag) => keyOf('batch reverse', flag))).toEqual([
      'cli.flag.yes',
      'cli.flag.dry_run',
      'cli.flag.idempotency_key',
      'cli.flag.reason',
    ]);
    expect([keyOf('batch list', '--json'), keyOf('fx rate list', '--json'), keyOf('fx rate set', '--yes')]).toEqual([
      'cli.flag.json',
      'cli.flag.json',
      'cli.flag.yes',
    ]);
  });

  it('the interpolated lists travel as parameters, so the Spanish help lists them too', () => {
    expectSpanishHelp('batch list', 'help.batch.list.option.kind', { kinds: CLASES_DE_LOTE.join(', ') });
    expectSpanishHelp('batch check', 'help.batch.check.option.check', {
      categories: CATEGORIAS_DE_HALLAZGO.join(', '),
    });
  });

  it('the finding categories of `batch check --check` move as they are: values the user types, left for I23', () => {
    // The acceptance of MNE-001-426: `cuenta` is a value, not author prose, so
    // it is not translated in either language and ux-status keeps the node.
    const categories = 'parse, forma, cuenta, periodo, validacion';
    expect(CATEGORIAS_DE_HALLAZGO.join(', ')).toBe(categories);
    const check = node('batch check').options.find((o) => o.long === '--check');
    expect(check?.description).toBe(
      `finding categories to display, comma-separated (available: ${categories}); the full battery always runs`
    );
    setLanguage('es');
    expect(flat(node('batch check').helpInformation())).toContain(`(disponibles: ${categories})`);
    const flagged = censar(program).casos['nodos-fuera-del-idioma-canonico'].map((c) => c.sujeto);
    expect(flagged).toContain('batch check');
  });

  it('the machine contract does not move: flags in order, defaults, no parser, nothing mandatory', () => {
    const types = '<spot|average|budget|historical>';
    const sources = '<manual|dof|banco_mexico|ecb|fed|xe|openexchangerates>';
    expect(node('fx rate list').options.slice(-5).map((o) => o.flags)).toEqual([
      '--pair <pair>',
      '--since <date>',
      '--until <date>',
      `--rate-type ${types}`,
      `--source ${sources}`,
    ]);
    expect(node('fx rate show').options.slice(-2).map((o) => [o.flags, (o.defaultValue as unknown) ?? null, o.mandatory])).toEqual([
      [`--rate-type ${types}`, 'spot', false],
      [`--source ${sources}`, null, false],
    ]);
    expect(node('fx rate set').options.slice(3, 7).map((o) => [o.flags, (o.defaultValue as unknown) ?? null, o.mandatory])).toEqual([
      [`--source ${sources}`, null, false],
      [`--rate-type ${types}`, 'spot', false],
      ['--until <date>', null, false],
      ['--dry-run', null, false],
    ]);
    expect(node('fx rate download').options.slice(3, 7).map((o) => o.flags)).toEqual([
      '--source <dof|banxico-fix|fed|ecb>',
      '--as-of <date>',
      '--since <date>',
      '--until <date>',
    ]);
    // The leaves' date flags parse nothing at declaration; their actions check them.
    for (const [path, flags] of Object.entries({
      'fx rate list': ['--since', '--until'],
      'fx rate download': ['--as-of', '--since', '--until'],
      'batch reverse': ['--as-of'],
    })) {
      for (const flag of flags) {
        const o = node(path).options.find((x) => x.long === flag);
        expect(o && (o as { parseArg?: unknown }).parseArg, `${path} ${flag}`).toBeUndefined();
      }
    }
    expect(node('batch post').options.slice(3, 5).map((o) => o.flags)).toEqual(['--partial', '--json']);
    expect(node('batch reverse').options.slice(3, 5).map((o) => o.flags)).toEqual(['--as-of <date>', '--json']);
    expect(node('batch list').options.at(-1)?.flags).toBe('--kind <kind>');
    expect(node('batch show').options.at(-1)?.flags).toBe('--errors-only');
    for (const leaf of ['show', 'check', 'post', 'reverse']) {
      expect(node(`batch ${leaf}`).registeredArguments.map((a) => [a.name(), a.required]), leaf).toEqual([['id', true]]);
    }
    expect(node('fx rate set').registeredArguments.map((a) => a.name())).toEqual(['pair', 'date', 'rate']);
    expect(node('fx rate show').registeredArguments.map((a) => a.name())).toEqual(['pair', 'date']);
    expect([node('batch').aliases(), node('fx').aliases(), node('fx rate').aliases()]).toEqual([
      ['lote'],
      ['cambio'],
      ['tipo'],
    ]);
  });
});
