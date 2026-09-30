import { describe, expect, it } from 'vitest';
import { Command, Option } from 'commander';
import { argumentByKey, describeCommand, optionByKey } from '../../src/cli/kernel/help.js';
import { HELP_PER_ENTRY_RULE, helpLanes, unkeyedDescriptions } from '../../scripts/language/lanes/help.js';

// ============================================================
// THE `help-descriptions-without-key` LANE (#314)
//
// A small tree of our own, so the rules of the count are pinned without the
// 300-node program: keyed descriptions are not counted, prose written at the
// call site is, hidden nodes and empty descriptions are not, and each hit is
// attributed to its top-level family.
// ============================================================

function tree(): Command {
  const root = new Command('mnemosine').option('--locale <tag>', 'global prose');
  const period = describeCommand(root.command('period'), 'help.period.description');
  const show = argumentByKey(period.command('show'), '<name>', 'help.period.show.argument.name');
  describeCommand(show, 'help.period.show.description');
  optionByKey(show, '--year <year>', 'help.period.list.option.year');

  const bank = root.command('bank').description('bank prose');
  bank
    .command('import')
    .description('import prose')
    .argument('<file>', 'file prose')
    .argument('[other]')
    .option('--dry-run', 'dry prose')
    .addOption(new Option('--secret', 'hidden prose').hideHelp());
  bank.command('ghost', { hidden: true }).description('ghost prose');
  return root;
}

describe('unkeyedDescriptions', () => {
  it('counts only the prose written at the call site, attributed to its family', () => {
    expect(unkeyedDescriptions(tree())).toEqual([
      { family: 'mnemosine', command: '', kind: 'option', term: '--locale <tag>' },
      { family: 'bank', command: 'bank', kind: 'command', term: '' },
      { family: 'bank', command: 'bank import', kind: 'command', term: '' },
      { family: 'bank', command: 'bank import', kind: 'option', term: '--dry-run' },
      { family: 'bank', command: 'bank import', kind: 'argument', term: 'file' },
    ]);
  });

  it('a keyed description a leaf overwrote counts again', () => {
    const root = tree();
    const period = root.commands.find((c) => c.name() === 'period')!;
    period.description('overwritten by the leaf');
    expect(unkeyedDescriptions(root).filter((hit) => hit.family === 'period')).toEqual([
      { family: 'period', command: 'period', kind: 'command', term: '' },
    ]);
  });
});

describe('helpLanes', () => {
  it('tells the author to register by key, per family, not to translate a file', () => {
    const [lane] = helpLanes();
    expect(lane.perEntryRule).toBe(HELP_PER_ENTRY_RULE);
    expect(HELP_PER_ENTRY_RULE).toContain('describeCommand/optionByKey/argumentByKey');
    expect(HELP_PER_ENTRY_RULE).not.toContain('archivo');
  });
});
