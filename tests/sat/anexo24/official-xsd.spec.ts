import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  construirCatalogoCuentas,
  type CuentaParaCatalogo,
} from '../../../src/services/sat/anexo24/catalogo-cuentas.js';
import { construirBalanzaXml, type DatosDeBalanza } from '../../../src/services/sat/anexo24/balanza-xml.js';
import type { CuentaDeBalanza } from '../../../src/services/sat/anexo24/balanza-invariantes.js';
import { construirPolizasXml, type DatosDePolizas } from '../../../src/services/sat/anexo24/polizas-xml.js';
import {
  construirAuxiliarCuentasXml,
  construirAuxiliarFoliosXml,
  type DatosDeAuxiliarCuentas,
  type DatosDeAuxiliarFolios,
} from '../../../src/services/sat/anexo24/polizas-auxiliar-xml.js';
import {
  validarCatalogo,
  type CabeceraCatalogo,
  type FilaCtas,
} from '../../../src/services/sat/anexo24/validador.js';
import {
  officialEnumeration,
  parseEnumerations,
  OFFICIAL_ENUMERATIONS_XSD,
} from '../../../src/services/sat/anexo24/official-enumerations.js';
import { METODO_A_SAT } from '../../../src/services/sat/anexo24/polizas-service.js';
import { ValidationError } from '../../../src/utils/errors.js';
import {
  OFFICIAL_SCHEMAS,
  XSD_ROOT,
  validateAgainstOfficialXsd,
} from '../../helpers/official-xsd.js';

// ============================================================
// #397 · The Anexo 24 XML against the SAT's official XSD.
//
// The other specs of this folder say what the generators EMIT. This one says
// whether the SAT's own schema accepts it, for the five documents, with the
// schemas vendored in the tree and no network. Every fixture is synthetic.
// ============================================================

const SAT_PREFIX = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/';

interface ProvenanceEntry {
  path: string;
  url: string;
  downloaded: string;
  sha256: string;
}

const provenance = JSON.parse(
  fs.readFileSync(path.join(XSD_ROOT, 'provenance.json'), 'utf8')
) as { files: ProvenanceEntry[] };

const vendoredXsds = (dir = XSD_ROOT): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? vendoredXsds(path.join(dir, entry.name))
        : entry.name.endsWith('.xsd')
          ? [path.relative(XSD_ROOT, path.join(dir, entry.name))]
          : []
    )
    .sort();

describe('the vendored schemas', () => {
  it('provenance.json lists every .xsd in the folder, and nothing else', () => {
    expect(provenance.files.map((f) => f.path).sort()).toEqual(vendoredXsds());
  });

  it.each(provenance.files.map((f) => [f.path, f] as const))(
    '%s is byte for byte what the SAT published: its SHA-256, URL and date',
    (file, entry) => {
      const bytes = fs.readFileSync(path.join(XSD_ROOT, file));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
      expect(entry.url).toBe(`https://www.sat.gob.mx/esquemas/${file}`);
      expect(entry.downloaded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  );

  it('every import of every schema is under the SAT prefix the catalog rewrites, and is vendored', () => {
    const vendored = new Set(vendoredXsds());
    const locations = vendoredXsds().flatMap((file) =>
      [...fs.readFileSync(path.join(XSD_ROOT, file), 'utf8').matchAll(/schemaLocation="([^"]+)"/g)].map(
        (m) => m[1]!
      )
    );
    expect(locations.length).toBeGreaterThan(0);
    for (const location of locations) {
      expect(location.startsWith(SAT_PREFIX), location).toBe(true);
      expect(vendored.has(`ContabilidadE/1_3/${location.slice(SAT_PREFIX.length)}`), location).toBe(true);
    }
  });

  it('the validation is offline: without the catalog, an import cannot be fetched and the schema does not compile', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, XML_CATALOG_FILES: '' };
    const run = spawnSync(
      'xmllint',
      ['--nonet', '--noout', '--schema', path.join(XSD_ROOT, OFFICIAL_SCHEMAS.chart), '-'],
      { input: '<x/>', encoding: 'utf8', env }
    );
    // Name the missing binary instead of failing on `status: null`.
    expect(run.error?.message, 'xmllint did not run: install libxml2-utils').toBeUndefined();
    expect(run.status).toBe(5);
    expect(run.stderr).toContain('failed to compile');
  });
});

