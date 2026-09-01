import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ADAPTADOR DE SOVOS (Reachcore) · RC Timbre v6.0
 *
 * Lo que estas pruebas protegen, por orden de gravedad:
 *
 *  1. Que el adaptador NUNCA fabrique un folio. Si la respuesta no trae
 *     UUID, lanza. Es lo que separa un adaptador real de un simulador, y lo
 *     que el cerrojo de simulacion.ts consulta con `simulado`.
 *  2. Que no se cablee ninguna de las dos vías de Sovos que exigen la llave
 *     privada del contribuyente. Están a un nombre de método de distancia de
 *     la buena y comparten marca comercial.
 *  3. Que un 311 —«ya timbrado»— no se reintente. Reintentar no produce otro
 *     UUID; volver a pedirlo es cómo se duplica un folio.
 */

interface CredencialesDePrueba {
  // Las pruebas de abajo le asignan `null` y una forma con `apiKeyEnv`, asi
  // que el tipo tiene que ser el ancho. Va como interfaz y no como
  // `... as Record<...> | null` en el literal porque el autofix de
  // no-unnecessary-type-assertion borra la asercion y tumba el typecheck de
  // tests; una anotacion sobre un `const` tampoco sirve, el estrechamiento
  // por flujo la deshace. Sobre el tipo de retorno no hay nada que borrar.
  actual: Record<string, unknown> | null;
}

const { credenciales } = vi.hoisted((): { credenciales: CredencialesDePrueba } => ({
  credenciales: {
    actual: { apiKey: 'LLAVE-DE-PRUEBA', environment: 'uat' },
  },
}));

vi.mock('../../src/services/integrations/base/registry.js', () => ({
  integrationRegistry: {
    loadCredentials: vi.fn(async () => credenciales.actual),
    saveCredentials: vi.fn(async () => undefined),
    getCredentialInfo: vi.fn(async () => ({ provider: 'sovos_reachcore' })),
  },
}));

import {
  SovosReachcoreAdapter,
  METODOS_PROHIBIDOS,
  NS_CONTRATO,
  type RespuestaHttp,
} from '../../src/services/integrations/mexico/pac/sovos-reachcore-adapter.js';

const CTX = { tenantId: 'inq-1', userId: 'usr-1' };
const CFDI = '<cfdi:Comprobante Version="4.0" Sello="abc"><cfdi:Emisor Rfc="AAA010101AAA"/></cfdi:Comprobante>';

/** Transporte falso: guarda lo enviado y devuelve lo que se le indique. */
function transporteFalso(respuesta: RespuestaHttp) {
  const llamadas: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const t = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    llamadas.push({ url, headers: init.headers, body: init.body });
    return respuesta;
  };
  return { t, llamadas };
}

const TIMBRE_OK = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
 <s:Body>
  <TimbrarComprobanteResponse>
   <TransactionId>TX-9</TransactionId>
   <Result>&lt;cfdi:Comprobante&gt;timbrado&lt;/cfdi:Comprobante&gt;</Result>
   <TransactionProperties>
     <TransactionProperty><Key>Timbre.UUID</Key><Value>11111111-2222-3333-4444-555555555555</Value></TransactionProperty>
     <TransactionProperty><Key>Timbre.FechaTimbrado</Key><Value>2026-08-26T10:00:00</Value></TransactionProperty>
     <TransactionProperty><Key>Timbre.NoCertificadoSAT</Key><Value>00001000000405428599</Value></TransactionProperty>
     <TransactionProperty><Key>Timbre.CadenaOriginal</Key><Value>||1.1|UUID||</Value></TransactionProperty>
     <TransactionProperty><Key>Timbre.SelloSAT</Key><Value>SELLO-SAT</Value></TransactionProperty>
   </TransactionProperties>
  </TimbrarComprobanteResponse>
 </s:Body>
</s:Envelope>`;

const conError = (codigo: string, mensaje: string): string => `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
 <s:Body><TimbrarComprobanteResponse>
   <TransactionId>TX-9</TransactionId>
   <Error><Code>InvalidRequest</Code><Message>${mensaje}</Message>
     <InnerErrors><Code>${codigo}</Code></InnerErrors></Error>
 </TimbrarComprobanteResponse></s:Body>
