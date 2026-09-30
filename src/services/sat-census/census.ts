import { withTransaction } from '../../database/connection.js';
import { CFDIParser } from '../xml-ingestion/cfdi-parser.js';

// ============================================================
// THE SAT CENSUS: WHAT THE SAT SAYS EXISTS FOR AN ENTITY (MNE-001-096, #312)
//
// CONTRACT: two inputs, both as the SAT publishes them.
//
// 1. The metadata file: plain text, one CFDI per line, fields separated by
//    `~`, with a header line. Source: SAT, «Servicio Web de Descarga Masiva
//    de CFDI y Retenciones», technical documentation v1.5 (metadata package),
//    and the metadata the «Consulta de CFDI» portal exports; read 2026-09-30.
//    Header of that specification:
//      Uuid~RfcEmisor~NombreEmisor~RfcReceptor~NombreReceptor~RfcPac~
//      FechaEmision~FechaCertificacionSat~Monto~EfectoComprobante~Estatus~
//      FechaCancelacion
//    Columns are found BY HEADER NAME, not by position, so a version that adds
//    columns (RfcACuentaTerceros…) still reads. Estatus 1 = current,
//    0 = cancelled. The file may arrive bare (.txt) or inside a ZIP.
// 2. The ZIP of CFDI XML: one comprobante per entry; the census row is read
//    from the XML itself (it carries no SAT status).
//
// Built from the public specification with synthetic fixtures, without a real
// portal sample (owner decision 2026-09-30 on #312); the owner validates it
// with a file of their own and a follow-up task fixes any difference.
//
// Names (NombreEmisor, NombreReceptor) are third-party text and not needed to
// tell what is missing: they are not stored (data minimisation).
// ============================================================

export const CFDI_TYPES = ['I', 'E', 'T', 'N', 'P'] as const;
export type CfdiType = (typeof CFDI_TYPES)[number];
/** Owner decision 2026-09-26 (#312): payroll (N) and transfers (T) are not «missing» by default. */
export const DEFAULT_CENSUS_TYPES: CfdiType[] = ['I', 'E', 'P'];

export interface CensusRow {
  uuid: string;
  direction: 'issued' | 'received';
  cfdiType: CfdiType;
  issuerRfc: string;
  receiverRfc: string;
  /** Wall-clock date as the CFDI prints it: `YYYY-MM-DD HH:MM:SS`. */
  issuedAt: string;
  amount: string;
  satStatus: 'current' | 'cancelled' | null;
  cancelledAt: string | null;
  source: 'metadata' | 'xml';
}

export interface CensusReading {
  rows: CensusRow[];
  /** Rows of a type outside the filter. */
  filteredOut: number;
  /** Rows where the entity is neither issuer nor receiver. */
  foreign: number;
  invalid: { where: string; reason: string }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/;
const AMOUNT_RE = /^-?\d+(\.\d+)?$/;
const REQUIRED = ['Uuid', 'RfcEmisor', 'RfcReceptor', 'FechaEmision', 'Monto', 'EfectoComprobante', 'Estatus'];

export function parseTypes(list: string | undefined): CfdiType[] {
  if (list === undefined) return DEFAULT_CENSUS_TYPES;
  const types = list.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  const unknown = types.filter((t) => !(CFDI_TYPES as readonly string[]).includes(t));
  if (types.length === 0 || unknown.length > 0) {
    throw new Error(`Unknown CFDI type(s): ${unknown.join(', ') || '(empty)'}. Valid: ${CFDI_TYPES.join(', ')}`);
  }
  return types as CfdiType[];
}

export function emptyReading(): CensusReading {
  return { rows: [], filteredOut: 0, foreign: 0, invalid: [] };
}

/** Reads a `~` metadata file into `into`. */
export function readMetadata(text: string, entityRfc: string, types: CfdiType[], into: CensusReading, where = 'metadata'): void {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = lines[0].split('~').map((h) => h.trim().toLowerCase());
  const col = (name: string): number => header.indexOf(name.toLowerCase());
  const missing = REQUIRED.filter((n) => col(n) < 0);
  if (missing.length > 0) {
    throw new Error(`${where}: not a SAT metadata file (missing column(s) ${missing.join(', ')})`);
  }
  const cancelledCol = col('FechaCancelacion');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const f = lines[i].split('~').map((v) => v.trim());
    const at = `${where}:${i + 1}`;
    if (f.length !== header.length) {
      into.invalid.push({ where: at, reason: `${f.length} fields, the header has ${header.length}` });
      continue;
    }
    const status = f[col('Estatus')];
    if (status !== '0' && status !== '1') {
      into.invalid.push({ where: at, reason: `Estatus «${status}» is neither 1 nor 0` });
      continue;
    }
    const cancelledAt = status === '0' && cancelledCol >= 0 && DATE_RE.test(f[cancelledCol]) ? f[cancelledCol] : null;
    add(into, at, entityRfc, types, {
      uuid: f[col('Uuid')], issuerRfc: f[col('RfcEmisor')], receiverRfc: f[col('RfcReceptor')],
      issuedAt: f[col('FechaEmision')], amount: f[col('Monto')], cfdiType: f[col('EfectoComprobante')],
      satStatus: status === '1' ? 'current' : 'cancelled', cancelledAt, source: 'metadata',
    });
  }
}

