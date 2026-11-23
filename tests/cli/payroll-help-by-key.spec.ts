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
// #314: THE PAYROLL FAMILIES, HELP BY KEY IN es-MX, FAMILY BY FAMILY
//
// MNE-001-241 takes `employee`, `garnishment`, `isn` and `payroll` whole,
// their roots included. `tax-deposit` shares `payroll-isn-command.ts` but is
// MNE-001-239's, checked by `payables-help-by-key.spec.ts`. No node of these
// families is author prose in Castilian, so the English moves to en.ts as
// shown.
// ============================================================

afterEach(() => resetLanguage());

/** Top-level family → the prefix of its keys. */
const FAMILIES: Record<string, string> = {
  employee: 'employee',
  garnishment: 'garnishment',
  isn: 'isn',
  payroll: 'payroll',
};

const option = (path: string, long: string) => node(path).options.find((o) => o.long === long);

/** The key of this leaf's option, or null when the leaf has no such flag. */
function keyOf(path: string, long: string): TranslationKey | null {
  const found = option(path, long);
  return found ? helpKeyOf(found) : null;
}

describe('the payroll families, help by key, family by family (#314, MNE-001-241)', () => {
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

  it.each<[string, TranslationKey]>([
    ['employee', 'help.employee.create.description'],
    ['employee', 'help.employee.show.description'],
    ['employee', 'help.employee.list.description'],
    ['employee create', 'help.employee.create.option.file'],
    ['employee create', 'help.employee.create.option.country'],
    ['employee create', 'help.employee.create.option.hire_date'],
    ['employee create', 'help.employee.create.option.pay_schedule'],
    ['employee create', 'help.employee.create.option.dry_run'],
    ['employee show', 'help.employee.show.argument.employee'],
    ['employee show', 'help.employee.show.option.redacted'],
    ['employee list', 'help.employee.list.option.country'],
    ['garnishment', 'help.garnishment.record.description'],
    ['garnishment', 'help.garnishment.list.description'],
    ['garnishment', 'help.garnishment.archive.description'],
    ['garnishment record', 'help.garnishment.record.argument.employee'],
    ['garnishment record', 'help.garnishment.record.option.type'],
    ['garnishment record', 'help.garnishment.record.option.amount'],
    ['garnishment record', 'help.garnishment.record.option.percent_disposable'],
    ['garnishment record', 'help.garnishment.record.option.percent_gross'],
    ['garnishment record', 'help.garnishment.record.option.priority'],
    ['garnishment record', 'help.garnishment.record.option.case'],
    ['garnishment record', 'help.garnishment.record.option.court'],
    ['garnishment record', 'help.garnishment.record.option.payee'],
    ['garnishment record', 'help.garnishment.record.option.start'],
    ['garnishment record', 'help.garnishment.record.option.exempt_amount'],
    ['garnishment record', 'help.garnishment.record.option.supports_second_family'],
    ['garnishment record', 'help.garnishment.record.option.arrears_12wk'],
    ['garnishment record', 'help.garnishment.record.option.dry_run'],
    ['garnishment list', 'help.garnishment.list.argument.employee'],
    ['garnishment list', 'help.garnishment.list.option.type'],
    ['garnishment archive', 'help.garnishment.archive.argument.id'],
    ['garnishment archive', 'help.garnishment.archive.option.as_of'],
    ['isn', 'help.isn.rate.description'],
    ['isn', 'help.isn.calculate.description'],
    ['isn rate', 'help.isn.rate.set.description'],
    ['isn rate', 'help.isn.rate.list.description'],
    ['isn rate set', 'help.isn.rate.set.argument.state'],
    ['isn rate set', 'help.isn.rate.set.argument.rate'],
    ['isn rate set', 'help.isn.rate.set.option.effective_from'],
    ['isn rate set', 'help.isn.rate.set.option.superseded_on'],
    ['isn rate set', 'help.isn.rate.set.option.legal_basis'],
    ['isn rate set', 'help.isn.rate.set.option.regime'],
    ['isn rate set', 'help.isn.rate.set.option.exemption'],
    ['isn rate set', 'help.isn.rate.set.option.dry_run'],
    ['isn rate set', 'help.isn.rate.set.option.yes'],
    ['isn rate list', 'help.isn.rate.list.option.limit'],
    ['isn rate list', 'help.isn.rate.list.option.offset'],
    ['isn rate list', 'help.isn.rate.list.option.all'],
    ['isn rate list', 'help.isn.rate.list.option.state'],
    ['isn rate list', 'help.isn.rate.list.option.as_of'],
    ['isn calculate', 'help.isn.calculate.option.run'],
    ['isn calculate', 'help.isn.calculate.option.state'],
    ['payroll', 'help.payroll.accrue.description'],
    ['payroll accrue', 'help.payroll.accrue.option.period'],
  ])('`%s --help` in es-MX shows %s in Spanish', (path, key) => {
    expectSpanishHelp(path, key);
  });

  it('every generic flag a 241 leaf declares keeps a key of its own; what the kernel adds stays on cli.flag.*', () => {
    const own: Record<string, string[]> = {
      // «roll it back: nothing is saved», «shows the order and the cascade it
      // would join», «and who it reaches»: none is cli.flag.dry_run's text.
      'employee create': ['--dry-run'],
      'garnishment record': ['--dry-run'],
      // Declared by the leaf before declareRisk: its -y is the leaf's own.
      'isn rate set': ['--dry-run', '--yes'],
      // Declared by hand instead of withSelection, with the leaf's own parser;
      // -a lifts the --as-of window, it does not include archived rows.
      'isn rate list': ['--limit', '--offset', '--all', '--state', '--as-of'],
      'isn calculate': ['--state'],
      'garnishment archive': ['--as-of'],
      'payroll accrue': ['--period'],
    };
    for (const [path, flags] of Object.entries(own)) {
      const prefix = `help.${path.replace(/ /g, '.')}.option`;
      for (const flag of flags) expect(keyOf(path, flag), `${path} ${flag}`).toBe(`${prefix}.${flag.slice(2).replace(/-/g, '_')}`);
    }
    const injected = [
      keyOf('employee create', '--yes'),
      keyOf('employee list', '--limit'),
      keyOf('garnishment record', '--note'),
      keyOf('garnishment list', '--all'),
      keyOf('garnishment archive', '--reason'),
      keyOf('isn rate list', '--json'),
      keyOf('isn calculate', '--strict'),
      keyOf('payroll accrue', '--dry-run'),
    ];
    expect(injected).toEqual([
      'cli.flag.yes',
      'cli.flag.limit',
      'cli.flag.note',
      'cli.flag.all',
      'cli.flag.reason',
      'cli.flag.json',
      'cli.flag.strict',
      'cli.flag.dry_run',
    ]);
  });

  it('the 241 leaves keep their machine contract: parsers, the default, short flags and argument arity', () => {
    expect(option('garnishment record', '--priority')?.parseArg?.('3', undefined)).toBe(3);
    expect(option('isn rate list', '--limit')?.short).toBe('-n');
    expect(option('isn rate list', '--limit')?.parseArg?.('7', undefined)).toBe(7);
    expect(option('isn rate list', '--offset')?.parseArg?.('2', undefined)).toBe(2);
    expect(option('isn rate list', '--all')?.short).toBe('-a');
    expect(option('isn rate set', '--regime')?.defaultValue).toBe('tasa_plana');
    expect(option('isn rate set', '--yes')?.short).toBe('-y');
    expect(node('garnishment list').registeredArguments[0]?.required).toBe(false);
    expect(node('isn rate set').registeredArguments.map((a) => a.name())).toEqual(['state', 'rate']);
  });
});
