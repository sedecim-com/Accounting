import { afterEach, describe, expect, it } from 'vitest';
import { program } from '../../src/cli/mnemosine.js';
import { CLAVES_QUERY, MODOS_BANDEJA } from '../../src/cli/bill-command.js';
import { INCLUDABLE } from '../../src/cli/vendor-command.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { TAX_ID_TYPES } from '../../src/services/ap/vendor-service.js';
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
// #314: THE PAYABLES FAMILIES, HELP BY KEY IN es-MX, FAMILY BY FAMILY
//
// Same acceptance as the receivables spec, filtered by family because payables
// is keyed in two tasks: MNE-001-238 takes `bill` and `vendor` whole, their
// roots included (`bill rule` was keyed before it); MNE-001-239 adds
// `payment`, `prepaid` and `tax-deposit` to FAMILIES, and with them the lane
// finds nothing left in payables.
// ============================================================

afterEach(() => resetLanguage());

/** Top-level family → the prefix of its keys. */
const FAMILIES: Record<string, string> = {
  bill: 'bill',
  vendor: 'vendor',
};

/** The key of this leaf's option, or null when the leaf has no such flag. */
function keyOf(path: string, long: string): TranslationKey | null {
  const option = node(path).options.find((o) => o.long === long);
  return option ? helpKeyOf(option) : null;
}

