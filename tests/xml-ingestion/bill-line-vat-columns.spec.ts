import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn(), getClient: vi.fn() }));

import { vatColumnsOf, uniformVatColumns } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { CFDIParser } from '../../src/services/xml-ingestion/cfdi-parser.js';
import type { CFDIImpuesto } from '../../src/services/xml-ingestion/cfdi-parser.js';

// ============================================================
// MNE-001-027 · #284 — WHAT A BILL LINE SAYS ABOUT ITS VAT.
//
// Migration 066 gave `bill_lines` a rate, a factor type and the value of the
// acts so the DIOT can tell an exempt purchase from a 0 % one. No writer filled
// them, and the inbox took the FIRST transfer of each concept as its VAT, so an
// IEPS transfer ahead of the IVA one landed in `tax_amount`.
// ============================================================

const ieps: CFDIImpuesto = { base: 1000, impuesto: '003', tipoFactor: 'Tasa', tasaOCuota: 0.08, importe: 80 };
const iva16: CFDIImpuesto = { base: 1080, impuesto: '002', tipoFactor: 'Tasa', tasaOCuota: 0.16, importe: 172.8 };

describe('vatColumnsOf', () => {
  it('takes only the IVA transfer (002), also when IEPS comes first', () => {
    expect(vatColumnsOf([ieps, iva16])).toEqual({
      tax: '172.8', factor_type: 'tasa', tax_rate: '16.00', acts_value: '1080.0000',
    });
  });

  it('reads the SAT key the parser turned into a number ("002" -> 2)', () => {
    const numeric = { ...iva16, impuesto: 2 as unknown as string };
    expect(vatColumnsOf([numeric]).tax_rate).toBe('16.00');
  });

  it('an exempt transfer is exempt, with no rate and its declared base', () => {
    const exempt: CFDIImpuesto = { base: 300, impuesto: '002', tipoFactor: 'Exento' };
    expect(vatColumnsOf([exempt])).toEqual({
      tax: '0', factor_type: 'exento', tax_rate: null, acts_value: '300.0000',
    });
  });

  it('an exempt transfer without Base leaves the value of the acts unknown, never zero', () => {
    const exempt: CFDIImpuesto = { impuesto: '002', tipoFactor: 'Exento' };
    expect(vatColumnsOf([exempt]).acts_value).toBeNull();
  });

  it('a 0 % rate is a rate, not an exemption', () => {
    const zero: CFDIImpuesto = { base: 500, impuesto: '002', tipoFactor: 'Tasa', tasaOCuota: 0, importe: 0 };
    expect(vatColumnsOf([zero])).toMatchObject({ factor_type: 'tasa', tax_rate: '0.00', acts_value: '500.0000' });
  });

  it('a concept with no IVA transfer declares nothing it does not know', () => {
    expect(vatColumnsOf(undefined)).toEqual({ tax: '0', factor_type: 'tasa', tax_rate: null, acts_value: null });
    expect(vatColumnsOf([ieps])).toEqual({ tax: '0', factor_type: 'tasa', tax_rate: null, acts_value: null });
  });

  it('two IVA transfers on one concept add their tax and leave the rate to be measured', () => {
    const iva8: CFDIImpuesto = { base: 100, impuesto: '002', tipoFactor: 'Tasa', tasaOCuota: 0.08, importe: 8 };
    expect(vatColumnsOf([iva16, iva8])).toEqual({ tax: '180.8', factor_type: 'tasa', tax_rate: null, acts_value: null });
  });
});

describe('uniformVatColumns', () => {
  it('one regime for every concept is the regime of every line', () => {
    const exempt = { impuestos: { traslados: [{ base: 300, impuesto: '002', tipoFactor: 'Exento' }], retenciones: [] } };
    expect(uniformVatColumns([exempt, exempt])).toEqual({ factor_type: 'exento', tax_rate: null });
  });

  it('mixed regimes have no line-level answer', () => {
    const exempt = { impuestos: { traslados: [{ base: 300, impuesto: '002', tipoFactor: 'Exento' }], retenciones: [] } };
    const taxed = { impuestos: { traslados: [iva16], retenciones: [] } };
    expect(uniformVatColumns([exempt, taxed])).toBeNull();
    expect(uniformVatColumns([])).toBeNull();
  });
});

describe('the parser keeps an absent Base absent', () => {
  it('an Exento transfer without Base parses with base undefined', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-08-20T10:00:00" TipoDeComprobante="I" Moneda="MXN" SubTotal="300.00" Total="300.00" LugarExpedicion="06600">
  <cfdi:Emisor Rfc="SIN060101AB1" Nombre="X" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="Y" UsoCFDI="G03" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="86121700" ClaveUnidad="E48" Descripcion="Colegiatura" Cantidad="1" ValorUnitario="300.00" Importe="300.00" ObjetoImp="02">
      <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Impuesto="002" TipoFactor="Exento"/></cfdi:Traslados></cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
</cfdi:Comprobante>`;
    const t = new CFDIParser().parse(xml).conceptos[0].impuestos?.traslados[0];
    expect(t?.tipoFactor).toBe('Exento');
    expect(t?.base).toBeUndefined();
  });
});
