import { afterEach, describe, expect, it } from 'vitest';
import { program } from '../../src/cli/mnemosine.js';
import { TAX_ID_TYPES } from '../../src/cli/customer-command.js';
import { CREDIT_NOTE_TYPES } from '../../src/database/enums.js';
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
// #314: THE RECEIVABLES FAMILIES, HELP BY KEY IN es-MX, FAMILY BY FAMILY
//
// Same acceptance as the bank spec, filtered by family because receivables is
// keyed in two tasks: MNE-001-236 takes `invoice` and `customer` whole, their
// roots included; MNE-001-237 adds `receipt`, `credit-note` and `rep` to
// FAMILIES, and with them the lane finds nothing left in receivables. The
// receipt leaves that 421, 422, 509, 511, 498, 567 and 570 keyed on their way
// are checked further down by those tasks' own tests.
// ============================================================

afterEach(() => resetLanguage());

/** Top-level family → the prefix of its keys. */
const FAMILIES: Record<string, string> = {
  invoice: 'invoice',
  customer: 'customer',
  receipt: 'receipt',
  'credit-note': 'credit_note',
  rep: 'rep',
};

/** The key of this leaf's option, or null when the leaf has no such flag. */
function keyOf(path: string, long: string): TranslationKey | null {
  const option = node(path).options.find((o) => o.long === long);
  return option ? helpKeyOf(option) : null;
}

