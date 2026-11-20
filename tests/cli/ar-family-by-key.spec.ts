import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { program } from '../../src/cli/mnemosine.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { t, type TranslationKey } from '../../src/i18n/index.js';

// ============================================================
// I8.3 · THE ar FAMILY SPEAKS BY KEY (MNE-001-220, #265)
//
// The keys no leaf spec of the family reaches: the reasons `invoice void`,
// `invoice delete` and `credit-note issue` give for not honoring a key, read
// from the shipped program, and the `customer` help examples in English.
// Texts written by hand, before the code.
// ============================================================

function leaf(...names: string[]): Command {
  let at: Command = program;
  for (const name of names) {
    const next = at.commands.find((c) => c.name() === name);
    if (!next) throw new Error(`no leaf ${names.join(' ')}`);
    at = next;
  }
  return at;
}

/** The no-key reason a leaf declares, rendered in a language. */
function reason(cmd: Command, language: 'en' | 'es'): string {
  const declared = riskOf(cmd)?.llave;
  if (!declared || !('sinLlave' in declared) || typeof declared.sinLlave === 'string') return '';
  return t(declared.sinLlave.key as TranslationKey, {}, language);
}

function helpOf(cmd: Command): string {
  let help = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    help += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    cmd.outputHelp();
  } finally {
    process.stdout.write = write;
  }
  return help;
}

describe('the ar family says why a key would protect nothing, in both languages', () => {
  it('invoice issue', () => {
    expect(reason(leaf('invoice', 'issue'), 'en')).toBe('a retry issues again and posts the revenue a second time');
    expect(reason(leaf('invoice', 'issue'), 'es')).toBe('un reintento vuelve a emitir y postea el ingreso otra vez');
  });

  it('invoice void', () => {
    expect(reason(leaf('invoice', 'void'), 'en')).toBe('a retry posts the mirror of the void again');
    expect(reason(leaf('invoice', 'void'), 'es')).toBe('un reintento vuelve a postear el espejo de la anulación');
  });

  it('invoice delete', () => {
    expect(reason(leaf('invoice', 'delete'), 'en')).toBe(
      'the delete is unrepeatable only through the state of the draft, not through the key'
    );
    expect(reason(leaf('invoice', 'delete'), 'es')).toBe(
      'el borrado sólo es irrepetible por estado del borrador, no por llave'
    );
  });

  it('credit-note issue', () => {
    expect(reason(leaf('credit-note', 'issue'), 'en')).toBe('a retry issues the note again and posts another entry');
    expect(reason(leaf('credit-note', 'issue'), 'es')).toBe('un reintento vuelve a emitir la nota y postea otro asiento');
  });
});

describe('the customer help examples are English', () => {
  it('edit and tax set give their reasons in English', () => {
    expect(helpOf(leaf('customer', 'edit'))).toContain('--reason "2026 commercial agreement"');
    expect(helpOf(leaf('customer', 'edit'))).toContain('--notes "Requires a purchase order on every invoice"');
    expect(helpOf(leaf('customer', 'tax', 'set'))).toContain('--reason "Tax status certificate of July"');
    expect(helpOf(leaf('customer', 'tax', 'set'))).toContain('--reason "Customer request"');
  });

  it('archive and restore too', () => {
    expect(helpOf(leaf('customer', 'archive'))).toContain('--reason "Customer inactive since 2025"');
    expect(helpOf(leaf('customer', 'restore'))).toContain('--reason "Reactivated with the 2026 contract"');
  });
});