</s:Envelope>`;

beforeEach(() => {
  credenciales.actual = { apiKey: 'LLAVE-DE-PRUEBA', environment: 'uat' };
  delete process.env.SOVOS_API_KEY_TEST;
});

describe('no es un simulador', () => {
  it('se declara real: no fabrica el timbre', () => {
    expect(new SovosReachcoreAdapter().simulado).toBe(false);
  });

  it('una respuesta sin UUID lanza en vez de inventar un folio', async () => {
    const { t } = transporteFalso({ status: 200, body: '<s:Envelope xmlns:s="x"><s:Body/></s:Envelope>' });
    await expect(new SovosReachcoreAdapter(t).stamp(CFDI, CTX)).rejects.toThrow(
      /sin UUID o sin XML timbrado/
    );
  });

  it('los saldos no se inventan: el endpoint sólo cuenta consumo histórico', async () => {
    const { t } = transporteFalso({ status: 200, body: '{"Transacciones":42}' });
    // Devolver 42 haría creer al cortacircuitos que quedan 42 folios. No los
    // hay: ese número es lo ya consumido en el periodo.
    expect(await new SovosReachcoreAdapter(t).getRemainingStamps(CTX)).toBe(-1);
  });
});

describe('el sobre SOAP', () => {
  it('manda el CFDI en CDATA y la ApiKey en el cuerpo, no en un encabezado', async () => {
    const { t, llamadas } = transporteFalso({ status: 200, body: TIMBRE_OK });
    await new SovosReachcoreAdapter(t).stamp(CFDI, CTX);

    const env = llamadas[0].body;
    expect(env).toContain('<![CDATA[');
    expect(env).toContain(CFDI);
    expect(env).toContain('<cus:ApiKey>LLAVE-DE-PRUEBA</cus:ApiKey>');
    expect(llamadas[0].headers.SOAPAction).toBe(`${NS_CONTRATO}/ITimbre/TimbrarComprobante`);
    expect(llamadas[0].headers['Content-Type']).toMatch(/text\/xml/);
  });

  it('va al ambiente de pruebas cuando así está configurado', async () => {
    const { t, llamadas } = transporteFalso({ status: 200, body: TIMBRE_OK });
    await new SovosReachcoreAdapter(t).stamp(CFDI, CTX);
    expect(llamadas[0].url).toBe('https://oat.reachcore.com/api/ws/6.0/pacservices/Timbre.svc/basic');

    credenciales.actual = { apiKey: 'K', environment: 'production' };
    const p = transporteFalso({ status: 200, body: TIMBRE_OK });
    await new SovosReachcoreAdapter(p.t).stamp(CFDI, CTX);
    expect(p.llamadas[0].url).toBe('https://go.reachcore.com/api/ws/6.0/pacservices/Timbre.svc/basic');
  });

  it('un CFDI que contenga "]]>" no rompe el CDATA', async () => {
    const { t, llamadas } = transporteFalso({ status: 200, body: TIMBRE_OK });
    await new SovosReachcoreAdapter(t).stamp('<a>x]]>y</a>', CTX);
    // El CDATA se parte en dos en vez de cerrarse antes de tiempo.
    expect(llamadas[0].body).toContain(']]]]><![CDATA[>');
    expect(llamadas[0].body.split('<![CDATA[').length - 1).toBe(2);
  });

  it('rechaza un sobre de más de 10 MB antes de enviarlo', async () => {
    const { t, llamadas } = transporteFalso({ status: 200, body: TIMBRE_OK });
    const enorme = `<a>${'x'.repeat(11 * 1024 * 1024)}</a>`;
    await expect(new SovosReachcoreAdapter(t).stamp(enorme, CTX)).rejects.toThrow(/10 MB/);
    expect(llamadas, 'no debe gastarse el viaje').toHaveLength(0);
  });
});

describe('lectura de la respuesta', () => {
  it('extrae el timbre de TransactionProperties', async () => {
    const { t } = transporteFalso({ status: 200, body: TIMBRE_OK });
    const r = await new SovosReachcoreAdapter(t).stamp(CFDI, CTX);

    expect(r.uuid).toBe('11111111-2222-3333-4444-555555555555');
    expect(r.no_certificado_sat).toBe('00001000000405428599');
    expect(r.cadena_original).toBe('||1.1|UUID||');
    expect(r.sello_sat).toBe('SELLO-SAT');
    expect(r.fecha_timbrado.getFullYear()).toBe(2026);
  });

  it('un 311 dice explícitamente que NO se retimbre', async () => {
    const { t } = transporteFalso({
      status: 200,
      body: conError('311', 'Comprobante timbrado previamente. El hash de la cadena original, ya fue timbrado previamente'),
    });
    await expect(new SovosReachcoreAdapter(t).stamp(CFDI, CTX)).rejects.toThrow(/NO retimbrar/);
  });

  it('el 311 explica por dónde recuperar el folio previo', async () => {
    const { t } = transporteFalso({ status: 200, body: conError('311', 'ya timbrado') });
    try {
      await new SovosReachcoreAdapter(t).stamp(CFDI, CTX);
      throw new Error('debió lanzar');
    } catch (e) {
      expect((e as Error).message).toMatch(/Timbre\/Get\?rfcEmisor/);
      expect((e as Error).message).toMatch(/folioOperacion/);
    }
  });

  it('una ApiKey inválida se distingue de un comprobante rechazado', async () => {
    const { t } = transporteFalso({ status: 200, body: conError('101', 'API Key no válida') });
    await expect(new SovosReachcoreAdapter(t).stamp(CFDI, CTX)).rejects.toThrow(/rechazó la ApiKey/);

    const otro = transporteFalso({ status: 200, body: conError('203', 'Estructura inválida contra Anexo 20') });
    await expect(new SovosReachcoreAdapter(otro.t).stamp(CFDI, CTX)).rejects.toThrow(/rechazó el comprobante \(203\)/);
  });
});

describe('credenciales', () => {
  it('la ApiKey puede venir por variable de entorno', async () => {
    process.env.SOVOS_API_KEY_TEST = 'DESDE-EL-ENTORNO';
    credenciales.actual = { apiKeyEnv: 'SOVOS_API_KEY_TEST', environment: 'uat' };

    const { t, llamadas } = transporteFalso({ status: 200, body: TIMBRE_OK });
    await new SovosReachcoreAdapter(t).stamp(CFDI, CTX);
    expect(llamadas[0].body).toContain('<cus:ApiKey>DESDE-EL-ENTORNO</cus:ApiKey>');
  });

  it('si la variable está vacía no se timbra a ciegas', async () => {
    credenciales.actual = { apiKeyEnv: 'SOVOS_API_KEY_TEST', environment: 'uat' };
    const { t } = transporteFalso({ status: 200, body: TIMBRE_OK });
    await expect(new SovosReachcoreAdapter(t).stamp(CFDI, CTX)).rejects.toThrow(
      /SOVOS_API_KEY_TEST está vacía/
    );
  });

  it('sin configurar, lo dice: no intenta con una llave vacía', async () => {
    credenciales.actual = null;
    const { t } = transporteFalso({ status: 200, body: TIMBRE_OK });
    await expect(new SovosReachcoreAdapter(t).stamp(CFDI, CTX)).rejects.toThrow(/no está configurado/);
  });

  it('configure exige un ambiente conocido', async () => {
    await expect(
      new SovosReachcoreAdapter().configure({ apiKey: 'k', environment: 'prod' as never }, CTX)
    ).rejects.toThrow(/'uat'.*'production'/);
  });
});

describe('la llave privada no se entrega: las dos vías prohibidas', () => {
  const fuente = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'services', 'integrations', 'mexico', 'pac', 'sovos-reachcore-adapter.ts'),
    'utf-8'
  );

  /**
   * La marca «Sovos» cubre tres pilas. Dos exigen subir el .cer y el .key:
   * RC Emisión (EmitirComprobante) y Sovos Compliance Cloud. Usarlas anula
   * la bóveda y la cadena de auditoría de withCredential.
   *
   * Sólo pueden aparecer como PROHIBICIÓN —en la lista o en un comentario—,
   * nunca como una llamada.
   */
  it('ningún método prohibido se invoca', () => {
    for (const prohibido of METODOS_PROHIBIDOS) {
      // Sin regex construida desde la lista: entradas como api-test.sovos.com
      // traen puntos que, sueltos en una regex, casan cualquier carácter. Se
      // busca el LITERAL y se mira qué le sigue — misma pregunta («¿alguien lo
      // invoca?»), sin patrón que pueda ensancharse.
      const invocaciones = fuente
        .split(prohibido)
        .slice(1)
        .filter((resto) => /^\s*\(/.test(resto));
      expect(invocaciones, `${prohibido} no puede llamarse`).toHaveLength(0);
    }
  });

  it('la URL de Compliance Cloud no aparece en ninguna petición', () => {
    // Sí aparece en el comentario que explica por qué está descartada.
    const enPeticion = /(?:url|host|fetch|transporte)[^\n]*api-test\.sovos\.com/i;
    expect(fuente).not.toMatch(enPeticion);
  });

  it('el servicio contratado es Timbre.svc, nunca Emision.svc', () => {
    expect(fuente).toContain('/pacservices/Timbre.svc/basic');
    const rutasEmision = [...fuente.matchAll(/RUTA_\w*\s*=\s*'[^']*Emision\.svc/g)];
    expect(rutasEmision).toHaveLength(0);
  });

  it('la cancelación firma de nuestro lado', async () => {
    const { t, llamadas } = transporteFalso({
      status: 200,
      body: '<s:Envelope xmlns:s="x"><s:Body><CancelarSolicitudFirmadaResponse><TrackingId>TR-1</TrackingId></CancelarSolicitudFirmadaResponse></s:Body></s:Envelope>',
    });
    await new SovosReachcoreAdapter(t).cancel(
      { uuid: 'U-1', rfcEmisor: 'AAA010101AAA', reason: '02' },
      CTX
    );
    // `Cancelar` a secas exige el CSD cargado en Sovos; la variante firmada no.
    expect(llamadas[0].body).toContain('CancelarSolicitudFirmada');
    expect(llamadas[0].headers.SOAPAction).toMatch(/CancelarSolicitudFirmada$/);
  });

  it('el motivo 01 exige el folio que sustituye', async () => {
    const { t } = transporteFalso({ status: 200, body: '<a/>' });
    await expect(
      new SovosReachcoreAdapter(t).cancel(
        { uuid: 'U-1', rfcEmisor: 'AAA010101AAA', reason: '01' },
        CTX
      )
    ).rejects.toThrow(/motivo 01 exige/);
  });
});

describe('identidad ante el SAT', () => {
  it('getConfigInfo nombra la razón social real, no la marca comercial', async () => {
    const info = await new SovosReachcoreAdapter().getConfigInfo(CTX);
    // En el padrón del SAT hay que buscar «Reachcore» o «Advantage Security»:
    // buscar «Sovos» no devuelve nada.
    expect(info.razonSocial).toMatch(/Advantage Security/);
    expect(info.rfcProvCertif).toBe('ASE0201179X0');
    expect(info.autorizacionSat).toBe('55267');
  });
});

describe('un «ya timbrado» no puede hacer failover', () => {
  it('el error 311 lleva el código que el router debe tratar aparte', async () => {
    // Si el router probara con el siguiente PAC, ese sí timbraría: el mismo
    // documento acabaría con DOS folios fiscales ante el SAT, y el segundo
    // no se puede cancelar sin dejar huérfano al primero.
    const { t } = transporteFalso({ status: 200, body: conError('311', 'ya timbrado') });
    try {
      await new SovosReachcoreAdapter(t).stamp(CFDI, CTX);
      throw new Error('debió lanzar');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('PAC_YA_TIMBRADO');
    }
  });
});
