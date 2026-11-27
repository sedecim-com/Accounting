import { afterEach, describe, expect, it } from 'vitest';
import { program } from '../../src/cli/mnemosine.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import type { MessageParams, TranslationKey } from '../../src/i18n/index.js';
import { REPORTING_VIEWS } from '../../src/services/reporting/materialized-view-service.js';
import { DepreciationMethod } from '../../src/types/index.js';
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
// #314: THE REPORT AND ASSET FAMILIES, HELP BY KEY IN es-MX
//
// MNE-001-427 is the second part of the fiscal and reports task (240 took
// `cfdi`, `e-accounting` and `sat`): `report` and `asset` whole, their roots
// included. No node of these families is author prose in Castilian, so the
// English moves to en.ts as shown. The report headers and footnotes are
// output, keyed by E4.2 long before, and not part of this lane.
// ============================================================

afterEach(() => resetLanguage());

/** Top-level family → the prefix of its keys. */
const FAMILIES: Record<string, string> = {
  report: 'report',
  asset: 'asset',
};

const VIEWS: MessageParams = { views: REPORTING_VIEWS.join(', ') };
// MNE-001-881: the help offers what a registration takes, so units of
// production is not in the list (`asset create` refuses it by key).
const METHODS: MessageParams = {
  methods: Object.values(DepreciationMethod)
    .filter((m) => m !== DepreciationMethod.UNITS_OF_PRODUCTION)
    .join(', '),
};

const option = (path: string, long: string) => node(path).options.find((o) => o.long === long);

/** The key of this leaf's option, or null when the leaf has no such flag. */
function keyOf(path: string, long: string): TranslationKey | null {
  const found = option(path, long);
  return found ? helpKeyOf(found) : null;
}

describe('the report and asset families, help by key (#314, MNE-001-427)', () => {
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
    for (const prefix of Object.values(FAMILIES)) {
      expect(help).toContain(t(`help.${prefix}.description` as TranslationKey, {}, 'es'));
    }
  });

  it.each<[string, TranslationKey, MessageParams?]>([
    ['report', 'help.report.trial_balance.description'],
    ['report', 'help.report.balance_sheet.description'],
    ['report', 'help.report.income_statement.description'],
    ['report', 'help.report.general_ledger.description'],
    ['report', 'help.report.aged_receivable.description'],
    ['report', 'help.report.aged_payable.description'],
    ['report', 'help.report.view.description'],
    ['report trial-balance', 'help.report.trial_balance.show.description'],
    ['report trial-balance show', 'help.report.trial_balance.show.option.level'],
    ['report trial-balance show', 'help.report.trial_balance.show.option.exclude_zero'],
    ['report balance-sheet', 'help.report.balance_sheet.show.description'],
    ['report income-statement', 'help.report.income_statement.show.description'],
    ['report general-ledger', 'help.report.general_ledger.show.description'],
    ['report general-ledger show', 'help.report.general_ledger.show.option.account'],
    ['report aged-receivable', 'help.report.aged_receivable.show.description'],
    ['report aged-payable', 'help.report.aged_payable.show.description'],
    ['report view', 'help.report.view.show.description'],
    ['report view', 'help.report.view.sync.description'],
    ['report view sync', 'help.report.view.sync.option.view', VIEWS],
    ['report view sync', 'help.report.view.sync.option.no_concurrently'],
    ['asset', 'help.asset.create.description'],
    ['asset', 'help.asset.category.description'],
    ['asset create', 'help.asset.create.argument.name'],
    ['asset create', 'help.asset.create.option.category'],
    ['asset create', 'help.asset.create.option.cost'],
    ['asset create', 'help.asset.create.option.acquired'],
    ['asset create', 'help.asset.create.option.in_service'],
    ['asset create', 'help.asset.create.option.book'],
    ['asset create', 'help.asset.create.option.capitalized'],
    ['asset create', 'help.asset.create.option.source_entry'],
    ['asset create', 'help.asset.create.option.salvage'],
    ['asset create', 'help.asset.create.option.life_years'],
    ['asset create', 'help.asset.create.option.life_months'],
    ['asset create', 'help.asset.create.option.method', METHODS],
    ['asset create', 'help.asset.create.option.tax_method', METHODS],
    ['asset create', 'help.asset.create.option.asset_account'],
    ['asset create', 'help.asset.create.option.accum_account'],
    ['asset create', 'help.asset.create.option.expense_account'],
    ['asset create', 'help.asset.create.option.number'],
    ['asset create', 'help.asset.create.option.description'],
    ['asset create', 'help.asset.create.option.vendor'],
    ['asset create', 'help.asset.create.option.serial'],
    ['asset create', 'help.asset.create.option.location'],
    ['asset create', 'help.asset.create.option.dry_run'],
    ['asset category', 'help.asset.category.seed.description'],
  ])('`%s --help` in es-MX shows %s in Spanish', (path, key, params) => {
    expectSpanishHelp(path, key, params);
  });

  it('every generic flag a 427 leaf declares keeps a key of its own; what the kernel adds stays on cli.flag.*', () => {
    const own: Record<string, string[]> = {
      // «shows the asset that would be created» is not cli.flag.dry_run's
      // text, and the leaf declares it before declareRisk.
      'asset create': ['--dry-run', '--description'],
      'report trial-balance show': ['--level', '--exclude-zero'],
      'report general-ledger show': ['--account'],
      'report view sync': ['--view', '--no-concurrently'],
    };
    for (const [path, flags] of Object.entries(own)) {
      const prefix = `help.${path.replace(/-/g, '_').replace(/ /g, '.')}.option`;
      for (const flag of flags) expect(keyOf(path, flag), `${path} ${flag}`).toBe(`${prefix}.${flag.slice(2).replace(/-/g, '_')}`);
    }
    const injected = [
      keyOf('asset create', '--yes'),
      keyOf('asset create', '--note'),
      keyOf('asset create', '--json'),
      keyOf('asset category seed', '--yes'),
      keyOf('report trial-balance show', '--period'),
      keyOf('report trial-balance show', '--limit'),
      keyOf('report aged-payable show', '--as-of'),
      keyOf('report view show', '--all'),
      keyOf('report view sync', '--yes'),
    ];
    expect(injected).toEqual([
      'cli.flag.yes',
      'cli.flag.note',
      'cli.flag.json',
      'cli.flag.yes',
      'cli.flag.period',
      'cli.flag.limit',
      'cli.flag.as_of',
      'cli.flag.all',
      'cli.flag.yes',
    ]);
  });

  it('the 427 leaves keep their machine contract: parsers, the variadic and negated flags, argument arity', () => {
    expect(option('asset create', '--life-years')?.parseArg?.('5', undefined)).toBe(5);
    expect(option('asset create', '--life-months')?.parseArg?.('18', undefined)).toBe(18);
    expect(() => option('asset create', '--life-years')?.parseArg?.('0', undefined)).toThrow(/--life-years/);
    expect(option('report view sync', '--view')?.variadic).toBe(true);
    expect(option('report view sync', '--no-concurrently')?.negate).toBe(true);
    expect(option('report view sync', '--no-concurrently')?.attributeName()).toBe('concurrently');
    expect(node('asset create').registeredArguments.map((a) => [a.name(), a.required])).toEqual([['name', true]]);
    // The two aging groups share registerAging; each keeps its own name and alias.
    expect(node('report aged-receivable').aliases()).toEqual(['antiguedad-cobrar']);
    expect(node('report aged-payable').aliases()).toEqual(['antiguedad-pagar']);
  });
});
