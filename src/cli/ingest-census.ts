import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  emptyReading, loadCensus, parseTypes, readMetadata, readXml, type CensusReading,
} from '../services/sat-census/census.js';
import { readZip } from '../services/sat-census/zip-reader.js';
import { palette } from './palette.js';

const c = palette(process.stdout);

// ============================================================
// `mnemosine ingest --kind zip|metadata` (MNE-001-096, #312): the SAT census.
//
// `metadata` loads the census and stops. `zip` loads the census from the XML
// in the package AND hands those XML files back to the caller, which runs
// them through the one ingestion `ingest` already has (dedupe by UUID), never
// a parallel path. Entries of a type outside `--types` are neither counted
// nor ingested: payroll is posted by the payroll module, not by the AP inbox.
// ============================================================

export type IngestKind = 'xml' | 'zip' | 'metadata';

export function parseKind(kind: string | undefined): IngestKind {
  const k = (kind ?? 'xml').toLowerCase();
  if (k !== 'xml' && k !== 'zip' && k !== 'metadata') {
    throw new Error(`Unknown --kind «${kind}». Valid: xml, zip, metadata`);
  }
  return k;
}

export interface CensusRun {
  reading: CensusReading;
  /** XML extracted from a ZIP, ready for the regular ingestion. Empty for metadata. */
  xmlFiles: string[];
}

export async function runCensus(opts: {
  kind: 'zip' | 'metadata'; files: string[]; entityId: string; entityRfc: string;
  types?: string; dryRun: boolean;
}): Promise<CensusRun> {
  if (!opts.entityRfc) throw new Error('The entity has no RFC: the census cannot tell issued from received');
  const types = parseTypes(opts.types);
  const reading = emptyReading();
  const xmlFiles: string[] = [];
  let tmp: string | null = null;

  for (const file of opts.files) {
    const name = path.basename(file);
    const bytes = fs.readFileSync(file);
    const isZip = bytes.subarray(0, 2).toString('latin1') === 'PK';
    if (opts.kind === 'metadata') {
      const texts = isZip
        ? readZip(bytes).filter((e) => e.name.toLowerCase().endsWith('.txt'))
        : [{ name, data: bytes }];
      for (const t of texts) readMetadata(t.data.toString('utf8'), opts.entityRfc, types, reading, t.name);
      continue;
    }
    if (!isZip) throw new Error(`${name} is not a ZIP file`);
    for (const entry of readZip(bytes)) {
      if (!entry.name.toLowerCase().endsWith('.xml')) continue;
      const where = `${name}/${entry.name}`;
      if (!readXml(entry.data.toString('utf8'), opts.entityRfc, types, reading, where)) continue;
      // SECURITY: the entry name is third-party data; only its base name is
      // kept, inside a directory of our own, so it can never escape it.
      tmp ??= makeTempDir();
      let target = path.join(tmp, path.basename(entry.name));
      if (fs.existsSync(target)) target = path.join(tmp, `${xmlFiles.length}-${path.basename(entry.name)}`);
      fs.writeFileSync(target, entry.data);
      xmlFiles.push(target);
    }
  }

  printReading(opts.kind, reading);
  if (!opts.dryRun && reading.rows.length > 0) {
    const { inserted, refreshed } = await loadCensus(opts.entityId, reading.rows);
    console.log(`Census loaded: ${inserted} new, ${refreshed} already known.`);
  } else if (opts.dryRun) {
    console.log(c.dim('(dry-run: the census was read, not loaded.)'));
  }
  return { reading, xmlFiles };
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-sat-zip-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function printReading(kind: string, r: CensusReading): void {
  const issued = r.rows.filter((x) => x.direction === 'issued').length;
  const months = new Map<string, number>();
  for (const x of r.rows) months.set(x.issuedAt.slice(0, 7), (months.get(x.issuedAt.slice(0, 7)) ?? 0) + 1);
  console.log(
    c.bold(`\nSAT census (${kind})`) +
      `: ${r.rows.length} CFDI (${issued} issued, ${r.rows.length - issued} received)` +
      c.dim(` · by month: ${[...months].sort().map(([m, n]) => `${m} ${n}`).join(', ') || '—'}`)
  );
  console.log(c.dim(
    `  ${r.filteredOut} outside the type filter · ${r.foreign} not this entity's · ${r.invalid.length} invalid`
  ));
  for (const bad of r.invalid.slice(0, 20)) console.log(c.dim(`  ✘ ${bad.where}: ${bad.reason}`));
  if (r.invalid.length > 20) console.log(c.dim(`  … and ${r.invalid.length - 20} more`));
}
