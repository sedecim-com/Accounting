import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InvalidArgumentError } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

const policy = vi.hoisted(() => ({ value: 'invoices_and_payments' }));
vi.mock('../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(async () => ({ key: 'census_cfdi_types', value: policy.value, defined: false })),
}));

import {
  completenessTypes, emptyReading, readMetadata, readXml,
} from '../../src/services/sat-census/census.js';
import { parseKind, refuseIngestionFlags, runCensus } from '../../src/cli/ingest-census.js';
import { entityScope } from '../../src/database/scope.js';
import { setLanguage } from '../../src/i18n/index.js';
import { makeZip } from './make-zip.js';

// MNE-001-096 (#312): the SAT metadata file and the ZIP of XML enter as the
// census of the period, every type kept; which types count toward
// completeness is the panel key `census_cfdi_types` (I/E/P by default). The
// format follows the SAT's public specification (owner decision 2026-09-30);
// every file here is synthetic.

const ENTITY = 'XAXX010101000';
const HEADER =
  'Uuid~RfcEmisor~NombreEmisor~RfcReceptor~NombreReceptor~RfcPac~FechaEmision~FechaCertificacionSat~Monto~EfectoComprobante~Estatus~FechaCancelacion';
const row = (uuid: string, issuer: string, receiver: string, type: string, status = '1', cancel = '', name = 'Emisor SA'): string =>
  `${uuid}~${issuer}~${name}~${receiver}~Receptor SA~SAT970701NN3~2026-08-15 10:00:00~2026-08-15 10:05:00~1160.00~${type}~${status}~${cancel}`;
const U = (n: number): string => `d5a8c9e1-4b2f-4a6d-9e3c-${String(n).padStart(12, '0')}`;
const XML = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-limpieza-1001.xml'), 'utf8');
const xmlWith = (uuidTail: string, type = 'I'): string =>
  XML.replace('TipoDeComprobante="I"', `TipoDeComprobante="${type}"`).replace('1F2A3B4C5D6E', uuidTail);
const SCOPE = entityScope('t', 'e');

afterEach(() => {
  vi.restoreAllMocks();
  policy.value = 'invoices_and_payments';
});

describe('readMetadata', () => {
  it('reads received, issued and cancelled CFDI, and keeps every type, payroll and transfers included', () => {
    const text = '﻿' + [
      HEADER,
      row(U(1), 'SIN060101AB1', ENTITY, 'I'),
      row(U(2), ENTITY, 'SIN060101AB1', 'E'),
      row(U(3), 'SIN060101AB1', ENTITY, 'P', '0', '2026-08-20 09:00:00'),
      row(U(4), ENTITY, 'SIN060101AB1', 'N'),
      row(U(5), ENTITY, 'SIN060101AB1', 'T'),
      '',
    ].join('\r\n');
    const r = emptyReading();
    readMetadata(text, ENTITY, r);
    expect(r.rows.map((x) => [x.uuid, x.direction, x.cfdiType, x.satStatus])).toEqual([
      [U(1), 'received', 'I', 'current'],
      [U(2), 'issued', 'E', 'current'],
      [U(3), 'received', 'P', 'cancelled'],
      [U(4), 'issued', 'N', 'current'],
      [U(5), 'issued', 'T', 'current'],
    ]);
    expect(r.rows[2].cancelledAt).toBe('2026-08-20 09:00:00');
    expect(r.rows[0]).toMatchObject({ issuedAt: '2026-08-15 10:00:00', amount: '1160.00', source: 'metadata' });
    expect(r.invalid).toEqual([]);
  });

  it('reads a bare LF inside a name of a CRLF file as part of the record, not as its end', () => {
    const text = [
      HEADER,
      row(U(1), 'SIN060101AB1', ENTITY, 'I', '1', '', 'Emisor\nen dos renglones SA'),
      row(U(2), 'SIN060101AB1', ENTITY, 'I'),
      '',
    ].join('\r\n');
    const r = emptyReading();
    readMetadata(text, ENTITY, r);
    expect(r.invalid).toEqual([]);
    expect(r.rows.map((x) => x.uuid)).toEqual([U(1), U(2)]);
  });

  it('finds the columns by header name, so an added column or another order still reads', () => {
    const text = `EfectoComprobante~Estatus~RfcACuentaTerceros~Monto~FechaEmision~RfcReceptor~RfcEmisor~Uuid\nI~1~~99.5~2026-09-01 08:00:00~${ENTITY}~SIN060101AB1~${U(9).toUpperCase()}`;
    const r = emptyReading();
    readMetadata(text, ENTITY, r);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ uuid: U(9), amount: '99.5', direction: 'received' });
  });

  it('counts what is not the entity, and reports each broken line by number and reason key', () => {
    const text = [
      HEADER,
      row(U(1), 'SIN060101AB1', 'AAA010101AAA', 'I'),
      row('not-a-uuid', 'SIN060101AB1', ENTITY, 'I'),
      row(U(3), 'SIN060101AB1', ENTITY, 'I', '7'),
      `${U(4)}~short`,
    ].join('\n');
    const r = emptyReading();
    readMetadata(text, ENTITY, r, 'agosto.txt');
    expect(r.rows).toEqual([]);
    expect(r.foreign).toBe(1);
    expect(r.invalid.map((i) => [i.where, i.key])).toEqual([
      ['agosto.txt:3', 'ingest.census.invalid.field'],
      ['agosto.txt:4', 'ingest.census.invalid.status'],
      ['agosto.txt:5', 'ingest.census.invalid.field_count'],
    ]);
  });

  it('refuses a file that is not SAT metadata instead of loading nothing quietly', () => {
    expect(() => readMetadata('a,b,c\n1,2,3', ENTITY, emptyReading())).toThrow(/not a SAT metadata file/);
  });
});

