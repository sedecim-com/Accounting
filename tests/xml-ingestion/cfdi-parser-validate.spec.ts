import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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
    cfdiRelacionados: [],
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

// MNE-001-561 (#729): Anexo 20 states SubTotal BEFORE discounts and the header
// Descuento as the sum of the concepts' own (cfdv40.xsd, both annotations).
// validate() compared the concepts net of discount against SubTotal, so every
// CFDI with a discount was refused at upload, whichever check it satisfied.
describe('CFDIParser.validate: a discount is read as the SAT schema states it', () => {
  const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', name), 'utf-8');
  const SALE = fixture('factura-consultoria-2001.xml');
  const HEADER = 'SubTotal="8000.00" Total="9280.00"';
  const AMOUNTS = 'ValorUnitario="8000.00" Importe="8000.00"';
  /** The fixture with a discount of 500.00: the header as given, VAT 1,200.00 on a base of 7,500.00. */
  const discounted = (header: string, ...concepts: string[]) =>
    SALE.replace(HEADER, header)
      .replace(/<cfdi:Concepto [^>]*\/>/, (c) => concepts.map((amounts) => c.replace(AMOUNTS, amounts)).join(''))
      .replace('TotalImpuestosTrasladados="1280.00"', 'TotalImpuestosTrasladados="1200.00"')
      .replace('Base="8000.00"', 'Base="7500.00"')
      .replace('Importe="1280.00"', 'Importe="1200.00"');
  const ONE = `${AMOUNTS} Descuento="500.00"`;
  const TWO = [
    'ValorUnitario="5000.00" Importe="5000.00" Descuento="300.00"',
    'ValorUnitario="3000.00" Importe="3000.00" Descuento="200.00"',
  ];
  const validate = (xml: string) => parser.validate(parser.parse(xml));

  it.each([
    ['one concept of 8,000.00 with its discount of 500.00', [ONE]],
    ['two concepts, 5,000.00 − 300.00 and 3,000.00 − 200.00', TWO],
    ['a discount on one of several concepts', ['ValorUnitario="5000.00" Importe="5000.00" Descuento="500.00"', 'ValorUnitario="3000.00" Importe="3000.00"']],
  ])('SubTotal 8,000.00, Descuento 500.00, Total 8,700.00 is valid: %s', (_name, concepts) => {
    expect(validate(discounted('SubTotal="8000.00" Descuento="500.00" Total="8700.00"', ...concepts))).toEqual({ valid: true, errors: [] });
  });

  it('the fixture on disk with a discount is valid, and so is a discount of the whole concept', () => {
    expect(validate(fixture('factura-consultoria-descuento-2002.xml'))).toEqual({ valid: true, errors: [] });
    const free = SALE.replace(HEADER, 'SubTotal="8000.00" Descuento="8000.00" Total="0.00"')
      .replace(AMOUNTS, `${AMOUNTS} Descuento="8000.00"`)
      .replace(/<cfdi:Impuestos[\s\S]*<\/cfdi:Impuestos>/, '');
    expect(validate(free)).toEqual({ valid: true, errors: [] });
  });

  it('a SubTotal net of the discount is refused, naming the sum of the concepts and the SubTotal', () => {
    // Total 8,700.00 is what the issuer charged; the total check then reads 7,500 − 500 + 1,200 and refuses too.
    const { valid, errors } = validate(discounted('SubTotal="7500.00" Descuento="500.00" Total="8700.00"', ...TWO));
    expect(valid).toBe(false);
    expect(errors[0]).toMatch(/^Conceptos total 8000\.00 .*does not match SubTotal 7500\.00$/);
  });

  it.each([
    ['a header Descuento of 400.00', 'SubTotal="8000.00" Descuento="400.00" Total="8800.00"', /discounts 500\.00 .*Descuento 400\.00$/],
    ['no header Descuento', 'SubTotal="8000.00" Total="9200.00"', /discounts 500\.00 .*Descuento 0\.00 \(not declared\)$/],
  ])('concept discounts of 500.00 under %s are refused, naming both figures', (_name, header, message) => {
    // Each Total satisfies the total check, so the discount check alone refuses.
    expect(validate(discounted(header, ...TWO))).toEqual({ valid: false, errors: [expect.stringMatching(message)] });
  });

  it('a header Descuento that no concept carries is refused', () => {
    const { errors } = validate(discounted('SubTotal="8000.00" Descuento="500.00" Total="8700.00"', AMOUNTS));
    expect(errors).toEqual([expect.stringMatching(/discounts 0\.00 .*Descuento 500\.00$/)]);
  });

  it('the cent of tolerance holds on both checks, and two cents do not', () => {
    const cent = discounted('SubTotal="8000.01" Descuento="500.01" Total="8700.00"', ONE);
    expect(validate(cent)).toEqual({ valid: true, errors: [] });
    expect(validate(cent.replace('SubTotal="8000.01"', 'SubTotal="8000.02"')).errors).toEqual([
      expect.stringMatching(/^Conceptos total 8000\.00 .*SubTotal 8000\.02$/),
    ]);
    expect(validate(cent.replace('Descuento="500.01" Total', 'Descuento="500.02" Total')).errors).toEqual([
      expect.stringMatching(/discounts 500\.00 .*Descuento 500\.02$/),
    ]);
  });

  it('guards: no discount, a payment CFDI of type P with SubTotal 0 and local taxes validate as before', () => {
    expect(validate(SALE)).toEqual({ valid: true, errors: [] });
    expect(validate(fixture('hospedaje-ish-4001.xml'))).toEqual({ valid: true, errors: [] });
    const payment = parser.parse(SALE);
    payment.tipoDeComprobante = 'P';
    payment.subTotal = 0;
    payment.total = 0;
    payment.impuestos = { traslados: [], retenciones: [] };
    payment.conceptos = [{ ...payment.conceptos[0], valorUnitario: 0, importe: 0, descuento: undefined }];
    expect(parser.validate(payment)).toEqual({ valid: true, errors: [] });
  });
});
