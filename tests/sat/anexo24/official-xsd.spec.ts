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