// ── The five documents, as the generators produce them ─────────────────────

const account = (over: Partial<CuentaParaCatalogo> & { code: string }): CuentaParaCatalogo => ({
  name: `Cuenta ${over.code}`,
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

const chartXml = (): string => {
  const built = construirCatalogoCuentas({
    rfc: 'AAA010101AAA',
    anio: 2026,
    mes: 1,
    cuentas: [
      account({ code: '1000', name: 'Activo', codigo_agrupador_sat: '100' }),
      account({
        code: '1110',
        name: 'Caja y bancos',
        account_level: 2,
        parent_code: '1000',
        codigo_agrupador_sat: '102.01',
        lineas_posteadas: 3,
      }),
      account({
        code: '2110',
        name: 'Proveedores & Cía',
        codigo_agrupador_sat: '201',
        normal_balance: 'credit',
        account_type: 'liability',
        lineas_posteadas: 1,
      }),
    ],
    politicas: {
      niveles: 'jerarquia_completa',
      sinAgrupador: 'bloquear',
      sellado: 'nunca_sellar_en_el_sistema',
    },
  });
  expect(built.hallazgos.filter((h) => h.severidad === 'bloquea')).toEqual([]);
  return built.xml!;
};

const balanceRow = (code: string, over: Partial<CuentaDeBalanza> = {}): CuentaDeBalanza => ({
  account_id: `id-${code}`,
  num_cta: code,
  natur: 'D',
  saldo_ini_mayor: '4500.0000',
  debe: '1300.0000',
  haber: '400.0000',
  saldo_fin_mayor: '5400.0000',
  codigo_agrupador: '102.01',
  natur_del_agrupador: 'D',
  ...over,
});

const trialBalance = (over: Partial<DatosDeBalanza> = {}): DatosDeBalanza => ({
  rfc: 'AAA010101AAA',
  anio: 2026,
  mes: '02',
  tipoEnvio: 'N',
  cuentas: [
    balanceRow('1110'),
    // An asset with a credit balance: t_Importe admits negatives.
    balanceRow('1120', { saldo_ini_mayor: '0.0000', debe: '0.0000', haber: '250.0000', saldo_fin_mayor: '-250.0000' }),
    balanceRow('2110', {
      natur: 'A',
      saldo_ini_mayor: '-3000.0000',
      debe: '1000.0000',
      haber: '0.0000',
      saldo_fin_mayor: '-2000.0000',
      codigo_agrupador: '201',
      natur_del_agrupador: 'A',
    }),
  ],
  ...over,
});

// One entry that carries every evidence node and every payment node the
// generator can emit, so each attribute name is checked against the schema.
const journal = (): DatosDePolizas => ({
  rfc: 'AAA010101AAA',
  anio: 2026,
  mes: '02',
  solicitud: { tipo: 'AF', numOrden: 'ABC1234567/26' },
  polizas: [
    {
      numUnIdenPol: 'JE-2026-0001',
      fecha: '2026-02-10',
      concepto: 'Pago de las facturas A-100, B-7 y EXT-9',
      transacciones: [
        {
          numCta: '2110',
          desCta: 'Proveedores',
          concepto: 'Facturas del mes',
          debe: '3480.00',
          haber: '0.00',
          comprobantes: [
            {
              clase: 'nacional',
              uuid: 'A1B2C3D4-1111-2222-3333-444455556666',
              rfc: 'PSA010101AA1',
              montoTotal: '1160.00',
            },
            { clase: 'nacional_otro', serie: 'B', numFolio: '7', rfc: 'PSA010101AA1', montoTotal: '1160.00' },
            {
              clase: 'extranjero',
              numFactExt: 'EXT-9',
              taxId: '123456789',
              montoTotal: '60.00',
              moneda: 'USD',
              tipCamb: '19.3333',
            },
          ],
        },
        {
          numCta: '1110',
          desCta: 'Bancos',
          concepto: 'Salida de bancos',
          debe: '0.00',
          haber: '3480.00',
          pagos: [
            {
              clase: 'cheque',
              num: '10042',
              banEmisNal: '012',
              ctaOri: '012180001234567895',
              fecha: '2026-02-10',
              benef: 'Aceros & Cía',
              rfc: 'AAA010101AAA',
              monto: '1160.00',
              moneda: 'MXN',
            },
            {
              clase: 'transferencia',
              ctaOri: '012180001234567895',
              bancoOriNal: '012',
              ctaDest: '002180009876543210',
              bancoDestNal: '002',
              fecha: '2026-02-10',
              benef: 'Proveedor SA',
              rfc: 'PSA010101AA1',
              monto: '1160.00',
              moneda: 'MXN',
            },
            {
              clase: 'otro',
              metPagoPol: '01',
              fecha: '2026-02-10',
              benef: 'Proveedor SA',
              rfc: 'PSA010101AA1',
              monto: '1160.00',
            },
          ],
        },
      ],
    },
  ],
});

const voucherAuxiliary = (): DatosDeAuxiliarFolios => ({
  rfc: 'AAA010101AAA',
  anio: 2026,
  mes: '02',
  solicitud: { tipo: 'DE', numTramite: 'DE202600000009' },
  detalles: [
    {
      numUnIdenPol: 'JE-2026-0001',
      fecha: '2026-02-10',
      comprobantes: [
        {
          clase: 'nacional',
          uuid: 'A1B2C3D4-1111-2222-3333-444455556666',
          rfc: 'PSA010101AA1',
          montoTotal: '1160.00',
        },
        { clase: 'nacional_otro', serie: 'B', numFolio: '7', rfc: 'PSA010101AA1', montoTotal: '1160.00' },
        { clase: 'extranjero', numFactExt: 'EXT-9', montoTotal: '60.00', moneda: 'USD', tipCamb: '19.3333' },
      ],
    },
  ],
});

const accountAuxiliary = (): DatosDeAuxiliarCuentas => ({
  rfc: 'AAA010101AAA',
  anio: 2026,
  mes: '02',
  solicitud: { tipo: 'CO', numTramite: 'CO202600000004' },
  cuentas: [
    {
      numCta: '4100',
      desCta: 'Ventas',
      saldoIni: '7000.00',
      saldoFin: '8300.00',
      movimientos: [
        {
          fecha: '2026-02-10',
          numUnIdenPol: 'JE-2026-0002',
          concepto: 'Venta del mes',
          debe: '0.00',
          haber: '1300.00',
        },
      ],
    },
  ],
});

describe('the generated XML validates against its official XSD', () => {
  it('the chart of accounts', () => {
    expect(validateAgainstOfficialXsd(chartXml(), 'chart')).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['a regular month (TipoEnvio N)', {}],
    ['a complementary one (TipoEnvio C, with FechaModBal)', { tipoEnvio: 'C', fechaModBal: '2026-04-01' }],
    ['month 13, the closing adjustments', { mes: '13' }],
  ] as const)('the trial balance of %s', (_label, over) => {
    const xml = construirBalanzaXml(trialBalance(over));
    expect(validateAgainstOfficialXsd(xml, 'trialBalance')).toEqual({ valid: true, errors: [] });
  });

  it('the journal entries, with every evidence and payment node', () => {
    const xml = construirPolizasXml(journal());
    for (const node of ['CompNal', 'CompNalOtr', 'CompExt', 'Cheque', 'Transferencia', 'OtrMetodoPago']) {
      expect(xml).toContain(`<PLZ:${node} `);
    }
    expect(validateAgainstOfficialXsd(xml, 'journal')).toEqual({ valid: true, errors: [] });
  });

  it('the folio auxiliary', () => {
    const xml = construirAuxiliarFoliosXml(voucherAuxiliary());
    expect(validateAgainstOfficialXsd(xml, 'voucherAuxiliary')).toEqual({ valid: true, errors: [] });
  });

  it('the account auxiliary', () => {
    const xml = construirAuxiliarCuentasXml(accountAuxiliary());
    expect(validateAgainstOfficialXsd(xml, 'accountAuxiliary')).toEqual({ valid: true, errors: [] });
  });
});

describe('the validation bites', () => {
  it('an attribute the XSD does not declare fails, and the error names it', () => {
    const xml = construirBalanzaXml(trialBalance()).replace('<BCE:Ctas ', '<BCE:Ctas Inventado="1" ');
    const verdict = validateAgainstOfficialXsd(xml, 'trialBalance');
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.join('\n')).toContain("The attribute 'Inventado' is not allowed");
  });

  it('the XSD rejects the filing number the generator used to let through', () => {
    const xml = construirAuxiliarFoliosXml(voucherAuxiliary()).replace(
      'NumTramite="DE202600000009"',
      'NumTramite="T-2026-9"'
    );
    const verdict = validateAgainstOfficialXsd(xml, 'voucherAuxiliary');
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.join('\n')).toContain("attribute 'NumTramite'");
  });

  it('a document that is not well-formed is a verdict, not a crash', () => {
    const verdict = validateAgainstOfficialXsd('<BCE:Balanza', 'trialBalance');
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.length).toBeGreaterThan(0);
  });
});

