import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  construirBalanzaXml,
  nombreDelArchivo,
  MES_DE_CIERRE,
  type DatosDeBalanza,
} from '../../../src/services/sat/anexo24/balanza-xml.js';
import { catalogoDesdeXml } from '../../../src/services/sat/anexo24/balanza-service.js';
import type { CuentaDeBalanza } from '../../../src/services/sat/anexo24/balanza-invariantes.js';
import { ValidationError } from '../../../src/utils/errors.js';
import { OFFICIAL_SCHEMAS, XSD_ROOT } from '../../../src/services/sat/anexo24/official-xsd.js';

// ============================================================
// F07b · EL ARCHIVO QUE SE ENTREGA.
//
// Lo que estas pruebas fijan y lo que deliberadamente NO fijan:
//
//   SÍ · que el archivo sale SIN SELLO, siempre y por decisión.
//   SÍ · que los bytes son idénticos para entradas idénticas, que es el
//        requisito literal del catálogo de comandos y lo que hace que diffear
//        la presentación de este mes contra la del anterior signifique algo.
//   SÍ · que las combinaciones que la autoridad rechaza se niegan ANTES de
//        construir nada: RFC que no lo es, Mes 14, complementaria sin fecha.
//
//   Whether the SAT's official XSD accepts the file is not here: it is
//   tests/sat/anexo24/official-xsd.spec.ts, against the schemas vendored in
//   src/services/sat/anexo24/xsd/ (#397).
// ============================================================

const cta = (over: Partial<CuentaDeBalanza> = {}): CuentaDeBalanza => ({
  account_id: 'id-1120',
  num_cta: '1120',
  natur: 'D',
  saldo_ini_mayor: '4500.0000',
  debe: '1300.0000',
  haber: '400.0000',
  saldo_fin_mayor: '5400.0000',
  codigo_agrupador: '105.01',
  natur_del_agrupador: 'D',
  ...over,
});

const datos = (over: Partial<DatosDeBalanza> = {}): DatosDeBalanza => ({
  rfc: 'AAA010101AAA',
  anio: 2026,
  mes: '02',
  tipoEnvio: 'N',
  cuentas: [cta()],
  ...over,
});

describe('el nodo raíz', () => {
  it('declara el espacio de nombres, la versión y el periodo', () => {
    const xml = construirBalanzaXml(datos());
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain(
      'xmlns:BCE="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion"'
    );
    expect(xml).toContain('Version="1.3"');
    expect(xml).toContain('RFC="AAA010101AAA"');
    expect(xml).toContain('Mes="02"');
    expect(xml).toContain('Anio="2026"');
    expect(xml).toContain('TipoEnvio="N"');
  });

  it('NO lleva Sello, noCertificado ni Certificado. Nunca.', () => {
    // No es que este tramo no haya llegado a sellar: es que sellar no es suyo.
    // La e.firma es el contribuyente firmando, no el software, y este módulo
    // no tiene por dónde cargar una llave privada.
    const xml = construirBalanzaXml(datos());
    expect(xml).not.toContain('Sello=');
    expect(xml).not.toContain('noCertificado=');
    expect(xml).not.toContain('Certificado=');
  });

  it('el nodo Ctas lleva las cinco columnas y ninguna más', () => {
    const xml = construirBalanzaXml(datos());
    expect(xml).toContain(
      '<BCE:Ctas NumCta="1120" SaldoIni="4500.00" Debe="1300.00" Haber="400.00" SaldoFin="5400.00"/>'
    );
  });
});

describe('los tres tipos de envío', () => {
  it('N es la normal, y no admite FechaModBal', () => {
    expect(construirBalanzaXml(datos())).not.toContain('FechaModBal');
    expect(() => construirBalanzaXml(datos({ fechaModBal: '2026-04-01' }))).toThrow(ValidationError);
  });

  it('C es la complementaria, y SIN FechaModBal se niega', () => {
    // Sin ella la autoridad no sabe qué presentación se está corrigiendo.
    expect(() => construirBalanzaXml(datos({ tipoEnvio: 'C' }))).toThrow(/FechaModBal/);
    const xml = construirBalanzaXml(datos({ tipoEnvio: 'C', fechaModBal: '2026-04-01' }));
    expect(xml).toContain('TipoEnvio="C"');
    expect(xml).toContain('FechaModBal="2026-04-01"');
  });

  it('la de CIERRE se distingue por Mes 13 y por nada más', () => {
    // Mismo esquema, mismo TipoEnvio, misma estructura. Lo que cambia está
    // fuera del archivo: qué movimiento declara.
    const xml = construirBalanzaXml(datos({ mes: MES_DE_CIERRE }));
    expect(xml).toContain('Mes="13"');
    expect(xml).toContain('TipoEnvio="N"');
  });

  it('Mes 14 no existe', () => {
    expect(() => construirBalanzaXml(datos({ mes: '14' }))).toThrow(/Mes/);
    expect(() => construirBalanzaXml(datos({ mes: '2' }))).toThrow(/Mes/);
  });
});

