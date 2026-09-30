import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  emptyReading, parseTypes, readMetadata, readXml, DEFAULT_CENSUS_TYPES,
} from '../../src/services/sat-census/census.js';
import { parseKind, runCensus } from '../../src/cli/ingest-census.js';
import { makeZip } from './make-zip.js';

// MNE-001-096 (#312): the SAT metadata file and the ZIP of XML enter as the
// census of the period, filtered by type I/E/P by default. The format follows
// the SAT's public specification (owner decision 2026-09-30); every file here
// is synthetic.

const ENTITY = 'XAXX010101000';
const HEADER =
  'Uuid~RfcEmisor~NombreEmisor~RfcReceptor~NombreReceptor~RfcPac~FechaEmision~FechaCertificacionSat~Monto~EfectoComprobante~Estatus~FechaCancelacion';
const row = (uuid: string, issuer: string, receiver: string, type: string, status = '1', cancel = ''): string =>
  `${uuid}~${issuer}~Emisor SA~${receiver}~Receptor SA~SAT970701NN3~2026-08-15 10:00:00~2026-08-15 10:05:00~1160.00~${type}~${status}~${cancel}`;
const U = (n: number): string => `d5a8c9e1-4b2f-4a6d-9e3c-${String(n).padStart(12, '0')}`;
const XML = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-limpieza-1001.xml'), 'utf8');

describe('readMetadata', () => {
  it('reads received, issued and cancelled CFDI, and keeps payroll and transfers out by default', () => {
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
    readMetadata(text, ENTITY, DEFAULT_CENSUS_TYPES, r);
    expect(r.rows.map((x) => [x.uuid, x.direction, x.cfdiType, x.satStatus])).toEqual([
      [U(1), 'received', 'I', 'current'],
      [U(2), 'issued', 'E', 'current'],
      [U(3), 'received', 'P', 'cancelled'],
    ]);
    expect(r.rows[2].cancelledAt).toBe('2026-08-20 09:00:00');
    expect(r.rows[0]).toMatchObject({ issuedAt: '2026-08-15 10:00:00', amount: '1160.00', source: 'metadata' });
    expect(r.filteredOut).toBe(2);
    expect(r.invalid).toEqual([]);
  });

  it('finds the columns by header name, so an added column or another order still reads', () => {
    const text = `EfectoComprobante~Estatus~RfcACuentaTerceros~Monto~FechaEmision~RfcReceptor~RfcEmisor~Uuid\nI~1~~99.5~2026-09-01 08:00:00~${ENTITY}~SIN060101AB1~${U(9).toUpperCase()}`;
    const r = emptyReading();
    readMetadata(text, ENTITY, DEFAULT_CENSUS_TYPES, r);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ uuid: U(9), amount: '99.5', direction: 'received' });
  });

  it('counts what is not the entity, and reports each broken line by number', () => {
    const text = [
      HEADER,
      row(U(1), 'SIN060101AB1', 'AAA010101AAA', 'I'),
      row('not-a-uuid', 'SIN060101AB1', ENTITY, 'I'),
      row(U(3), 'SIN060101AB1', ENTITY, 'I', '7'),
      `${U(4)}~short`,
    ].join('\n');
    const r = emptyReading();
    readMetadata(text, ENTITY, DEFAULT_CENSUS_TYPES, r, 'agosto.txt');
    expect(r.rows).toEqual([]);
    expect(r.foreign).toBe(1);
    expect(r.invalid.map((i) => i.where)).toEqual(['agosto.txt:3', 'agosto.txt:4', 'agosto.txt:5']);
  });

  it('refuses a file that is not SAT metadata instead of loading nothing quietly', () => {
    expect(() => readMetadata('a,b,c\n1,2,3', ENTITY, DEFAULT_CENSUS_TYPES, emptyReading())).toThrow(/not a SAT metadata file/);
  });
});

describe('readXml, parseTypes and parseKind', () => {
  it('reads the census row from the CFDI itself, with no SAT status', () => {
    const r = emptyReading();
    expect(readXml(XML, ENTITY, DEFAULT_CENSUS_TYPES, r, 'p.zip/A.xml')).toBe(true);
    expect(r.rows[0]).toMatchObject({
      uuid: 'd5a8c9e1-4b2f-4a6d-9e3c-1f2a3b4c5d6e', direction: 'received', cfdiType: 'I',
      issuedAt: '2026-08-15 10:00:00', amount: '1160', satStatus: null, source: 'xml',
    });
    expect(readXml('<nope/>', ENTITY, DEFAULT_CENSUS_TYPES, r, 'p.zip/B.xml')).toBe(false);
    expect(r.invalid[0].where).toBe('p.zip/B.xml');
  });

  it('takes I,E,P by default and refuses an unknown type or kind', () => {
    expect(parseTypes(undefined)).toEqual(['I', 'E', 'P']);
    expect(parseTypes('i, n')).toEqual(['I', 'N']);
    expect(() => parseTypes('I,X')).toThrow(/X/);
    expect(parseKind(undefined)).toBe('xml');
    expect(() => parseKind('csv')).toThrow(/csv/);
  });
});

describe('runCensus (dry-run: nothing is loaded)', () => {
  it('extracts from a ZIP only the XML inside the type filter, under a directory of its own', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-spec-'));
    const payroll = XML.replace('TipoDeComprobante="I"', 'TipoDeComprobante="N"').replace('1F2A3B4C5D6E', '1F2A3B4C5D6F');
    const zip = path.join(dir, 'paquete.zip');
    fs.writeFileSync(zip, makeZip([
      { name: '../../escape/A.xml', data: XML }, { name: 'N.xml', data: payroll }, { name: 'leeme.pdf', data: 'x' },
    ]));
    const run = await runCensus({ kind: 'zip', files: [zip], entityId: 'e', entityRfc: ENTITY, dryRun: true });
    expect(run.reading.rows).toHaveLength(1);
    expect(run.reading.filteredOut).toBe(1);
    expect(run.xmlFiles).toHaveLength(1);
    expect(path.basename(run.xmlFiles[0])).toBe('A.xml');
    expect(path.dirname(run.xmlFiles[0])).not.toBe(dir);
    expect(fs.readFileSync(run.xmlFiles[0], 'utf8')).toBe(XML);

    const meta = path.join(dir, 'metadata.zip');
    fs.writeFileSync(meta, makeZip([{ name: 'm.txt', data: `${HEADER}\n${row(U(1), ENTITY, 'SIN060101AB1', 'I')}` }]));
    const m = await runCensus({ kind: 'metadata', files: [meta], entityId: 'e', entityRfc: ENTITY, dryRun: true });
    expect(m.reading.rows.map((x) => x.direction)).toEqual(['issued']);
    expect(m.xmlFiles).toEqual([]);
    await expect(runCensus({ kind: 'zip', files: [meta.replace('.zip', '.txt')], entityId: 'e', entityRfc: '', dryRun: true }))
      .rejects.toThrow(/no RFC/);
    vi.restoreAllMocks();
  });
});
