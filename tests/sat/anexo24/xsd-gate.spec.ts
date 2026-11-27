import { describe, expect, it } from 'vitest';
import {
  construirCatalogoCuentas,
  type CuentaParaCatalogo,
} from '../../../src/services/sat/anexo24/catalogo-cuentas.js';
import { construirBalanzaXml, type DatosDeBalanza } from '../../../src/services/sat/anexo24/balanza-xml.js';
import type { CuentaDeBalanza } from '../../../src/services/sat/anexo24/balanza-invariantes.js';
import { officialXsdRefusal } from '../../../src/services/sat/anexo24/official-xsd.js';
import { xsdFindings, xsdFindingWithoutFile } from '../../../src/services/sat/anexo24/balanza-invariantes.js';
import { xsdFindings as requestFileXsdFindings } from '../../../src/services/sat/anexo24/polizas-invariantes.js';
import { construirPolizasXml } from '../../../src/services/sat/anexo24/polizas-xml.js';
import {
  construirAuxiliarCuentasXml,
  construirAuxiliarFoliosXml,
} from '../../../src/services/sat/anexo24/polizas-auxiliar-xml.js';
import { textIn, ValidationError } from '../../../src/utils/errors.js';

// ============================================================
// MNE-001-666 (#608) · A generated Anexo 24 file is deliverable only when the
// SAT's official XSD accepts it. official-xsd.spec.ts says what the schema
// accepts; this says what the GENERATORS do with that verdict, with the real
// xmllint over the vendored schemas. Every fixture is synthetic.
// ============================================================

/** Runs `fn` on a PATH with no xmllint, and puts the PATH back. */
function withoutXmllint<T>(fn: () => T): T {
  const path = process.env.PATH;
  process.env.PATH = '/mne-001-666-no-such-directory';
  try {
    return fn();
  } finally {
    process.env.PATH = path;
  }
}

const account = (number: string): CuentaDeBalanza => ({
  account_id: `id-${number}`,
  num_cta: number,
  natur: 'D',
  saldo_ini_mayor: '0.0000',
  debe: '100.0000',
  haber: '0.0000',
  saldo_fin_mayor: '100.0000',
  codigo_agrupador: '100',
  natur_del_agrupador: null,
});

const balance = (over: Partial<DatosDeBalanza> = {}): string =>
  construirBalanzaXml({
    rfc: 'AAA010101AAA',
    anio: 2026,
    mes: '01',
    tipoEnvio: 'N',
    cuentas: [account('100')],
    ...over,
  });

/**
 * Valid bytes with one attribute value replaced: since MNE-001-775 the builder
 * refuses, by its own key, everything this schema rejects, so a file the XSD
 * must judge and refuse is no longer one the builder writes.
 */
const withAttribute = (xml: string, attribute: string, from: string, to: string): string => {
  const out = xml.replace(`${attribute}="${from}"`, `${attribute}="${to}"`);
  expect(out).not.toBe(xml);
  return out;
};

/** A valid balance whose RFC has month 99, which the official XSD rejects. */
const month99 = () => withAttribute(balance(), 'RFC', 'AAA010101AAA', 'AAA019901AAA');

const chartAccount = (over: Partial<CuentaParaCatalogo> = {}): CuentaParaCatalogo => ({
  code: '100',
  name: 'Activo',
  account_level: 1,
  parent_code: null,
  codigo_agrupador_sat: '100',
  normal_balance: 'debit',
  account_type: 'asset',
  lineas_posteadas: 0,
  naturaleza_agrupador: null,
  estado_agrupador: 'valido',
  ...over,
});

const chart = (accounts: CuentaParaCatalogo[]) =>
  construirCatalogoCuentas({
    rfc: 'AAA010101AAA',
    anio: 2026,
    mes: 1,
    cuentas: accounts,
    politicas: { niveles: 'jerarquia_completa', sinAgrupador: 'bloquear', sellado: 'nunca_sellar_en_el_sistema' },
  });

