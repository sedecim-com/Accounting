import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InvalidArgumentError } from 'commander';
import type { EntityScope } from '../database/scope.js';
import { t } from '../i18n/index.js';
import {
  CENSUS_TYPES_POLICY_KEY, INGESTIBLE_TYPES, completenessTypes, emptyReading, loadCensus, readMetadata, readXml,
  type CensusReading,
} from '../services/sat-census/census.js';
import { readZip, type ZipEntry } from '../services/sat-census/zip-reader.js';
import { AppError } from '../utils/errors.js';
import { usageError } from './kernel/index.js';
import { palette } from './palette.js';

const c = palette(process.stdout);

// ============================================================
// `mnemosine ingest --kind zip|metadata` (MNE-001-096, #312): the SAT census.
//
// `metadata` loads the census and stops. `zip` loads the census from the XML
// in the package AND hands those XML files back to the caller, which runs
// them through the one ingestion `ingest` already has (dedupe by UUID), never
// a parallel path. The census keeps every type; which ones count toward
// completeness is the panel's (`census_cfdi_types`). Only the types the
// ingestion routes (INGESTIBLE_TYPES) are handed on: payroll is posted by the
// payroll module, not by the AP inbox.
// ============================================================

export const INGEST_KINDS = ['xml', 'zip', 'metadata'] as const;
export type IngestKind = (typeof INGEST_KINDS)[number];

/** Commander parser for `--kind`: a wrong value is a usage error, raised before any prompt. */
export function parseKind(value: string): IngestKind {
  const k = value.toLowerCase();
  if (!(INGEST_KINDS as readonly string[]).includes(k)) {
    throw new InvalidArgumentError(t('ingest.census.bad_kind', { valid: INGEST_KINDS.join(', ') }));
  }
  return k as IngestKind;
}

/** The flags that only mean something to the XML ingestion, which `--kind metadata` never reaches. */
export function refuseIngestionFlags(kind: IngestKind, opts: Record<string, unknown>): void {
  if (kind !== 'metadata') return;
  const flags: [string, unknown][] = [
    ['--auto-post', opts.autoPost === true ? true : undefined], ['--min-confidence', opts.minConfidence],
    ['--max-amount', opts.maxAmount], ['--retry', opts.retry], ['--provider', opts.provider], ['--model', opts.model],
  ];
  const given = flags.filter(([, v]) => v !== undefined).map(([f]) => f);
  if (given.length > 0) throw usageError({ key: 'ingest.census.flag_not_for_metadata', params: { flags: given.join(', ') } });
}

export interface CensusRun {
  /** Everything read, across the files. */
  reading: CensusReading;
  /** XML extracted from a ZIP, ready for the regular ingestion. Empty for metadata. */
  xmlFiles: string[];
}

/** Third-party text (entry names, raw field values) never reaches the terminal with control characters. */
const clean = (s: string | number): string =>
  String(s).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ');

function entriesOf(bytes: Buffer, file: string, accept: (name: string) => boolean): ZipEntry[] {
  try {
    return readZip(bytes, { accept });
  } catch (err) {
    throw new AppError(422, 'SAT_CENSUS_BAD_ZIP', {
      key: 'ingest.census.bad_zip', params: { file: clean(file), detail: clean((err as Error).message) },
    });
  }
}

