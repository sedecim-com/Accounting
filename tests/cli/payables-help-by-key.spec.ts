import { afterEach, describe, expect, it } from 'vitest';
import { program } from '../../src/cli/mnemosine.js';
import { CLAVES_QUERY, MODOS_BANDEJA } from '../../src/cli/bill-command.js';
import { INCLUDABLE } from '../../src/cli/vendor-command.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { TAX_ID_TYPES } from '../../src/services/ap/vendor-service.js';
import { ESTADOS_DE_PASIVO } from '../../src/cli/payroll-isn-command.js';
import { CONVENCIONES_AMORTIZACION } from '../../src/services/accruals/amortization-math.js';
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
// `payment` (`payment trace` was keyed before it), `prepaid` and `tax-deposit`
// to FAMILIES, and with them the lane finds nothing left in payables.
// ============================================================

afterEach(() => resetLanguage());

/** Top-level family → the prefix of its keys. */
const FAMILIES: Record<string, string> = {
  bill: 'bill',
  vendor: 'vendor',
  payment: 'payment',
  prepaid: 'prepaid',
  'tax-deposit': 'tax_deposit',
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
    ['bill', 'help.bill.void.description'],
    ['bill void', 'help.bill.void.argument.bill'],
    ['bill void', 'help.bill.void.option.json'],
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
    // MNE-001-664: `vendor tax set`.
    ['vendor', 'help.vendor.tax.description'],
    ['vendor tax', 'help.vendor.tax.set.description'],
    ['vendor tax set', 'help.vendor.tax.set.option.tax_id'],
  ])('`%s --help` in es-MX shows %s in Spanish', (path, key) => {
    expectSpanishHelp(path, key);
  });

  it('the family rows of `mnemosine --help` are in Spanish', () => {
    setLanguage('es');
    const help = flat(program.helpInformation());
    for (const prefix of Object.values(FAMILIES)) {
      expect(help).toContain(t(`help.${prefix}.description` as TranslationKey, {}, 'es'));
    }
  });

  it('every generic flag a 238 leaf declares is worded for it and keeps a key of its own', () => {
    const own: Record<string, string[]> = {
      // «JSON output», not cli.flag.json («shorthand for --format json»): these leaves have no --format.
      'bill create': ['--json'],
      'bill approve': ['--json'],
      'bill void': ['--json'],
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

describe('payment, prepaid and tax-deposit, help by key (#314, MNE-001-239)', () => {
  // Every group screen and every leaf 239 keys, at least once.
  it.each<[string, TranslationKey]>([
    ['payment', 'help.payment.create.description'],
    ['payment', 'help.payment.reverse.description'],
    ['payment create', 'help.payment.create.argument.bill'],
    ['payment create', 'help.payment.create.option.amount'],
    ['payment create', 'help.payment.create.option.to_bank'],
    ['payment create', 'help.payment.create.option.memo'],
    ['payment apply', 'help.payment.apply.argument.payment'],
    ['payment apply', 'help.payment.apply.option.short_pay_reason'],
    ['payment unapply', 'help.payment.unapply.description'],
    ['payment unapply', 'help.payment.unapply.option.bill'],
    ['payment reverse', 'help.payment.reverse.option.date'],
    ['prepaid', 'help.prepaid.run.description'],
    ['prepaid create', 'help.prepaid.create.argument.description'],
    ['prepaid create', 'help.prepaid.create.option.origin'],
    ['prepaid create', 'help.prepaid.create.option.prepaid_account'],
    ['prepaid list', 'help.prepaid.list.option.all'],
    ['prepaid show', 'help.prepaid.show.argument.id_or_description'],
    ['prepaid run', 'help.prepaid.run.option.period'],
    ['tax-deposit', 'help.tax_deposit.list.description'],
    ['tax-deposit list', 'help.tax_deposit.list.option.until'],
    ['tax-deposit list', 'help.tax_deposit.list.option.all_entities'],
  ])('`%s --help` in es-MX shows %s in Spanish', (path, key) => {
    expectSpanishHelp(path, key);
  });

  it('every generic flag a 239 leaf declares is worded for it and keeps a key of its own', () => {
    const own: Record<string, string[]> = {
      // «JSON output», not cli.flag.json: these leaves have no --format.
      'payment create': ['--date', '--json'],
      'payment apply': ['--json'],
      // «why: it lands in the audit trail» is not cli.flag.reason's text.
      'payment unapply': ['--reason', '--date', '--json'],
      'payment reverse': ['--reason', '--date', '--json'],
      // The threshold's reason and the schedule's dry run.
      'prepaid create': ['--reason', '--dry-run'],
      // Declared by hand, not by withSelection, and -a voids -n: in doubt, per leaf.
      'prepaid list': ['--limit', '--offset', '--all', '--as-of'],
      'prepaid run': ['--period'],
      // -a and -s are withSelection's, reworded for this leaf through describeOption.
      'tax-deposit list': ['--status', '--all', '--period', '--until', '--all-entities'],
    };
    for (const [path, flags] of Object.entries(own)) {
      const prefix = `help.${path.replace(/ /g, '.').replace(/-/g, '_')}.option`;
      for (const flag of flags) expect(keyOf(path, flag), path).toBe(`${prefix}.${flag.slice(2).replace(/-/g, '_')}`);
    }
    // What the kernel adds stays on cli.flag.*.
    const injected = [
      keyOf('payment create', '--entity'),
      keyOf('payment create', '--yes'),
      keyOf('payment create', '--dry-run'),
      keyOf('payment create', '--idempotency-key'),
      keyOf('prepaid create', '--json'),
      keyOf('prepaid create', '--note'),
      keyOf('tax-deposit list', '--limit'),
      keyOf('tax-deposit list', '--offset'),
    ];
    expect(injected).toEqual([
      'cli.flag.entity',
      'cli.flag.yes',
      'cli.flag.dry_run',
      'cli.flag.idempotency_key',
      'cli.flag.json',
      'cli.flag.note',
      'cli.flag.limit',
      'cli.flag.offset',
    ]);
  });

  it('the amortisation conventions and the liability states travel as parameters', () => {
    expectSpanishHelp('prepaid create', 'help.prepaid.create.option.convention', {
      conventions: CONVENCIONES_AMORTIZACION.join('|'),
    });
    expectSpanishHelp('tax-deposit list', 'help.tax_deposit.list.option.status', { states: ESTADOS_DE_PASIVO.join('|') });
  });

  it('the mandatory options, the defaults and the parsers of their own are where they were', () => {
    const option = (path: string, long: string) => node(path).options.find((o) => o.long === long)!;
    expect(
      [
        option('payment create', '--amount'),
        option('payment unapply', '--bill'),
        option('payment unapply', '--reason'),
        option('payment reverse', '--reason'),
      ].map((o) => o.mandatory)
    ).toEqual([true, true, true, true]);
    expect(option('payment create', '--method').defaultValue).toBe('spei');
    expect(option('payment apply', '--mode').defaultValue).toBe('partial');
    for (const long of ['--bill', '--amount', '--discount']) {
      expect(option('payment apply', long).parseArg?.('y', ['x']), long).toEqual(['x', 'y']);
    }
    expect(option('prepaid list', '--limit').parseArg?.('3', undefined)).toBe(3);
    expect(() => option('prepaid list', '--offset').parseArg?.('-1', undefined)).toThrow(/non-negative/);
  });
});