describe('the gate a generator passes its finished file through', () => {
  it('says nothing about a file the official XSD accepts', () => {
    expect(officialXsdRefusal(balance(), 'trialBalance')).toBeNull();
  });

  it('refuses a file the XSD rejects, with the validator own line and the schema it judged by', () => {
    const refusal = officialXsdRefusal(month99(), 'trialBalance');
    expect(refusal).toMatchObject({ reason: 'rejected', statusCode: 422 });
    expect(refusal?.messageKey).toMatchObject({
      key: 'anexo24.xsd.rejected',
      params: { schema: 'BalanzaComprobacion_1_3.xsd', more: 0 },
    });
    expect(refusal?.message).toMatch(/not deliverable: line 2: .*attribute 'RFC'.*AAA019901AAA/);
  });

  it('refuses a document that is not well formed: xmllint exits 1 or 4 by release, and both are a verdict', () => {
    const refusal = officialXsdRefusal('<BCE:Balanza RFC="AAA010101AAA"', 'trialBalance');
    expect(refusal?.reason).toBe('rejected');
    expect(refusal?.message).toContain('line 1');
  });

  it('without xmllint the file is not validated, and that is said instead of thrown', () => {
    const refusal = withoutXmllint(() => officialXsdRefusal(balance(), 'trialBalance'));
    expect(refusal?.reason).toBe('not_validated');
    expect(refusal?.messageKey?.key).toBe('anexo24.xsd.not_validated');
    expect(refusal?.message).toMatch(/was not validated .*ENOENT.*not deliverable.*mnemosine doctor/);
  });

  it('shows the first five lines, each cut to 300 characters by its middle, and counts the rest', () => {
    // Eight accounts whose NumCta has 101 characters: eight maxLength errors.
    const digits = ['1', '2', '3', '4', '5', '6', '7', '8'];
    const long = digits.reduce(
      (xml, d) => withAttribute(xml, 'NumCta', d, d.repeat(101)),
      balance({ cuentas: digits.map(account) })
    );
    const refusal = officialXsdRefusal(long, 'trialBalance');
    const params = refusal?.messageKey?.params as { errors: string; more: number };
    expect(params.more).toBe(3);
    expect(params.errors.match(/line \d+: /g)).toHaveLength(5);
    // xmllint quotes the 101 characters, so every line runs past the limit:
    // 5 lines of 300 and 4 separators of 2.
    expect(params.errors).toHaveLength(1508);
    // The cut keeps both ends (MNE-001-667): the attribute and how the value
    // begins, and the reason, which xmllint says last in 74 characters: the
    // tail of 79 holds it and the last five 1s.
    expect(params.errors).toMatch(
      /^line 3: .*attribute 'NumCta'.* The value '1+…11111' has a length of '101'; this exceeds the allowed maximum length of '100'\.; line 4: /
    );
    expect(refusal?.message).toContain('and 3 more lines');
  });
});

describe('the chart of accounts', () => {
  it('a chart the XSD accepts is deliverable and carries no finding of the gate', () => {
    expect(chart([chartAccount()])).toMatchObject({ puedeEntregarse: true, hallazgos: [] });
  });

  it('a chart the hand-written rules block keeps their finding, and the XSD verdict is added after it', () => {
    // 100.99 has the shape of a grouping code and is not on the SAT's list.
    const built = chart([chartAccount({ codigo_agrupador_sat: '100.99' })]);
    expect(built.puedeEntregarse).toBe(false);
    expect(built.hallazgos.map((h) => [h.regla, h.severidad, h.procedencia, h.numCta])).toEqual([
      ['CAT-CODAGRUP-ENUM', 'bloquea', 'official_xsd', '100'],
      ['CAT-XSD-REJECTED', 'bloquea', 'official_xsd', undefined],
    ]);
    const added = built.hallazgos[1];
    expect(added.messageKey?.key).toBe('anexo24.xsd.rejected');
    expect(added.mensaje).toMatch(/CatalogoCuentas_1_3\.xsd.*attribute 'CodAgrup'/);
    // One enumeration error of this schema runs to 15 KB: the finding stays readable.
    expect(added.mensaje.length).toBeLessThan(500);
  });

  it('a hundred rejected accounts are still a verdict: 5 lines shown, 95 counted', () => {
    // 100 enumeration errors of 15 KB each are 1.5 MB of stderr, past spawnSync's default buffer.
    const many = Array.from({ length: 100 }, (_, i) =>
      chartAccount({ code: String(1000 + i), codigo_agrupador_sat: '100.99' })
    );
    const added = chart(many).hallazgos.at(-1);
    expect(added?.regla).toBe('CAT-XSD-REJECTED');
    expect(added?.messageKey?.params).toMatchObject({ more: 95 });
  });

  it('without xmllint a chart is not deliverable, and its finding says it was not validated', () => {
    const built = withoutXmllint(() => chart([chartAccount()]));
    expect(built.xml).not.toBeNull();
    expect(built.puedeEntregarse).toBe(false);
    expect(built.hallazgos.map((h) => [h.regla, h.severidad, h.messageKey?.key])).toEqual([
      ['CAT-XSD-NOT-VALIDATED', 'bloquea', 'anexo24.xsd.not_validated'],
    ]);
    expect(built.hallazgos[0].mensaje).toContain('was not validated');
  });
});

