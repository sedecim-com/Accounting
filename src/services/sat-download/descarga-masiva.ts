import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type pg from 'pg';
import { query, withTransaction } from '../../database/connection.js';
import { config } from '../../config/index.js';
import { CredentialError, withCredential } from '../fiscal-credentials/service.js';
import { authenticateWithSat, forgetSatToken, type SatAuthContext, type SatAuthDeps } from './authentication.js';
import { buildSignedRequest, SAT_DOWNLOAD_NS } from './ws-security.js';
import { REQUEST_STATES, requestedDocumentStatus, satCode, type SatRetryClass } from './sat-codes.js';

// ============================================================
// EFIRMA-2 1/2 (#440, MNE-001-142) · THE DESCARGA MASIVA ENGINE
//
// Requests a period's issued or received CFDI (XML or metadata), verifies the
// request until the SAT reports its packages, and downloads a package. The
// commands and the ingest of the packages are EFIRMA-2 2/2.
//
// CONTRACT: SAT Descarga Masiva v1.5 (in production since 2025-05-30): the
// operations SolicitaDescargaEmitidos / SolicitaDescargaRecibidos,
// VerificaSolicitudDescarga and Descargar; the codes and their sources are
// in sat-codes.ts. Every call carries the token of authentication.ts and a
// body signed with the e.firma.
//
// SECURITY: the e.firma is read only inside withCredential (purpose
// 'sat_auth', the use the SAT's own documents give it: every operation
// authenticates the requester by its signature). Each signed call is one
// logged access under the daily cap and efirma_accion_anomalia.
//
// The lifetime limit on identical XML requests (5002) is refused BEFORE the
// call, from the counter of migration 167, never from memory.
// ============================================================

export type Direction = 'issued' | 'received';
export type RequestType = 'CFDI' | 'Metadata';

export const SOLICITA_OPERATIONS: Readonly<Record<Direction, string>> = {
  issued: 'SolicitaDescargaEmitidos',
  received: 'SolicitaDescargaRecibidos',
};
const VERIFY_OPERATION = 'VerificaSolicitudDescarga';
const DOWNLOAD_OPERATION = 'PeticionDescargaMasivaTercerosEntrada';
const REQUEST_TIMEOUT_MS = 60_000;
export const OPEN_STATES = ['accepted', 'in_process'];
/** The SAT answers 5002 to the third identical XML request of a period; migration 167 holds the same number in its CHECK. */
export const LIFETIME_XML_LIMIT = 2;

export interface BulkDownloadDeps extends SatAuthDeps {
  requestUrl?: string;
  verifyUrl?: string;
  downloadUrl?: string;
}

export interface DownloadRequestInput {
  direction: Direction;
  requestType: RequestType;
  /** The SAT's wall-clock datetimes, 'YYYY-MM-DDTHH:mm:ss'. */
  start: string;
  end: string;
}

export interface DownloadRequestState {
  id: string;
  status: string;
  satRequestId: string | null;
  satCode: string | null;
  errorKey: string | null;
  cfdiCount: number | null;
  packageIds: string[];
}

export class SatDownloadError extends Error {
  constructor(message: string, readonly key: string, readonly retry: SatRetryClass, readonly satCode?: string) {
    super(message);
    this.name = 'SatDownloadError';
  }
}

const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false, ignoreAttributes: false, attributeNamePrefix: '' });

type XmlNode = Record<string, unknown> | undefined;
const child = (node: unknown, name: string): XmlNode =>
  node && typeof node === 'object' ? ((node as Record<string, unknown>)[name] as XmlNode) : undefined;
const attr = (node: XmlNode, name: string): string | undefined => {
  const v = node?.[name];
  return typeof v === 'string' ? v : undefined;
};
/** The SAT's text is data: no control characters, bounded. */
const clean = (s: string | undefined): string | null => (s ? s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500) : null);

