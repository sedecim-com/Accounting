import { withTransaction } from '../../database/connection.js';
import type { EntityScope } from '../../database/scope.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import type { MessageParams, TranslationKey } from '../../i18n/index.js';
import { getPolicy, type PolicyContext } from '../policy/policy-service.js';
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
//    0 = cancelled. The file may arrive bare (.txt) or inside a ZIP. Records
//    end in CRLF; a bare LF inside a CRLF file is part of a free-text field
//    (a name), not the end of a record, and is read as a space.
// 2. The ZIP of CFDI XML: one comprobante per entry; the census row is read
//    from the XML itself (it carries no SAT status).
//
// Built from the public specification with synthetic fixtures, without a real
// portal sample (owner decision 2026-09-30 on #312); the owner validates it
// with a file of their own and a follow-up task fixes any difference.
//
// EVERY TYPE IS STORED. Which types count toward completeness is the firm's
// judgement: the policy key `census_cfdi_types`, read by `completenessTypes`.
//
// Names (NombreEmisor, NombreReceptor) are third-party text and not needed to
// tell what is missing: they are not stored (data minimisation).
// ============================================================

export const CFDI_TYPES = ['I', 'E', 'T', 'N', 'P'] as const;
export type CfdiType = (typeof CFDI_TYPES)[number];

/**
 * The types the regular ingestion routes: I and E to drafts, P to the payment
 * it settles. Payroll (N) is posted by the payroll module and a transfer (T)
 * carries no transaction to post, so a ZIP never hands those to the AP inbox.
 * This is what the pipeline can process, not what counts as missing.
 */
export const INGESTIBLE_TYPES: readonly CfdiType[] = ['I', 'E', 'P'];

export const CENSUS_TYPES_POLICY_KEY = 'census_cfdi_types';
const TYPES_BY_POLICY_VALUE: Record<string, readonly CfdiType[]> = {
  invoices_and_payments: ['I', 'E', 'P'],
  plus_payroll: ['I', 'E', 'P', 'N'],
  all_types: CFDI_TYPES,
};

/** The CFDI types that count toward completeness for this entity (panel key `census_cfdi_types`). */
export async function completenessTypes(ctx: PolicyContext): Promise<readonly CfdiType[]> {
  const { value } = await getPolicy(ctx, CENSUS_TYPES_POLICY_KEY);
  return TYPES_BY_POLICY_VALUE[value] ?? TYPES_BY_POLICY_VALUE.invoices_and_payments;
}

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

/** A row that did not read, with its reason as a catalog key (rendered by the caller). */
export interface InvalidRow {
  where: string;
  key: TranslationKey;
  params: MessageParams;
}

