import { afterEach, describe, expect, it } from 'vitest';
import { Argument, Command, Option } from 'commander';
import {
  argumentByKey,
  describeArgument,
  describeCommand,
  describeOption,
  helpKeyOf,
  installHelpChrome,
} from '../../../src/cli/kernel/help.js';
import { resetLanguage, setLanguage, t } from '../../../src/i18n/index.js';

// ============================================================
// POSITIONAL ARGUMENTS ARE DESCRIBED BY KEY TOO (#314)
//
// Before `describeArgument`, `Arguments:` was the one section of a help screen
// that no key could reach: `cmd.argument('<name>', 'prose')` stored English and
// the stock `Help.argumentDescription` printed it in every locale. These pin
// the same two-faces contract `help-stores-english.spec.ts` pins for commands
// and options, plus `helpKeyOf`, which is what the language lane asks.
// ============================================================

const KEY = 'help.period.show.argument.name';
const ENGLISH = t(KEY, {}, 'en');
const SPANISH = t(KEY, {}, 'es');

afterEach(() => resetLanguage());

function rootWithChrome(): Command {
  const root = new Command('mnemosine');
  installHelpChrome(root);
  return root;
}

describe('describeArgument and argumentByKey', () => {
  it('store the English of the key in the argument, whatever language is active', () => {
    setLanguage('es');
    const argument = describeArgument(new Argument('<name>'), KEY);
    expect(argument.description).toBe(ENGLISH);

    const cmd = argumentByKey(new Command('show'), '<name>', KEY);
    expect(cmd.registeredArguments[0].description).toBe(ENGLISH);
    expect(cmd.registeredArguments[0].required).toBe(true);
  });

  it('the help screen renders the argument in Spanish under `Argumentos:`', () => {
    const sub = argumentByKey(rootWithChrome().command('show'), '<name>', KEY);
    setLanguage('es');
    const help = sub.helpInformation();
    expect(help).toContain(t('cli.chrome.arguments', {}, 'es'));
    expect(help).toContain(SPANISH);
    expect(help).not.toContain(ENGLISH);
  });

  it('keeps the stock default suffix and the parser', () => {
    const sub = argumentByKey(rootWithChrome().command('show'), '[name]', KEY, {
      defaultValue: 'current',
      parser: (value) => value.toUpperCase(),
    });
    setLanguage('es');
    expect(sub.helpInformation()).toContain(`${SPANISH} (default: "current")`);
    expect(sub.registeredArguments[0].parseArg?.('x', undefined)).toBe('X');
  });

  it('an argument whose prose a leaf overwrote renders that prose, not the key', () => {
    const sub = argumentByKey(rootWithChrome().command('show'), '<name>', KEY);
    sub.registeredArguments[0].description = 'written by the leaf';
    setLanguage('es');
    expect(sub.helpInformation()).toContain('written by the leaf');
    expect(sub.helpInformation()).not.toContain(SPANISH);
  });

  it('the two faces of the key really differ, so the checks above can fail', () => {
    expect(SPANISH).not.toBe(ENGLISH);
  });
});

describe('helpKeyOf', () => {
  it('returns the key of a keyed command, option and argument', () => {
    const cmd = describeCommand(new Command('period'), 'help.period.description');
    const option = describeOption(new Option('--year <year>'), 'help.period.list.option.year');
    const argument = describeArgument(new Argument('<name>'), KEY);
    expect(helpKeyOf(cmd)).toBe('help.period.description');
    expect(helpKeyOf(option)).toBe('help.period.list.option.year');
    expect(helpKeyOf(argument)).toBe(KEY);
  });

  it('returns null for prose written at the call site', () => {
    const cmd = new Command('period').description('prose');
    expect(helpKeyOf(cmd)).toBeNull();
    expect(helpKeyOf(new Option('--year <year>', 'prose'))).toBeNull();
    expect(helpKeyOf(new Argument('<name>', 'prose'))).toBeNull();
  });

  it('returns null once a leaf overwrote the keyed prose, because the screen shows the overwrite', () => {
    const cmd = describeCommand(new Command('period'), 'help.period.description');
    cmd.description('overwritten');
    const option = describeOption(new Option('--year <year>'), 'help.period.list.option.year');
    option.description = 'overwritten';
    const argument = describeArgument(new Argument('<name>'), KEY);
    argument.description = 'overwritten';
    expect(helpKeyOf(cmd)).toBeNull();
    expect(helpKeyOf(option)).toBeNull();
    expect(helpKeyOf(argument)).toBeNull();
  });
});
