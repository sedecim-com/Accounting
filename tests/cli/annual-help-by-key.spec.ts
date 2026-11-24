import { afterEach, describe, expect, it } from 'vitest';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { resetLanguage } from '../../src/i18n/index.js';
import { describedIn, expectEveryKeyInFormat, expectSpanishHelp, node, unkeyedInFamilies } from './helpers/help-by-key.js';

// MNE-001-457 (#622) · `mnemosine annual figure record`: the family is born
// with keys (AGENTS.md), and its one leaf is a write the agent cannot call.

afterEach(() => resetLanguage());

describe('mnemosine annual, help by key', () => {
  it('the lane finds no description without key in the family', () => {
    expect(unkeyedInFamilies(['annual'])).toEqual([]);
  });

  it('every description has a key in the decided format, or a generic cli.* key', () => {
    const described = describedIn(node('annual'));
    expect(described.length).toBeGreaterThan(7);
    expectEveryKeyInFormat(described, 'annual');
  });

  it('the leaf shows its description, its --source and its --updated-through in Spanish', () => {
    expectSpanishHelp('annual figure record', 'help.annual.figure.record.description');
    expectSpanishHelp('annual figure record', 'help.annual.figure.record.option.source');
    expectSpanishHelp('annual figure record', 'help.annual.figure.record.option.updated_through');
  });

  it('the leaf is a write the agent cannot call', () => {
    expect(riskOf(node('annual figure record'))).toMatchObject({ risk: 'escritura', agentAllowed: false });
  });
});
