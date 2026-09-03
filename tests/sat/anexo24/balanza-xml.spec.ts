import { describe, it, expect } from 'vitest';
import {
  construirBalanzaXml,
  nombreDelArchivo,
  MES_DE_CIERRE,
  type DatosDeBalanza,
} from '../../../src/services/sat/anexo24/balanza-xml.js';
import {
  catalogoDesdeXml,
  totalesDeclarados,
} from '../../../src/services/sat/anexo24/balanza-service.js';
import type { CuentaDeBalanza } from '../../../src/services/sat/anexo24/balanza-invariantes.js';
import { ValidationError } from '../../../src/utils/errors.js';

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
//   NO · que el documento valide contra el XSD oficial. No hay ni un `.xsd` en
//        el repositorio y esta máquina no tiene red. Estas pruebas dicen lo
//        que el generador EMITE; el día que se traigan los esquemas, son ellas
//        las que hay que confrontar.
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
  tiene_hijas: false,
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
    expect(() => construirBalanzaXml(datos({ cuentas: [] }))).toThrow(/ninguna cuenta/);
  });

  it('dos nodos Ctas con el mismo NumCta', () => {
    expect(() =>
      construirBalanzaXml(datos({ cuentas: [cta(), cta({ account_id: 'otro' })] }))
    ).toThrow(/repetido/);
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

describe('la suma de control', () => {
  it('foota Debe y Haber sobre TODAS las filas, con decimal.js', () => {
    // 0.1 + 0.2 en coma flotante da 0.30000000000000004. Las columnas de una
    // balanza se suman a mano contra el mayor y ese cuarto decimal aparece.
    const t = totalesDeclarados([
      cta({ debe: '0.1000', haber: '0.2000' }),
      cta({ debe: '0.2000', haber: '0.1000' }),
    ]);
    expect(t).toEqual({ debe: '0.30', haber: '0.30' });
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

  it('un archivo que no es XML bien formado se niega', () => {
    expect(() => catalogoDesdeXml('<Catalogo><Ctas NumCta="1"></Catalogo>')).toThrow(
      ValidationError
    );
  });
});
