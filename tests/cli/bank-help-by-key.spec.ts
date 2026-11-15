import { afterEach, describe, expect, it } from 'vitest';
import { program } from '../../src/cli/mnemosine.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import type { TranslationKey } from '../../src/i18n/index.js';
import { MATCHED_ENTITY_TYPES } from '../../src/database/enums.js';
import { MOTIVOS_DESAPLICACION } from '../../src/services/banking/match-service.js';
import { STATEMENT_CHECK_NAMES } from '../../src/services/banking/statement-checks.js';
import {
  describedIn,
  expectEveryKeyInFormat,
  expectSpanishHelp,
  flat,
  keyFormat,
  node,
  unkeyedAt,
  unkeyedUnder,
} from './helpers/help-by-key.js';

// ============================================================
// #314: THE BANK FAMILY, HELP BY KEY IN es-MX, BY SUBCOMMAND GROUP
//
// Same acceptance as the `period` pilot, filtered by command path because the
// family is keyed in three tasks: MNE-001-231 takes `account`, `statement` and
// `transaction`, and the root's own description; MNE-001-232 takes `match`,
// `fee`, `interest`, `check` and `book-item`; 233 adds its groups.
// ============================================================

afterEach(() => resetLanguage());

/** Subcommand group → the prefix of its keys. */
const GROUPS: Record<string, string> = {
  'bank account': 'bank.account',
  'bank statement': 'bank.statement',
  'bank transaction': 'bank.transaction',
  'bank match': 'bank.match',
  'bank fee': 'bank.fee',
  'bank interest': 'bank.interest',
  'bank check': 'bank.check',
  'bank book-item': 'bank.book_item',
};

/** The key of this leaf's option, or null when the leaf has no such flag. */
function keyOf(path: string, long: string): TranslationKey | null {
  const option = node(path).options.find((o) => o.long === long);
  return option ? helpKeyOf(option) : null;
}

