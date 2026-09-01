import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import {
  consultaCfdi,
  toValidationStatus,
  toClassifierStatus,
  type FetchImpl,
} from '../../src/services/sat/cfdi-status.js';

// ============================================================
// F02 · El cliente REAL del ConsultaCFDIService, sin red: el fetch se
// inyecta y las respuestas son sobres SOAP de fixture. Lo que se prueba
// es el contrato — el sobre que se manda, el relleno del total, el
// reintento ante «expresión mal formada», y los dos vocabularios de
// salida (el de la columna y el del clasificador).
// ============================================================

const sobreRespuesta = (campos: Record<string, string>) =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
  `<ConsultaResponse xmlns="http://tempuri.org/"><ConsultaResult xmlns:a="http://schemas.datacontract.org/2004/07/Sat.Cfdi">` +
  Object.entries(campos).map(([k, v]) => `<a:${k}>${v}</a:${k}>`).join('') +
  `</ConsultaResult></ConsultaResponse></s:Body></s:Envelope>`;

const respuesta = (campos: Record<string, string>): Response =>
  new Response(sobreRespuesta(campos), { status: 200 });

const ENTRADA = {
  emisorRfc: 'SIN060101AB1',
  receptorRfc: 'XAXX010101000',
  total: '1160.5',
  uuid: 'D5A8C9E1-4B2F-4A6D-9E3C-1F2A3B4C5D6E',
};

describe('consultaCfdi', () => {
  it('manda el sobre con SOAPAction y la expresión impresa con el total a SEIS decimales', async () => {
    const llamadas: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      llamadas.push({ url, init });
      return respuesta({ CodigoEstatus: 'S - Comprobante obtenido satisfactoriamente', Estado: 'Vigente', EsCancelable: 'Cancelable sin aceptación' });
    };
    const st = await consultaCfdi(ENTRADA, { fetchImpl });
    expect(llamadas).toHaveLength(1);
    expect((llamadas[0].init.headers as Record<string, string>).SOAPAction)
      .toBe('http://tempuri.org/IConsultaCFDIService/Consulta');
    const cuerpo = String(llamadas[0].init.body);
    expect(cuerpo).toContain('tt=1160.500000');
    expect(cuerpo).toContain(`id=${ENTRADA.uuid}`);
    // El & de la expresión viaja ESCAPADO: es XML, no una URL.
    expect(cuerpo).toContain('&amp;rr=');
    expect(st.estado).toBe('Vigente');
    expect(st.esCancelable).toBe('Cancelable sin aceptación');
  });

  it('ante «expresión mal formada» (N-601) reintenta UNA vez con el total sin relleno', async () => {
    const cuerpos: string[] = [];
    const fetchImpl: FetchImpl = async (_url, init) => {
      cuerpos.push(String(init.body));
      if (cuerpos.length === 1) {
        return respuesta({ CodigoEstatus: 'N - 601: La expresión impresa proporcionada no es válida', Estado: '' });
      }
      return respuesta({ CodigoEstatus: 'S - ok', Estado: 'Cancelado', EsCancelable: 'No cancelable', EstatusCancelacion: 'Cancelado sin aceptación' });
    };
    const st = await consultaCfdi(ENTRADA, { fetchImpl });
    expect(cuerpos).toHaveLength(2);
    expect(cuerpos[0]).toContain('tt=1160.500000');
    expect(cuerpos[1]).toContain('tt=1160.5&amp;');
    expect(st.estado).toBe('Cancelado');
    expect(st.estatusCancelacion).toBe('Cancelado sin aceptación');
  });

  it('una respuesta sin ConsultaResult es error legible, no un estatus inventado', async () => {
    const fetchImpl: FetchImpl = async () => new Response('<html>mantenimiento</html>', { status: 200 });
    await expect(consultaCfdi(ENTRADA, { fetchImpl })).rejects.toThrow(/ConsultaResult/);
  });

  it('HTTP no-200 se reporta como tal (y withRetry ya agotó sus intentos)', async () => {
    let intentos = 0;
    const fetchImpl: FetchImpl = async () => {
      intentos += 1;
      return new Response('', { status: 500 });
    };
    await expect(consultaCfdi(ENTRADA, { fetchImpl })).rejects.toThrow(/HTTP 500/);
    expect(intentos).toBeGreaterThanOrEqual(3);
  }, 30_000);
});

describe('los dos vocabularios de salida', () => {
  it('columna sat_validation_status: Vigente/Cancelado/No Encontrado/otro', () => {
    expect(toValidationStatus('Vigente')).toBe('valid');
    expect(toValidationStatus('Cancelado')).toBe('cancelled');
    expect(toValidationStatus('No Encontrado')).toBe('not_found');
    expect(toValidationStatus('Consulta SAT deshabilitada')).toBe('error');
  });

  it('clasificador: el vocabulario exacto de ClassifyOptions', () => {
    expect(toClassifierStatus('Vigente')).toBe('vigente');
    expect(toClassifierStatus('Cancelado')).toBe('cancelado');
    expect(toClassifierStatus('No Encontrado')).toBe('no_encontrado');
    expect(toClassifierStatus('lo que sea')).toBe('sin_validar');
  });
});
