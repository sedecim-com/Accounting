import { describe, it, expect } from 'vitest';
import { CFDIParser } from '../../src/services/xml-ingestion/cfdi-parser.js';
import { extractPagosCompletos } from '../../src/services/xml-ingestion/cfdi-facts.js';

/**
 * EL COMPLEMENTO DE PAGOS, ENTERO.
 *
 * El sistema leía sólo los `DoctoRelacionado` —el reparto— y de ellos sólo los
 * importes. Faltaban dos cosas, y las dos deciden asientos:
 *
 *  · El nodo `Pago`: su `FechaPago` es la que fija en qué MES el IVA se causa
 *    o se acredita, es decir en qué declaración entra. Su `Monto` es lo que
 *    de verdad salió del banco. Sin ellos, un REP no se puede fechar ni cuadrar.
 *  · `ImpuestosDR`: el IVA que ampara CADA parcialidad, dicho por el propio
 *    SAT. Sin él sólo queda prorratear contra la factura original, que es una
 *    estimación; con él no hace falta estimar nada.
 *
 * Se distingue `undefined` de `0` a propósito: cero significa que la
 * parcialidad no ampara impuesto, y «no vino» obliga a prorratear. Colapsarlos
 * haría que un REP sin el nodo acreditara cero IVA en silencio.
 */

