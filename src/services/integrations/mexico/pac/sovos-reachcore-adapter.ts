import { XMLParser } from 'fast-xml-parser';
import { integrationRegistry } from '../../base/registry.js';
import type { IPacAdapter, AdapterContext, AdapterHealthCheck } from '../../base/adapter.interface.js';
import { AccountingError } from '../../../../utils/errors.js';

// ============================================================
// SOVOS · RC Timbre v6.0 (marca «Reachcore»)
//
// PAC propio, NO revendedor: el TimbreFiscalDigital sale con
// RfcProvCertif = ASE0201179X0, que es el RFC de su razón social mexicana
// —Advantage Security, S. de R.L. de C.V.—, con autorización SAT 55267.
// Aviso operativo: en el padrón del SAT hay que buscar «Reachcore» o
// «Advantage Security». Buscar «Sovos» no devuelve nada.
//
// POR QUÉ ESTE SERVICIO Y NO OTRO — la marca «Sovos» cubre TRES pilas y
// dos de ellas exigen la llave privada del contribuyente:
//
//   ✔ RC Timbre v6.0 (go.reachcore.com) · TimbrarComprobante
//     Recibe el XML YA SELLADO por nosotros y sólo agrega el timbre.
//     Valida el sello contra el certificado público que viaja dentro del
//     propio XML. El .key nunca sale de la bóveda. ES ESTE.
//
//   ✘ RC Emisión (Emision60) · EmitirComprobante
//     «Sovos México se encarga de realizar el sello […] empleando el CSD
//     del emisor, que previamente fue configurado». Exige cargarles el CSD.
//
//   ✘ Sovos Compliance Cloud (api-test.sovos.com)
//     Su alta de México pide certificateFileData, certificateFileKey y
//     password. Exige el .cer, el .key Y la contraseña.
//
// Las dos vías descartadas están a un nombre de método de distancia de la
// buena, y comparten nombre comercial: un ejecutivo de cuenta puede vender
// la equivocada. Por eso la prohibición vive en el código
// (METODOS_PROHIBIDOS) y no sólo en el expediente.
//
// TRANSPORTE: todo el ciclo fiscal es SOAP (WCF basicHttpBinding). No hay
// SDK en ningún lenguaje. Sólo la recuperación de documentos ya procesados
// y los reportes son REST.
// ============================================================

export interface SovosCredentials {
  /**
   * ApiKey del portal de Sovos. Puede darse directa o —preferido en
   * despliegue— por el nombre de la variable de entorno que la contiene.
   */
  apiKey?: string;
  apiKeyEnv?: string;
  environment: 'uat' | 'production';
}

/** Los dos ambientes, ambos verificados en la documentación del proveedor. */
const HOSTS = {
  uat: 'https://oat.reachcore.com',
  production: 'https://go.reachcore.com',
} as const;

const RUTA_TIMBRE = '/api/ws/6.0/pacservices/Timbre.svc/basic';
const RUTA_CANCELA = '/api/ws/6.0/pacservices/Cancelacion.svc/basic';
const RUTA_REST = '/api/rest';

/**
 * Nombres de método que NUNCA debe invocar este adaptador porque implican
 * entregarle el CSD a un tercero. La lista existe para que un cambio futuro
 * tropiece con ella, no para documentar.
 */
export const METODOS_PROHIBIDOS = [
  'EmitirComprobante',   // RC Emisión: Sovos sella con el CSD que le cargues
  'Emision.svc',
  'api-test.sovos.com',  // Compliance Cloud: pide .cer, .key y contraseña
  'certificateFileKey',
] as const;

