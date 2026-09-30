import { crc32, inflateRawSync } from 'node:zlib';

// ============================================================
// A MINIMAL ZIP READER, FOR THE PACKAGES THE SAT HANDS OUT.
//
// The SAT portal and its bulk-download service deliver CFDI as ZIP files
// (the XML, or one `~`-separated metadata .txt). Node has no ZIP reader and
// the repo carries no dependency for one, so this reads the central directory
// and inflates each entry with node:zlib: stored (0) and deflate (8) only,
// which is what those packages use. ZIP64, encryption and any other method are
// refused by name instead of read wrong.
//
// SECURITY: the file comes from outside. Every size is checked against the
// buffer before it is read, the inflated size is capped by what the entry
// declares (a zip bomb cannot expand past it) and by MAX_ENTRY_BYTES, and the
// CRC-32 must match. Entry names are returned as data; the caller never uses
// them as a path.
// ============================================================

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** A metadata file of a full year of a large taxpayer fits well below this. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export function readZip(zip: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(zip);
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    need(zip, at, 46);
    if (zip.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw new Error('Invalid ZIP: broken central directory');
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localAt = zip.readUInt32LE(at + 42);
    need(zip, at + 46, nameLength);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if (compressed === 0xffffffff || size === 0xffffffff) throw new Error(`ZIP64 is not supported (${name})`);
    if (flags & 0x1) throw new Error(`Encrypted ZIP entries are not supported (${name})`);
    if (size > MAX_ENTRY_BYTES) throw new Error(`ZIP entry too large (${name}: ${size} bytes)`);

    need(zip, localAt, 30);
    if (zip.readUInt32LE(localAt) !== LOCAL_SIGNATURE) throw new Error(`Invalid ZIP: broken local header (${name})`);
    const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
    need(zip, dataAt, compressed);
    const raw = zip.subarray(dataAt, dataAt + compressed);

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    else throw new Error(`ZIP compression method ${method} is not supported (${name})`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`Corrupt ZIP entry (${name})`);
    entries.push({ name, data });
  }
  return entries;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  // The record is 22 bytes plus a comment of at most 65 535.
  const floor = Math.max(0, zip.length - 22 - 0xffff);
  // A buffer shorter than the record starts the loop below zero and skips it.
  for (let at = zip.length - 22; at >= floor; at--) {
    if (zip.readUInt32LE(at) === EOCD_SIGNATURE) return at;
  }
  throw new Error('Not a ZIP file (no end of central directory)');
}

function need(zip: Buffer, at: number, length: number): void {
  if (at < 0 || at + length > zip.length) throw new Error('Invalid ZIP: truncated');
}
