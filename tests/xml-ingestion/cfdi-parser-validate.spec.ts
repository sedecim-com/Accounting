import { describe, it, expect } from 'vitest';
import { CFDIParser, type CFDIParsed } from '../../src/services/xml-ingestion/cfdi-parser.js';

// validate() must fail CLOSED on non-finite amounts: Decimal NaN comparisons
// return false, so without an explicit finiteness check a Total="junk" CFDI
// would pass every arithmetic gate and persist NaN into xml_documents.

const parser = new CFDIParser();

function makeCfdi(overrides: Partial<CFDIParsed> = {}): CFDIParsed {
  return {
    version: '4.0',
    fecha: new Date('2026-08-01'),
    tipoDeComprobante: 'I',
    moneda: 'MXN',
    subTotal: 1000,
    total: 1160,
    emisor: { rfc: 'PRO010101AAA', nombre: 'Proveedor SA', regimenFiscal: '601' },
    receptor: { rfc: 'AME010101AAA', nombre: 'Acme MX', usoCFDI: 'G03' },
    conceptos: [
      {
        claveProdServ: '01010101',
        claveUnidad: 'E48',
        descripcion: 'Servicio',
        cantidad: 1,
        valorUnitario: 1000,
        importe: 1000,
        objetoImp: '02',
      },
    ],
    impuestos: { totalImpuestosTrasladados: 160, traslados: [], retenciones: [] },
    timbreFiscalDigital: {
      uuid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      fechaTimbrado: new Date('2026-08-01'),
      rfcProvCertif: 'SAT970701NN3',
      selloCFD: 'x',
      selloSAT: 'y',
      noCertificadoSAT: 'z',
    },
    complementos: [],
    ...overrides,
  };
}

describe('CFDIParser.validate — non-finite amounts fail closed', () => {
  it('accepts a well-formed CFDI', () => {
    const { valid, errors } = parser.validate(makeCfdi());
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it('rejects a NaN Total (e.g. Total="junk" parsed with parseFloat)', () => {
    const { valid, errors } = parser.validate(makeCfdi({ total: NaN }));
    expect(valid).toBe(false);
    expect(errors).toContain('Non-numeric Total/SubTotal');
  });

  it('rejects a NaN SubTotal', () => {
    const { valid, errors } = parser.validate(makeCfdi({ subTotal: NaN }));
    expect(valid).toBe(false);
    expect(errors).toContain('Non-numeric Total/SubTotal');
  });

  it('rejects an Infinity Total', () => {
    const { valid, errors } = parser.validate(makeCfdi({ total: Infinity }));
    expect(valid).toBe(false);
    expect(errors).toContain('Non-numeric Total/SubTotal');
  });
});