export interface CensusReading {
  rows: CensusRow[];
  /** Rows where the entity is neither issuer nor receiver. */
  foreign: number;
  invalid: InvalidRow[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/;
const AMOUNT_RE = /^-?\d+(\.\d+)?$/;
const REQUIRED = ['Uuid', 'RfcEmisor', 'RfcReceptor', 'FechaEmision', 'Monto', 'EfectoComprobante', 'Estatus'];

export function emptyReading(): CensusReading {
  return { rows: [], foreign: 0, invalid: [] };
}

/** Splits the records of a metadata file; see the CONTRACT above for the bare LF. */
function metadataRecords(text: string): string[] {
  const body = text.replace(/^﻿/, '');
  if (/^[^\n]*\r\n/.test(body)) return body.split('\r\n').map((r) => r.replace(/[\r\n]/g, ' '));
  return body.split(/\r?\n/);
}

/** Reads a `~` metadata file into `into`. */
export function readMetadata(text: string, entityRfc: string, into: CensusReading, where = 'metadata'): void {
  const lines = metadataRecords(text);
  const header = lines[0].split('~').map((h) => h.trim().toLowerCase());
  const col = (name: string): number => header.indexOf(name.toLowerCase());
  const missing = REQUIRED.filter((n) => col(n) < 0);
  if (missing.length > 0) {
    throw new AppError(422, 'SAT_CENSUS_NOT_METADATA', {
      key: 'ingest.census.not_metadata', params: { file: where, columns: missing.join(', ') },
    });
  }
  const cancelledCol = col('FechaCancelacion');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const f = lines[i].split('~').map((v) => v.trim());
    const at = `${where}:${i + 1}`;
    if (f.length !== header.length) {
      into.invalid.push({
        where: at, key: 'ingest.census.invalid.field_count', params: { found: f.length, expected: header.length },
      });
      continue;
    }
    const status = f[col('Estatus')];
    if (status !== '0' && status !== '1') {
      into.invalid.push({ where: at, key: 'ingest.census.invalid.status', params: { value: status } });
      continue;
    }
    const cancelledAt = status === '0' && cancelledCol >= 0 && DATE_RE.test(f[cancelledCol])
      ? f[cancelledCol].replace('T', ' ') : null;
    add(into, at, entityRfc, {
      uuid: f[col('Uuid')], issuerRfc: f[col('RfcEmisor')], receiverRfc: f[col('RfcReceptor')],
      issuedAt: f[col('FechaEmision')], amount: f[col('Monto')], cfdiType: f[col('EfectoComprobante')],
      satStatus: status === '1' ? 'current' : 'cancelled', cancelledAt, source: 'metadata',
    });
  }
}

/**
 * The `Fecha` attribute of the Comprobante, verbatim. It is the CFDI's own
 * wall-clock time with no zone; a round trip through `Date` reinterprets it in
 * the host's zone and moves a time inside a DST gap by an hour.
 */
function rawIssueDate(xml: string): string {
  const tag = /<(?:[\w-]+:)?Comprobante\b[^>]*>/.exec(xml)?.[0] ?? '';
  return /\sFecha\s*=\s*["']([^"']*)["']/.exec(tag)?.[1] ?? '';
}

/** Reads one CFDI XML into `into`; returns its row, or null when it did not enter. */
export function readXml(xml: string, entityRfc: string, into: CensusReading, where: string): CensusRow | null {
  let cfdi;
  try {
    cfdi = new CFDIParser().parse(xml);
  } catch (err) {
    into.invalid.push({ where, key: 'ingest.census.invalid.xml', params: { detail: (err as Error).message } });
    return null;
  }
  const before = into.rows.length;
  add(into, where, entityRfc, {
    uuid: cfdi.timbreFiscalDigital?.uuid ?? '', issuerRfc: cfdi.emisor.rfc, receiverRfc: cfdi.receptor.rfc,
    issuedAt: rawIssueDate(xml), amount: String(cfdi.total), cfdiType: cfdi.tipoDeComprobante,
    satStatus: null, cancelledAt: null, source: 'xml',
  });
  return into.rows.length > before ? into.rows[into.rows.length - 1] : null;
}

function add(
  into: CensusReading, where: string, entityRfc: string,
  raw: Omit<CensusRow, 'direction' | 'cfdiType'> & { cfdiType: string }
): void {
  const issuerRfc = (raw.issuerRfc ?? '').toUpperCase();
  const receiverRfc = (raw.receiverRfc ?? '').toUpperCase();
  const bad =
    !UUID_RE.test(raw.uuid) ? 'UUID' :
    !RFC_RE.test(issuerRfc) || !RFC_RE.test(receiverRfc) ? 'RFC' :
    !DATE_RE.test(raw.issuedAt) ? 'date' :
    !AMOUNT_RE.test(raw.amount) ? 'amount' :
    !(CFDI_TYPES as readonly string[]).includes(raw.cfdiType) ? 'type' : null;
  if (bad) {
    into.invalid.push({ where, key: 'ingest.census.invalid.field', params: { field: bad } });
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

/** One file loaded: what it was and who loaded it. */
export interface CensusFile {
  source: 'metadata' | 'xml';
  /** Base name, for display only. */
  fileName: string;
  sha256: string;
  loadedBy: string | null;
}

/**
 * Loads the census read from one file for one entity: records the load in
 * `sat_census_loads` (what it covered, as observed) and upserts its rows.
 *
 * SCOPE: the entity must belong to the scope's tenant, and that is checked
 * inside the SQL of every statement, not before it in TypeScript (invariant 4).
 * An entity of another tenant is a 404 and writes nothing.
 *
 * A reload refreshes `last_loaded_at`; a status the source does not state
 * (NULL) never overwrites one it did, a cancellation is never undone by an
 * older file, and a metadata file (the SAT's record) refreshes the columns a
 * ZIP of XML wrote first (migration 163).
 */
export async function loadCensus(
  scope: EntityScope, file: CensusFile, reading: CensusReading
): Promise<{ loadId: string; inserted: number; refreshed: number }> {
  // One row per UUID: the same UUID twice in one statement would make the
  // upsert touch its row twice, which Postgres refuses.
  const byUuid = new Map<string, CensusRow>();
  for (const r of reading.rows) {
    const seen = byUuid.get(r.uuid);
    byUuid.set(r.uuid, seen?.satStatus === 'cancelled' ? seen : r);
  }
  const unique = [...byUuid.values()];
  const dates = unique.map((r) => r.issuedAt).sort();
  const issued = unique.filter((r) => r.direction === 'issued').length;

  return withTransaction(async (client) => {
    const load = await client.query<{ id: string }>(
      `INSERT INTO sat_census_loads
         (entity_id, source, file_name, file_sha256, issued_count, received_count,
          first_issued_at, last_issued_at, foreign_count, invalid_count, loaded_by)
       SELECT le.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
         FROM legal_entities le
        WHERE le.id = $1 AND le.tenant_id = $2
       RETURNING id`,
      [scope.entityId, scope.tenantId, file.source, file.fileName, file.sha256, issued, unique.length - issued,
        dates[0] ?? null, dates[dates.length - 1] ?? null, reading.foreign, reading.invalid.length, file.loadedBy]
    );
    if (load.rows.length === 0) throw new NotFoundError('Legal entity', scope.entityId);
    const loadId = load.rows[0].id;

    let inserted = 0;
    for (let i = 0; i < unique.length; i += 1000) {
      const chunk = unique.slice(i, i + 1000);
      const col = <K extends keyof CensusRow>(k: K): CensusRow[K][] => chunk.map((r) => r[k]);
      const res = await client.query<{ inserted: boolean }>(
        `INSERT INTO sat_cfdi_census AS c
           (entity_id, cfdi_uuid, direction, cfdi_type, issuer_rfc, receiver_rfc,
            issued_at, amount, sat_status, cancelled_at, source, last_load_id)
         SELECT le.id, u.*, $13::uuid
           FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[],
                       $8::timestamp[], $9::numeric[], $10::text[], $11::timestamp[], $12::text[]) AS u
           JOIN legal_entities le ON le.id = $1 AND le.tenant_id = $2
         ON CONFLICT (entity_id, cfdi_uuid) DO UPDATE SET
           sat_status = CASE WHEN c.sat_status = 'cancelled' THEN 'cancelled'
                             ELSE COALESCE(EXCLUDED.sat_status, c.sat_status) END,
           cancelled_at = CASE WHEN c.sat_status = 'cancelled' THEN COALESCE(c.cancelled_at, EXCLUDED.cancelled_at)
                               ELSE COALESCE(EXCLUDED.cancelled_at, c.cancelled_at) END,
           direction = CASE WHEN EXCLUDED.source = 'metadata' THEN EXCLUDED.direction ELSE c.direction END,
           cfdi_type = CASE WHEN EXCLUDED.source = 'metadata' THEN EXCLUDED.cfdi_type ELSE c.cfdi_type END,
           issuer_rfc = CASE WHEN EXCLUDED.source = 'metadata' THEN EXCLUDED.issuer_rfc ELSE c.issuer_rfc END,
           receiver_rfc = CASE WHEN EXCLUDED.source = 'metadata' THEN EXCLUDED.receiver_rfc ELSE c.receiver_rfc END,
           issued_at = CASE WHEN EXCLUDED.source = 'metadata' THEN EXCLUDED.issued_at ELSE c.issued_at END,
           amount = CASE WHEN EXCLUDED.source = 'metadata' THEN EXCLUDED.amount ELSE c.amount END,
           last_loaded_at = NOW(),
           last_load_id = EXCLUDED.last_load_id
         RETURNING (xmax = 0) AS inserted`,
        [scope.entityId, scope.tenantId, col('uuid'), col('direction'), col('cfdiType'), col('issuerRfc'),
          col('receiverRfc'), col('issuedAt'), col('amount'), col('satStatus'), col('cancelledAt'), col('source'),
          loadId]
      );
      if (res.rowCount !== chunk.length) {
        throw new Error(`Census load wrote ${res.rowCount} of ${chunk.length} rows`);
      }
      inserted += res.rows.filter((r) => r.inserted).length;
    }
    return { loadId, inserted, refreshed: unique.length - inserted };
  });
}