describe('readXml', () => {
  it('reads the census row from the CFDI itself, with no SAT status', () => {
    const r = emptyReading();
    expect(readXml(XML, ENTITY, r, 'p.zip/A.xml')).toMatchObject({
      uuid: 'd5a8c9e1-4b2f-4a6d-9e3c-1f2a3b4c5d6e', direction: 'received', cfdiType: 'I',
      issuedAt: '2026-08-15 10:00:00', amount: '1160', satStatus: null, source: 'xml',
    });
    expect(readXml('<nope/>', ENTITY, r, 'p.zip/B.xml')).toBeNull();
    expect(r.invalid[0]).toMatchObject({ where: 'p.zip/B.xml', key: 'ingest.census.invalid.xml' });
  });

  it('keeps the Fecha as the CFDI prints it, even inside a DST gap of the host zone', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const r = emptyReading();
      const gap = XML.replace('Fecha="2026-08-15T10:00:00"', 'Fecha="2026-03-08T02:30:00"');
      expect(readXml(gap, ENTITY, r, 'gap.xml')?.issuedAt).toBe('2026-03-08 02:30:00');
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe('completenessTypes (panel key census_cfdi_types)', () => {
  it('maps each option to its types, I/E/P by default', async () => {
    const ctx = { tenantId: 't', entityId: 'e' };
    expect(await completenessTypes(ctx)).toEqual(['I', 'E', 'P']);
    policy.value = 'plus_payroll';
    expect(await completenessTypes(ctx)).toEqual(['I', 'E', 'P', 'N']);
    policy.value = 'all_types';
    expect(await completenessTypes(ctx)).toEqual(['I', 'E', 'T', 'N', 'P']);
  });
});

describe('parseKind and refuseIngestionFlags', () => {
  it('refuses an unknown kind as a usage error', () => {
    expect(parseKind('ZIP')).toBe('zip');
    expect(() => parseKind('csv')).toThrow(InvalidArgumentError);
  });

  it('refuses the flags of the XML ingestion with --kind metadata, which ingests nothing', () => {
    expect(() => refuseIngestionFlags('metadata', { autoPost: true, retry: true })).toThrow(
      expect.objectContaining({ exitCode: 2 })
    );
    expect(() => refuseIngestionFlags('metadata', { autoPost: false })).not.toThrow();
    expect(() => refuseIngestionFlags('zip', { autoPost: true, retry: true })).not.toThrow();
  });
});

describe('runCensus (dry-run: nothing is loaded)', () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'census-spec-'));
  }

  it('hands on only the XML the ingestion routes, under a directory of its own', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = tmpDir();
    const zip = path.join(dir, 'paquete.zip');
    fs.writeFileSync(zip, makeZip([
      { name: '../../escape/A.xml', data: XML }, { name: 'N.xml', data: xmlWith('1F2A3B4C5D6F', 'N') },
      { name: 'leeme.pdf', data: 'x' },
    ]));
    const run = await runCensus({ kind: 'zip', files: [zip], scope: SCOPE, entityRfc: ENTITY, dryRun: true, loadedBy: null });
    expect(run.reading.rows.map((x) => x.cfdiType)).toEqual(['I', 'N']);
    expect(run.xmlFiles).toHaveLength(1);
    expect(path.basename(run.xmlFiles[0])).toBe('1-A.xml');
    expect(path.dirname(run.xmlFiles[0])).not.toBe(dir);
    expect(fs.readFileSync(run.xmlFiles[0], 'utf8')).toBe(XML);
  });

  it('never gives two entries of a package the same file', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const zip = path.join(tmpDir(), 'p.zip');
    const docs = [XML, xmlWith('1F2A3B4C5D6F'), xmlWith('1F2A3B4C5D70')];
    fs.writeFileSync(zip, makeZip([
      { name: 'A.xml', data: docs[0] }, { name: '2-A.xml', data: docs[1] }, { name: 'x/A.xml', data: docs[2] },
    ]));
    const run = await runCensus({ kind: 'zip', files: [zip], scope: SCOPE, entityRfc: ENTITY, dryRun: true, loadedBy: null });
    expect(new Set(run.xmlFiles).size).toBe(3);
    expect(run.xmlFiles.map((f) => fs.readFileSync(f, 'utf8'))).toEqual(docs);
  });

  it('with --kind metadata reads only the .txt of a ZIP and never inflates its XML', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = tmpDir();
    const meta = path.join(dir, 'metadata.zip');
    const zip = makeZip([
      { name: 'm.txt', data: `${HEADER}\n${row(U(1), ENTITY, 'SIN060101AB1', 'I')}` },
      { name: 'stray.xml', data: 'hello world, hello world' },
    ], true);
    // Corrupt the stray XML: reading it would fail its CRC.
    const corrupt = Buffer.from(zip);
    const at = corrupt.indexOf('hello world');
    corrupt[at] ^= 0xff;
    fs.writeFileSync(meta, corrupt);
    const m = await runCensus({ kind: 'metadata', files: [meta], scope: SCOPE, entityRfc: ENTITY, dryRun: true, loadedBy: null });
    expect(m.reading.rows.map((x) => x.direction)).toEqual(['issued']);
    expect(m.xmlFiles).toEqual([]);
    await expect(runCensus({ kind: 'zip', files: [meta], scope: SCOPE, entityRfc: '', dryRun: true, loadedBy: null }))
      .rejects.toThrow(/no RFC/);
  });

  it('says how many count toward completeness under the panel key, and strips control characters', async () => {
    setLanguage('en');
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(String(s)); });
    const file = path.join(tmpDir(), 'm.txt');
    fs.writeFileSync(file, [
      HEADER,
      row(U(1), 'SIN060101AB1', ENTITY, 'I'),
      row(U(2), ENTITY, 'SIN060101AB1', 'N'),
      row(U(3), 'SIN060101AB1', ENTITY, 'I', '\u001b[31mX'),
    ].join('\n'));
    await runCensus({ kind: 'metadata', files: [file], scope: SCOPE, entityRfc: ENTITY, dryRun: true, loadedBy: null });
    const text = out.join('\n');
    expect(text).toContain('1 count toward completeness under census_cfdi_types (I,E,P); 1 of other types');
    expect(text).toContain('Estatus «');
    expect(text).not.toContain('\u001b[31m');
  });
});
