import { describe, it, expect } from 'vitest';
import { CFDIParser } from '../../src/services/xml-ingestion/cfdi-parser.js';
import { extractFacts } from '../../src/services/xml-ingestion/cfdi-facts.js';

// ============================================================
// #126 · UN CERO ES UN NÚMERO, NO UNA AUSENCIA
//
// `total_iva_0` salía siempre en 0.00. La causa está una capa más abajo de
// donde se ve: con `parseAttributeValue: true` los atributos del XML llegan
// como NÚMEROS, así que `TasaOCuota="0.000000"` llega como `0` — que es
// falsy. `parseImpuestosList` lo probaba por verdad, no por presencia, y
// borraba la tasa y el importe del traslado.
//
// Borrado ese bit, las DOS copias que reparten el IVA por tasa quedaron cada
// una a medias, y ninguna podía estar entera:
//
//   · `cfdi-parser.calculateTaxBreakdown` se saltaba el traslado completo
//     (`&& t.importe`) y, de llegar, sumaba el importe —que en una tasa 0 %
//     vale cero por definición—. De ahí el 0.00 perpetuo.
//   · `cfdi-facts.extractFacts` sí suma la BASE, y lo dice: «Real 0% rate:
//     the tax amount is 0, what matters is the BASE». Pero como la tasa
//     llegaba `undefined`, `num(undefined)` daba 0 y un `TipoFactor="Exento"`
//     —que no declara tasa ninguna— caía en el mismo cubo que una tasa 0 %.
//
// Ante el SAT son dos renglones distintos y sólo la tasa 0 % da derecho a
// acreditar: el propio tipo ya los separa en `ivaTasaCero` e `importeExento`.
// Reportar un exento como tasa 0 % es declarar acreditamiento de más.
// ============================================================

const parser = new CFDIParser();

const xml = (transfer: string, taxObject = '02'): string => `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0"
  Fecha="2026-08-01T10:00:00" Moneda="MXN" SubTotal="1000.00" Total="1000.00"
  TipoDeComprobante="I" LugarExpedicion="01000">
  <cfdi:Emisor Rfc="PRO010101AAA" Nombre="Proveedor SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="AME010101AAA" Nombre="Acme MX" UsoCFDI="G03"
    DomicilioFiscalReceptor="01000" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="01010101" ClaveUnidad="E48" Cantidad="1"
      Descripcion="Servicio" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="${taxObject}">
      <cfdi:Impuestos>
        <cfdi:Traslados>${transfer}</cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
</cfdi:Comprobante>`;

const ZERO_RATE =
  '<cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.000000" Importe="0.00"/>';
const RATE_16 =
  '<cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>';
const EXEMPT = '<cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Exento"/>';

/** El RFC del receptor: fija la dirección en `extractFacts`. */
const OWN_RFC = 'AME010101AAA';

describe('el cero que el parser borraba', () => {
  it('conserva la tasa y el importe cuando valen cero', () => {
    const t = parser.parse(xml(ZERO_RATE)).conceptos[0].impuestos!.traslados![0];
    // EL DEFECTO DE ORIGEN: los dos filtros por verdad los dejaban en `undefined`,
    // y con ellos se iba el único bit que separa una tasa 0 % de un exento.
    expect(t.tasaOCuota).toBe(0);
    expect(t.importe).toBe(0);
  });

  it('distingue un exento, que de verdad no declara ni tasa ni importe', () => {
    const t = parser.parse(xml(EXEMPT, '01')).conceptos[0].impuestos!.traslados![0];
    expect(t.tipoFactor).toBe('Exento');
    expect(t.tasaOCuota).toBeUndefined();
    expect(t.importe).toBeUndefined();
    // Y su base es un número, no un NaN: `parseFloat(String(undefined))`.
    expect(t.base).toBe(1000);
  });

  it('y una base ausente vale cero, no NaN', () => {
    // Trampa que el arreglo abre y cierra a la vez: mientras el cubo de 0 %
    // sumaba el importe, un `@_Base` ausente daba NaN y no lo notaba nadie.
    // Desde que suma la BASE, ese NaN envenenaría el Decimal de la partida.
    const withoutBase = '<cfdi:Traslado Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.000000" Importe="0.00"/>';
    const t = parser.parse(xml(withoutBase)).conceptos[0].impuestos!.traslados![0];
    expect(t.base).toBe(0);
    expect(parser.calculateTaxBreakdown(parser.parse(xml(withoutBase))).iva_0).toBe('0.0000');
  });
});

describe('el desglose del parser reparte por tasa', () => {
  it('la venta a tasa 0 % declara su BASE, no su importe', () => {
    // El importe de una tasa 0 % es cero por definición. Lo que la DIOT
    // declara —y contra lo que se calcula el acreditamiento proporcional—
    // es la BASE.
    expect(parser.calculateTaxBreakdown(parser.parse(xml(ZERO_RATE))).iva_0).toBe('1000.0000');
  });

  it('y no se confunde con el 16 %, que sí declara su importe', () => {
    const breakdown = parser.calculateTaxBreakdown(parser.parse(xml(RATE_16)));
    expect(breakdown.iva_16).toBe('160.0000');
    expect(breakdown.iva_0).toBe('0.0000');
  });

  it('un exento no cae en el cubo de tasa 0: son dos renglones distintos', () => {
    expect(parser.calculateTaxBreakdown(parser.parse(xml(EXEMPT, '01'))).iva_0).toBe('0.0000');
  });
});

describe('los hechos reparten por tasa la misma factura', () => {
  it('la tasa 0 % llega a `ivaTasaCero` por su base', () => {
    const facts = extractFacts(parser.parse(xml(ZERO_RATE)), OWN_RFC);
    expect(facts.ivaTasaCero).toBe(1000);
    expect(facts.importeExento).toBe(0);
  });

  it('el exento llega a `importeExento`, que es el campo que ya existía para él', () => {
    // `importeExento` se documenta a sí mismo: «does not generate creditable
    // VAT». Sumarlo a `ivaTasaCero` declaraba acreditamiento inexistente.
    const facts = extractFacts(parser.parse(xml(EXEMPT, '01')), OWN_RFC);
    expect(facts.ivaTasaCero).toBe(0);
    expect(facts.importeExento).toBe(1000);
  });

  it('y el 16 % sigue midiéndose por su importe, no por su base', () => {
    const facts = extractFacts(parser.parse(xml(RATE_16)), OWN_RFC);
    expect(facts.ivaTrasladado16).toBe(160);
    expect(facts.ivaTasaCero).toBe(0);
  });
});
