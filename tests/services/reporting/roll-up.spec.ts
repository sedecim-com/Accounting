import { describe, it, expect } from 'vitest';
import {
  rollUpTrialBalanceRows,
  type AccountAncestry,
  type TrialBalanceReportRow,
} from '../../../src/services/reporting/report-service.js';

// #323 · THE roll-up behind the Anexo 24 balanza (and #100's --level). Each
// case is written to kill one wrong roll-up: direct children only, the
// declared sign instead of the ledger axis, a cycle counted twice, and a
// `cuadra` left over from the own figures.

const row = (id: string, opening: string, debit: string, credit: string): TrialBalanceReportRow => {
  const closing = (Number(opening) + Number(debit) - Number(credit)).toFixed(4);
  return {
    account_id: id,
    account_code: id,
    account_name: id,
    account_type: 'asset',
    debit_total: debit,
    credit_total: credit,
    ending_balance: (Number(debit) - Number(credit)).toFixed(4),
    beginning_balance: opening,
    final_balance: closing,
    cuadra: true,
  };
};
const tree = (entries: [string, number, string[]][]): Map<string, AccountAncestry> =>
  new Map(entries.map(([id, level, ancestors]) => [id, { level, ancestors }]));

const byId = (rows: TrialBalanceReportRow[], id: string) => rows.find((r) => r.account_id === id)!;

describe('rollUpTrialBalanceRows', () => {
  const ancestry = tree([
    ['1000', 1, []],
    ['1110', 2, ['1000']],
    ['1111', 3, ['1110', '1000']],
    ['1112', 3, ['1110', '1000']],
  ]);
  const rows = [
    row('1000', '0', '0', '0'),
    row('1110', '0', '0', '0'),
    row('1111', '1000', '300', '0'),
    row('1112', '250', '50', '300'),
  ];

  it('1110 declares 1111 + 1112 in all four columns, and the leaves stay their own', () => {
    const out = rollUpTrialBalanceRows(rows, ancestry);
    expect(byId(out, '1110')).toMatchObject({
      beginning_balance: '1250.0000',
      debit_total: '350.0000',
      credit_total: '300.0000',
      final_balance: '1300.0000',
      ending_balance: '50.0000',
      cuadra: true,
    });
    expect(byId(out, '1111').final_balance).toBe('1300.0000');
    expect(byId(out, '1112').final_balance).toBe('0.0000');
  });

  it('reaches the grandparent, not only the direct parent', () => {
    expect(byId(rollUpTrialBalanceRows(rows, ancestry), '1000').final_balance).toBe('1300.0000');
  });

  it('adds the own figures of a parent to those of its subtree', () => {
    const withOwn = rows.map((r) => (r.account_id === '1110' ? row('1110', '5', '0', '0') : r));
    expect(byId(rollUpTrialBalanceRows(withOwn, ancestry), '1110').final_balance).toBe('1305.0000');
  });

  it('a credit-nature child NETS against its debit parent (ledger axis, not declared sign)', () => {
    const fixedAssets = tree([
      ['1200', 1, []],
      ['1210', 2, ['1200']],
      ['1290', 2, ['1200']],
    ]);
    const out = rollUpTrialBalanceRows(
      [row('1200', '0', '0', '0'), row('1210', '1000', '0', '0'), row('1290', '-200', '0', '0')],
      fixedAssets
    );
    expect(byId(out, '1200').final_balance).toBe('800.0000');
  });

  it('a parent_id cycle neither hangs nor counts an account into itself', () => {
    const cycle = tree([
      ['A', 1, ['B', 'A']],
      ['B', 1, ['A', 'B']],
    ]);
    const out = rollUpTrialBalanceRows([row('A', '9', '0', '0'), row('B', '0', '0', '0')], cycle);
    expect(byId(out, 'A').final_balance).toBe('9.0000');
    expect(byId(out, 'B').final_balance).toBe('9.0000');
  });

  it('recomputes `cuadra` on the rolled figures, which is the row the SAT redoes', () => {
    const broken = { ...row('1111', '1000', '300', '0'), final_balance: '1299.0000', cuadra: false };
    const out = rollUpTrialBalanceRows([row('1110', '0', '0', '0'), broken], ancestry);
    expect(byId(out, '1110').cuadra).toBe(false);
  });
});