/** Signs `attrs` into the operation's node, posts it with the token, returns the parsed envelope. */
async function callSat(
  ctx: SatAuthContext, deps: BulkDownloadDeps, url: string, action: string,
  operation: string, node: string, attrs: Record<string, string | undefined>, onSend?: () => void
): Promise<{ header: XmlNode; body: XmlNode }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await authenticateWithSat(ctx, deps);
  const access = { purpose: 'sat_auth' as const, actor: ctx.actor, unattended: ctx.unattended, requestId: ctx.requestId };
  return withCredential(ctx.entityId, ctx.tenantId, access, async (material, cred) => {
    if (cred.rfc !== attrs.RfcSolicitante) {
      throw new SatDownloadError('The active e.firma is not the one this request was made with', 'sat_download.credential_changed', 'ambiguous');
    }
    const signed = buildSignedRequest(material, operation, node, attrs);
    material.key.fill(0);
    material.cer.fill(0);
    material.password = '';
    onSend?.();
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: action,
        Authorization: `WRAP access_token="${token.value}"`,
      },
      body:
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:des="${SAT_DOWNLOAD_NS}" ` +
        `xmlns:xd="http://www.w3.org/2000/09/xmldsig#"><s:Header/><s:Body>${signed}</s:Body></s:Envelope>`,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let envelope: XmlNode;
    try {
      envelope = child(parser.parse(await res.text()), 'Envelope');
    } catch {
      envelope = undefined;
    }
    const body = child(envelope, 'Body');
    if (res.status !== 200 || !body || child(body, 'Fault')) {
      throw new SatDownloadError(`The SAT did not answer ${operation} (HTTP ${res.status})`, 'sat_download.transport_failed', 'ambiguous');
    }
    return { header: child(envelope, 'Header'), body };
  });
}

async function activeRfc(ctx: SatAuthContext): Promise<string> {
  const r = await query<{ rfc: string }>(
    `SELECT rfc FROM fiscal_credentials
      WHERE entity_id = $1 AND tenant_id = $2 AND credential_type = 'efirma' AND status = 'active'`,
    [ctx.entityId, ctx.tenantId]
  );
  if (!r.rows[0]) throw new CredentialError('There is no active e.firma for this entity. Upload it with: mnemosine sat cred add');
  return r.rows[0].rfc;
}

interface QuotaKey { rfc: string; direction: Direction; start: string; end: string }
const QUOTA_WHERE = `tenant_id = $1 AND entity_id = $2 AND rfc = $3 AND direction = $4
   AND request_type = 'CFDI' AND period_start = $5 AND period_end = $6`;
const quotaParams = (ctx: SatAuthContext, k: QuotaKey) => [ctx.tenantId, ctx.entityId, k.rfc, k.direction, k.start, k.end];

/** Takes one of the lifetime slots, or refuses: the CHECK of migration 167 stops the third. */
async function reserveXmlRequest(client: pg.PoolClient, ctx: SatAuthContext, k: QuotaKey): Promise<void> {
  try {
    const r = await client.query(
      `INSERT INTO sat_download_quota (tenant_id, entity_id, rfc, direction, request_type, period_start, period_end, requests_made)
       VALUES ($1, $2, $3, $4, 'CFDI', $5, $6, 1)
       ON CONFLICT ON CONSTRAINT uq_sat_download_quota DO UPDATE
          SET requests_made = sat_download_quota.requests_made + 1, last_at = NOW()
        WHERE sat_download_quota.tenant_id = EXCLUDED.tenant_id
       RETURNING requests_made`,
      quotaParams(ctx, k)
    );
    if (r.rowCount !== 1) throw new SatDownloadError('The request quota could not be reserved', 'sat_download.quota_not_reserved', 'ambiguous');
  } catch (e) {
    if ((e as { code?: string }).code !== '23514') throw e;
    throw new SatDownloadError(
      `The SAT allows two identical XML requests for life, and both were used: ${k.rfc} ${k.direction} ${k.start} – ${k.end}`,
      'sat_download.lifetime_requests_exhausted', 'permanent_quota', '5002'
    );
  }
}

/** Gives the slot back (nothing reached the SAT, or it registered nothing), or fills it (the SAT said 5002). */
async function settleQuota(ctx: SatAuthContext, k: QuotaKey, action: 'release' | 'exhaust'): Promise<void> {
  const exhausted = action === 'exhaust';
  const r = await query(
    `UPDATE sat_download_quota SET requests_made = ${exhausted ? String(LIFETIME_XML_LIMIT) : 'requests_made - 1'}, last_at = NOW()
      WHERE ${QUOTA_WHERE} AND requests_made > 0`,
    quotaParams(ctx, k)
  );
  if (r.rowCount !== 1) throw new Error(`sat_download_quota row missing for ${k.rfc} ${k.direction} ${k.start}`);
}

async function settleRequest(ctx: SatAuthContext, id: string, from: string[], s: Omit<DownloadRequestState, 'id'>, message: string | null): Promise<DownloadRequestState> {
  const r = await query(
    `UPDATE sat_download_requests
        SET status = $4, sat_request_id = COALESCE($5, sat_request_id), sat_code = $6, sat_message = $7,
            error_key = $8, cfdi_count = $9, package_ids = $10, verified_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND entity_id = $3 AND status = ANY($11)`,
    [id, ctx.tenantId, ctx.entityId, s.status, s.satRequestId, s.satCode, message, s.errorKey, s.cfdiCount, s.packageIds, from]
  );
  if (r.rowCount !== 1) throw new Error(`sat_download_requests ${id} is no longer in ${from.join('/')}`);
  return { id, ...s };
}

/** Sends SolicitaDescarga for the period. The request row is written before the call. */
export async function requestDownload(ctx: SatAuthContext, input: DownloadRequestInput, deps: BulkDownloadDeps = {}): Promise<DownloadRequestState> {
  const datetime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
  if (!datetime.test(input.start) || !datetime.test(input.end) || input.start >= input.end) {
    throw new SatDownloadError('The period must be two SAT datetimes (YYYY-MM-DDTHH:mm:ss), start before end', 'sat_download.invalid_period', 'ambiguous');
  }
  const rfc = await activeRfc(ctx);
  const key: QuotaKey = { rfc, direction: input.direction, start: input.start, end: input.end };
  // The slot and the row that explains it commit together: a request row that
  // cannot be written takes no lifetime slot with it.
  const id = await withTransaction(async (client) => {
    if (input.requestType === 'CFDI') await reserveXmlRequest(client, ctx, key);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO sat_download_requests (tenant_id, entity_id, rfc, direction, request_type, period_start, period_end, actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [ctx.tenantId, ctx.entityId, rfc, input.direction, input.requestType, input.start, input.end, ctx.actor]
    );
    return inserted.rows[0].id;
  });
  const operation = SOLICITA_OPERATIONS[input.direction];
  const party = input.direction === 'issued' ? { RfcEmisor: rfc } : { RfcReceptor: rfc };
  const state = requestedDocumentStatus(input.direction, input.requestType);
  let answer: XmlNode;
  let sent = false;
  try {
    const { body } = await callSat(ctx, deps, deps.requestUrl ?? config.sat.descargaMasivaSolicitaUrl,
      `${SAT_DOWNLOAD_NS}/ISolicitaDescargaService/${operation}`, operation, 'solicitud',
      { ...party, RfcSolicitante: rfc, TipoSolicitud: input.requestType, FechaInicial: input.start, FechaFinal: input.end, EstadoComprobante: state },
      () => { sent = true; });
    answer = child(child(body, `${operation}Response`), `${operation}Result`);
  } catch (e) {
    // Once the request left, the slot stays taken: whether the SAT kept it is unknown.
    if (!sent && input.requestType === 'CFDI') await settleQuota(ctx, key, 'release');
    const errorKey = e instanceof SatDownloadError ? e.key
      : e instanceof CredentialError ? 'sat_download.credential_denied' : 'sat_download.transport_failed';
    await settleRequest(ctx, id, ['submitted'], { status: 'failed', satRequestId: null, satCode: null, errorKey, cfdiCount: null, packageIds: [] }, null);
    throw e;
  }
  const code = attr(answer, 'CodEstatus');
  if (code === '300') forgetSatToken(ctx);
  const meaning = satCode(code);
  if (input.requestType === 'CFDI' && (code === '5002' || !meaning.consumesQuota)) {
    await settleQuota(ctx, key, code === '5002' ? 'exhaust' : 'release');
  }
  const status = meaning.outcome === 'ok' ? 'accepted' : meaning.outcome === 'empty' ? 'no_data' : 'rejected';
  return settleRequest(ctx, id, ['submitted'], {
    status,
    satRequestId: meaning.outcome === 'ok' ? attr(answer, 'IdSolicitud') ?? null : null,
    satCode: code ?? null,
    errorKey: meaning.outcome === 'error' ? meaning.key : null,
    cfdiCount: meaning.outcome === 'empty' ? 0 : null,
    packageIds: [],
  }, clean(attr(answer, 'Mensaje')));
}

interface RequestRow { rfc: string; direction: Direction; request_type: RequestType; start: string; end: string; status: string; sat_request_id: string | null; package_ids: string[] }

async function loadRequest(ctx: SatAuthContext, id: string): Promise<RequestRow> {
  const r = await query<RequestRow>(
    `SELECT rfc, direction, request_type, to_char(period_start, 'YYYY-MM-DD"T"HH24:MI:SS') AS start,
            to_char(period_end, 'YYYY-MM-DD"T"HH24:MI:SS') AS "end", status, sat_request_id, package_ids
       FROM sat_download_requests WHERE id = $1 AND tenant_id = $2 AND entity_id = $3`,
    [id, ctx.tenantId, ctx.entityId]
  );
  if (!r.rows[0]) throw new SatDownloadError(`Download request ${id} not found`, 'sat_download.request_not_found', 'ambiguous');
  return r.rows[0];
}

/** Sends VerificaSolicitudDescarga and records the state and the package ids. */
export async function verifyDownload(ctx: SatAuthContext, id: string, deps: BulkDownloadDeps = {}): Promise<DownloadRequestState> {
  const row = await loadRequest(ctx, id);
  if (!row.sat_request_id || !OPEN_STATES.includes(row.status)) {
    throw new SatDownloadError(`Download request ${id} is ${row.status}, not open`, 'sat_download.request_not_open', 'ambiguous');
  }
  const { body } = await callSat(ctx, deps, deps.verifyUrl ?? config.sat.descargaMasivaVerificaUrl,
    `${SAT_DOWNLOAD_NS}/IVerificaSolicitudDescargaService/${VERIFY_OPERATION}`, VERIFY_OPERATION, 'solicitud',
    { IdSolicitud: row.sat_request_id, RfcSolicitante: row.rfc });
  const result = child(child(body, `${VERIFY_OPERATION}Response`), `${VERIFY_OPERATION}Result`);
  const code = attr(result, 'CodEstatus');
  if (code === '300') forgetSatToken(ctx);
  if (code !== '5000') {
    // A 5004 HERE is «the request to verify was not found», not zero rows.
    const c = satCode(code);
    throw new SatDownloadError(`The SAT refused to verify request ${id} (${code})`,
      code === '5004' ? 'sat_download.request_not_found' : c.key, c.retry ?? 'ambiguous', code);
  }
  const requestCode = attr(result, 'CodigoEstadoSolicitud');
  const meaning = satCode(requestCode ?? '5000');
  if (requestCode === '5002' && row.request_type === 'CFDI') {
    await settleQuota(ctx, { rfc: row.rfc, direction: row.direction, start: row.start, end: row.end }, 'exhaust');
  }
  const ids = child(result, 'IdsPaquetes') as unknown;
  const packageIds = (Array.isArray(ids) ? ids : ids === undefined ? [] : [ids]).map(String);
  const status = meaning.outcome === 'empty' ? 'no_data'
    : meaning.outcome === 'error' ? 'rejected'
    : REQUEST_STATES[attr(result, 'EstadoSolicitud') ?? ''] ?? 'error';
  return settleRequest(ctx, id, OPEN_STATES, {
    status,
    satRequestId: null,
    satCode: requestCode ?? code,
    errorKey: meaning.outcome === 'error' ? meaning.key : null,
    cfdiCount: meaning.outcome === 'empty' ? 0 : Number(attr(result, 'NumeroCFDIs') ?? 0),
    packageIds: status === 'finished' ? packageIds : [],
  }, clean(attr(result, 'Mensaje')));
}

export interface DownloadedPackage {
  packageId: string;
  bytes: Buffer;
  sha256: string;
}

/** Sends Descargar for one package of a finished request and returns the ZIP as the SAT sent it. */
export async function downloadPackage(ctx: SatAuthContext, id: string, packageId: string, deps: BulkDownloadDeps = {}): Promise<DownloadedPackage> {
  const row = await loadRequest(ctx, id);
  if (row.status !== 'finished' || !row.package_ids.includes(packageId)) {
    throw new SatDownloadError(`Package ${packageId} is not a package of finished request ${id}`, 'sat_download.package_not_in_request', 'ambiguous');
  }
  const { header, body } = await callSat(ctx, deps, deps.downloadUrl ?? config.sat.descargaMasivaDescargaUrl,
    `${SAT_DOWNLOAD_NS}/IDescargaMasivaTercerosService/Descargar`, DOWNLOAD_OPERATION, 'peticionDescarga',
    { IdPaquete: packageId, RfcSolicitante: row.rfc });
  const code = attr(child(header, 'respuesta'), 'CodEstatus');
  if (code === '300') forgetSatToken(ctx);
  const meaning = satCode(code);
  if (meaning.outcome !== 'ok') {
    throw new SatDownloadError(`The SAT did not deliver package ${packageId} (${code})`,
      meaning.outcome === 'empty' ? 'sat_download.package_not_found' : meaning.key, meaning.retry ?? 'ambiguous', code);
  }
  const packageB64 = child(child(body, 'RespuestaDescargaMasivaTercerosSalida'), 'Paquete') as unknown;
  const bytes = Buffer.from(typeof packageB64 === 'string' ? packageB64 : '', 'base64');
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) {
    throw new SatDownloadError(`Package ${packageId} is not a ZIP`, 'sat_download.package_not_zip', 'ambiguous', code);
  }
  return { packageId, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
