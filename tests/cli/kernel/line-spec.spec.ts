import { describe, it, expect } from 'vitest';
import {
  parseKeyValueLine,
  normalizeLineKey,
  normalizeLineRecord,
  SIDE_ALIASES,
  isKeyValueLine,
  lineKeysHelp,
  LEGACY_COMMA_WARNING,
  LEGACY_LINE_FORMS_RETIRE_IN,
} from '../../../src/cli/kernel/line-spec.js';
import { parseEntryLine } from '../../../src/cli/entry-command.js';
import { parseLineSpec } from '../../../src/cli/bill-command.js';
import {
  parseInvoiceLine,
  resolveInvoiceTaxRate,
  LEGACY_INVOICE_TAX_KEY_WARNING,
} from '../../../src/cli/invoice-command.js';

// One --line grammar for entry, bill and invoice (#327, MNE-001-100): key=value
// pairs separated by ";", cargo/abono as synonyms of debit/credit, "_" read as
// "-", and the legacy spellings still accepted with a warning.

describe('the kernel line grammar', () => {
  it('reads key=value pairs separated by ";" and keeps commas inside a value', () => {
    expect(parseKeyValueLine('account=4100;price=10;description=Consultoria, agosto')).toEqual({
      fields: { account: '4100', price: '10', description: 'Consultoria, agosto' },
      legacyComma: false,
    });
  });

  it('reads "_" as "-", and folds cargo/abono only where the grammar says so', () => {
    expect(normalizeLineKey('Tax_Rate')).toBe('tax-rate');
    expect(normalizeLineKey('CARGO')).toBe('cargo');
    const entryLike = { known: ['account', 'debit', 'credit'], aliases: SIDE_ALIASES };
    expect(parseKeyValueLine('account=1;CARGO=5', { grammar: entryLike }).fields).toEqual({ account: '1', debit: '5' });
    expect(normalizeLineRecord({ account: '1', abono: 5 }, entryLike)).toEqual({ account: '1', credit: '5' });
    expect(normalizeLineRecord({ tax_amount: 160, cost_center: 'CC1', skip: null })).toEqual({
      'tax-amount': '160',
      'cost-center': 'CC1',
    });
  });

  it('refuses two spellings of one key instead of keeping one of two amounts', () => {
    const entryLike = { known: ['account', 'debit', 'credit'], aliases: SIDE_ALIASES };
    expect(() => parseKeyValueLine('account=6120;debit=100;cargo=200', { grammar: entryLike })).toThrow(
      /"debit" twice \(as "debit" and "cargo"\)/
    );
    expect(() => normalizeLineRecord({ tax_rate: 16, 'tax-rate': 8 })).toThrow(/"tax-rate" twice/);
  });

  it('reads the legacy comma form only when asked, and says it did', () => {
    expect(parseKeyValueLine('account=5100,price=1', { allowLegacyComma: true })).toEqual({
      fields: { account: '5100', price: '1' },
      legacyComma: true,
    });
    // A lone pair whose value has a comma is not the legacy form.
    expect(parseKeyValueLine('description=a, b', { allowLegacyComma: true }).legacyComma).toBe(false);
    expect(parseKeyValueLine('account=5100;description=a, b', { allowLegacyComma: true }).legacyComma).toBe(false);
  });

  it('refuses a fragment that is not key=value', () => {
    expect(() => parseKeyValueLine('5100;2;350')).toThrow(/key=value/);
  });

  it('names every known key when it rejects one, spelled as the person wrote it', () => {
    const grammar = { known: ['account'] };
    expect(() => parseKeyValueLine('account=1;colour=x', { grammar })).toThrow(
      /Unknown key\(s\) in --line: colour\. Known keys: account\./
    );
    expect(() => normalizeLineRecord({ account: '1', Cost_Centre: 'x' }, grammar)).toThrow(
      /Unknown key\(s\) in --line: Cost_Centre\./
    );
  });

  it('refuses two keys that set one field, whatever the values', () => {
    const grammar = { known: ['price', 'unit-price'], sameField: [['price', 'unit-price']] };
    expect(() => parseKeyValueLine('price=100;unit_price=1000', { grammar })).toThrow(
      /gives one field twice: "price" and "unit_price"/
    );
    expect(parseKeyValueLine('unit-price=1000', { grammar }).fields).toEqual({ 'unit-price': '1000' });
  });

  it('tells the key=value form from the positional shortcut', () => {
    expect(isKeyValueLine('account=6120;debit=1')).toBe(true);
    expect(isKeyValueLine('6120:debit:1:a=b')).toBe(false);
  });

  it('prints the key block and carries a retirement version on the comma warning', () => {
    expect(lineKeysHelp([['account', 'code'], ['description', 'text']])).toContain('  account       code');
    expect(LEGACY_COMMA_WARNING).toContain(LEGACY_LINE_FORMS_RETIRE_IN);
  });
});

