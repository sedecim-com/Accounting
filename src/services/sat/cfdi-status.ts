import Decimal from 'decimal.js';
import { XMLParser } from 'fast-xml-parser';
import { query } from '../../database/connection.js';
import { config } from '../../config/index.js';
import { withRetry } from '../integrations/base/retry.js';

// ============================================================
// F02 · ESTATUS DE CFDI ANTE EL SAT — el cliente real
//
// ConsultaCFDIService es un servicio PÚBLICO y ANÓNIMO del SAT: no usa
// la e.firma, no pasa por withCredential y no consume cupo de credencial
// — el bloqueo de E3.1/E3.2 nunca le aplicó. El stub anterior respondía
// «Vigente» SIEMPRE en sandbox: un CFDI cancelado por el emisor se
// clasificaba como vigente y el asiento se planeaba encima. Un estatus
// simulado es peor que ninguno; desde F02, apagado significa APAGADO
// (statusMode 'off' → un resultado que lo dice), y encendido significa
// la respuesta del SAT.
//
// El sobre SOAP se arma a mano (fetch nativo + fast-xml-parser para la
// respuesta): una dependencia de cliente SOAP entera para UNA operación
// de un solo parámetro es superficie sin renta.
//
// La expresión impresa lleva el total con seis decimales (tt=...): hay
// registros históricos timbrados con el total sin relleno — si el SAT
// responde «expresión mal formada» (código N-*), se reintenta UNA vez
// con el total tal cual, y el resultado dice cuál funcionó.
// ============================================================

export interface CfdiSatStatus {
  uuid: string;
  codigoEstatus: string;
  estado: string;
  esCancelable: string;
  estatusCancelacion: string | null;
  validacionEFOS: string | null;
  consultedAt: Date;
}

export interface ConsultaCfdiInput {
  emisorRfc: string;
  receptorRfc: string;
  total: string;
  uuid: string;
}

const SOAP_ACTION = 'http://tempuri.org/IConsultaCFDIService/Consulta';

function sobre(expresion: string): string {
  const esc = expresion
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<s:Body><Consulta xmlns="http://tempuri.org/">' +
    `<expresionImpresa>${esc}</expresionImpresa>` +
    '</Consulta></s:Body></s:Envelope>'
  );
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

interface RespuestaSat {
  codigoEstatus: string;
  estado: string;
  esCancelable: string;
  estatusCancelacion: string | null;
  validacionEFOS: string | null;
}

function parseRespuesta(xml: string): RespuestaSat {
  const parser = new XMLParser({ removeNSPrefix: true, parseAttributeValue: false });
  const doc = parser.parse(xml) as Record<string, unknown>;
  // Envelope → Body → ConsultaResponse → ConsultaResult { CodigoEstatus, Estado, EsCancelable, EstatusCancelacion, ValidacionEFOS }
  const body = (doc.Envelope as Record<string, unknown> | undefined)?.Body as Record<string, unknown> | undefined;
  const resp = (body?.ConsultaResponse as Record<string, unknown> | undefined)?.ConsultaResult as
    | Record<string, unknown>
    | undefined;
  if (!resp) {
    throw new Error('Respuesta SAT ilegible: no trae ConsultaResult');
  }
  const texto = (v: unknown): string | null =>
    v === undefined || v === null || v === '' ? null : String(v);
  return {
    codigoEstatus: texto(resp.CodigoEstatus) ?? '',
    estado: texto(resp.Estado) ?? '',
    esCancelable: texto(resp.EsCancelable) ?? '',
    estatusCancelacion: texto(resp.EstatusCancelacion),
    validacionEFOS: texto(resp.ValidacionEFOS),
  };
}

async function consultaUna(
  expresion: string,
  fetchImpl: FetchImpl
): Promise<RespuestaSat> {
  return withRetry(
    async () => {
      const res = await fetchImpl(config.sat.consultaUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: SOAP_ACTION,
        },
        body: sobre(expresion),
      });
      if (!res.ok) {
        throw new Error(`SAT respondió HTTP ${res.status}`);
      }
      return parseRespuesta(await res.text());
    },
    { maxAttempts: 3, initialDelayMs: 1000 }
  );
}

/** «Expresión impresa mal formada»: los códigos N-* que piden reformatear. */
function esExpresionMalFormada(codigo: string): boolean {
  return /^N\s*-\s*60[12]/.test(codigo) || /no encontrado.*expresi/i.test(codigo);
}