describe('the payables families, help by key, family by family (#314, MNE-001-238 and 239)', () => {
  it('the lane finds nothing in these families, and each root has a key of its own', () => {
    expect(unkeyedInFamilies(Object.keys(FAMILIES))).toEqual([]);
    for (const [family, prefix] of Object.entries(FAMILIES)) {
      expect(helpKeyOf(node(family)) ?? 'no key', family).toMatch(keyFormat(prefix));
    }
  });

  it.each(Object.entries(FAMILIES))('every description of %s has a key in the decided format', (path, prefix) => {
    expectEveryKeyInFormat(describedIn(node(path)), prefix);
  });

  // Every group screen and every leaf 238 keys, at least once. `--1099` starts
  // with a digit, which a key segment cannot, so its keys say `is_1099`.
  it.each<[string, TranslationKey]>([
    ['bill', 'help.bill.description'],
    ['bill', 'help.bill.approve.description'],
    ['bill list', 'help.bill.list.argument.search'],
    ['bill list', 'help.bill.list.option.open'],
    ['bill show', 'help.bill.show.description'],
    ['bill show', 'help.bill.show.option.no_lines'],
    ['bill create', 'help.bill.create.description'],
    ['bill create', 'help.bill.create.option.vendor_invoice_number'],
    ['bill create', 'help.bill.create.option.line'],
    ['bill line', 'help.bill.line.description'],
    ['bill line', 'help.bill.line.set.description'],
    ['bill line set', 'help.bill.line.set.option.account'],
    ['bill approve', 'help.bill.approve.argument.bill'],
    ['bill approve', 'help.bill.approve.option.json'],
    ['bill inbox', 'help.bill.inbox.description'],
    ['bill inbox', 'help.bill.inbox.run.description'],
    ['bill inbox list', 'help.bill.inbox.list.description'],
    ['bill inbox list', 'help.bill.inbox.list.option.requires_approval'],
    ['bill inbox edit', 'help.bill.inbox.edit.argument.id'],
    ['bill inbox edit', 'help.bill.inbox.edit.option.line'],
    ['bill inbox run', 'help.bill.inbox.run.option.allow_new_vendor'],
    ['bill inbox run', 'help.bill.inbox.run.option.dry_run'],
    ['vendor', 'help.vendor.description'],
    ['vendor', 'help.vendor.terms.description'],
    ['vendor list', 'help.vendor.list.option.is_1099'],
    ['vendor list', 'help.vendor.list.option.no_tax_id'],
    ['vendor show', 'help.vendor.show.argument.vendor'],
    ['vendor create', 'help.vendor.create.description'],
    ['vendor create', 'help.vendor.create.option.default_account'],
    ['vendor edit', 'help.vendor.edit.description'],
    ['vendor edit', 'help.vendor.edit.option.reason'],
    ['vendor terms', 'help.vendor.terms.set.description'],
    ['vendor terms set', 'help.vendor.terms.set.option.currency'],
  ])('`%s --help` in es-MX shows %s in Spanish', (path, key) => {
    expectSpanishHelp(path, key);
  });

  it('the family rows of `mnemosine --help` are in Spanish', () => {
    setLanguage('es');
    const help = flat(program.helpInformation());
    expect(help).toContain(t('help.bill.description', {}, 'es'));
    expect(help).toContain(t('help.vendor.description', {}, 'es'));
  });

  it('every generic flag a 238 leaf declares is worded for it and keeps a key of its own', () => {
    const own: Record<string, string[]> = {
      // «JSON output», not cli.flag.json («shorthand for --format json»): these leaves have no --format.
      'bill create': ['--json'],
      'bill approve': ['--json'],
      // The reason is the rejection's, the note the approval's, and the dry run stops at «write nothing».
      'bill inbox run': ['--reason', '--note', '--dry-run', '--json'],
      'vendor create': ['--json'],
      // Optional here, so not cli.flag.reason, whose text ends in «(required)».
      'vendor edit': ['--reason'],
      'vendor terms set': ['--reason'],
    };
    for (const [path, flags] of Object.entries(own)) {
      const prefix = `help.${path.replace(/ /g, '.').replace(/-/g, '_')}.option`;
      for (const flag of flags) expect(keyOf(path, flag), path).toBe(`${prefix}.${flag.slice(2).replace(/-/g, '_')}`);
    }
    // What the kernel adds stays on cli.flag.*: withOutput's --json, withTime's --date-basis (whose default
    // `bill list` moves, not its text), and declareRisk's -y, --dry-run and --idempotency-key.
    const injected = [
      keyOf('bill list', '--json'),
      keyOf('bill list', '--date-basis'),
      keyOf('bill create', '--yes'),
      keyOf('bill approve', '--yes'),
      keyOf('bill approve', '--dry-run'),
      keyOf('bill approve', '--idempotency-key'),
      keyOf('vendor edit', '--yes'),
    ];
    expect(injected).toEqual([
      'cli.flag.json',
      'cli.flag.date_basis',
      'cli.flag.yes',
      'cli.flag.yes',
      'cli.flag.dry_run',
      'cli.flag.idempotency_key_unneeded',
      'cli.flag.yes',
    ]);
  });

  it('`bill approve --json` leaves cli.flag.json; the inbox -y and --idempotency-key enter cli.flag.*', () => {
    // #314, answer 3: the leaf has no --format, so «shorthand for --format json» was never true of it.
    expect(node('bill approve').options.some((o) => o.long === '--format')).toBe(false);
    expect(keyOf('bill approve', '--json')).toBe('help.bill.approve.option.json');
    expect(t('help.bill.approve.option.json', {}, 'en')).not.toBe(t('cli.flag.json', {}, 'en'));
    // Their English already was the kernel's, word for word, and each does exactly what it says.
    expect([keyOf('bill inbox run', '--yes'), keyOf('bill inbox run', '--idempotency-key')]).toEqual([
      'cli.flag.yes',
      'cli.flag.idempotency_key',
    ]);
  });

  it('the inbox modes, the query keys, the vendor sections, the tax id types and the JSON shape travel as parameters', () => {
    expectSpanishHelp('bill inbox list', 'help.bill.inbox.list.option.processing_mode', {
      modes: MODOS_BANDEJA.join(', '),
    });
    expectSpanishHelp('bill inbox run', 'help.bill.inbox.run.option.query', { keys: CLAVES_QUERY.join(', ') });
    expectSpanishHelp('vendor show', 'help.vendor.show.option.include', { parts: INCLUDABLE.join(', ') });
    expectSpanishHelp('vendor create', 'help.vendor.create.option.tax_id_type', { types: TAX_ID_TYPES.join(' | ') });
    expectSpanishHelp('bill create', 'help.bill.create.option.from_file', { shape: '{ lines: [...], ... }' });
  });

  it('`bill line set --line` is still mandatory, and the two defaults are where they were', () => {
    expect(node('bill line set').options.find((o) => o.long === '--line')?.mandatory).toBe(true);
    expect(node('bill inbox run').options.find((o) => o.long === '--action')?.defaultValue).toBe('process');
    expect(node('vendor create').options.find((o) => o.long === '--terms')?.defaultValue).toBe('Net 30');
  });
});
