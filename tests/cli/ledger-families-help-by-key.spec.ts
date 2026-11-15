import { afterEach, describe, expect, it } from 'vitest';
import { program } from '../../src/cli/mnemosine.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { RETIRED_OPTION_PREFIX } from '../../src/cli/kernel/index.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import type { MessageParams, TranslationKey } from '../../src/i18n/index.js';
import { ACCOUNT_TYPES, MAPPING_SCHEMES } from '../../src/services/accounting/account-service.js';
import { rolesValidos } from '../../src/services/accounting/account-roles-service.js';
import { LEDGER_CHECK_NAMES } from '../../src/services/accounting/ledger-checks.js';
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
// Same acceptance as the `period` pilot. The ledger series is keyed in two
// tasks: MNE-001-234 takes `account` and `ledger`; MNE-001-235 adds `entry`,
// `batch` and `fx` to FAMILIES.
// ============================================================

afterEach(() => resetLanguage());

/** Family name → the prefix of its keys. */
const FAMILIES: Record<string, string> = {
  account: 'account',
  ledger: 'ledger',
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
