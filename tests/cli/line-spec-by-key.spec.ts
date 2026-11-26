import { afterEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

// I8b · the one --line grammar speaks by key (MNE-001-806, #150). Under es-MX the refusals, the comma warning
// and the heading of the key block that entry, invoice and bill print are Spanish from the catalogue, written
// here by hand before the code; the keys as typed, the separator and the sample line stay as they are. The
// English was compared by a dump.

import { legacyCommaWarning, lineKeysHelp, normalizeLineRecord, parseKeyValueLine, type LineGrammar } from '../../src/cli/kernel/line-spec.js';
import { parseEntryLine, registerEntryCommand } from '../../src/cli/entry-command.js';
import { parseInvoiceLine, registerInvoiceCommand } from '../../src/cli/invoice-command.js';
import { parseLineSpec, registerBillCommand } from '../../src/cli/bill-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import type { CliError } from '../../src/cli/kernel/cli-error.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import { englishUserStrings } from '../../scripts/language/lanes/cli-strings.js';

const pass = (s: string) => s;
const deps = { palette: { dim: pass, bold: pass, cyan: pass, red: pass, green: pass, yellow: pass }, shutdown: () => undefined, reportError: () => undefined } as never;
const G: LineGrammar = { known: ['account', 'price', 'unit-price', 'debit'], aliases: { cargo: 'debit' }, sameField: [['price', 'unit-price']] };
afterEach(() => resetLanguage());

/** The refusal of `f`, as the person reads it and as `message` keeps it. */
function refusal(f: () => unknown): { es: string; en: string; key: string | undefined } {
  try { f(); } catch (e) { const c = e as CliError; return { es: c.localized(), en: c.message, key: c.key }; }
  throw new Error('no refusal');
}

/** The `--help` of a leaf, with what `addHelpText` adds, under the active language. */
function helpOf(register: (p: Command, d: never) => void, leaf: string[]): string {
  resetDeclarations();
  const program = new Command('mnemosine');
  register(program, deps);
  let node = program;
  for (const name of leaf) node = node.commands.find((c) => c.name() === name)!;
  let out = '';
  node.configureOutput({ writeOut: (s) => { out += s; } });
  node.outputHelp();
  return out;
}

describe('under es-MX, the grammar of --line refuses in Spanish', () => {
  it('the kernel keeps its message English and names what was typed', () => {
    setLanguage('es');
    expect(refusal(() => parseKeyValueLine('5100;2;350'))).toEqual({
      es: 'No se puede leer la línea "5100;2;350". Cada parte es clave=valor, y las partes van separadas por ";": --line "account=5100;qty=2;price=350.00;description=Text".',
      en: 'Cannot read the line "5100;2;350". Each part is key=value, separated by ";": --line "account=5100;qty=2;price=350.00;description=Text".',
      key: 'cli.line.pair_unreadable',
    });
    expect(refusal(() => normalizeLineRecord({ tax_rate: 16, 'tax-rate': 8 })).es).toBe(
      'La línea "{"tax_rate":16,"tax-rate":8}" da "tax-rate" dos veces (como "tax_rate" y como "tax-rate").');
    expect(refusal(() => parseKeyValueLine('account=1;Colour=x', { grammar: G })).es).toBe(
      'Clave desconocida en --line: Colour. Claves conocidas: account, price, unit-price, debit.');
    expect(refusal(() => normalizeLineRecord({ account: '1', Zz: 1, Cost_Centre: 'x' }, G)).es).toBe(
      'Claves desconocidas en --line: Zz, Cost_Centre. Claves conocidas: account, price, unit-price, debit.');
    expect(refusal(() => parseKeyValueLine('price=1;unit_price=2', { grammar: G }))).toEqual({
      es: 'La línea "price=1;unit_price=2" da un mismo campo dos veces: "price" y "unit_price" son la misma clave. Escribe sólo una.',
      en: 'The line "price=1;unit_price=2" gives one field twice: "price" and "unit_price" are the same key. Give only one.',
      key: 'cli.line.same_field',
    });
    expect(legacyCommaWarning()).toBe(
      'Separar los pares de --line con "," está en desuso; sepáralos con ";" (account=5100;qty=1;price=1000;tax-amount=160). Las comas dejan de funcionar en 2.0.0.');
    expect(lineKeysHelp([['account', 'code']])).toBe(
      '\nClaves que acepta --line (pares clave=valor separados por ";"; "_" y "-" son lo mismo):\n  account   code\n');
  });

  it('entry, invoice and bill read their --line in Spanish, and their --help says so when it is shown', () => {
    setLanguage('es');
    expect(refusal(() => parseEntryLine('account=6120;debit=1;cargo=2')).es).toBe(
      'La línea "account=6120;debit=1;cargo=2" da "debit" dos veces (como "debit" y como "cargo").');
    expect(refusal(() => parseInvoiceLine('account=4100;qty=1;quantity=2;price=1')).es).toBe(
      'La línea "account=4100;qty=1;quantity=2;price=1" da un mismo campo dos veces: "qty" y "quantity" son la misma clave. Escribe sólo una.');
    expect(refusal(() => parseLineSpec('account=5100,price=1,colour=x')).es).toBe(
      'Clave desconocida en --line: colour. Claves conocidas: account, qty, quantity, price, unit-price, tax-amount, tax, description, cost-center, project.');
    expect(refusal(() => parseLineSpec('account=5100;price')).es).toContain('No se puede leer la línea "account=5100;price".');
    const heading = 'Claves que acepta --line (pares clave=valor separados por ";"; "_" y "-" son lo mismo):\n  account ';
    expect(helpOf(registerEntryCommand, ['entry', 'create'])).toContain(heading);
    expect(helpOf(registerInvoiceCommand, ['invoice', 'create'])).toContain(heading);
    expect(helpOf(registerBillCommand, ['bill', 'create'])).toContain(heading);
    setLanguage('en');
    expect(helpOf(registerBillCommand, ['bill', 'create'])).toContain('Keys accepted in --line (key=value pairs separated by ";"; "_" and "-" are the same):\n  account ');
  });
});

describe('the English keeps its words, and the lane finds no English literal', () => {
  it('an English plural defect stays', () => {
    setLanguage('en');
    expect(t('cli.line.unknown_keys', { count: 1, unknown: 'colour', known: 'account' })).toBe('Unknown key(s) in --line: colour. Known keys: account.');
  });
  it.each(['src/cli/kernel/line-spec.ts', 'src/cli/entry-command.ts'])('%s', (file) => {
    const code = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    expect(englishUserStrings(code, file).map((h) => h.text)).toEqual([]);
  });
});