describe('lo que se niega antes de construir nada', () => {
  it('un identificador que no es RFC', () => {
    // Una sociedad de Delaware con EIN no presenta contabilidad electrónica.
    expect(() => construirBalanzaXml(datos({ rfc: '12-3456789' }))).toThrow(/RFC/);
  });

  it('un ejercicio fuera del rango del esquema', () => {
    expect(() => construirBalanzaXml(datos({ anio: 1999 }))).toThrow(/Anio/);
  });

  it('una balanza sin una sola cuenta', () => {
    // Se acepta y declara que en ese periodo no hubo contabilidad, que es peor
    // que un error.
    expect(() => construirBalanzaXml(datos({ cuentas: [] }))).toThrow(/no account to declare/);
  });

  it('dos nodos Ctas con el mismo NumCta', () => {
    expect(() =>
      construirBalanzaXml(datos({ cuentas: [cta(), cta({ account_id: 'otro' })] }))
    ).toThrow(/Repeated NumCta/);
  });
});

describe('bytes idénticos para entradas idénticas', () => {
  it('dos generaciones con los mismos datos dan la MISMA cadena', () => {
    // Es el requisito literal del catálogo de comandos, y lo que hace que un
    // humano pueda diffear la presentación de este mes contra la del anterior.
    expect(construirBalanzaXml(datos())).toBe(construirBalanzaXml(datos()));
  });

  it('el orden de las filas es el que se le pasa, y sale en los bytes', () => {
    const a = construirBalanzaXml(
      datos({ cuentas: [cta(), cta({ account_id: 'b', num_cta: '4100', natur: 'A' })] })
    );
    const b = construirBalanzaXml(
      datos({ cuentas: [cta({ account_id: 'b', num_cta: '4100', natur: 'A' }), cta()] })
    );
    expect(a).not.toBe(b);
    expect(a.indexOf('1120')).toBeLessThan(a.indexOf('4100'));
  });

  it('un nombre con «&» no rompe el archivo: el escapado es estructural', () => {
    // La balanza sólo lleva números de cuenta, pero el número es un dato del
    // cliente y el escapado no puede depender de que se acuerden.
    const xml = construirBalanzaXml(datos({ cuentas: [cta({ num_cta: 'A&B' })] }));
    expect(xml).toContain('NumCta="A&amp;B"');
  });
});

describe('el nombre del archivo', () => {
  it('lleva RFC, ejercicio, mes y tipo', () => {
    expect(nombreDelArchivo({ rfc: 'AAA010101AAA', anio: 2026, mes: '02', tipoEnvio: 'N' })).toBe(
      'AAA010101AAA202602BN.XML'
    );
    expect(nombreDelArchivo({ rfc: 'BNA010101AAA', anio: 2026, mes: '13', tipoEnvio: 'C' })).toBe(
      'BNA010101AAA202613BC.XML'
    );
  });
});

// ============================================================
// EL COTEJO CRUZADO LEE EL CATÁLOGO QUE SE ENTREGÓ
// ============================================================

describe('catalogoDesdeXml', () => {
  const catalogo = (prefijo: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<${prefijo}Catalogo xmlns:catalogocuentas="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas" Version="1.3" RFC="AAA010101AAA" Mes="02" Anio="2026">
  <${prefijo}Ctas CodAgrup="105.01" NumCta="1120" Desc="Cuentas por Cobrar" Nivel="2" Natur="D"/>
  <${prefijo}Ctas CodAgrup="401.01" NumCta="4100" Desc="Ventas" Nivel="2" Natur="A"/>
</${prefijo}Catalogo>`;

  it('extrae los NumCta que el archivo declara', () => {
    const c = catalogoDesdeXml(catalogo('catalogocuentas:'), 'sha-1');
    expect(c.origen).toBe('artefacto_archivado');
    expect(c.referencia).toBe('sha-1');
    expect(c.cuentas).toEqual(['1120', '4100']);
  });

  it('no depende del prefijo que eligiera quien lo generó', () => {
    // Preguntar por un prefijo concreto es cómo un cotejo devuelve cero
    // cuentas en silencio, y cero cuentas aquí se leería como «ninguna cuenta
    // de la balanza está declarada».
    expect(catalogoDesdeXml(catalogo('')).cuentas).toEqual(['1120', '4100']);
  });

  it('un catálogo sin un solo NumCta se niega en vez de condenar la balanza', () => {
    expect(() =>
      catalogoDesdeXml('<?xml version="1.0"?><catalogocuentas:Catalogo Version="1.3"/>')
    ).toThrow(/no declara ningún NumCta/);
  });

  // Numeric references, never `&amp;`: the library decodes `&amp;` even without
  // the shared reader, so a test written with it passes against the defect (#218).
  it('decodes numeric character references in NumCta', () => {
    const xml = catalogo('catalogocuentas:').replace('NumCta="1120"', 'NumCta="&#49;120"');
    expect(catalogoDesdeXml(xml).cuentas).toEqual(['1120', '4100']);
  });

  it('reads `&#10;` inside NumCta as the space the SAT read (XML 1.0 §3.3.3)', () => {
    const xml = catalogo('catalogocuentas:').replace('NumCta="1120"', 'NumCta="11&#10;20"');
    expect(catalogoDesdeXml(xml).cuentas).toEqual(['11 20', '4100']);
  });

  it('un archivo que no es XML bien formado se niega', () => {
    expect(() => catalogoDesdeXml('<Catalogo><Ctas NumCta="1"></Catalogo>')).toThrow(
      ValidationError
    );
  });
});

