import { afterEach, describe, expect, it } from 'vitest';
import { Command, Option } from 'commander';
import { describeCommand, describeOption, installHelpChrome } from '../../../src/cli/kernel/help.js';
import { resetLanguage, setLanguage, t } from '../../../src/i18n/index.js';

// ============================================================
// COMMANDER STORES ENGLISH, WHATEVER LANGUAGE IS ACTIVE
//
// `scripts/ux-status.ts` counts the CLI surface by reading
// `Command.description()` and `Option.description`, and its baseline assumes
// that text is the English source. Today that holds for one reason only:
// `describeCommand` / `describeOption` store `t(key, params, 'en')` and
// translate at RENDER time. docs/auditorias/I7.md listed it as open debt —
// "if someone stores the translated text, it breaks and no test says so" —
// and the Witness review of #228 asked for this same direct assertion.
//
// So this pins the mechanism itself, not the whole program: with Spanish
// active, what Commander holds is English, and what the help screen prints
// is Spanish. If the two ever collapse into one, one of these goes red.
// ============================================================

const KEY = 'bank.parse.amount_invalid';
const PARAMS = { flag: '--amount', value: 'x' };
// The expected English comes from the catalog directly, NOT from `englishOf`:
// that helper is the piece under test, and comparing its output against
// itself stays green when it breaks — measured, the option case did exactly
// that before this line existed.
const ENGLISH = t(KEY, PARAMS, 'en');

afterEach(() => resetLanguage());

describe('kernel/help stores the English source and translates only the render', () => {
  it('a command described with Spanish active still holds the English text', () => {
    setLanguage('es');
    const cmd = describeCommand(new Command('demo'), KEY, PARAMS);
    expect(cmd.description()).toBe(ENGLISH);
    expect(cmd.description()).toContain('must be a decimal amount');
  });

  it('an option described with Spanish active still holds the English text', () => {
    setLanguage('es');
    const option = describeOption(new Option('--amount <value>'), KEY, PARAMS);
    expect(option.description).toBe(ENGLISH);
  });

  it('the help screen renders that same key in Spanish, chrome included', () => {
    const root = new Command('mnemosine');
    installHelpChrome(root);
    // `root.command(...)`, not `addCommand(new Command(...))`: only the former
    // runs `copyInheritedSettings`, which is how every real leaf receives the
    // configured help. A detached command would render stock English and prove
    // nothing about the kernel.
    const sub = describeCommand(root.command('demo'), KEY, PARAMS);
    const option = describeOption(new Option('--amount <value>'), KEY, PARAMS);
    sub.addOption(option);

    setLanguage('es');
    const help = sub.helpInformation();
    // The render is Spanish…
    expect(help).toContain(t(KEY, PARAMS, 'es'));
    expect(help).toContain(t('cli.chrome.usage', {}, 'es'));
    expect(help).not.toContain('must be a decimal amount');
    // …while the object underneath is untouched.
    expect(sub.description()).toBe(ENGLISH);
    expect(option.description).toBe(ENGLISH);
  });

  it('the Spanish and English faces of the key really differ, so the checks above can fail', () => {
    // Without this, a key whose two translations were identical would make
    // every assertion above pass for the wrong reason.
    expect(t(KEY, PARAMS, 'es')).not.toBe(t(KEY, PARAMS, 'en'));
    expect(t('cli.chrome.usage', {}, 'es')).not.toBe('Usage:');
  });
});