// ── #404 · The rules say what the XSD says ─────────────────────────────────
//
// Each case is applied twice: to the rows the rule validator sees, and to the
// XML the chart generator emits for the same rows. The rule must block
// exactly when the SAT's schema rejects.

const chartHeader: CabeceraCatalogo = { RFC: 'AAA010101AAA', Mes: '01', Anio: '2026' };
const chartRows: FilaCtas[] = [
  { NumCta: '1000', Desc: 'Activo', CodAgrup: '100', Nivel: 1, Natur: 'D' },
  { NumCta: '1110', Desc: 'Caja y bancos', SubCtaDe: '1000', CodAgrup: '102.01', Nivel: 2, Natur: 'D' },
  { NumCta: '2110', Desc: 'Proveedores & Cía', CodAgrup: '201', Nivel: 1, Natur: 'A' },
];

interface ChartCase {
  header?: Partial<CabeceraCatalogo>;
  /** Replaces attributes of the last account, 2110, which has no children. */
  row?: Partial<FilaCtas>;
  /** The same change, on the emitted XML. */
  xml: (xml: string) => string;
  /** The rule that blocks, or null when the XSD accepts the value. */
  rule: string | null;
  /** Where the rule comes from, when it is not a facet of the XSD alone. */
  source?: string;
}

