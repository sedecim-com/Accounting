import { afterEach, describe, expect, it } from 'vitest';
import { program } from '../../src/cli/mnemosine.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import type { TranslationKey } from '../../src/i18n/index.js';
import { MATCHED_ENTITY_TYPES } from '../../src/database/enums.js';
import { MOTIVOS_DESAPLICACION } from '../../src/services/banking/match-service.js';
import { ROLES_QUE_FALTAN } from '../../src/services/banking/reconciliation-adjustments.js';
import { TIPOS_DE_PARTIDA } from '../../src/services/banking/reconciliation-math.js';
import { ESCALAMIENTOS } from '../../src/services/banking/reconciling-items.js';
import { STATEMENT_CHECK_NAMES } from '../../src/services/banking/statement-checks.js';
import {
  describedIn,
  expectEveryKeyInFormat,
  expectSpanishHelp,
  flat,
  keyFormat,
  node,
  unkeyedAt,
  unkeyedInFamilies,
  unkeyedUnder,
} from './helpers/help-by-key.js';

// ============================================================
// #314: THE BANK FAMILY, HELP BY KEY IN es-MX, BY SUBCOMMAND GROUP
//
// Same acceptance as the `period` pilot, filtered by command path because the
// family is keyed in three tasks: MNE-001-231 takes `account`, `statement` and
// `transaction`, and the root's own description; MNE-001-232 takes `match`,
// `fee`, `interest`, `check` and `book-item`; MNE-001-233 takes
// `reconciliation`, `reconciling-item` and `adjustment`, the last three, so
// the lane finds nothing left in the whole family.
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
  'bank reconciliation': 'bank.reconciliation',
  'bank reconciling-item': 'bank.reconciling_item',
  'bank adjustment': 'bank.adjustment',
};

/** The key of this leaf's option, or null when the leaf has no such flag. */
function keyOf(path: string, long: string): TranslationKey | null {
  const option = node(path).options.find((o) => o.long === long);
  return option ? helpKeyOf(option) : null;
}

describe('the bank family, help by key, group by group (#314, MNE-001-231 to 233)', () => {
  it('the lane finds nothing in these groups, nor in what the bank root shows of its own', () => {
    expect(unkeyedUnder(Object.keys(GROUPS))).toEqual([]);
    expect(unkeyedAt(['bank'])).toEqual([]);
    expect(helpKeyOf(node('bank')) ?? 'no key').toMatch(keyFormat('bank'));
  });

  it('with the last three groups keyed, the lane finds nothing anywhere in the bank family', () => {
    expect(unkeyedInFamilies(['bank'])).toEqual([]);
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
    ['bank', 'help.bank.reconciliation.description'],
    ['bank', 'help.bank.reconciling_item.description'],
    ['bank', 'help.bank.adjustment.description'],
    ['bank reconciliation', 'help.bank.reconciliation.run.description'],
    ['bank reconciliation', 'help.bank.reconciliation.close.description'],
    ['bank reconciliation run', 'help.bank.reconciliation.run.argument.account'],
    ['bank reconciliation run', 'help.bank.reconciliation.run.option.format'],
    ['bank reconciliation run', 'help.bank.reconciliation.run.option.stop_at'],
    ['bank reconciliation open', 'help.bank.reconciliation.open.option.baseline'],
    ['bank reconciliation list', 'help.bank.reconciliation.list.option.all_entities'],
    ['bank reconciliation status', 'help.bank.reconciliation.status.argument.session'],
    ['bank reconciliation close', 'help.bank.reconciliation.close.option.tolerance'],
    ['bank reconciliation approve', 'help.bank.reconciliation.approve.option.reason'],
    ['bank reconciliation reopen', 'help.bank.reconciliation.reopen.description'],
    ['bank reconciliation post', 'help.bank.reconciliation.post.argument.session'],
    ['bank reconciliation generate', 'help.bank.reconciliation.generate.description'],
    ['bank reconciling-item', 'help.bank.reconciling_item.list.description'],
    ['bank reconciling-item list', 'help.bank.reconciling_item.list.option.over_days'],
    ['bank reconciling-item assign', 'help.bank.reconciling_item.assign.argument.item'],
    ['bank reconciling-item assign', 'help.bank.reconciling_item.assign.option.clear_expected'],
    ['bank reconciling-item correct', 'help.bank.reconciling_item.correct.option.amount'],
    ['bank adjustment', 'help.bank.adjustment.create.description'],
    ['bank adjustment create', 'help.bank.adjustment.create.option.amount'],
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

  it('every generic flag a 233 leaf declares is worded for it and keeps a key of its own', () => {
    const own: Record<string, string[]> = {
      // --format here is the format of the FILE given in --file, not cli.flag.format («output format»).
      'bank reconciliation run': ['--period', '--since', '--until', '--dry-run', '--json', '--format'],
      'bank reconciliation open': ['--period', '--since', '--until', '--dry-run', '--json'],
      'bank reconciliation list': ['--period', '--since', '--until'],
      'bank reconciliation close': ['--dry-run', '--yes', '--json'],
      'bank reconciliation approve': ['--reason', '--json'],
      'bank reconciliation reopen': ['--json'],
      'bank reconciliation post': ['--json'],
      'bank reconciling-item assign': ['--note', '--json'],
      'bank reconciling-item correct': ['--json'],
      'bank adjustment create': ['--json'],
    };
    for (const [path, flags] of Object.entries(own)) {
      const prefix = `help.${path.replace(/ /g, '.').replace(/-/g, '_')}.option`;
      for (const flag of flags) expect(keyOf(path, flag), path).toBe(`${prefix}.${flag.slice(2).replace(/-/g, '_')}`);
    }
    // What the kernel adds where the leaf declares nothing stays on cli.flag.*.
    const injected = [
      keyOf('bank reconciliation run', '--note'),
      keyOf('bank reconciliation run', '--yes'),
      keyOf('bank reconciliation approve', '--dry-run'),
      keyOf('bank reconciliation reopen', '--reason'),
      keyOf('bank reconciling-item assign', '--yes'),
    ];
    expect(injected).toEqual(['cli.flag.note', 'cli.flag.yes', 'cli.flag.dry_run', 'cli.flag.reason', 'cli.flag.yes']);
  });

  it('the item types, the escalation states and the types still without a role travel as parameters', () => {
    const types = TIPOS_DE_PARTIDA.join(', ');
    expectSpanishHelp('bank reconciling-item list', 'help.bank.reconciling_item.list.option.type', { types });
    expectSpanishHelp('bank reconciling-item correct', 'help.bank.reconciling_item.correct.option.type', { types });
    const values = ESCALAMIENTOS.join(', ');
    expectSpanishHelp('bank reconciling-item assign', 'help.bank.reconciling_item.assign.option.escalation', { values });
    const unseeded = ROLES_QUE_FALTAN.map((r) => r.tipo).join(', ');
    expectSpanishHelp('bank adjustment create', 'help.bank.adjustment.create.option.gl_account', { types: unseeded });
  });
});
