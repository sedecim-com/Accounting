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
// SECURITY: the file comes from outside. Before anything is inflated:
//   · every offset and size is checked against the buffer;
//   · each entry's bytes, from its local header to the end of its data, must
//     lie before the central directory and overlap no other entry's, so many
//     central records cannot point at one local header (the overlapping zip
//     bomb): each byte of input is inflated at most once;
//   · each entry's declared size is capped by MAX_ENTRY_BYTES, and the sum of
//     the declared sizes of the entries to be read by `maxTotalBytes`.
// Inflation is then capped by the size each entry declares, so the declared
// totals bound the memory used, and the CRC-32 must match. Entries the caller
// filters out with `accept` are never inflated. Entry names are returned as
// data; the caller never uses them as a path.
// ============================================================

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** A metadata file of a full year of a large taxpayer fits well below this. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
/** What one package may inflate to in all. */
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

export interface ReadZipOptions {
  /** Only entries whose name passes are inflated and returned. */
  accept?: (name: string) => boolean;
  maxTotalBytes?: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

interface Located {
  name: string;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  localAt: number;
  dataAt: number;
}

export function readZip(zip: Buffer, options: ReadZipOptions = {}): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(zip);
  const count = zip.readUInt16LE(eocd + 10);
  const centralAt = zip.readUInt32LE(eocd + 16);
  let at = centralAt;
  const located: Located[] = [];
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

    if (compressed === 0xffffffff || size === 0xffffffff) throw new Error(`ZIP64 is not supported (${name})`);
    need(zip, localAt, 30);
    if (zip.readUInt32LE(localAt) !== LOCAL_SIGNATURE) throw new Error(`Invalid ZIP: broken local header (${name})`);
    const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
    need(zip, dataAt, compressed);
    if (dataAt + compressed > centralAt) throw new Error(`Invalid ZIP: entry overlaps the central directory (${name})`);
    // A directory still claims its bytes, so it takes part in the overlap check.
    located.push({ name, method, crc, compressed, size, localAt, dataAt });
    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw new Error(`Encrypted ZIP entries are not supported (${name})`);
    if (size > MAX_ENTRY_BYTES) throw new Error(`ZIP entry too large (${name}: ${size} bytes)`);
  }

  const byOffset = [...located].sort((a, b) => a.localAt - b.localAt);
  for (let i = 1; i < byOffset.length; i++) {
    const prev = byOffset[i - 1];
    if (byOffset[i].localAt < prev.dataAt + prev.compressed) {
      throw new Error(`Invalid ZIP: overlapping entries (${prev.name}, ${byOffset[i].name})`);
    }
  }

  const wanted = located.filter((e) => !e.name.endsWith('/') && (options.accept?.(e.name) ?? true));
  const maxTotal = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const total = wanted.reduce((sum, e) => sum + e.size, 0);
  if (total > maxTotal) throw new Error(`ZIP too large: its entries inflate to ${total} bytes (limit ${maxTotal})`);

  return wanted.map((e) => {
    const raw = zip.subarray(e.dataAt, e.dataAt + e.compressed);
    let data: Buffer;
    if (e.method === 0) data = Buffer.from(raw);
    else if (e.method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) });
    else throw new Error(`ZIP compression method ${e.method} is not supported (${e.name})`);
    if (data.length !== e.size || crc32(data) !== e.crc) throw new Error(`Corrupt ZIP entry (${e.name})`);
    return { name: e.name, data };
  });
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