describe('balance check · the xsd check (MNE-001-774)', () => {
  it('says nothing about a balance the official XSD accepts', () => {
    expect(xsdFindings(balance())).toEqual([]);
  });

  it('a balance the XSD rejects is one blocking finding of the whole file, by key', () => {
    const found = xsdFindings(month99());
    expect(found.map((h) => [h.check, h.severity, h.referencia, h.messageKey?.key])).toEqual([
      ['xsd', 'blocking', '', 'anexo24.xsd.rejected'],
    ]);
    expect(found[0].detalle).toMatch(/not deliverable: line 2: .*attribute 'RFC'/);
  });

  it('without xmllint the check blocks too and says the file was not validated', () => {
    const found = withoutXmllint(() => xsdFindings(balance()));
    expect(found.map((h) => [h.check, h.severity, h.messageKey?.key])).toEqual([
      ['xsd', 'blocking', 'anexo24.xsd.not_validated'],
    ]);
  });

  it('a builder refusal by key is the cause, in the language the finding is read in (MNE-001-775)', () => {
    let refused: unknown;
    try {
      balance({ rfc: 'AAA019901AAA' });
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(ValidationError);
    const found = xsdFindingWithoutFile((refused as ValidationError).messageKey ?? 'not keyed');
    expect([found.check, found.severity, found.messageKey?.key]).toEqual(['xsd', 'blocking', 'anexo24.xsd.not_built']);
    const key = found.messageKey;
    if (key === undefined) throw new Error('the finding has no key');
    expect(found.detalle).toMatch(/^No file was built .*: The entity RFC «AAA019901AAA» is not one/);
    expect(textIn(key, 'es')).toMatch(/^No se construyó ningún archivo .*: El RFC de la entidad «AAA019901AAA» no es/);
    // A prose cause (the serializer's) still travels as written.
    expect(xsdFindingWithoutFile('texto tal cual').detalle).toMatch(/: texto tal cual$/);
  });
});

describe('the vouchers file and both auxiliaries · the xsd finding (MNE-001-667)', () => {
  const header = { rfc: 'AAA010101AAA', anio: 2026, mes: '01', solicitud: { tipo: 'AF', numOrden: 'ABC1234567/26' } } as const;
  const line = { fecha: '2026-01-10', numUnIdenPol: 'JE-0001', concepto: 'Compra', debe: '7000.00', haber: '0.00' };
  const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const lines = [
    { numCta: '1140', desCta: 'Inventarios', concepto: 'Compra', debe: '7000.00', haber: '0.00' },
    { numCta: '4100', desCta: 'Ventas', concepto: 'Compra', debe: '0.00', haber: '7000.00' },
  ];
  // Each builder with the one value its schema bounds: 300 and 100 characters, and the RFC pattern.
  const FILES = {
    journal: (concept: string) =>
      construirPolizasXml({ ...header, polizas: [{ numUnIdenPol: 'JE-0001', fecha: '2026-01-10', concepto: concept, transacciones: lines }] }),
    accountAuxiliary: (name: string) =>
      construirAuxiliarCuentasXml({
        ...header,
        cuentas: [{ numCta: '1140', desCta: name, saldoIni: '0.00', saldoFin: '7000.00', movimientos: [line] }],
      }),
    voucherAuxiliary: (rfc: string) =>
      construirAuxiliarFoliosXml({
        ...header,
        detalles: [{ numUnIdenPol: 'JE-0001', fecha: '2026-01-10', comprobantes: [{ clase: 'nacional', uuid: UUID, rfc, montoTotal: '1160.00' }] }],
      }),
  };

  it.each([
    ['journal', 'C'.repeat(300), 'C'.repeat(301), 'PolizasPeriodo_1_3.xsd', /Poliza', attribute 'Concepto'.*'301'.*'300'/],
    ['accountAuxiliary', 'N'.repeat(100), 'N'.repeat(101), 'AuxiliarCtas_1_3.xsd', /Cuenta', attribute 'DesCta'.*'101'.*'100'/],
    ['voucherAuxiliary', 'CCC031203CC3', 'CCC039903CC3', 'AuxiliarFolios_1_3.xsd', /ComprNal', attribute 'RFC'/],
  ] as const)('%s: nothing at the bound of its own schema, one blocking finding of the whole file past it', (schema, at, past, file, said) => {
    expect(requestFileXsdFindings(FILES[schema](at), schema)).toEqual([]);
    const found = requestFileXsdFindings(FILES[schema](past), schema);
    expect(found.map((h) => [h.check, h.severity, h.referencia, h.messageKey?.key])).toEqual([
      ['xsd', 'blocking', '', 'anexo24.xsd.rejected'],
    ]);
    expect(found[0].messageKey?.params?.schema).toBe(file);
    expect(found[0].detalle).toMatch(said);
  });

  it('judges by the schema it is given, and without xmllint blocks and says the file was not validated', () => {
    expect(requestFileXsdFindings(FILES.journal('Compra'), 'accountAuxiliary')[0]?.messageKey?.key).toBe('anexo24.xsd.rejected');
    const found = withoutXmllint(() => requestFileXsdFindings(FILES.journal('Compra'), 'journal'));
    expect(found.map((h) => [h.check, h.severity, h.messageKey?.key])).toEqual([['xsd', 'blocking', 'anexo24.xsd.not_validated']]);
  });
});
