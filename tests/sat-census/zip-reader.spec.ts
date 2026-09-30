import { describe, expect, it } from 'vitest';
import { readZip } from '../../src/services/sat-census/zip-reader.js';
import { makeZip } from './make-zip.js';

// MNE-001-096 (#312): the SAT packages are ZIP files and the repo has no ZIP
// dependency. The reader must return the bytes that went in, and refuse what
// it cannot read instead of reading it wrong.

const CENTRAL = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

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

  it('refuses central records that share one local header (the overlapping zip bomb)', () => {
    const zip = makeZip([{ name: 'A.xml', data: 'a'.repeat(10_000) }, { name: 'B.xml', data: 'b' }]);
    const centrals: number[] = [];
    for (let at = zip.indexOf(CENTRAL); at >= 0; at = zip.indexOf(CENTRAL, at + 1)) centrals.push(at);
    const bomb = Buffer.from(zip);
    bomb.writeUInt32LE(0, centrals[1] + 42); // B's central record points at A's local header
    expect(() => readZip(bomb)).toThrow(/overlapping/);
  });

  it('caps what all the entries inflate to together, and never inflates what the caller filters out', () => {
    const zip = makeZip([{ name: 'A.xml', data: 'a'.repeat(1000) }, { name: 'm.txt', data: 'x~y' }]);
    expect(() => readZip(zip, { maxTotalBytes: 1002 })).toThrow(/too large/);
    const corrupt = Buffer.from(makeZip([{ name: 'A.xml', data: 'hello world' }, { name: 'm.txt', data: 'x~y' }], true));
    corrupt[30 + 'A.xml'.length] ^= 0xff;
    expect(() => readZip(corrupt)).toThrow(/Corrupt/);
    const only = readZip(corrupt, { accept: (n) => n.endsWith('.txt'), maxTotalBytes: 3 });
    expect(only.map((e) => e.data.toString())).toEqual(['x~y']);
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