const lastRow =
  (attribute: string, value: string) =>
  (xml: string): string =>
    xml.replace(
      /(<catalogocuentas:Ctas [^>]*NumCta="2110"[^>]*)\/>/,
      (_m, node: string) => `${node.replace(new RegExp(` ${attribute}="[^"]*"`), ` ${attribute}="${value}"`)}/>`
    );
const headerAttribute =
  (attribute: string, value: string) =>
  (xml: string): string =>
    xml.replace(new RegExp(` ${attribute}="[^"]*"`), ` ${attribute}="${value}"`);

const rowCase = (attribute: keyof FilaCtas, value: string, rule: string | null): ChartCase => ({
  row: { [attribute]: value },
  xml: lastRow(attribute, value),
  rule,
});
const yearCase = (year: string, rule: string | null): ChartCase => ({
  header: { Anio: year },
  xml: headerAttribute('Anio', year),
  rule,
});

const rfcCase = (rfc: string, rule: string | null): ChartCase => ({
  header: { RFC: rfc },
  xml: headerAttribute('RFC', rfc),
  rule,
  source: 'estructura_publicada',
});
// 399 letters and one astral character: 400 characters to XML Schema, 401
// UTF-16 code units to `String.length`.
const emojiDesc = (letters: number): string => `${'d'.repeat(letters)}\u{1F4B0}`;