// ============================================================
// MNE-001-775 (#608) · Each hand-written rule says what BalanzaComprobacion
// 1.3 says, so the refusal names the account or the datum before the XSD gate
// of #982 names an XML line. The six cases are #982's, measured there with the
// builders and xmllint; each comes with the boundary the schema accepts.
// ============================================================

/** The builder's refusal of `d`, or a failure when it built the file. */
function refusalOf(d: DatosDeBalanza): ValidationError {
  try {
    construirBalanzaXml(d);
  } catch (err) {
    if (err instanceof ValidationError) return err;
    throw err;
  }
  throw new Error('the builder built a file the schema rejects');
}

describe('the hand-written rules say what the schema says (MNE-001-775)', () => {
  it('RFC: the date digits are the schema pattern, month 99 and day 99 are refused naming the RFC', () => {
    for (const rfc of ['AAA019901AAA', 'AAA010199AAA']) {
      const e = refusalOf(datos({ rfc }));
      expect(e.messageKey).toEqual({ key: 'anexo24.balance.rfc', params: { rfc } });
      expect(e.message).toContain(`«${rfc}»`);
    }
    // The schema takes a month digit 0-1 and a day digit 0-3, whatever follows.
    expect(construirBalanzaXml(datos({ rfc: 'AAA011939AAA' }))).toContain('RFC="AAA011939AAA"');
    expect(construirBalanzaXml(datos({ rfc: 'AAAA010101AA1' }))).toContain('RFC="AAAA010101AA1"');
  });

  it('FechaModBal: a real day on or after 2015-01-01, naming the date', () => {
    const amended = (modified: string) => datos({ tipoEnvio: 'C', fechaModBal: modified });
    for (const day of ['2014-12-31', '2026-13-45', '2026-02-29']) {
      expect(refusalOf(amended(day)).messageKey).toEqual({
        key: 'anexo24.balance.modified_date',
        params: { date: day },
      });
    }
    expect(construirBalanzaXml(amended('2015-01-01'))).toContain('FechaModBal="2015-01-01"');
    expect(construirBalanzaXml(amended('2024-02-29'))).toContain('FechaModBal="2024-02-29"');
  });

  it('NumCta: 1 to 100 characters, counted as the schema counts them, naming the account', () => {
    const long = '9'.repeat(101);
    expect(refusalOf(datos({ cuentas: [cta({ num_cta: long })] })).messageKey).toEqual({
      key: 'anexo24.balance.account_number_length',
      params: { account: long, length: 101 },
    });
    expect(refusalOf(datos({ cuentas: [cta({ num_cta: '' })] })).messageKey?.params).toEqual({
      account: '',
      length: 0,
    });
    // 100 «ñ» are 100 characters to the schema, whatever String.length says.
    expect(construirBalanzaXml(datos({ cuentas: [cta({ num_cta: 'ñ'.repeat(100) })] }))).toContain('ñ'.repeat(100));
  });

  it('amounts: t_Importe admits 22 integer digits, and the refusal names the account and the column', () => {
    const big = '12345678901234567890123.0000';
    expect(refusalOf(datos({ cuentas: [cta({ saldo_ini_mayor: big })] })).messageKey).toEqual({
      key: 'anexo24.balance.amount_out_of_range',
      params: { account: '1120', column: 'SaldoIni', amount: '12345678901234567890123.00' },
    });
    // minExclusive: the negative of the maximum is out, one cent above it is in.
    expect(
      refusalOf(datos({ cuentas: [cta({ haber: '-9999999999999999999999.99' })] })).messageKey?.params
    ).toMatchObject({ column: 'Haber' });
    const edge = construirBalanzaXml(
      datos({ cuentas: [cta({ debe: '9999999999999999999999.99', haber: '-9999999999999999999999.98' })] })
    );
    expect(edge).toContain('Debe="9999999999999999999999.99"');
  });

  it('the rules that were already the schema speak by key too', () => {
    expect(refusalOf(datos({ rfc: '12-3456789' })).messageKey?.key).toBe('anexo24.balance.rfc');
    expect(refusalOf(datos({ mes: '14' })).messageKey).toEqual({ key: 'anexo24.balance.month', params: { month: '14' } });
    expect(refusalOf(datos({ anio: 1999 })).messageKey?.key).toBe('anexo24.balance.year');
    expect(refusalOf(datos({ tipoEnvio: 'C' })).messageKey?.key).toBe('anexo24.balance.amended_without_date');
    expect(refusalOf(datos({ fechaModBal: '2026-04-01' })).messageKey?.key).toBe('anexo24.balance.normal_with_date');
    expect(refusalOf(datos({ cuentas: [] })).messageKey?.key).toBe('anexo24.balance.no_accounts');
    expect(
      refusalOf(datos({ cuentas: [cta(), cta({ account_id: 'b', num_cta: '4100' }), cta({ account_id: 'c' })] }))
        .messageKey
    ).toEqual({ key: 'anexo24.balance.repeated_account', params: { accounts: '1120' } });
  });
});