describe('entry --line', () => {
  it('accepts the canonical form, with cargo/abono as keys', () => {
    expect(parseEntryLine('account=6120;debit=45000.00;description=Renta')).toEqual({
      account: '6120', debit: '45000.00', credit: undefined, description: 'Renta',
    });
    expect(parseEntryLine('account=2110;abono=45000.00')).toMatchObject({ account: '2110', credit: '45000.00' });
    expect(parseEntryLine('account=6120;cargo=1')).toMatchObject({ debit: '1' });
  });

  it('keeps the positional shortcut, with cargo/abono as sides', () => {
    expect(parseEntryLine('6120:cargo:100:CFE')).toEqual({
      account: '6120', debit: '100', credit: undefined, description: 'CFE',
    });
    expect(parseEntryLine('2110:abono:100')).toMatchObject({ credit: '100' });
  });

  it('wants an account and exactly one side, and no unknown key', () => {
    expect(() => parseEntryLine('debit=1')).toThrow(/account/);
    expect(() => parseEntryLine('account=1;debit=1;credit=1')).toThrow(/exactly one/);
    expect(() => parseEntryLine('account=1')).toThrow(/exactly one/);
    expect(() => parseEntryLine('account=1;debit=1;amount=1')).toThrow(/Unknown key/);
  });
});

describe('bill --line', () => {
  it('reads the canonical ";" form and the legacy comma form alike', () => {
    const canonical = parseLineSpec('account=5100;qty=2;price=350.00;tax_amount=112');
    expect(canonical).toEqual({ account: '5100', qty: '2', price: '350.00', 'tax-amount': '112' });
    expect(parseLineSpec('account=5100,qty=2,price=350.00,tax-amount=112')).toEqual(canonical);
  });

  it('refuses price with unit-price, or qty with quantity, in one line', () => {
    expect(() => parseLineSpec('account=5100;price=100;unit-price=1000')).toThrow(/one field twice/);
    expect(() => parseLineSpec('account=5100;price=1;qty=2;quantity=3')).toThrow(/one field twice/);
  });

  it('names cargo= as typed, since bill has no debit/credit key', () => {
    expect(() => parseLineSpec('account=5100;price=1;cargo=1')).toThrow(/Unknown key\(s\) in --line: cargo\./);
  });
});

describe('invoice --line', () => {
  it('honours tax-rate= (it used to be ignored and the invoice came out with 0 IVA)', () => {
    expect(resolveInvoiceTaxRate(parseInvoiceLine('account=4100;price=1000;tax-rate=16'))).toEqual({
      tax_rate: '16',
      usedLegacyTaxKey: false,
    });
    expect(resolveInvoiceTaxRate(parseInvoiceLine('account=4100;price=1000;tax_rate=16')).tax_rate).toBe('16');
  });

  it('still reads the bare tax= as the rate, and flags it for the warning', () => {
    expect(resolveInvoiceTaxRate(parseInvoiceLine('account=4100;price=1000;tax=16'))).toEqual({
      tax_rate: '16',
      usedLegacyTaxKey: true,
    });
    expect(LEGACY_INVOICE_TAX_KEY_WARNING).toMatch(/tax-rate=/);
    expect(LEGACY_INVOICE_TAX_KEY_WARNING).toContain(LEGACY_LINE_FORMS_RETIRE_IN);
  });

  it('refuses price with unit-price, or qty with quantity, in one line', () => {
    expect(() => parseInvoiceLine('account=4100;price=100;unit-price=1000')).toThrow(/one field twice/);
    expect(() => parseInvoiceLine({ account: '4100', price: 1, qty: 1, quantity: 2 })).toThrow(/one field twice/);
    expect(() => parseInvoiceLine('account=4100;price=1;abono=1')).toThrow(/Unknown key\(s\) in --line: abono\./);
  });

  it('rejects a key it does not know instead of dropping it', () => {
    expect(() => parseInvoiceLine('account=4100;price=1000;iva=16')).toThrow(/Unknown key\(s\) in --line: iva/);
    expect(() => parseInvoiceLine({ account: '4100', price: 1000, vat: 16 })).toThrow(/Unknown key/);
  });

  it('reads a --from-file object whose description has a ";"', () => {
    expect(parseInvoiceLine({ account: '4100', unit_price: 10, description: 'a; b' })).toEqual({
      account: '4100', 'unit-price': '10', description: 'a; b',
    });
  });
});