const chartCases: Array<[string, ChartCase]> = [
  ['a Desc of 150 characters', rowCase('Desc', 'd'.repeat(150), null)],
  ['a Desc of exactly 400', rowCase('Desc', 'd'.repeat(400), null)],
  ['a Desc of 401', rowCase('Desc', 'd'.repeat(401), 'CAT-LONGITUD')],
  ['a Desc of 400 characters, one of them an emoji', rowCase('Desc', emojiDesc(399), null)],
  ['a Desc of 401 characters, one of them an emoji', rowCase('Desc', emojiDesc(400), 'CAT-LONGITUD')],
  ['an RFC whose month digit is above 1', rfcCase('AAA019901AA1', 'CAT-RFC')],
  ['an RFC whose day digit is above 3', rfcCase('AAA010141AA1', 'CAT-RFC')],
  ['an RFC dated 1999-12-31', rfcCase('AAA991231AA1', null)],
  ['a NumCta of exactly 100', rowCase('NumCta', '9'.repeat(100), null)],
  ['a NumCta of 101', rowCase('NumCta', '9'.repeat(101), 'CAT-LONGITUD')],
  ['a Desc with leading and trailing spaces', rowCase('Desc', ' Caja ', null)],
  ['a CodAgrup of the right shape that is not on c_CodAgrup', rowCase('CodAgrup', '100.99', 'CAT-CODAGRUP-ENUM')],
  ['Anio 2014', yearCase('2014', 'CAT-ANIO-RANGO')],
  ['Anio 2015', yearCase('2015', null)],
  ['Anio 2099', yearCase('2099', null)],
  ['Anio 2100', yearCase('2100', 'CAT-ANIO-RANGO')],
];

describe('the chart rule validator blocks exactly what CatalogoCuentas_1_3.xsd rejects', () => {
  it.each(chartCases)('%s', (_label, c) => {
    const rows = chartRows.map((r, i) => (i === chartRows.length - 1 ? { ...r, ...c.row } : r));
    const findings = validarCatalogo({ ...chartHeader, ...c.header }, rows);
    const original = chartXml();
    const xml = c.xml(original);
    expect(xml).not.toBe(original);
    const verdict = validateAgainstOfficialXsd(xml, 'chart');

    if (c.rule === null) {
      expect(findings).toEqual([]);
      expect(verdict).toEqual({ valid: true, errors: [] });
    } else {
      expect(findings.map((h) => [h.regla, h.severidad, h.procedencia])).toEqual([
        [c.rule, 'bloquea', c.source ?? 'official_xsd'],
      ]);
      if (c.source === undefined) expect(findings[0]!.mensaje).toMatch(/\.xsd/);
      expect(verdict.valid).toBe(false);
    }
  });
});

