import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createXmlReader,
  normalizeAttributeValue,
  normalizeAttributes,
} from '../../src/utils/xml-reader.js';
import { stripComments } from '../../src/utils/strip-comments.js';

// The shared reader of third-party XML (#218, #299). Every accent is written as
// a NUMERIC reference: `&amp;` is decoded even without `htmlEntities`, so a
// test written with it would pass against the defect it is meant to catch.

describe('createXmlReader', () => {
  it('decodes numeric character references and keeps every attribute as text', () => {
    const parsed = createXmlReader({ trimValues: true }).parse(
      '<x:A xmlns:x="urn:x" Nombre="Cr&#233;dito" CodigoPostal="01000" Folio="000123" Total="10.50"/>'
    ) as { A: Record<string, unknown> };
    expect(parsed.A).toMatchObject({
      '@_Nombre': 'Crédito',
      '@_CodigoPostal': '01000',
      '@_Folio': '000123',
      '@_Total': '10.50',
    });
  });

  it('returns the repeated nodes as an array even when the file has one, and trims only when asked', () => {
    const xml = '<R><Row NumCta=" 100"/></R>';
    const kept = createXmlReader({ trimValues: false, repeated: ['Row'] }).parse(xml) as {
      R: { Row: Array<Record<string, unknown>> };
    };
    expect(kept.R.Row).toEqual([{ '@_NumCta': ' 100' }]);
    const trimmed = createXmlReader({ trimValues: true }).parse(xml) as { R: { Row: Record<string, unknown> } };
    expect(trimmed.R.Row).toEqual({ '@_NumCta': '100' });
  });
});

describe('normalizeAttributeValue', () => {
  it('replaces the three characters XML 1.0 §3.3.3 names with a space and says whether it touched anything', () => {
    expect(normalizeAttributeValue('a\tb\nc\rd')).toEqual({ text: 'a b c d', normalized: true });
    expect(normalizeAttributeValue('clean')).toEqual({ text: 'clean', normalized: false });
  });
});

describe('normalizeAttributes', () => {
  it('normalizes every attribute of the tree, inside arrays too, and leaves text nodes alone', () => {
    const tree = createXmlReader({ trimValues: true, repeated: ['B'] }).parse(
      '<A Nombre="Cr&#233;dito&#10;SA"><B Desc="uno&#9;dos"/><B Desc="tres"/><C>l&#237;nea&#10;dos</C></A>'
    ) as unknown;
    expect(normalizeAttributes(tree)).toEqual({
      A: {
        '@_Nombre': 'Crédito SA',
        B: [{ '@_Desc': 'uno dos' }, { '@_Desc': 'tres' }],
        C: 'línea\ndos',
      },
    });
  });
});

describe('one definition of the reader options', () => {
  it('htmlEntities is set only in src/utils/xml-reader.ts', () => {
    const src = path.join(__dirname, '..', '..', 'src');
    const setters = (fs.readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /htmlEntities\s*:/.test(stripComments(fs.readFileSync(path.join(src, f), 'utf8'))));
    expect(setters).toEqual([path.join('utils', 'xml-reader.ts')]);
  });

  it('the bank-statement and catalogue readers build their parser through it', () => {
    const src = path.join(__dirname, '..', '..', 'src');
    for (const file of [
      path.join('services', 'banking', 'parsers', 'camt053.ts'),
      path.join('services', 'sat', 'anexo24', 'balanza-service.ts'),
    ]) {
      const code = stripComments(fs.readFileSync(path.join(src, file), 'utf8'));
      expect(code, file).not.toMatch(/new\s+XMLParser\s*\(/);
      expect(code, file).toMatch(/createXmlReader\(/);
      expect(code, file).toMatch(/normalizeAttributes\(/);
    }
  });
});
