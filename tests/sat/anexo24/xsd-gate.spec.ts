import { describe, expect, it } from 'vitest';
import {
  construirCatalogoCuentas,
  type CuentaParaCatalogo,
} from '../../../src/services/sat/anexo24/catalogo-cuentas.js';
import { construirBalanzaXml, type DatosDeBalanza } from '../../../src/services/sat/anexo24/balanza-xml.js';
import type { CuentaDeBalanza } from '../../../src/services/sat/anexo24/balanza-invariantes.js';
import { officialXsdRefusal } from '../../../src/services/sat/anexo24/official-xsd.js';
import { xsdFindings } from '../../../src/services/sat/anexo24/balanza-invariantes.js';

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
    // Month 99: the builder's own RFC check takes any six digits, the schema does not.
    const refusal = officialXsdRefusal(balance({ rfc: 'AAA019901AAA' }), 'trialBalance');
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

  it('shows the first five lines, each cut at 300 characters, and counts the rest', () => {
    // Eight accounts whose NumCta has 101 characters: eight maxLength errors.
    const long = ['1', '2', '3', '4', '5', '6', '7', '8'].map((d) => account(d.repeat(101)));
    const refusal = officialXsdRefusal(balance({ cuentas: long }), 'trialBalance');
    const params = refusal?.messageKey?.params as { errors: string; more: number };
    expect(params.more).toBe(3);
    expect(params.errors.match(/line \d+: /g)).toHaveLength(5);
    // xmllint quotes the 101 characters, so every line runs past the limit:
    // 5 lines of 300 and 4 separators of 2.
    expect(params.errors).toHaveLength(1508);
    expect(params.errors).toMatch(/^line 3: .*attribute 'NumCta'.*…; line 4: /);
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
    const found = xsdFindings(balance({ rfc: 'AAA019901AAA' }));
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
});