describe('the receivables families, help by key, family by family (#314, MNE-001-236 and 237)', () => {
  it('the lane finds nothing in these families, and each root has a key of its own', () => {
    expect(unkeyedInFamilies(Object.keys(FAMILIES))).toEqual([]);
    for (const [family, prefix] of Object.entries(FAMILIES)) {
      expect(helpKeyOf(node(family)) ?? 'no key', family).toMatch(keyFormat(prefix));
    }
  });

  it.each(Object.entries(FAMILIES))('every description of %s has a key in the decided format', (path, prefix) => {
    expectEveryKeyInFormat(describedIn(node(path)), prefix);
  });

  it.each<[string, TranslationKey]>([
    ['invoice', 'help.invoice.description'],
    ['invoice', 'help.invoice.list.description'],
    ['invoice', 'help.invoice.issue.description'],
    ['invoice', 'help.invoice.series.description'],
    ['invoice list', 'help.invoice.list.argument.search'],
    ['invoice list', 'help.invoice.list.option.overdue_days'],
    ['invoice show', 'help.invoice.show.description'],
    ['invoice show', 'help.invoice.show.argument.ref'],
    ['invoice create', 'help.invoice.create.description'],
    ['invoice create', 'help.invoice.create.option.line'],
    ['invoice create', 'help.invoice.create.option.due_date'],
    ['invoice create', 'help.invoice.create.option.po_number'],
    ['invoice issue', 'help.invoice.issue.argument.ref'],
    ['invoice void', 'help.invoice.void.description'],
    ['invoice edit', 'help.invoice.edit.description'],
    ['invoice edit', 'help.invoice.edit.option.line'],
    ['invoice edit', 'help.invoice.edit.option.po_number'],
    ['invoice delete', 'help.invoice.delete.description'],
    ['invoice series', 'help.invoice.series.list.description'],
    ['invoice series', 'help.invoice.series.check.description'],
    ['invoice series check', 'help.invoice.series.check.option.year'],
    ['customer', 'help.customer.description'],
    ['customer', 'help.customer.archive.description'],
    ['customer', 'help.customer.tax.description'],
    ['customer list', 'help.customer.list.argument.query'],
    ['customer list', 'help.customer.list.option.balance_gt'],
    ['customer list', 'help.customer.list.option.inactive'],
    ['customer show', 'help.customer.show.description'],
    ['customer show', 'help.customer.show.argument.ref'],
    ['customer create', 'help.customer.create.description'],
    ['customer create', 'help.customer.create.option.tax_id'],
    ['customer create', 'help.customer.create.option.terms'],
    ['customer edit', 'help.customer.edit.description'],
    ['customer edit', 'help.customer.edit.option.notes'],
    ['customer edit', 'help.customer.edit.option.reason'],
    ['customer archive', 'help.customer.archive.argument.ref'],
    ['customer restore', 'help.customer.restore.description'],
    ['customer restore', 'help.customer.restore.option.reason'],
    ['customer tax', 'help.customer.tax.show.description'],
    ['customer tax', 'help.customer.tax.set.description'],
    ['customer tax show', 'help.customer.tax.show.argument.ref'],
    ['customer tax set', 'help.customer.tax.set.option.postal_code'],
    ['customer tax set', 'help.customer.tax.set.option.uso_cfdi'],
    ['customer tax list', 'help.customer.tax.list.description'],
    ['customer tax list', 'help.customer.tax.list.option.missing'],
  ])('`%s --help` in es-MX shows %s in Spanish', (path, key) => {
    expectSpanishHelp(path, key);
  });

  it('the family rows of `mnemosine --help` are in Spanish', () => {
    setLanguage('es');
    const help = flat(program.helpInformation());
    expect(help).toContain(t('help.invoice.description', {}, 'es'));
    expect(help).toContain(t('help.customer.description', {}, 'es'));
    expect(help).toContain(t('help.receipt.description', {}, 'es'));
    expect(help).toContain(t('help.credit_note.description', {}, 'es'));
    expect(help).toContain(t('help.rep.description', {}, 'es'));
  });

  // MNE-001-237: receipt, credit-note and rep, every leaf sampled.
  it.each<[string, TranslationKey]>([
    ['receipt', 'help.receipt.show.description'],
    ['receipt', 'help.receipt.list.description'],
    ['receipt', 'help.receipt.unapply.description'],
    ['receipt record', 'help.receipt.record.option.amount'],
    ['receipt record', 'help.receipt.record.option.method'],
    ['receipt record', 'help.receipt.record.option.bank'],
    ['receipt record', 'help.receipt.record.option.reference'],
    ['receipt show', 'help.receipt.show.argument.ref'],
    ['receipt list', 'help.receipt.list.option.unapplied'],
    ['receipt list', 'help.receipt.list.option.needs_rep'],
    ['receipt apply', 'help.receipt.apply.argument.ref'],
    ['receipt apply', 'help.receipt.apply.option.invoice'],
    ['receipt unapply', 'help.receipt.unapply.option.invoice'],
    ['receipt unapply', 'help.receipt.unapply.option.reason'],
    ['receipt reverse', 'help.receipt.reverse.argument.ref'],
    ['receipt reverse', 'help.receipt.reverse.option.fee'],
    ['credit-note', 'help.credit_note.create.description'],
    ['credit-note', 'help.credit_note.issue.description'],
    ['credit-note create', 'help.credit_note.create.option.tax'],
    ['credit-note create', 'help.credit_note.create.option.invoice'],
    ['credit-note create', 'help.credit_note.create.option.relates_to'],
    ['credit-note create', 'help.credit_note.create.option.date'],
    ['credit-note show', 'help.credit_note.show.description'],
    ['credit-note show', 'help.credit_note.show.argument.ref'],
    ['credit-note list', 'help.credit_note.list.description'],
    ['credit-note list', 'help.credit_note.list.option.open'],
    ['credit-note issue', 'help.credit_note.issue.argument.ref'],
    ['credit-note apply', 'help.credit_note.apply.description'],
    ['credit-note apply', 'help.credit_note.apply.option.invoice'],
    ['credit-note apply', 'help.credit_note.apply.option.dry_run'],
    ['rep', 'help.rep.missing.description'],
    ['rep', 'help.rep.reconcile.description'],
    ['rep missing', 'help.rep.missing.list.description'],
    ['rep missing list', 'help.rep.missing.list.option.direction'],
    ['rep missing list', 'help.rep.missing.list.option.min_amount'],
    ['rep reconcile', 'help.rep.reconcile.option.limit'],
    ['rep reconcile', 'help.rep.reconcile.option.dry_run'],
  ])('`%s --help` in es-MX shows %s in Spanish (237)', (path, key) => {
    expectSpanishHelp(path, key);
  });

  it('every generic flag a 237 leaf declares is worded for it and keeps a key of its own', () => {
    const own: Record<string, string[]> = {
      // «JSON output», not cli.flag.json («shorthand for --format json»): these leaves have no --format.
      'receipt record': ['--json', '--date'],
      'receipt apply': ['--json'],
      // It also lands in the ledger description, which cli.flag.reason does not say.
      'receipt unapply': ['--json', '--reason'],
      'receipt reverse': ['--json'],
      'credit-note create': ['--json', '--date'],
      'credit-note issue': ['--json'],
      // «run the real path and roll back», not cli.flag.dry_run's «compute and show the full effect».
      'credit-note apply': ['--json', '--dry-run'],
      // 50 parked REPs, not cli.flag.limit's «maximum rows to return».
      'rep reconcile': ['--limit', '--dry-run'],
    };
    for (const [path, flags] of Object.entries(own)) {
      const prefix = `help.${path.replace(/ /g, '.').replace(/-/g, '_')}.option`;
      for (const flag of flags) expect(keyOf(path, flag), path).toBe(`${prefix}.${flag.slice(2).replace(/-/g, '_')}`);
    }
    // What the kernel adds stays on cli.flag.*.
    const injected = [
      keyOf('receipt list', '--json'),
      keyOf('receipt show', '--json'),
      keyOf('credit-note list', '--json'),
      keyOf('rep missing list', '--json'),
      keyOf('rep missing list', '--limit'),
      keyOf('receipt record', '--yes'),
      keyOf('receipt record', '--dry-run'),
    ];
    expect(injected).toEqual([
      'cli.flag.json',
      'cli.flag.json',
      'cli.flag.json',
      'cli.flag.json',
      'cli.flag.limit',
      'cli.flag.yes',
      'cli.flag.dry_run',
    ]);
  });

  it('the credit note types travel as a parameter, so the Spanish shows them too', () => {
    const types = CREDIT_NOTE_TYPES.join(', ');
    expectSpanishHelp('credit-note create', 'help.credit_note.create.option.type', { types });
    expectSpanishHelp('credit-note list', 'help.credit_note.list.option.type', { types });
  });

  it('the 237 leaves keep their machine contract: mandatory options, defaults and variadic flags', () => {
    const option = (path: string, long: string) => node(path).options.find((o) => o.long === long);
    for (const [path, long] of [
      ['receipt record', '--amount'],
      ['receipt unapply', '--invoice'],
      ['receipt unapply', '--reason'],
      ['credit-note create', '--type'],
      ['credit-note create', '--amount'],
    ] as const) {
      expect(option(path, long)?.mandatory, `${path} ${long}`).toBe(true);
    }
    expect(option('receipt record', '--method')?.defaultValue).toBe('spei');
    expect(option('credit-note create', '--tax')?.defaultValue).toBe('0');
    expect(option('rep missing list', '--direction')?.defaultValue).toBe('received');
    expect(option('rep reconcile', '--limit')?.defaultValue).toBe('50');
    expect(option('rep reconcile', '--limit')?.short).toBe('-n');
    expect(option('receipt apply', '--invoice')?.variadic).toBe(true);
    expect(option('credit-note apply', '--invoice')?.variadic).toBe(true);
  });

  it('every generic flag a 236 leaf declares is worded for it and keeps a key of its own', () => {
    const own: Record<string, string[]> = {
      // «JSON output», not cli.flag.json («shorthand for --format json»): these leaves have no --format.
      'invoice create': ['--json'],
      'invoice issue': ['--json'],
      'invoice void': ['--json'],
      'invoice edit': ['--json'],
      'invoice delete': ['--json'],
      'invoice series check': ['--strict'],
      'customer create': ['--json'],
      // Optional here, so not cli.flag.reason, whose text ends in «(required)».
      'customer edit': ['--reason'],
      'customer restore': ['--reason'],
      'customer tax set': ['--reason', '--json'],
    };
    for (const [path, flags] of Object.entries(own)) {
      const prefix = `help.${path.replace(/ /g, '.').replace(/-/g, '_')}.option`;
      for (const flag of flags) expect(keyOf(path, flag), path).toBe(`${prefix}.${flag.slice(2).replace(/-/g, '_')}`);
    }
    // What the kernel adds stays on cli.flag.*: withOutput's --json, declareRisk's --reason, -y and --dry-run,
    // and withForce's --force.
    const injected = [
      keyOf('invoice list', '--json'),
      keyOf('invoice void', '--reason'),
      keyOf('invoice delete', '--reason'),
      keyOf('customer archive', '--reason'),
      keyOf('invoice create', '--yes'),
      keyOf('invoice issue', '--dry-run'),
      keyOf('customer archive', '--force'),
    ];
    expect(injected).toEqual([
      'cli.flag.json',
      'cli.flag.reason',
      'cli.flag.reason',
      'cli.flag.reason',
      'cli.flag.yes',
      'cli.flag.dry_run',
      'cli.flag.force',
    ]);
  });

  it('the tax id types and the RFC mask travel as parameters, so the Spanish shows them too', () => {
    const types = TAX_ID_TYPES.join(', ');
    expectSpanishHelp('customer create', 'help.customer.create.option.tax_id_type', { types });
    expectSpanishHelp('customer tax set', 'help.customer.tax.set.option.rfc', { shape: 'AAAA######XXX' });
  });

  // MNE-001-509 (#701): the reversal states its cause, and its help no longer speaks of a bounced cheque only.
  it.each<TranslationKey>(['help.receipt.reverse.description', 'help.receipt.reverse.option.cause'])(
    '`receipt reverse --help` shows %s in Spanish, and neither language says NSF', (key) => {
      expect(keyOf('receipt reverse', '--cause')).toBe('help.receipt.reverse.option.cause');
      expect(flat(node('receipt reverse').helpInformation())).not.toContain('NSF');
      expectSpanishHelp('receipt reverse', key);
      expect(flat(node('receipt reverse').helpInformation())).not.toContain('NSF');
    });

  // MNE-001-511 (#701): the leaf that states a cause afterwards is born with every description by key.
  it.each<[string, TranslationKey]>([
    ['receipt', 'help.receipt.cause.description'],
    ['receipt cause', 'help.receipt.cause.record.description'],
    ['receipt cause record', 'help.receipt.cause.record.argument.ref'],
    ['receipt cause record', 'help.receipt.cause.record.option.cause'],
    ['receipt cause record', 'cli.flag.reason'],
  ])('`%s --help` shows %s in Spanish', (path, key) => {
    expect(keyOf('receipt cause record', '--cause')).toBe('help.receipt.cause.record.option.cause');
    expect(keyOf('receipt cause record', '--reason')).toBe('cli.flag.reason');
    expect(keyOf('receipt cause record', '--json')).toBe('help.receipt.cause.record.option.json');
    expectSpanishHelp(path, key);
  });

  it('`invoice create --customer` is still mandatory', () => {
    expect(node('invoice create').options.find((o) => o.long === '--customer')?.mandatory).toBe(true);
  });
});