/**
 * El sobre SOAP se arma a mano en vez de cargar el WSDL. Dos razones: cargar
 * el WSDL exige red en el arranque —lo que vuelve intestable el adaptador— y
 * el contrato de un basicHttpBinding es SOAP 1.1 plano, que cabe en una
 * plantilla.
 *
 * ESPACIO DE NOMBRES: es lo ÚNICO de este archivo que no está confirmado
 * contra la documentación pública, porque el WSDL no se pudo descargar sin
 * contrato. Al primer contacto con el ambiente de pruebas hay que leer el
 * targetNamespace del WSDL y ajustar esta constante — es un cambio de una
 * línea, no una reescritura, y por eso está aislada aquí.
 */
export const NS_CONTRATO = 'http://reachcore.com/pacservices';

const LIMITE_BYTES = 10 * 1024 * 1024; // 10 MB, sobre SOAP incluido

/** Códigos de error del servicio que el adaptador entiende. */
const ERR_API_KEY = '101';
const ERR_YA_TIMBRADO = '311';

export interface RespuestaHttp {
  status: number;
  body: string;
}

/** El transporte se inyecta para poder probar sin red. */
export type Transporte = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<RespuestaHttp>;

const transporteFetch: Transporte = async (url, init) => {
  const r = await fetch(url, init);
  return { status: r.status, body: await r.text() };
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
});

export class SovosReachcoreAdapter implements IPacAdapter {
  readonly providerId = 'sovos_reachcore';
  readonly displayName = 'Sovos (Reachcore) · RC Timbre 6.0';
  readonly regions = ['MX'] as const;
  readonly category = 'pac' as const;

  /**
   * NO fabrica nada. Si no puede hablar con Sovos, o si la respuesta no
   * trae un UUID, lanza — nunca inventa un folio. Ésa es exactamente la
   * diferencia entre un adaptador real y un simulador, y es lo que el
   * cerrojo de simulacion.ts consulta.
   */
  readonly simulado = false;

  constructor(private readonly transporte: Transporte = transporteFetch) {}

  // ── Configuración ──

  async configure(config: SovosCredentials, ctx: AdapterContext): Promise<void> {
    if (!config.apiKey && !config.apiKeyEnv) {
      throw new AccountingError(
        'INVALID_CONFIG',
        'Sovos necesita apiKey, o apiKeyEnv con el nombre de la variable de entorno que la contiene.'
      );
    }
    if (config.environment !== 'uat' && config.environment !== 'production') {
      throw new AccountingError(
        'INVALID_CONFIG',
        `Ambiente "${String(config.environment)}" desconocido: usa 'uat' (oat.reachcore.com) o 'production' (go.reachcore.com).`
      );
    }
    if (config.apiKeyEnv && !process.env[config.apiKeyEnv]) {
      throw new AccountingError(
        'INVALID_CONFIG',
        `La variable de entorno ${config.apiKeyEnv} está vacía. Las API keys de Sovos NO son recuperables desde su portal: si se pierde, hay que generar otra.`
      );
    }
    await integrationRegistry.saveCredentials(ctx.tenantId, this.providerId, config, {
      userId: ctx.userId,
      isPrimary: true,
      metadata: { environment: config.environment, autorizacionSat: '55267' },
    });
  }

  async getConfigInfo(ctx: AdapterContext): Promise<Record<string, unknown>> {
    const info = await integrationRegistry.getCredentialInfo(ctx.tenantId, this.providerId);
    const creds = await this.credenciales(ctx).catch(() => null);
    return {
      providerId: this.providerId,
      displayName: this.displayName,
      configured: info !== null,
      environment: creds?.environment ?? null,
      host: creds ? HOSTS[creds.environment] : null,
      razonSocial: 'Advantage Security, S. de R.L. de C.V. (Reachcore)',
      rfcProvCertif: 'ASE0201179X0',
      autorizacionSat: '55267',
      servicio: 'RC Timbre v6.0 — TimbrarComprobante (el XML se sella de nuestro lado)',
    };
  }