export async function consultaCfdi(
  input: ConsultaCfdiInput,
  deps: { fetchImpl?: FetchImpl } = {}
): Promise<CfdiSatStatus> {
  if (config.sat.statusMode === 'off') {
    return {
      uuid: input.uuid,
      codigoEstatus: 'DISABLED',
      estado: 'Consulta SAT deshabilitada',
      esCancelable: '',
      estatusCancelacion: null,
      validacionEFOS: null,
      consultedAt: new Date(),
    };
  }
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));

  const conSeis = new Decimal(input.total).toFixed(6);
  const expr = (tt: string) =>
    `?re=${input.emisorRfc}&rr=${input.receptorRfc}&tt=${tt}&id=${input.uuid}`;

  let r = await consultaUna(expr(conSeis), fetchImpl);
  if (esExpresionMalFormada(r.codigoEstatus)) {
    // Registros históricos timbrados con el total sin relleno: un intento más.
    r = await consultaUna(expr(input.total), fetchImpl);
  }

  return {
    uuid: input.uuid,
    codigoEstatus: r.codigoEstatus,
    estado: r.estado,
    esCancelable: r.esCancelable,
    estatusCancelacion: r.estatusCancelacion,
    validacionEFOS: r.validacionEFOS,
    consultedAt: new Date(),
  };
}

/** El vocabulario de xml_documents.sat_validation_status (005). */
export function toValidationStatus(estado: string): 'valid' | 'cancelled' | 'not_found' | 'error' {
  if (estado === 'Vigente') return 'valid';
  if (estado === 'Cancelado') return 'cancelled';
  if (estado === 'No Encontrado') return 'not_found';
  return 'error';
}

/** El vocabulario exacto que consume el clasificador (cfdi-classifier ClassifyOptions). */
export function toClassifierStatus(
  estado: string
): 'vigente' | 'cancelado' | 'no_encontrado' | 'sin_validar' {
  if (estado === 'Vigente') return 'vigente';
  if (estado === 'Cancelado') return 'cancelado';
  if (estado === 'No Encontrado') return 'no_encontrado';
  return 'sin_validar';
}

export interface RevalidacionResumen {
  consultados: number;
  vigentes: number;
  cancelados: number;
  no_encontrados: number;
  errores: number;
}

/**
 * Barrido de revalidación por entidad: los CFDI sin consultar o con la
 * consulta vieja. Concurrencia acotada (5) y respiro entre lotes: es el
 * servicio público del SAT, no un benchmark.
 */
export async function revalidateEntityCfdis(
  ctx: { entityId: string },
  opts: { limit?: number; staleHours?: number; fetchImpl?: FetchImpl } = {}
): Promise<RevalidacionResumen> {
  const staleHours = opts.staleHours ?? 24;
  const filas = await query<{
    id: string; cfdi_uuid: string; emisor_rfc: string; receptor_rfc: string; total: string;
  }>(
    `SELECT id, cfdi_uuid, emisor_rfc, receptor_rfc, total::text AS total
       FROM xml_documents
      WHERE entity_id = $1
        AND (sat_validated_at IS NULL OR sat_validated_at < NOW() - ($2 || ' hours')::interval)
      ORDER BY sat_validated_at ASC NULLS FIRST
      LIMIT $3`,
    [ctx.entityId, String(staleHours), opts.limit ?? 100]
  );

  const resumen: RevalidacionResumen = {
    consultados: 0, vigentes: 0, cancelados: 0, no_encontrados: 0, errores: 0,
  };
  const LOTE = 5;
  for (let i = 0; i < filas.rows.length; i += LOTE) {
    const lote = filas.rows.slice(i, i + LOTE);
    await Promise.all(
      lote.map(async (fila) => {
        try {
          const st = await consultaCfdi(
            {
              emisorRfc: fila.emisor_rfc,
              receptorRfc: fila.receptor_rfc,
              total: fila.total,
              uuid: fila.cfdi_uuid,
            },
            { fetchImpl: opts.fetchImpl }
          );
          const vs = toValidationStatus(st.estado);
          await query(
            `UPDATE xml_documents
                SET sat_validation_status = $1, sat_estado = $2, sat_validated_at = NOW(),
                    sat_efecto_cancelacion = $3, sat_fecha_cancelacion = NULL
              WHERE id = $4`,
            [vs, st.estado, st.estatusCancelacion, fila.id]
          );
          resumen.consultados += 1;
          if (vs === 'valid') resumen.vigentes += 1;
          else if (vs === 'cancelled') resumen.cancelados += 1;
          else if (vs === 'not_found') resumen.no_encontrados += 1;
          else resumen.errores += 1;
        } catch {
          resumen.errores += 1;
        }
      })
    );
    if (i + LOTE < filas.rows.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return resumen;
}
