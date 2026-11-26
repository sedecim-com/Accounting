import { afterEach, describe, expect, it } from 'vitest';
import { parsePtuClose } from '../../src/cli/ptu-command.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { resetLanguage } from '../../src/i18n/index.js';
import { describedIn, expectEveryKeyInFormat, expectSpanishHelp, node, unkeyedInFamilies } from './helpers/help-by-key.js';

// MNE-001-298 (#111) · `mnemosine ptu close`: the family is born with keys,
// its leaf is a write the agent cannot call, and every flag is refused before
// any query.

afterEach(() => resetLanguage());

const OK = {
  year: '2026', accumulableIncome: '5000000', authorizedDeductions: '3800000.5',
  nonDeductibleExemptPay: '094000', source: ' annual computation 2026 ',
};

describe('mnemosine ptu close, help by key', () => {
  it('the lane finds no description without key, and every key is in the family format', () => {
    expect(unkeyedInFamilies(['ptu'])).toEqual([]);
    expectEveryKeyInFormat(describedIn(node('ptu')), 'ptu');
  });

  it('the leaf shows its description and its --source in Spanish', () => {
    expectSpanishHelp('ptu close', 'help.ptu.close.description');
    expectSpanishHelp('ptu close', 'help.ptu.close.option.source');
  });

  it('the leaf is a write the agent cannot call', () => {
    expect(riskOf(node('ptu close'))).toMatchObject({ risk: 'escritura', agentAllowed: false });
  });
});

describe('parsePtuClose', () => {
  it('normalizes the three figures to four decimals and trims the source', () => {
    expect(parsePtuClose(OK)).toEqual({
      year: 2026,
      figures: {
        accumulableIncome: '5000000.0000', authorizedDeductions: '3800000.5000',
        nonDeductibleExemptPay: '94000.0000', source: 'annual computation 2026',
      },
    });
  });

  it.each([
    [{ year: '26' }, '--year "26" is not valid'],
    [{ accumulableIncome: '-1' }, '--accumulable-income "-1" is not valid'],
    [{ authorizedDeductions: '1,000' }, '--authorized-deductions "1,000" is not valid'],
    [{ nonDeductibleExemptPay: '1.23456' }, '--non-deductible-exempt-pay "1.23456" is not valid'],
    [{ source: '  ' }, 'Missing --source'],
  ])('refuses %o in words', (change, message) => {
    expect(() => parsePtuClose({ ...OK, ...change })).toThrow(message);
  });
});
