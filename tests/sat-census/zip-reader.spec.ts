import { describe, expect, it } from 'vitest';
import { readZip } from '../../src/services/sat-census/zip-reader.js';
import { makeZip } from './make-zip.js';

// MNE-001-096 (#312): the SAT packages are ZIP files and the repo has no ZIP
// dependency. The reader must return the bytes that went in, and refuse what
// it cannot read instead of reading it wrong.

describe('readZip', () => {
  it('reads deflated and stored entries back byte for byte, skipping directories', () => {
    const xml = '<?xml version="1.0"?><a>ñ</a>'.repeat(50);
    for (const store of [false, true]) {
      const entries = readZip(makeZip([{ name: 'dir/', data: '' }, { name: 'dir/A.xml', data: xml }, { name: 'm.txt', data: 'x~y' }], store));
      expect(entries.map((e) => e.name)).toEqual(['dir/A.xml', 'm.txt']);
      expect(entries[0].data.toString('utf8')).toBe(xml);
      expect(entries[1].data.toString('utf8')).toBe('x~y');
    }
  });

  it('refuses something that is not a ZIP, a truncated one and a corrupt entry', () => {
    expect(() => readZip(Buffer.from('Uuid~RfcEmisor'))).toThrow(/Not a ZIP/);
    const zip = makeZip([{ name: 'A.xml', data: 'hello world, hello world' }], true);
    expect(() => readZip(zip.subarray(10))).toThrow(/ZIP/);
    const corrupt = Buffer.from(zip);
    corrupt[31 + 'A.xml'.length] ^= 0xff; // one byte of the stored body
    expect(() => readZip(corrupt)).toThrow(/Corrupt ZIP entry/);
  });

  it('refuses an entry that inflates past the size it declares (zip bomb)', () => {
    const zip = makeZip([{ name: 'A.xml', data: 'a'.repeat(10_000) }]);
    const lying = Buffer.from(zip);
    const central = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    lying.writeUInt32LE(10, central + 24); // declares 10 bytes
    expect(() => readZip(lying)).toThrow();
  });

  it('refuses encryption and methods other than stored and deflate by name', () => {
    const zip = makeZip([{ name: 'A.xml', data: 'abc' }], true);
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const encrypted = Buffer.from(zip);
    encrypted.writeUInt16LE(1, central + 8);
    expect(() => readZip(encrypted)).toThrow(/Encrypted/);
    const bzip = Buffer.from(zip);
    bzip.writeUInt16LE(12, central + 10);
    expect(() => readZip(bzip)).toThrow(/method 12/);
  });
});