describe('the closed lists are read from CatalogosParaEsqContE.xsd, not copied', () => {
  it('the parser finds every enumeration value the schema declares', () => {
    const xsd = fs.readFileSync(path.join(XSD_ROOT, OFFICIAL_ENUMERATIONS_XSD), 'utf8');
    // The SAT's file repeats four values of c_CodAgrupH, so compare sets.
    const declared = new Set([...xsd.matchAll(/<xs:enumeration value="([^"]*)"/g)].map((m) => m[1]));
    const parsed = parseEnumerations(xsd);
    expect(declared.size).toBeGreaterThan(0);
    expect(new Set([...parsed.values()].flatMap((values) => [...values]))).toEqual(declared);
    expect([...parsed.keys()]).toEqual(expect.arrayContaining(['c_CodAgrup', 'c_Banco', 'c_Moneda', 'c_MetPagos']));
  });

  it('every payment method the system records maps to a code on c_MetPagos', () => {
    const offList = Object.entries(METODO_A_SAT).filter(([, code]) => !officialEnumeration('c_MetPagos').has(code));
    expect(offList).toEqual([]);
  });

  it('an unknown list is a setup error, not an empty list', () => {
    expect(() => officialEnumeration('c_Inventado' as 'c_Banco')).toThrow(/c_Inventado/);
  });
});

type JournalMutation = (d: DatosDePolizas) => void;
const payment = (d: DatosDePolizas, i: number): object => d.polizas[0]!.transacciones[1]!.pagos![i]!;
const evidence = (d: DatosDePolizas, i: number): object => d.polizas[0]!.transacciones[0]!.comprobantes![i]!;

const journalCases: Array<[node: string, attribute: string, bad: string, mutate: JournalMutation]> = [
  ['CompNal', 'Moneda', 'QQQ', (d) => Object.assign(evidence(d, 0), { moneda: 'QQQ' })],
  ['CompNalOtr', 'CFD_CBB_Serie', 'b1', (d) => Object.assign(evidence(d, 1), { serie: 'b1' })],
  ['CompNalOtr', 'CFD_CBB_Serie', 'ABCDEFGHIJK', (d) => Object.assign(evidence(d, 1), { serie: 'ABCDEFGHIJK' })],
  ['CompExt', 'Moneda', 'MXP', (d) => Object.assign(evidence(d, 2), { moneda: 'MXP' })],
  ['Cheque', 'BanEmisNal', '003', (d) => Object.assign(payment(d, 0), { banEmisNal: '003' })],
  // The bank codes are required (#532): an empty one is off c_Banco too.
  ['Cheque', 'BanEmisNal', '', (d) => Object.assign(payment(d, 0), { banEmisNal: '' })],
  ['Transferencia', 'BancoOriNal', '', (d) => Object.assign(payment(d, 1), { bancoOriNal: '' })],
  ['Transferencia', 'BancoDestNal', '', (d) => Object.assign(payment(d, 1), { bancoDestNal: '' })],
  ['Cheque', 'Moneda', 'QQQ', (d) => Object.assign(payment(d, 0), { moneda: 'QQQ' })],
  ['Transferencia', 'BancoOriNal', '003', (d) => Object.assign(payment(d, 1), { bancoOriNal: '003' })],
  ['Transferencia', 'BancoDestNal', '001', (d) => Object.assign(payment(d, 1), { bancoDestNal: '001' })],
  ['OtrMetodoPago', 'MetPagoPol', '18', (d) => Object.assign(payment(d, 2), { metPagoPol: '18' })],
];

describe('the journal generator refuses, by name, a value the XSD rejects', () => {
  it.each(journalCases)('PLZ:%s/@%s = %s', (node, attribute, bad, mutate) => {
    const data = journal();
    mutate(data);
    expect(() => construirPolizasXml(data)).toThrow(ValidationError);
    expect(() => construirPolizasXml(data)).toThrow(`PLZ:${node}/@${attribute} = «${bad}»`);

    // The same value, written into a valid file: the XSD rejects it too.
    // Attribute order is not significant in XML, so an absent one goes first.
    const valid = construirPolizasXml(journal());
    const present = new RegExp(`(<PLZ:${node} [^>]*?)${attribute}="[^"]*"`);
    const xml = present.test(valid)
      ? valid.replace(present, `$1${attribute}="${bad}"`)
      : valid.replace(`<PLZ:${node} `, `<PLZ:${node} ${attribute}="${bad}" `);
    expect(xml).not.toBe(valid);
    const verdict = validateAgainstOfficialXsd(xml, 'journal');
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.join('\n')).toContain(`attribute '${attribute}'`);
  });

  it('names every entry at once, and builds anyway for a caller that reported them', () => {
    const data = journal();
    Object.assign(evidence(data, 0), { moneda: 'VES' });
    Object.assign(payment(data, 1), { bancoOriNal: '003' });
    const entry = data.polizas[0]!.numUnIdenPol;
    expect(() => construirPolizasXml(data)).toThrow(
      new RegExp(`póliza ${entry}: PLZ:CompNal/@Moneda = «VES».*póliza ${entry}: PLZ:Transferencia/@BancoOriNal = «003»`)
    );
    const shown = construirPolizasXml(data, { allowOffList: true });
    expect(shown).toContain('Moneda="VES"');
    expect(shown).toContain('BancoOriNal="003"');
  });

  it('the folio auxiliary shares the voucher node, and with it the check', () => {
    const data = voucherAuxiliary();
    Object.assign(data.detalles[0]!.comprobantes[2]!, { moneda: 'QQQ' });
    expect(() => construirAuxiliarFoliosXml(data)).toThrow('RepAuxFol:ComprExt/@Moneda = «QQQ»');
  });
});
