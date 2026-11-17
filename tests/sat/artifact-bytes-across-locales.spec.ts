import { afterEach, describe, expect, it } from 'vitest';
import { construirCatalogoCuentas } from '../../src/services/sat/anexo24/catalogo-cuentas.js';
import { construirBalanzaXml } from '../../src/services/sat/anexo24/balanza-xml.js';
import { construirPolizasXml } from '../../src/services/sat/anexo24/polizas-xml.js';
import { construirAuxiliarCuentasXml, construirAuxiliarFoliosXml } from '../../src/services/sat/anexo24/polizas-auxiliar-xml.js';
import { serializeSatBatch } from '../../src/services/sat/diot/sat-batch.js';
import { desgloseCero } from '../../src/services/sat/diot/desglose.js';
import { buildIncomeCfdiXml } from '../../src/services/sat/cfdi40/income-cfdi.js';
import { getLanguage, resetLanguage, setLanguage } from '../../src/i18n/index.js';
import { LOCALE_ENV_VAR, LOCALE_ENV_VAR_ALIAS, languageOfLocale, type Locale } from '../../src/i18n/locale.js';

// ============================================================
// #652 · WHAT GOES TO THE SAT DOES NOT CHANGE WITH THE LANGUAGE
//
// docs/language.md rule 5: an artifact for an authority follows the authority.
// `.env.example` and docs/cli-command-catalog.md promise identical Anexo 24 XML
// and DIOT under en-US and es-MX; imports prove nothing, since every builder
// reaches src/i18n through src/utils/errors.ts. So each pure builder runs with
// the locale variable and its alias unset and nothing pinned, then under es-MX
// and en-US with the catalog pinned to each language: the resolver and t()
// both move, the bytes must not. Only artifacts are compared, never a
// ValidationError's message, which may follow the language.
// ============================================================

const VARIANTS: ReadonlyArray<Locale | undefined> = [undefined, 'es-MX', 'en-US'];
const SAVED = [LOCALE_ENV_VAR, LOCALE_ENV_VAR_ALIAS].map((name) => [name, process.env[name]] as const);

afterEach(() => {
  for (const [name, value] of SAVED) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetLanguage();
});

const RFC = 'AAA010101AAA';
const ACCOUNT = { account_level: 1, parent_code: null, naturaleza_agrupador: null, estado_agrupador: 'valido' } as const;
const LINE = { numCta: '2110', desCta: 'Proveedores & Cía', concepto: 'Pago de la factura A-100' };
const CHECK = {
  clase: 'cheque', num: '10042', banEmisNal: '012', ctaOri: '012180001234567895', fecha: '2026-02-10',
  benef: 'Aceros & Cía', rfc: RFC, monto: '11600.00', moneda: 'MXN',
} as const;
const PARTY = {
  vendorId: 'v1', nombre: 'Papelería del Centro', tipoTercero: '04', tipoOperacion: '85', rfc: 'ABC010101AA1',
  procedencia: { tipoTercero: 'declarado', tipoOperacion: 'declarado' },
} as const;
const CFDI_LINE = { quantity: '1.0000', taxCode: 'IVA16', taxRate: '16.00', productCode: '84111506', unitCode: 'E48' };