function rep(opts: {
  fechaPago?: string;
  monto: number;
  monedaP?: string;
  tipoCambioP?: number;
  docs: Array<{
    uuid: string;
    pagado: number;
    saldoAnt: number;
    saldoInsoluto: number;
    /** Importe del TrasladoDR de IVA. `undefined` = no se emite el nodo. */
    ivaDR?: number;
    objetoImp?: string;
    monedaDR?: string;
  }>;
  /** Dos nodos Pago en el mismo REP. */
  segundoPago?: { monto: number; docs: Array<{ uuid: string; pagado: number }> };
}): string {
  const doc = (d: (typeof opts.docs)[number]): string => {
    const impuestos =
      d.ivaDR === undefined
        ? ''
        : `<pago20:ImpuestosDR><pago20:TrasladosDR>` +
          `<pago20:TrasladoDR BaseDR="${(d.pagado - d.ivaDR).toFixed(2)}" ImpuestoDR="002" ` +
          `TipoFactorDR="Tasa" TasaOCuotaDR="0.160000" ImporteDR="${d.ivaDR.toFixed(2)}"/>` +
          `</pago20:TrasladosDR></pago20:ImpuestosDR>`;
    return (
      `<pago20:DoctoRelacionado IdDocumento="${d.uuid}" MonedaDR="${d.monedaDR ?? 'MXN'}" ` +
      `NumParcialidad="1" ImpSaldoAnt="${d.saldoAnt}" ImpPagado="${d.pagado}" ` +
      `ImpSaldoInsoluto="${d.saldoInsoluto}" ObjetoImpDR="${d.objetoImp ?? '02'}">` +
      impuestos +
      `</pago20:DoctoRelacionado>`
    );
  };

  const pago2 = opts.segundoPago
    ? `<pago20:Pago FechaPago="2026-08-25T10:00:00" FormaDePagoP="02" MonedaP="MXN" ` +
      `Monto="${opts.segundoPago.monto}">` +
      opts.segundoPago.docs
        .map((d) => doc({ ...d, saldoAnt: d.pagado, saldoInsoluto: 0 }))
        .join('') +
      `</pago20:Pago>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
  xmlns:pago20="http://www.sat.gob.mx/Pagos20"
  Version="4.0" TipoDeComprobante="P" Moneda="XXX" Total="0" SubTotal="0"
  Fecha="2026-08-20T12:00:00" LugarExpedicion="64000" Exportacion="01">
  <cfdi:Emisor Rfc="SIN060101AB1" Nombre="Proveedor" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="Cliente" UsoCFDI="CP01"
    DomicilioFiscalReceptor="64000" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="84111506" Cantidad="1" ClaveUnidad="ACT"
      Descripcion="Pago" ValorUnitario="0" Importe="0" ObjetoImp="01"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0">
      <pago20:Pago FechaPago="${opts.fechaPago ?? '2026-08-20T12:00:00'}"
        FormaDePagoP="03" MonedaP="${opts.monedaP ?? 'MXN'}"
        ${opts.tipoCambioP ? `TipoCambioP="${opts.tipoCambioP}"` : ''}
        Monto="${opts.monto}" NumOperacion="OP-1">
        ${opts.docs.map(doc).join('')}
      </pago20:Pago>
      ${pago2}
    </pago20:Pagos>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

const parse = (xml: string) => new CFDIParser().parse(xml);

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

describe('el nodo Pago, que antes no se leía', () => {
  it('trae fecha, importe, moneda, forma y número de operación', () => {
    const p = extractPagosCompletos(
      parse(rep({ monto: 1160, fechaPago: '2026-08-21T09:30:00', docs: [
        { uuid: UUID_A, pagado: 1160, saldoAnt: 1160, saldoInsoluto: 0 },
      ] }))
    );
    expect(p).toHaveLength(1);
    expect(p[0].fechaPago, 'sin la fecha del pago el asiento no sabe en qué mes va').toBe(
      '2026-08-21T09:30:00'
    );
    expect(p[0].monto).toBe(1160);
    expect(p[0].monedaP).toBe('MXN');
    expect(p[0].formaDePagoP).toBe('03');
    expect(p[0].numOperacion).toBe('OP-1');
  });

  it('un REP con dos pagos son dos hechos, no uno', () => {
    // Aplanarlos en un solo importe —como hace la taxonomía con `A.pagado`—
    // pierde que son dos movimientos de banco, en dos fechas y por dos medios.
    const p = extractPagosCompletos(
      parse(rep({
        monto: 500,
        docs: [{ uuid: UUID_A, pagado: 500, saldoAnt: 1000, saldoInsoluto: 500 }],
        segundoPago: { monto: 500, docs: [{ uuid: UUID_A, pagado: 500 }] },
      }))
    );
    expect(p).toHaveLength(2);
    expect(p[0].formaDePagoP).toBe('03');
    expect(p[1].formaDePagoP, 'cada pago tiene su propio medio').toBe('02');
    expect(p[1].fechaPago).toBe('2026-08-25T10:00:00');
  });

  it('conserva el tipo de cambio cuando el pago es en otra moneda', () => {
    const p = extractPagosCompletos(
      parse(rep({ monto: 100, monedaP: 'USD', tipoCambioP: 17.5, docs: [
        { uuid: UUID_A, pagado: 100, saldoAnt: 100, saldoInsoluto: 0, monedaDR: 'USD' },
      ] }))
    );
    expect(p[0].monedaP).toBe('USD');
    expect(p[0].tipoCambioP).toBe(17.5);
  });
});

describe('ImpuestosDR: el IVA que el SAT dice de cada parcialidad', () => {
  it('lo extrae por documento', () => {
    const p = extractPagosCompletos(
      parse(rep({ monto: 1160, docs: [
        { uuid: UUID_A, pagado: 1160, saldoAnt: 1160, saldoInsoluto: 0, ivaDR: 160 },
      ] }))
    );
    expect(
      p[0].docsRelacionados[0].ivaTrasladadoDR,
      'es el dato del propio SAT: gana sobre cualquier prorrateo nuestro'
    ).toBe(160);
    expect(p[0].docsRelacionados[0].objetoImpDR).toBe('02');
  });

  it('cada documento lleva el suyo, no el del REP', () => {
    const p = extractPagosCompletos(
      parse(rep({ monto: 2320, docs: [
        { uuid: UUID_A, pagado: 1160, saldoAnt: 1160, saldoInsoluto: 0, ivaDR: 160 },
        { uuid: UUID_B, pagado: 1160, saldoAnt: 2320, saldoInsoluto: 1160, ivaDR: 60 },
      ] }))
    );
    expect(p[0].docsRelacionados.map((d) => d.ivaTrasladadoDR)).toEqual([160, 60]);
  });

  it('sin el nodo devuelve undefined, NO cero', () => {
    // La distinción decide el asiento: cero dice «esta parcialidad no ampara
    // impuesto» y se acredita cero con razón; «no vino» obliga a prorratear
    // contra la factura original. Colapsarlos acreditaría cero en silencio.
    const p = extractPagosCompletos(
      parse(rep({ monto: 1160, docs: [
        { uuid: UUID_A, pagado: 1160, saldoAnt: 1160, saldoInsoluto: 0 },
      ] }))
    );
    expect(p[0].docsRelacionados[0].ivaTrasladadoDR).toBeUndefined();
  });

  it('con ImpuestosDR pero SIN traslado de IVA, sigue siendo undefined', () => {
    // El caso que separa de verdad `undefined` de `0`: el nodo viene, pero
    // sólo con un impuesto que no es IVA. Devolver 0 aquí diría «esta
    // parcialidad no ampara IVA», cuando lo que pasa es que el emisor no lo
    // declaró en el complemento y hay que prorratear contra la factura.
    const xml = rep({ monto: 1080, docs: [
      { uuid: UUID_A, pagado: 1080, saldoAnt: 1080, saldoInsoluto: 0, ivaDR: 0 },
    ] }).replace(/ImpuestoDR="002"/, 'ImpuestoDR="003"');
    const p = extractPagosCompletos(parse(xml));
    expect(p[0].docsRelacionados[0].ivaTrasladadoDR).toBeUndefined();
  });

  it('ignora los impuestos que no son IVA', () => {
    // Un TrasladoDR de otro impuesto (IEPS, 003) no es IVA acreditable y no
    // puede sumarse al traspaso de 1135 a 1130.
    const xml = rep({ monto: 1160, docs: [
      { uuid: UUID_A, pagado: 1160, saldoAnt: 1160, saldoInsoluto: 0, ivaDR: 160 },
    ] }).replace(
      '</pago20:TrasladosDR>',
      '<pago20:TrasladoDR BaseDR="1000.00" ImpuestoDR="003" TipoFactorDR="Tasa" ' +
        'TasaOCuotaDR="0.080000" ImporteDR="80.00"/></pago20:TrasladosDR>'
    );
    const p = extractPagosCompletos(parse(xml));
    expect(p[0].docsRelacionados[0].ivaTrasladadoDR, 'el IEPS no se acredita como IVA').toBe(160);
  });
});

describe('lo que ya se leía sigue leyéndose', () => {
  it('la cadena de parcialidades queda intacta', () => {
    const p = extractPagosCompletos(
      parse(rep({ monto: 500, docs: [
        { uuid: UUID_A, pagado: 500, saldoAnt: 1160, saldoInsoluto: 660, ivaDR: 68.97 },
      ] }))
    );
    const d = p[0].docsRelacionados[0];
    expect(d.uuid).toBe(UUID_A);
    expect(d.impSaldoAnt).toBe(1160);
    expect(d.impPagado).toBe(500);
    expect(d.impSaldoInsoluto).toBe(660);
    expect(d.numParcialidad).toBe(1);
    // La invariante que revisa el auditor, y que el sistema debe poder afirmar.
    expect(d.impSaldoAnt - d.impPagado).toBeCloseTo(d.impSaldoInsoluto, 2);
  });
});
