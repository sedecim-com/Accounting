import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import type { UnkeyedDescription } from '../../scripts/language/lanes/help.js';
import { keyFormat, unkeyedAt, unkeyedUnder } from './helpers/help-by-key.js';

// ============================================================
// WHAT tests/cli/helpers/help-by-key.ts ADDS TO THE TWO SPECS IT CAME FROM
//
// The filters by command path, which the bank split of #314 needs (231 to 233
// key `bank account`, `bank match` and so on, not the whole family, and 231
// also the `bank` root's own description), and the escaped key prefix they
// pair with. On a tree of their own, so whether they work does not depend on
// which families are keyed today.
// ============================================================

/** `bank` with `account` (and its `list`), a sibling `accounting` that shares the prefix, and `period`. */
function tree(): Command {
  const root = new Command('mnemosine');
  const bank = root.command('bank').description('bank prose');
  const account = bank.command('account').description('account prose');
  account.command('list').description('list prose').option('--type <type>', 'type prose');
  bank.command('accounting').description('accounting prose').argument('<name>', 'name prose');
  root.command('period').description('period prose');
  return root;
}

const lines = (hits: UnkeyedDescription[]): string[] =>
  hits.map((hit) => `${hit.command} ${hit.kind} ${hit.term}`.trim());
const under = (...paths: string[]): string[] => lines(unkeyedUnder(paths, tree()));
const at = (...paths: string[]): string[] => lines(unkeyedAt(paths, tree()));

describe('the help-by-key helper (#314, MNE-001-092)', () => {
  it('a command path takes the command and everything under it, never its parent or a sibling that shares the prefix', () => {
    expect(under('bank account')).toEqual([
      'bank account command',
      'bank account list command',
      'bank account list option --type <type>',
    ]);
    expect(under('bank accounting')).toEqual(['bank accounting command', 'bank accounting argument name']);
    expect(under('bank account list', 'period')).toEqual([
      'bank account list command',
      'bank account list option --type <type>',
      'period command',
    ]);
  });

  it('a command alone takes what it shows of its own, never what the commands under it show', () => {
    expect(at('bank')).toEqual(['bank command']);
    expect(at('bank account list', 'bank accounting')).toEqual([
      'bank account list command',
      'bank account list option --type <type>',
      'bank accounting command',
      'bank accounting argument name',
    ]);
  });

  it('a path that names no command throws instead of passing as an empty list', () => {
    expect(() => under('bank acount')).toThrow('no command bank acount');
    expect(() => under('bank account', 'bank  account')).toThrow('no command bank  account');
    expect(() => at('bank acount')).toThrow('no command bank acount');
  });

  it('the key prefix is literal: its dots match only dots', () => {
    expect(keyFormat('bank.account').test('help.bank.account.list.option.type')).toBe(true);
    expect(keyFormat('bank.account').test('help.bankXaccount.list.option.type')).toBe(false);
    expect(keyFormat('bank.account').test('help.bank.accounting.description')).toBe(false);
  });
});