describe('the hand-written rules and the official XSD agree (MNE-001-775)', () => {
  // Each document is a valid balance with ONE attribute replaced in its
  // bytes, so the schema judges exactly the value the builder judged. All of
  // them go to ONE xmllint process.
  const base = construirBalanzaXml(datos());
  const amendedBase = construirBalanzaXml(datos({ tipoEnvio: 'C', fechaModBal: '2026-04-01' }));
  const cases: Array<{ name: string; data: DatosDeBalanza; xml: string }> = [];
  const rfc = (v: string) =>
    cases.push({ name: `RFC ${v}`, data: datos({ rfc: v }), xml: base.replace('RFC="AAA010101AAA"', `RFC="${v}"`) });
  const date = (v: string) =>
    cases.push({
      name: `FechaModBal ${v}`,
      data: datos({ tipoEnvio: 'C', fechaModBal: v }),
      xml: amendedBase.replace('FechaModBal="2026-04-01"', `FechaModBal="${v}"`),
    });
  const accountNumber = (v: string) =>
    cases.push({
      name: `NumCta of ${[...v].length}`,
      data: datos({ cuentas: [cta({ num_cta: v })] }),
      xml: base.replace('NumCta="1120"', `NumCta="${v}"`),
    });
  const openingBalance = (v: string) =>
    cases.push({
      name: `SaldoIni ${v}`,
      data: datos({ cuentas: [cta({ saldo_ini_mayor: v })] }),
      xml: base.replace('SaldoIni="4500.00"', `SaldoIni="${v}"`),
    });
  ['AAA019901AAA', 'AAA010199AAA', 'AAA011939AAA', 'AAAA010101AA1'].forEach(rfc);
  ['2014-12-31', '2026-13-45', '2026-02-29', '2015-01-01', '2024-02-29'].forEach(date);
  ['9'.repeat(101), '9'.repeat(100), 'ñ'.repeat(100)].forEach(accountNumber);
  [
    '12345678901234567890123.00',
    '9999999999999999999999.99',
    '-9999999999999999999999.99',
    '-9999999999999999999999.98',
  ].forEach(openingBalance);

  it('for every case, the builder refuses exactly when the schema rejects', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mne-001-775-'));
    try {
      const files = cases.map((c, i) => {
        const file = path.join(dir, `${i}.xml`);
        writeFileSync(file, c.xml);
        return file;
      });
      const run = spawnSync(
        'xmllint',
        ['--nonet', '--noout', '--schema', path.join(XSD_ROOT, OFFICIAL_SCHEMAS.trialBalance), ...files],
        { encoding: 'utf8', maxBuffer: Infinity }
      );
      expect(run.error, 'xmllint must be on the PATH').toBeUndefined();
      const verdicts = cases.map((c, i) => {
        const schemaRejects = run.stderr.includes(`${files[i]} fails to validate`);
        expect(schemaRejects || run.stderr.includes(`${files[i]} validates`), c.name).toBe(true);
        let builderRefuses = false;
        try {
          construirBalanzaXml(c.data);
        } catch (err) {
          if (!(err instanceof ValidationError)) throw err;
          builderRefuses = true;
        }
        return [c.name, builderRefuses, schemaRejects];
      });
      // Every case, the boundaries too, says the same both ways.
      expect(verdicts.filter(([, b, s]) => b !== s)).toEqual([]);
      // And the table holds both verdicts: 8 rejections, 8 acceptances.
      expect(verdicts.filter(([, , s]) => s)).toHaveLength(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