describe('the bank family, help by key, group by group (#314, MNE-001-231 and 232)', () => {
  it('the lane finds nothing in these groups, nor in what the bank root shows of its own', () => {
    expect(unkeyedUnder(Object.keys(GROUPS))).toEqual([]);
    expect(unkeyedAt(['bank'])).toEqual([]);
    expect(helpKeyOf(node('bank')) ?? 'no key').toMatch(keyFormat('bank'));
  });

  it.each(Object.entries(GROUPS))('every description of %s has a key in the decided format', (path, prefix) => {
    expectEveryKeyInFormat(describedIn(node(path)), prefix);
  });

  it.each<[string, TranslationKey]>([
    ['bank', 'help.bank.description'],
    ['bank', 'help.bank.account.description'],
    ['bank', 'help.bank.statement.description'],
    ['bank', 'help.bank.transaction.description'],
    ['bank account create', 'help.bank.account.create.option.type'],
    ['bank account list', 'help.bank.account.list.argument.query'],
    ['bank account show', 'help.bank.account.show.option.redacted'],
    ['bank account edit', 'help.bank.account.edit.option.reason'],
    ['bank account set', 'help.bank.account.set.description'],
    ['bank statement', 'help.bank.statement.import.description'],
    ['bank statement import', 'help.bank.statement.import.option.format'],
    ['bank statement list', 'help.bank.statement.list.option.until'],
    ['bank statement show', 'help.bank.statement.show.option.limit'],
    ['bank statement check', 'help.bank.statement.check.argument.id'],
    ['bank transaction', 'help.bank.transaction.list.description'],
    ['bank transaction list', 'help.bank.transaction.list.argument.query'],
    ['bank transaction show', 'help.bank.transaction.show.option.raw'],
    ['bank transaction reclassify', 'help.bank.transaction.reclassify.description'],
    ['bank', 'help.bank.book_item.description'],
    ['bank', 'help.bank.match.description'],
    ['bank', 'help.bank.fee.description'],
    ['bank', 'help.bank.interest.description'],
    ['bank', 'help.bank.check.description'],
    ['bank book-item', 'help.bank.book_item.list.description'],
    ['bank book-item list', 'help.bank.book_item.list.argument.account'],
    ['bank book-item list', 'help.bank.book_item.list.option.over_days'],
    ['bank match', 'help.bank.match.unapply.description'],
    ['bank match preview', 'help.bank.match.preview.argument.tx_id'],
    ['bank match preview', 'help.bank.match.preview.option.min_confidence'],
    ['bank match run', 'help.bank.match.run.description'],
    ['bank match run', 'help.bank.match.run.option.max_amount'],
    ['bank match apply', 'help.bank.match.apply.option.stdin'],
    ['bank match create', 'help.bank.match.create.option.residual'],
    ['bank match unapply', 'help.bank.match.unapply.argument.match_id'],
    ['bank fee post', 'help.bank.fee.post.option.iva_rate'],
    ['bank interest', 'help.bank.interest.post.description'],
    ['bank interest post', 'help.bank.interest.post.option.rate'],
    ['bank check reconcile', 'help.bank.check.reconcile.option.as_of'],
  ])('`%s --help` in es-MX shows %s in Spanish', (path, key) => {
    expectSpanishHelp(path, key);
  });

  it('the family row of `mnemosine --help` is in Spanish', () => {
    setLanguage('es');
    expect(flat(program.helpInformation())).toContain(t('help.bank.description', {}, 'es'));
  });

  it('a generic flag worded for its leaf keeps a key of its own; -y of `bank account edit` is the kernel one', () => {
    const withReason = ['bank account edit', 'bank account set', 'bank transaction reclassify'];
    for (const path of ['bank account create', 'bank statement import', ...withReason]) {
      const prefix = `help.${path.replace(/ /g, '.')}.option`;
      expect([keyOf(path, '--json'), keyOf(path, '--dry-run')], path).toEqual([`${prefix}.json`, `${prefix}.dry_run`]);
      if (withReason.includes(path)) expect(keyOf(path, '--reason'), path).toBe(`${prefix}.reason`);
    }
    expect(keyOf('bank account edit', '--yes')).toBe('cli.flag.yes');
  });

  it('the check names travel as a parameter, so `bank statement check --help` lists them in Spanish too', () => {
    const checks = STATEMENT_CHECK_NAMES.join(', ');
    expectSpanishHelp('bank statement check', 'help.bank.statement.check.option.check', { checks });
  });

  it('every generic flag a 232 leaf declares is worded for it and keeps a key of its own', () => {
    const own: Record<string, string[]> = {
      'bank book-item list': ['--since', '--until'],
      'bank match preview': ['--since', '--until'],
      'bank match run': ['--since', '--until', '--dry-run', '--json'],
      'bank match apply': ['--dry-run', '--yes', '--json'],
      'bank match create': ['--dry-run', '--json'],
      'bank match unapply': ['--reason', '--dry-run', '--yes', '--json'],
      'bank fee post': ['--period', '--json'],
      'bank interest post': ['--period', '--json'],
      'bank check reconcile': ['--as-of', '--json'],
    };
    for (const [path, flags] of Object.entries(own)) {
      const prefix = `help.${path.replace(/ /g, '.').replace(/-/g, '_')}.option`;
      for (const flag of flags) expect(keyOf(path, flag), path).toBe(`${prefix}.${flag.slice(2).replace(/-/g, '_')}`);
    }
    // What declareRisk adds where the leaf declares nothing is the kernel's, and stays on cli.flag.*.
    const injected = [keyOf('bank match run', '--yes'), keyOf('bank fee post', '--dry-run')];
    expect(injected).toEqual(['cli.flag.yes', 'cli.flag.dry_run']);
  });

  it('the matchable types and the unapply reason codes travel as parameters, so the Spanish lists them too', () => {
    const types = MATCHED_ENTITY_TYPES.join(', ');
    expectSpanishHelp('bank match create', 'help.bank.match.create.option.book_item', { types });
    const codes = MOTIVOS_DESAPLICACION.join(' | ');
    expectSpanishHelp('bank match unapply', 'help.bank.match.unapply.option.reason', { codes });
  });
});