/** Reads one CFDI XML into `into`; returns true when it passed the filter. */
export function readXml(xml: string, entityRfc: string, types: CfdiType[], into: CensusReading, where: string): boolean {
  let cfdi;
  try {
    cfdi = new CFDIParser().parse(xml);
  } catch (err) {
    into.invalid.push({ where, reason: (err as Error).message });
    return false;
  }
  const before = into.rows.length;
  add(into, where, entityRfc, types, {
    uuid: cfdi.timbreFiscalDigital?.uuid ?? '', issuerRfc: cfdi.emisor.rfc, receiverRfc: cfdi.receptor.rfc,
    issuedAt: wallClock(cfdi.fecha), amount: String(cfdi.total), cfdiType: cfdi.tipoDeComprobante,
    satStatus: null, cancelledAt: null, source: 'xml',
  });
  return into.rows.length > before;
}

function add(
  into: CensusReading, where: string, entityRfc: string, types: CfdiType[],
  raw: Omit<CensusRow, 'direction' | 'cfdiType'> & { cfdiType: string }
): void {
  const issuerRfc = raw.issuerRfc.toUpperCase();
  const receiverRfc = raw.receiverRfc.toUpperCase();
  const bad =
    !UUID_RE.test(raw.uuid) ? 'UUID' :
    !RFC_RE.test(issuerRfc) || !RFC_RE.test(receiverRfc) ? 'RFC' :
    !DATE_RE.test(raw.issuedAt) ? 'date' :
    !AMOUNT_RE.test(raw.amount) ? 'amount' :
    !(CFDI_TYPES as readonly string[]).includes(raw.cfdiType) ? 'type' : null;
  if (bad) {
    into.invalid.push({ where, reason: `invalid ${bad}` });
    return;
  }
  if (!types.includes(raw.cfdiType as CfdiType)) {
    into.filteredOut++;
    return;
  }
  const rfc = entityRfc.toUpperCase();
  if (issuerRfc !== rfc && receiverRfc !== rfc) {
    into.foreign++;
    return;
  }
  into.rows.push({
    ...raw, issuerRfc, receiverRfc, uuid: raw.uuid.toLowerCase(),
    issuedAt: raw.issuedAt.replace('T', ' '), cfdiType: raw.cfdiType as CfdiType,
    direction: issuerRfc === rfc ? 'issued' : 'received',
  });
}

function wallClock(d: Date): string {
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Upserts the census of one entity. A reload refreshes `last_loaded_at`; a
 * status the source does not state (NULL) never overwrites one it did, and a
 * cancellation is never undone by an older file (migration 163).
 */
export async function loadCensus(entityId: string, rows: CensusRow[]): Promise<{ inserted: number; refreshed: number }> {
  // One row per UUID: the same UUID twice in one statement would make the
  // upsert touch its row twice, which Postgres refuses.
  const byUuid = new Map<string, CensusRow>();
  for (const r of rows) {
    const seen = byUuid.get(r.uuid);
    byUuid.set(r.uuid, seen?.satStatus === 'cancelled' ? seen : r);
  }
  const unique = [...byUuid.values()];
  let inserted = 0;
  await withTransaction(async (client) => {
    for (let i = 0; i < unique.length; i += 1000) {
      const chunk = unique.slice(i, i + 1000);
      const col = <K extends keyof CensusRow>(k: K): CensusRow[K][] => chunk.map((r) => r[k]);
      const res = await client.query<{ inserted: boolean }>(
        `INSERT INTO sat_cfdi_census AS c
           (entity_id, cfdi_uuid, direction, cfdi_type, issuer_rfc, receiver_rfc,
            issued_at, amount, sat_status, cancelled_at, source)
         SELECT $1, * FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[],
                                  $7::timestamp[], $8::numeric[], $9::text[], $10::timestamp[], $11::text[])
         ON CONFLICT (entity_id, cfdi_uuid) DO UPDATE SET
           sat_status = CASE WHEN c.sat_status = 'cancelled' THEN 'cancelled'
                             ELSE COALESCE(EXCLUDED.sat_status, c.sat_status) END,
           cancelled_at = CASE WHEN c.sat_status = 'cancelled' THEN c.cancelled_at
                               ELSE COALESCE(EXCLUDED.cancelled_at, c.cancelled_at) END,
           last_loaded_at = NOW()
         WHERE c.entity_id = $1
         RETURNING (xmax = 0) AS inserted`,
        [entityId, col('uuid'), col('direction'), col('cfdiType'), col('issuerRfc'), col('receiverRfc'),
          col('issuedAt'), col('amount'), col('satStatus'), col('cancelledAt'), col('source')]
      );
      if (res.rowCount !== chunk.length) {
        throw new Error(`Census load wrote ${res.rowCount} of ${chunk.length} rows`);
      }
      inserted += res.rows.filter((r) => r.inserted).length;
    }
  });
  return { inserted, refreshed: unique.length - inserted };
}
