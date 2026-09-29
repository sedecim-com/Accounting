import { describe, it, expect } from 'vitest';
import { CFDIParser } from '../../src/services/xml-ingestion/cfdi-parser.js';

// #299 (MNE-001-031): SAT keys and identifiers are text. With
// `parseAttributeValue: true` the postal code 01000 was stored as 1000 and the
// folio 000123 as 123. And #218: accents written as numeric character
// references must be decoded, and `&#10;` read as a space (XML 1.0 §3.3.3).
// Every accent below is a NUMERIC reference on purpose: `&amp;` is decoded
// even by the broken configuration, so a test written with it proves nothing.

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" xmlns:pago20="http://www.sat.gob.mx/Pagos20"
  Version="4.0" Serie="007" Folio="000123" Fecha="2026-08-20T10:00:00" FormaPago="03" MetodoPago="PUE" TipoDeComprobante="I" Moneda="MXN" SubTotal="1000.50" Total="1160.58" LugarExpedicion="01000">
  <cfdi:CfdiRelacionados TipoRelacion="07">
    <cfdi:CfdiRelacionado UUID="11111111-2222-3333-4444-555555555555"/>
  </cfdi:CfdiRelacionados>
  <cfdi:Emisor Rfc="SIN060101AB1" Nombre="Servicios Pe&#241;a&#10;SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="Cr&#233;dito&#10;SA" UsoCFDI="G03" DomicilioFiscalReceptor="01000" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="01010101" ClaveUnidad="E48" NoIdentificacion="000789" Descripcion="Asesor&#237;a&#9;contable" Cantidad="1" ValorUnitario="1000.50" Importe="1000.50" ObjetoImp="02">
      <cfdi:Impuestos>
        <cfdi:Traslados>
          <cfdi:Traslado Base="1000.50" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.08"/>
        </cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="160.08">
    <cfdi:Traslados>
      <cfdi:Traslado Base="1000.50" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.08"/>
    </cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0">
      <pago20:Pago FechaPago="2026-08-20T10:00:00" FormaDePagoP="03" MonedaP="MXN" Monto="1160.58" NumOperacion="000456"/>
    </pago20:Pagos>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80" FechaTimbrado="2026-08-20T10:05:00" RfcProvCertif="SAT970701NN3" SelloCFD="s" NoCertificadoSAT="00001000000500000001" SelloSAT="t"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

const cfdi = new CFDIParser().parse(XML);

describe('CFDIParser · SAT keys and identifiers keep their leading zeros (#299)', () => {
  const payment = (cfdi.complementos.find((c) => c.type === 'Pagos')?.data.Pago ?? {}) as Record<string, unknown>;
  const item = cfdi.conceptos[0];

  // The key-attribute list: each one starts with a zero in the file above.
  const keys: Array<[string, unknown, string]> = [
    ['Comprobante/Serie', cfdi.serie, '007'],
    ['Comprobante/Folio', cfdi.folio, '000123'],
    ['Comprobante/FormaPago', cfdi.formaPago, '03'],
    ['Comprobante/LugarExpedicion', cfdi.lugarExpedicion, '01000'],
    ['CfdiRelacionados/TipoRelacion', cfdi.cfdiRelacionados?.tipoRelacion, '07'],
    ['Receptor/DomicilioFiscalReceptor', cfdi.receptor.domicilioFiscalReceptor, '01000'],
    ['Concepto/ClaveProdServ', item.claveProdServ, '01010101'],
    ['Concepto/NoIdentificacion', item.noIdentificacion, '000789'],
    ['Concepto/ObjetoImp', item.objetoImp, '02'],
    ['Traslado/Impuesto', item.impuestos?.traslados[0].impuesto, '002'],
    ['TimbreFiscalDigital/NoCertificadoSAT', cfdi.timbreFiscalDigital?.noCertificadoSAT, '00001000000500000001'],
    ['Pago/FormaDePagoP', payment['@_FormaDePagoP'], '03'],
    ['Pago/NumOperacion', payment['@_NumOperacion'], '000456'],
  ];

  it.each(keys)('%s arrives as the exact text of the file', (_name, value, expected) => {
    expect(value).toBe(expected);
  });

  it('amounts are still numbers', () => {
    expect(cfdi.subTotal).toBe(1000.5);
    expect(cfdi.total).toBe(1160.58);
    expect(item.importe).toBe(1000.5);
    expect(item.impuestos?.traslados[0].tasaOCuota).toBe(0.16);
    expect(cfdi.impuestos.totalImpuestosTrasladados).toBe(160.08);
  });

  it('the version reads as the SAT writes it', () => {
    expect(cfdi.version).toBe('4.0');
  });
});

describe('CFDIParser · accents written as numeric references, line breaks read as spaces (#218)', () => {
  it('Nombre="Cr&#233;dito&#10;SA" reads «Crédito SA»', () => {
    expect(cfdi.receptor.nombre).toBe('Crédito SA');
    expect(cfdi.emisor.nombre).toBe('Servicios Peña SA');
  });

  it('a concept description with &#237; and &#9; reads with its accent and a space', () => {
    expect(cfdi.conceptos[0].descripcion).toBe('Asesoría contable');
  });
});
