// ============================================================
// EFIRMA-2 (#440) · THE SAT DESCARGA MASIVA CODES
//
// CONTRACT: every code below is copied from the SAT's own tables, never
// guessed. Sources (consulted 2026-09-30):
//  · «Documentación del Servicio de Solicitud de Descarga Masiva», v1.5,
//    May 2025, in production since 2025-05-30 (SAT portal, Trámites y
//    servicios › Factura electrónica › Documentos relacionados; the copy read
//    was https://ampocdevbuk01a.s3.us-east-1.amazonaws.com/1_WS_Solicitud_Descarga_Masiva_V1_5_VF_89183c42e9.pdf):
//    300–305, 404, 5000, 5001, 5002, 5005, 5012.
//  · «… Servicio Web de Verificación de Descarga Masiva», v1.2, December 2023,
//    https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461175779527&ssbinary=true:
//    5003, 5004, 5011 and the EstadoSolicitud values 1–6.
//  · «… Servicio de Descarga de Solicitudes Exitosas», v1.1, August 2018,
//    https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461174995026&ssbinary=true:
//    5007 (packages live 72 h) and 5008 (a package downloads twice at most).
// The lifetime limit of 5002 is «no solicitar en más de 2 ocasiones el mismo
// periodo» (README of phpcfdi/sat-ws-descarga-masiva for v1.5); the SAT's
// table names the limit without the number. Migration 167 holds it.
//
// The retry class tells the caller what to do, never the engine:
// retryable_transient (try again later), permanent_quota (a SAT limit was
// reached; a new call with the same parameters cannot succeed), permanent
// (the SAT refused this request or credential; retrying repeats the refusal)
// and ambiguous (we cannot tell what the SAT kept: a person looks).
// ============================================================

export type SatRetryClass = 'retryable_transient' | 'permanent_quota' | 'permanent' | 'ambiguous';

export interface SatCode {
  /** Stable machine key; the operator's text is looked up by it. */
  key: string;
  /** ok: accepted; empty: success with zero rows (5004); error: refused. */
  outcome: 'ok' | 'empty' | 'error';
  retry?: SatRetryClass;
  /** false when the SAT refused before registering the request: the quota slot is given back. */
  consumesQuota: boolean;
}

const err = (key: string, retry: SatRetryClass, consumesQuota = false): SatCode => ({
  key: `sat_download.${key}`, outcome: 'error', retry, consumesQuota,
});

export const SAT_CODES: Readonly<Record<string, SatCode>> = {
  '5000': { key: 'sat_download.accepted', outcome: 'ok', consumesQuota: true },
  '5004': { key: 'sat_download.no_data', outcome: 'empty', consumesQuota: true },
  // 300 is also what an expired token gets: one retry with a fresh token, then a person.
  '300': err('user_not_valid', 'ambiguous'),
  '301': err('malformed_xml', 'permanent'),
  '302': err('malformed_seal', 'permanent'),
  '303': err('seal_does_not_match_rfc', 'permanent'),
  '304': err('certificate_revoked_or_expired', 'permanent'),
  '305': err('certificate_invalid', 'permanent'),
  // «realizar nuevamente la petición y si persiste el error levantar un RMA».
  '404': err('unhandled_sat_error', 'retryable_transient', true),
  '5001': err('third_party_not_authorized', 'permanent'),
  '5002': err('lifetime_requests_exhausted', 'permanent_quota', true),
  '5003': err('maximum_results_exceeded', 'permanent_quota', true),
  // An identical request is still active: the SAT kept that one, not this.
  '5005': err('duplicate_request_active', 'ambiguous'),
  '5007': err('package_not_found', 'permanent'),
  '5008': err('package_download_limit', 'permanent_quota'),
  '5011': err('daily_folio_download_limit', 'retryable_transient'),
  '5012': err('cancelled_xml_not_downloadable', 'permanent'),
};

/** A code the table does not know is kept verbatim and treated as ambiguous. */
export function satCode(code: string | undefined): SatCode {
  return (code !== undefined && SAT_CODES[code]) || err('unknown_code', 'ambiguous', true);
}

/** EstadoSolicitud of VerificaSolicitudDescarga. */
export const REQUEST_STATES: Readonly<Record<string, string>> = {
  '1': 'accepted',
  '2': 'in_process',
  '3': 'finished',
  '4': 'error',
  '5': 'rejected',
  '6': 'expired',
};