  async healthCheck(ctx: AdapterContext): Promise<AdapterHealthCheck> {
    const inicio = Date.now();
    try {
      const creds = await this.credenciales(ctx);
      const r = await this.transporte(`${HOSTS[creds.environment]}${RUTA_REST}/Timbre/saldos`, {
        method: 'POST',
        headers: { RCApiKey: this.apiKey(creds), 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (r.status === 401) {
        return { healthy: false, latencyMs: Date.now() - inicio, error: 'ApiKey inválida (401)' };
      }
      return { healthy: r.status === 200, latencyMs: Date.now() - inicio };
    } catch (e) {
      return { healthy: false, latencyMs: Date.now() - inicio, error: (e as Error).message };
    }
  }

  // ── Timbrado ──

  async stamp(xml: string, ctx: AdapterContext): Promise<{
    uuid: string;
    xml_timbrado: string;
    cadena_original: string;
    fecha_timbrado: Date;
    no_certificado_sat: string;
    sello_sat: string;
  }> {
    const creds = await this.credenciales(ctx);
    const sobre = this.sobreTimbrado(this.apiKey(creds), xml);
    assertTamano(sobre);

    const r = await this.transporte(`${HOSTS[creds.environment]}${RUTA_TIMBRE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `${NS_CONTRATO}/ITimbre/TimbrarComprobante`,
      },
      body: sobre,
    });

    return this.leerTimbre(r);
  }

  /**
   * El sobre. El CFDI va en CDATA: ya viene sellado y su XML no debe
   * reinterpretarse al anidarlo.
   */
  private sobreTimbrado(apiKey: string, xml: string): string {
    // Un CDATA no puede contener «]]>»; partirlo es la forma canónica.
    const seguro = xml.replace(/]]>/g, ']]]]><![CDATA[>');
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cus="${NS_CONTRATO}">
  <s:Body>
    <cus:TimbrarComprobante>
      <cus:ApiKey>${escapar(apiKey)}</cus:ApiKey>
      <cus:Comprobante><![CDATA[${seguro}]]></cus:Comprobante>
    </cus:TimbrarComprobante>
  </s:Body>
</s:Envelope>`;
  }

  /**
   * Lee la respuesta. Toda salida que no traiga UUID es un error: este
   * adaptador no completa nada por su cuenta.
   */
  private leerTimbre(r: RespuestaHttp): {
    uuid: string;
    xml_timbrado: string;
    cadena_original: string;
    fecha_timbrado: Date;
    no_certificado_sat: string;
    sello_sat: string;
  } {
    const doc = parser.parse(r.body) as Record<string, unknown>;
    const cuerpo = buscar(doc, 'TimbrarComprobanteResult') ?? buscar(doc, 'TimbrarComprobanteResponse');

    const error = buscar(doc, 'Error');
    if (error && typeof error === 'object') {
      const e = error as Record<string, unknown>;
      const codigo = String(interno(e, 'Code') ?? '');
      const mensaje = String(e.Message ?? 'error sin mensaje');

      if (codigo === ERR_API_KEY || r.status === 401) {
        throw new AccountingError('PAC_AUTH', `Sovos rechazó la ApiKey (${codigo}): ${mensaje}`);
      }
      if (codigo === ERR_YA_TIMBRADO) {
        // El hash de la cadena original ya fue timbrado. NO se reintenta:
        // reintentar no produce otro UUID, y volver a pedirlo es cómo se
        // duplica un folio. Se recupera el timbre previo.
        throw new AccountingError(
          'PAC_YA_TIMBRADO',
          `Sovos ya timbró este comprobante (311): ${mensaje}. NO retimbrar: ` +
            `recupera el folio con GET ${RUTA_REST}/Timbre/Get?rfcEmisor=…&serie=…&folio=… ` +
            `o por folioOperacion.`
        );
      }
      throw new AccountingError('PAC_ERROR', `Sovos rechazó el comprobante (${codigo}): ${mensaje}`);
    }

    const props = propiedades(doc);
    const uuid = props.get('Timbre.UUID');
    const xmlTimbrado = typeof cuerpo === 'string' ? cuerpo : String(buscar(doc, 'Result') ?? '');

    if (!uuid || !xmlTimbrado) {
      throw new AccountingError(
        'PAC_RESPUESTA_ILEGIBLE',
        `Sovos respondió ${r.status} sin UUID o sin XML timbrado. No se fabrica un folio: ` +
          `revisa el contrato del servicio (targetNamespace del WSDL) antes de reintentar.`
      );
    }

    return {
      uuid,
      xml_timbrado: xmlTimbrado,
      cadena_original: props.get('Timbre.CadenaOriginal') ?? '',
      fecha_timbrado: new Date(props.get('Timbre.FechaTimbrado') ?? Date.now()),
      no_certificado_sat: props.get('Timbre.NoCertificadoSAT') ?? '',
      sello_sat: props.get('Timbre.SelloSAT') ?? '',
    };
  }

  // ── Cancelación ──

  async cancel(
    params: { uuid: string; rfcEmisor: string; reason: '01' | '02' | '03' | '04'; replacementUuid?: string },
    ctx: AdapterContext
  ): Promise<{ status: string; acuse_xml: string }> {
    if (params.reason === '01' && !params.replacementUuid) {
      throw new AccountingError(
        'VALIDATION_FAILED',
        'El motivo 01 exige el UUID del comprobante que sustituye.'
      );
    }
    const creds = await this.credenciales(ctx);

    // CancelarSolicitudFirmada, no Cancelar: la petición la firmamos NOSOTROS.
    // `Cancelar` exige que el CSD esté cargado en Sovos, que es justo lo que
    // este adaptador existe para no hacer.
    const sobre = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cus="${NS_CONTRATO}">
  <s:Body>
    <cus:CancelarSolicitudFirmada>
      <cus:ApiKey>${escapar(this.apiKey(creds))}</cus:ApiKey>
      <cus:RfcEmisor>${escapar(params.rfcEmisor)}</cus:RfcEmisor>
      <cus:Uuid>${escapar(params.uuid)}</cus:Uuid>
      <cus:Motivo>${params.reason}</cus:Motivo>
      ${params.replacementUuid ? `<cus:FolioSustitucion>${escapar(params.replacementUuid)}</cus:FolioSustitucion>` : ''}
    </cus:CancelarSolicitudFirmada>
  </s:Body>
</s:Envelope>`;
    assertTamano(sobre);

    const r = await this.transporte(`${HOSTS[creds.environment]}${RUTA_CANCELA}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `${NS_CONTRATO}/ICancelacion/CancelarSolicitudFirmada`,
      },
      body: sobre,
    });

    const doc = parser.parse(r.body) as Record<string, unknown>;
    const error = buscar(doc, 'Error');
    if (error) {
      throw new AccountingError(
        'PAC_ERROR',
        `Sovos rechazó la cancelación: ${String((error as Record<string, unknown>).Message ?? error)}`
      );
    }

    // La cancelación de Sovos es ASÍNCRONA: devuelve un identificador de
    // seguimiento y el estado definitivo llega después. Quien llame debe
    // tratarla como máquina de estados, no como respuesta final.
    const seguimiento = buscar(doc, 'TrackingId') ?? buscar(doc, 'TransactionId');
    return {
      status: String(buscar(doc, 'Estatus') ?? 'en_proceso'),
      acuse_xml: String(buscar(doc, 'Acuse') ?? seguimiento ?? ''),
    };
  }

  async getRemainingStamps(ctx: AdapterContext): Promise<number> {
    const creds = await this.credenciales(ctx);
    const r = await this.transporte(`${HOSTS[creds.environment]}${RUTA_REST}/Timbre/saldos`, {
      method: 'POST',
      headers: { RCApiKey: this.apiKey(creds), 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (r.status !== 200) {
      throw new AccountingError('PAC_ERROR', `Sovos devolvió ${r.status} al consultar saldos.`);
    }
    // El endpoint es un CONTADOR HISTÓRICO por periodo: devuelve transacciones
    // consumidas, no folios disponibles. No sirve para anticipar el
    // agotamiento de la cuota, y por eso se devuelve -1 en vez de fingir un
    // número: el cortacircuitos no debe creerse un dato que no existe.
    return -1;
  }

  // ── Interno ──

  private async credenciales(ctx: AdapterContext): Promise<SovosCredentials> {
    const c = (await integrationRegistry.loadCredentials(
      ctx.tenantId,
      this.providerId
    )) as SovosCredentials | null;
    if (!c) {
      throw new AccountingError(
        'PAC_NOT_CONFIGURED',
        `Sovos no está configurado para este inquilino. Configúralo con las credenciales del portal de Sovos Reachcore.`
      );
    }
    return c;
  }

  private apiKey(c: SovosCredentials): string {
    const valor = c.apiKeyEnv ? process.env[c.apiKeyEnv] : c.apiKey;
    if (!valor) {
      throw new AccountingError(
        'PAC_NOT_CONFIGURED',
        c.apiKeyEnv
          ? `La variable de entorno ${c.apiKeyEnv} está vacía: sin ApiKey no se puede timbrar.`
          : 'Falta la ApiKey de Sovos.'
      );
    }
    return valor;
  }
}

// ── Utilidades de módulo ──

function assertTamano(sobre: string): void {
  const bytes = Buffer.byteLength(sobre, 'utf8');
  if (bytes > LIMITE_BYTES) {
    throw new AccountingError(
      'PAC_PETICION_GRANDE',
      `El sobre SOAP mide ${(bytes / 1024 / 1024).toFixed(2)} MB y Sovos rechaza más de 10 MB ` +
        `(el límite es del sobre completo, no sólo del XML).`
    );
  }
}

function escapar(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Primera aparición de una clave a cualquier profundidad. */
function buscar(nodo: unknown, clave: string): unknown {
  if (nodo === null || typeof nodo !== 'object') return undefined;
  const o = nodo as Record<string, unknown>;
  if (clave in o) return o[clave];
  for (const v of Object.values(o)) {
    const hallado = buscar(v, clave);
    if (hallado !== undefined) return hallado;
  }
  return undefined;
}

/**
 * El código accionable de un Error.
 *
 * Sovos devuelve DOS niveles: el externo es una categoría en texto
 * («InvalidRequest») y el numérico —101, 203, 311, que es el que decide qué
 * hacer— viaja dentro de InnerErrors. Se prefiere el numérico; el externo
 * queda de respaldo para que el mensaje nunca salga vacío.
 */
function interno(e: Record<string, unknown>, clave: string): unknown {
  const anidado = buscar(e.InnerErrors, clave);
  if (anidado !== undefined && /^\d+$/.test(String(anidado))) return anidado;
  return e[clave] ?? anidado;
}

/**
 * TransactionProperties llega como lista de pares clave-valor. Se aplana a un
 * mapa para leer Timbre.UUID y compañía sin depender del orden.
 */
function propiedades(doc: unknown): Map<string, string> {
  const mapa = new Map<string, string>();
  const props = buscar(doc, 'TransactionProperties');
  if (!props) return mapa;
  const lista = Array.isArray(props) ? props : [props];
  for (const entrada of lista) {
    if (entrada === null || typeof entrada !== 'object') continue;
    const pares = Array.isArray((entrada as Record<string, unknown>).TransactionProperty)
      ? ((entrada as Record<string, unknown>).TransactionProperty as unknown[])
      : [entrada];
    for (const p of pares) {
      if (p === null || typeof p !== 'object') continue;
      const o = p as Record<string, unknown>;
      const k = o.Key ?? o.Name;
      const v = o.Value;
      if (typeof k === 'string' && v !== undefined) mapa.set(k, String(v));
    }
  }
  return mapa;
}

export const sovosReachcoreAdapter = new SovosReachcoreAdapter();