export async function runCensus(opts: {
  kind: 'zip' | 'metadata'; files: string[]; scope: EntityScope; entityRfc: string;
  dryRun: boolean; loadedBy: string | null;
}): Promise<CensusRun> {
  if (!opts.entityRfc) throw new AppError(422, 'SAT_CENSUS_NO_RFC', { key: 'ingest.census.no_rfc' });
  const total = emptyReading();
  const xmlFiles: string[] = [];
  const loaded: string[] = [];
  let tmp: string | null = null;

  for (const file of opts.files) {
    const name = path.basename(file);
    const bytes = fs.readFileSync(file);
    const isZip = bytes.subarray(0, 2).toString('latin1') === 'PK';
    const reading = emptyReading();
    if (opts.kind === 'metadata') {
      const texts = isZip
        ? entriesOf(bytes, name, (n) => n.toLowerCase().endsWith('.txt'))
        : [{ name, data: bytes }];
      for (const text of texts) readMetadata(text.data.toString('utf8'), opts.entityRfc, reading, text.name);
    } else {
      if (!isZip) throw new AppError(422, 'SAT_CENSUS_NOT_ZIP', { key: 'ingest.census.not_zip', params: { file: clean(name) } });
      for (const entry of entriesOf(bytes, name, (n) => n.toLowerCase().endsWith('.xml'))) {
        const row = readXml(entry.data.toString('utf8'), opts.entityRfc, reading, `${name}/${entry.name}`);
        if (!row || !INGESTIBLE_TYPES.includes(row.cfdiType)) continue;
        // SECURITY: the entry name is third-party data. The file is written
        // inside a directory of our own under a name that starts with its
        // position, so no two entries share one and none escapes the
        // directory; the rest of the name is kept only for display.
        tmp ??= makeTempDir();
        const target = path.join(tmp, `${xmlFiles.length + 1}-${path.basename(entry.name).replace(/[^\w.-]/g, '_')}`);
        fs.writeFileSync(target, entry.data, { flag: 'wx' });
        xmlFiles.push(target);
      }
    }
    total.rows.push(...reading.rows);
    total.foreign += reading.foreign;
    total.invalid.push(...reading.invalid);
    if (!opts.dryRun) {
      const r = await loadCensus(
        opts.scope,
        { source: opts.kind === 'metadata' ? 'metadata' : 'xml', fileName: name,
          sha256: createHash('sha256').update(bytes).digest('hex'), loadedBy: opts.loadedBy },
        reading
      );
      loaded.push(t('ingest.census.loaded', { file: clean(name), inserted: r.inserted, refreshed: r.refreshed }));
    }
  }

  const counted = await completenessTypes({ tenantId: opts.scope.tenantId, entityId: opts.scope.entityId });
  printReading(opts.kind, total, counted);
  for (const line of loaded) console.log(line);
  if (opts.dryRun) console.log(c.dim(t('ingest.census.dry_run')));
  return { reading: total, xmlFiles };
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-sat-zip-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function printReading(kind: string, r: CensusReading, counted: readonly string[]): void {
  const issued = r.rows.filter((x) => x.direction === 'issued').length;
  const months = new Map<string, number>();
  for (const x of r.rows) months.set(x.issuedAt.slice(0, 7), (months.get(x.issuedAt.slice(0, 7)) ?? 0) + 1);
  const inCount = r.rows.filter((x) => counted.includes(x.cfdiType)).length;
  console.log(
    c.bold(`\n${t('ingest.census.title', { kind })}`) +
      `: ${t('ingest.census.summary', { total: r.rows.length, issued, received: r.rows.length - issued })}` +
      c.dim(` · ${t('ingest.census.by_month', { months: [...months].sort().map(([m, n]) => `${m} ${n}`).join(', ') || '—' })}`)
  );
  console.log(c.dim(`  ${t('ingest.census.completeness', {
    counted: inCount, key: CENSUS_TYPES_POLICY_KEY, types: counted.join(','), others: r.rows.length - inCount,
  })}`));
  console.log(c.dim(`  ${t('ingest.census.counts', { foreign: r.foreign, invalid: r.invalid.length })}`));
  for (const bad of r.invalid.slice(0, 20)) {
    const params = Object.fromEntries(Object.entries(bad.params).map(([k, v]) => [k, clean(v)]));
    console.log(c.dim(`  ✘ ${clean(bad.where)}: ${t(bad.key, params)}`));
  }
  if (r.invalid.length > 20) console.log(c.dim(`  ${t('ingest.census.more_invalid', { count: r.invalid.length - 20 })}`));
}