// NOTE: es-MX and en-US group digits and mark decimals the same way
// ("11,600.00" in both), so a builder that formats an amount by locale is not
// caught here; the XSD specs (tests/sat/anexo24/official-xsd.spec.ts) catch it.
const BUILDERS: ReadonlyArray<readonly [string, () => string]> = [
  ['construirCatalogoCuentas', () => construirCatalogoCuentas({
    rfc: RFC, anio: 2026, mes: 1,
    politicas: { niveles: 'jerarquia_completa', sinAgrupador: 'bloquear', sellado: 'nunca_sellar_en_el_sistema' },
    cuentas: [
      { ...ACCOUNT, code: '100', name: 'Activo', codigo_agrupador_sat: '100', normal_balance: 'debit', account_type: 'asset', lineas_posteadas: 0 },
      { ...ACCOUNT, code: '200', name: 'Proveedores & Cía', codigo_agrupador_sat: '201', normal_balance: 'credit', account_type: 'liability', lineas_posteadas: 1 },
    ],
  }).xml ?? ''],
  ['construirBalanzaXml', () => construirBalanzaXml({
    rfc: RFC, anio: 2026, mes: '02', tipoEnvio: 'N',
    cuentas: [{
      account_id: 'id-1120', num_cta: '1120', natur: 'D', saldo_ini_mayor: '12345.6700', debe: '1300.0000',
      haber: '400.0000', saldo_fin_mayor: '13245.6700', codigo_agrupador: '105.01', natur_del_agrupador: 'D',
    }],
  })],
  ['construirPolizasXml', () => construirPolizasXml({
    rfc: RFC, anio: 2026, mes: '02', solicitud: { tipo: 'AF', numOrden: 'ABC1234567/26' },
    polizas: [{
      numUnIdenPol: 'JE-2026-0001', fecha: '2026-02-10', concepto: LINE.concepto,
      transacciones: [
        { ...LINE, debe: '11600.00', haber: '0.00' },
        { ...LINE, numCta: '1120', desCta: 'Bancos', debe: '0.00', haber: '11600.00', pagos: [CHECK] },
      ],
    }],
  })],
  ['construirAuxiliarFoliosXml', () => construirAuxiliarFoliosXml({
    rfc: RFC, anio: 2026, mes: '02', solicitud: { tipo: 'DE', numTramite: 'DE202600000009' },
    detalles: [{
      numUnIdenPol: 'JE-2026-0001', fecha: '2026-02-10',
      comprobantes: [{ clase: 'nacional', uuid: 'A1B2C3D4-1111-2222-3333-444455556666', rfc: 'PSA010101AA1', montoTotal: '11600.00' }],
    }],
  })],
  ['construirAuxiliarCuentasXml', () => construirAuxiliarCuentasXml({
    rfc: RFC, anio: 2026, mes: '02', solicitud: { tipo: 'CO', numTramite: 'CO202600000004' },
    cuentas: [{
      numCta: '4100', desCta: 'Ventas', saldoIni: '7000.00', saldoFin: '8300.00',
      movimientos: [{ fecha: '2026-02-10', numUnIdenPol: 'JE-2026-0002', concepto: 'Venta del mes', debe: '0.00', haber: '1300.00' }],
    }],
  })],
  ['serializeSatBatch, its file', () => serializeSatBatch({
    periodo: { anio: 2026, mes: 4, desde: '2026-04-01', hasta: '2026-04-30' },
    rfc: RFC, razonSocial: 'Contribuyente de prueba', politicas: [], hallazgos: [],
    renglones: [{
      tercero: PARTY, ivaRetenido: '0.0000', documentos: [],
      desglose: { ...desgloseCero(), tasa16: { base: '1000.5000', iva: '160.0800' } },
    }],
    totales: { desglose: desgloseCero(), ivaRetenido: '0.0000', ivaAcreditablePagado: '160.0800', terceros: 1, documentos: 0 },
  }, { proportion: 'taxed_only' }).file],
  ['buildIncomeCfdiXml', () => buildIncomeCfdiXml({
    issuedAt: '2026-09-30T12:00:00',
    invoice: { invoiceNumber: 'INV-2026-0001', currencyCode: 'MXN', exchangeRate: '1', subtotal: '1200.00', totalAmount: '1360.00' },
    issuer: { rfc: 'EKU9003173C9', name: 'ESCUELA KEMPER URGATE', taxRegime: '601', postalCode: '06600' },
    receiver: { rfc: 'URE180429TM6', name: 'ACEROS & CIA "SUR"', taxRegime: '601', postalCode: '65000', cfdiUse: 'G03' },
    lines: [
      { ...CFDI_LINE, lineNumber: 1, description: 'Consultoría', unitPrice: '1000.0000' },
      { ...CFDI_LINE, lineNumber: 2, description: 'Libro', quantity: '2.0000', unitPrice: '100.0000', taxCode: 'exento', taxRate: null, productCode: '55101500', unitCode: 'H87' },
    ],
  })],
];

describe('the seven pure SAT builders give the same bytes in every locale', () => {
  it.each(BUILDERS)('%s', (_name, build) => {
    delete process.env[LOCALE_ENV_VAR_ALIAS];
    const languages: string[] = [];
    const outputs = VARIANTS.map((locale) => {
      if (locale === undefined) {
        delete process.env[LOCALE_ENV_VAR];
        resetLanguage();
      } else {
        process.env[LOCALE_ENV_VAR] = locale;
        setLanguage(languageOfLocale(locale));
      }
      languages.push(getLanguage());
      return build();
    });
    // Not vacuous: the two pinned runs did speak different languages.
    expect(languages.slice(1)).toEqual(['es', 'en']);
    expect(outputs[0].length).toBeGreaterThan(0);
    expect(outputs[1]).toBe(outputs[0]);
    expect(outputs[2]).toBe(outputs[0]);
  });
});
