import { describe, it, expect } from 'vitest';
import { gainAndLoss, postedSoFar, revalue } from '../../../src/services/accounting/fx-revaluation.js';
import { POLICY_CATALOG } from '../../../src/services/policy/pending-catalog.js';
import { revaluationRows } from '../../../src/cli/closing-fx-command.js';

describe('MNE-001-083 · the closing revaluation arithmetic (NIF B-15)', () => {
  it('a USD 1 000 receivable born at 17.50 gains 700 at 18.20', () => {
    expect(revalue('1000', '17500', '18.2')).toEqual({ revalued: '18200.0000', difference: '700.0000' });
  });

  it('a USD 500 payable (credit balance) loses 350 at 18.20', () => {
    expect(revalue('-500', '-8750', '18.2')).toEqual({ revalued: '-9100.0000', difference: '-350.0000' });
  });

  it('rounds the revalued balance half-up to 4 places, as every ledger line', () => {
    expect(revalue('0.00005', '0', '1').revalued).toBe('0.0001');
  });

  it('a book residue with no foreign balance left is revalued to zero', () => {
    expect(revalue('0', '0.0100', '18.2').difference).toBe('-0.0100');
  });

  it('subtracts what earlier runs of the period already posted: only what moved since is left', () => {
    // USD 1 200 in the bank at 18.20 = 21 840, book 21 000, 140 posted by run 1.
    expect(revalue('1200', '21000', '18.2', '140').difference).toBe('700.0000');
    expect(revalue('200', '3500', '18.2', '140').difference).toBe('0.0000');
  });

  it('adds up what the earlier runs posted per account and currency', () => {
    const posted = postedSoFar([
      { lines: [{ accountId: 'a', accountCode: '1150', currency: 'USD', difference: '140.0000' }] },
      { lines: [
        { accountId: 'a', accountCode: '1150', currency: 'USD', difference: '700.0000' },
        { accountId: 'a', accountCode: '1150', currency: 'EUR', difference: '-5.0000' },
      ] },
    ]);
    expect(Object.fromEntries(posted)).toEqual({
      'a|USD': { accountCode: '1150', posted: '840.0000' },
      'a|EUR': { accountCode: '1150', posted: '-5.0000' },
    });
  });

  it('whether to reverse is a panel key, reverse_on_day_one by default, with no option left without a reader', () => {
    const spec = POLICY_CATALOG.find((p) => p.key === 'fx_revaluation_reversal');
    expect(spec?.defaultValue).toBe('reverse_on_day_one');
    expect(spec?.options.map((o) => o.value)).toEqual(['reverse_on_day_one']);
    expect(spec?.defaultRationale).toMatch(/NIF B-15/);
  });

  it('adds gains and losses apart, never netted', () => {
    expect(gainAndLoss([{ difference: '700' }, { difference: '-350' }, { difference: '140' }, { difference: '0' }]))
      .toEqual({ gain: '840.0000', loss: '350.0000' });
  });

  it('prints one row per account and currency', () => {
    const rows = revaluationRows({
      periodId: 'p', periodName: 'Agosto', closingDate: '2026-08-31', reversalDate: '2026-09-01',
      rates: [], gain: '700.0000', loss: '0.0000', alreadyRun: null, sequence: 1, entry: null, reversal: null,
      lines: [{
        accountId: 'a', accountCode: '1150', currency: 'USD', foreignBalance: '1000.0000',
        bookBalance: '17500.0000', rate: '18.2', revaluedBalance: '18200.0000', alreadyPosted: '0.0000',
        difference: '700.0000',
      }],
    });
    expect(rows).toEqual([{
      account: '1150', currency: 'USD', foreign_balance: '1000.0000', book_balance: '17500.0000',
      rate: '18.2', revalued_balance: '18200.0000', already_posted: '0.0000', difference: '700.0000',
    }]);
  });
});
