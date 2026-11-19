import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'cfdi', name), 'utf8');

/** A string replacement that fails when the fixture no longer has the text. */
function swap(xml: string, from: string | RegExp, to: string): string {
  if (xml.search(from) < 0) throw new Error(`issued-cfdi-xml: the fixture no longer has ${String(from)}`);
  return xml.replace(from, to);
}

export interface IssuedSale {
  /** The entity that issues the CFDI, and the customer that receives it. */
  ownRfc: string;
  customerRfc: string;
  /** Written as given; `null` removes the attribute. Default PUE. */
  method?: string | null;
}

const LOCAL_TAX_30 =
  '<implocal:ImpuestosLocales xmlns:implocal="http://www.sat.gob.mx/implocal" version="1.0" TotaldeRetenciones="0.00" ' +
  'TotaldeTraslados="30.00"><implocal:TrasladosLocales ImpLocTrasladado="ISH" TasadeTraslado="3.00" Importe="30.00"/>' +
  '</implocal:ImpuestosLocales>';

/**
 * `factura-consultoria-2001.xml` turned into a sale the entity issues with
 * IEPS: SubTotal 1,000.00; IEPS 80.00 (8 % of 1,000.00, or a quota of 80.00
 * per unit with `quota`); VAT 172.80 (16 % of 1,080.00: the IEPS is part of
 * the VAT base); Total 1,252.80. With `localTax`, a local tax of 30.00 (3 % of
 * 1,000.00) in its complement: Total 1,282.80.
 */
export function issuedIepsSale(o: IssuedSale & { quota?: boolean; localTax?: boolean }): { xml: string; uuid: string } {
  const uuid = uuidv4().toUpperCase();
  const ieps = o.quota
    ? '<cfdi:Traslado Base="1.00" Impuesto="003" TipoFactor="Cuota" TasaOCuota="80.000000" Importe="80.00"/>'
    : '<cfdi:Traslado Base="1000.00" Impuesto="003" TipoFactor="Tasa" TasaOCuota="0.080000" Importe="80.00"/>';
  const taxes =
    `<cfdi:Traslados>${ieps}<cfdi:Traslado Base="1080.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" ` +
    'Importe="172.80"/></cfdi:Traslados>';
  let xml = fixture('factura-consultoria-2001.xml');
  xml = swap(xml, 'F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80', uuid);
  xml = swap(xml, '<cfdi:Emisor Rfc="SIN060101AB1"', `<cfdi:Emisor Rfc="${o.ownRfc}"`);
  xml = swap(xml, '<cfdi:Receptor Rfc="XAXX010101000"', `<cfdi:Receptor Rfc="${o.customerRfc}"`);
  xml = swap(xml, ' MetodoPago="PPD"', o.method === null ? '' : ` MetodoPago="${o.method ?? 'PUE'}"`);
  xml = swap(xml, 'SubTotal="8000.00" Total="9280.00"', `SubTotal="1000.00" Total="${o.localTax ? '1282.80' : '1252.80'}"`);
  xml = swap(xml, 'ValorUnitario="8000.00" Importe="8000.00" ObjetoImp="02"/>',
    `ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02"><cfdi:Impuestos>${taxes}</cfdi:Impuestos></cfdi:Concepto>`);
  xml = swap(xml, /<cfdi:Impuestos TotalImpuestosTrasladados="1280\.00">[\s\S]*?<\/cfdi:Impuestos>/,
    `<cfdi:Impuestos TotalImpuestosTrasladados="252.80">${taxes}</cfdi:Impuestos>`);
  if (o.localTax) xml = swap(xml, '<cfdi:Complemento>', `<cfdi:Complemento>${LOCAL_TAX_30}`);
  return { xml, uuid };
}

/**
 * `hospedaje-ish-4001.xml` turned around: the entity issues it. SubTotal
 * 1,000.00; VAT 160.00 (16 %); ISH 30.00 (3 %) in the ImpuestosLocales
 * complement; Total 1,190.00.
 */
export function issuedIshSale(o: IssuedSale): { xml: string; uuid: string } {
  const uuid = uuidv4().toUpperCase();
  let xml = fixture('hospedaje-ish-4001.xml');
  xml = swap(xml, '4A1B2C3D-5E6F-4071-8293-A4B5C6D7E8F9', uuid);
  // The receiver first: the fixture's receiver is the generic RFC, which a test entity may also use.
  xml = swap(xml, '<cfdi:Receptor Rfc="XAXX010101000"', `<cfdi:Receptor Rfc="${o.customerRfc}"`);
  xml = swap(xml, '<cfdi:Emisor Rfc="HOS060101AB1"', `<cfdi:Emisor Rfc="${o.ownRfc}"`);
  xml = swap(xml, ' MetodoPago="PUE"', o.method === null ? '' : ` MetodoPago="${o.method ?? 'PUE'}"`);
  return { xml, uuid };
}
