import { describe, it, expect } from 'vitest';
import {
  readBalanzaComprobacion,
  cuadraEnAlgunaNaturaleza,
} from '../../../src/services/sat/anexo24/balance-reader.js';
import { construirBalanzaXml } from '../../../src/services/sat/anexo24/balanza-xml.js';
import type { CuentaDeBalanza } from '../../../src/services/sat/anexo24/balanza-invariantes.js';
import { ValidationError } from '../../../src/utils/errors.js';

// ============================================================
// O1 · EL LECTOR DE LA BALANZA
//
// La prueba que manda está al final: la IDA Y LA VUELTA. Lo que
// `construirBalanzaXml` escribe, este lector lo devuelve campo por campo y sin
// un solo hallazgo. Si esa no pasa, el sistema no puede releer lo que él mismo
// entrega y el cotejo «al peso» de la migración no significa nada.
// ============================================================

const NS = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion';

interface FilaXml {
  numCta: string;
  saldoIni?: string;
  debe?: string;
  haber?: string;
  saldoFin?: string;
  /** Para omitir un atributo entero. */
  omitir?: 'NumCta' | 'SaldoIni' | 'Debe' | 'Haber' | 'SaldoFin';
}

function fila(f: FilaXml): string {
  const partes: [string, string][] = [
    ['NumCta', f.numCta],
    ['SaldoIni', f.saldoIni ?? '0.00'],
    ['Debe', f.debe ?? '0.00'],
    ['Haber', f.haber ?? '0.00'],
    ['SaldoFin', f.saldoFin ?? f.saldoIni ?? '0.00'],
  ];
  return `<BCE:Ctas ${partes
    .filter(([k]) => k !== f.omitir)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')}/>`;
}

function archivo(
  filas: FilaXml[],
  cabecera: Partial<{ rfc: string; version: string; mes: string; anio: string; tipoEnvio: string }> = {}
): string {
  const atributos: [string, string | undefined][] = [
    ['Version', cabecera.version ?? '1.3'],
    ['RFC', cabecera.rfc ?? 'AAA010101AAA'],
    ['Mes', cabecera.mes ?? '12'],
    ['Anio', cabecera.anio ?? '2025'],
    ['TipoEnvio', cabecera.tipoEnvio ?? 'N'],
  ];
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<BCE:Balanza xmlns:BCE="${NS}" ` +
    atributos
      .filter((a): a is [string, string] => a[1] !== undefined)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ') +
    `>${filas.map(fila).join('')}</BCE:Balanza>`
  );
}

const reglas = (xml: string): string[] =>
  readBalanzaComprobacion(xml).findings.map((f) => f.regla);

// ------------------------------------------------------------
// 1 · CUANDO NO HAY BALANZA QUE LEER, SE LANZA
// ------------------------------------------------------------

describe('readBalanzaComprobacion · lo que no es una balanza', () => {
  it('un XML mal formado lanza y dice en qué línea', () => {
    expect(() => readBalanzaComprobacion('<BCE:Balanza><BCE:Ctas></BCE:Balanza>')).toThrow(
      ValidationError
    );
    try {
      readBalanzaComprobacion('<a><b></a>');
    } catch (e) {
      expect((e as Error).message).toContain('línea');
    }
  });

  it('si le dan el CATÁLOGO, lo dice CON NOMBRE y manda a la capa anterior', () => {
    // Es el error más común de esta puerta: los dos archivos salen del mismo
    // menú del sistema de origen y se llaman casi igual.
    const catalogo =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<catalogocuentas:Catalogo xmlns:catalogocuentas="x" RFC="AAA010101AAA"/>`;
    try {
      readBalanzaComprobacion(catalogo);
      expect.unreachable('tenía que lanzar');
    } catch (e) {
      expect((e as Error).message).toContain('<Catalogo>');
      expect((e as Error).message).toContain('CATÁLOGO DE CUENTAS');
    }
  });

  it('otra raíz cualquiera se nombra y NO se confunde con el catálogo', () => {
    try {
      readBalanzaComprobacion('<Polizas RFC="AAA010101AAA"/>');
      expect.unreachable('tenía que lanzar');
    } catch (e) {
      expect((e as Error).message).toContain('<Polizas>');
      expect((e as Error).message).toContain('CtaCatalogo son archivos distintos');
    }
  });

  it('un <Balanza/> pelado NO se confunde con «esto no es una balanza»', () => {
    // Sin un solo atributo, el analizador devuelve una CADENA donde debería
    // haber un objeto. Lo es igual, y lo que le falta es el RFC: el mensaje
    // tiene que mandar a quien lo lee al sitio correcto.
    expect(() => readBalanzaComprobacion('<Balanza/>')).toThrow(/no declara RFC/);
  });

  it('sin RFC lanza: es la protección contra cargar la contabilidad de otro', () => {
    const sinRfc = `<BCE:Balanza xmlns:BCE="${NS}" Version="1.3" Mes="12" Anio="2025"/>`;
    expect(() => readBalanzaComprobacion(sinRfc)).toThrow(/no declara RFC/);
  });
});

// ------------------------------------------------------------
// 2 · LA CABECERA
// ------------------------------------------------------------

describe('readBalanzaComprobacion · la cabecera', () => {
  it('devuelve las seis casillas, con el RFC en mayúsculas', () => {
    const r = readBalanzaComprobacion(
      archivo([{ numCta: '100' }], { rfc: 'aaa010101aaa', tipoEnvio: 'N' })
    );
    expect(r.header).toEqual({
      version: '1.3',
      rfc: 'AAA010101AAA',
      mes: '12',
      anio: '2025',
      tipoEnvio: 'N',
      fechaModBal: null,
    });
  });

  it('FechaModBal se lee cuando viene', () => {
    const xml = archivo([{ numCta: '100' }], { tipoEnvio: 'C' }).replace(
      'TipoEnvio="C"',
      'TipoEnvio="C" FechaModBal="2026-03-01"'
    );
    expect(readBalanzaComprobacion(xml).header.fechaModBal).toBe('2026-03-01');
  });

  it('una versión distinta se lee igual y se AVISA', () => {
    expect(reglas(archivo([{ numCta: '100' }], { version: '1.1' }))).toContain('LEC-BAL-VERSION');
  });

  it('un Mes fuera de 01..13 BLOQUEA: decide a qué corte pertenece la apertura', () => {
    const r = readBalanzaComprobacion(archivo([{ numCta: '100' }], { mes: '14' }));
    expect(r.findings.map((f) => f.regla)).toContain('LEC-BAL-MES');
    expect(r.puedeImportarse).toBe(false);
  });

  it('Mes 13 —la balanza de cierre— es válido', () => {
    expect(reglas(archivo([{ numCta: '100' }], { mes: '13' }))).not.toContain('LEC-BAL-MES');
  });

  it('un Anio que no es de cuatro dígitos BLOQUEA', () => {
    expect(reglas(archivo([{ numCta: '100' }], { anio: '25' }))).toContain('LEC-BAL-ANIO');
  });

  it('un TipoEnvio que no es N ni C se AVISA y se sigue leyendo', () => {
    const r = readBalanzaComprobacion(archivo([{ numCta: '100' }], { tipoEnvio: 'X' }));
    expect(r.findings.map((f) => f.regla)).toContain('LEC-BAL-TIPO-ENVIO');
    expect(r.puedeImportarse).toBe(true);
  });

  it('sin espacio de nombres se lee y se avisa', () => {
    const xml = archivo([{ numCta: '100' }]).replace(` xmlns:BCE="${NS}"`, '');
    const r = readBalanzaComprobacion(xml.replace(/BCE:/g, ''));
    expect(r.findings.map((f) => f.regla)).toContain('LEC-BAL-SIN-ESPACIO-DE-NOMBRES');
    expect(r.rows).toHaveLength(1);
  });
});

// ------------------------------------------------------------
// 3 · LAS FILAS
// ------------------------------------------------------------

describe('readBalanzaComprobacion · las filas', () => {
  it('lee las cuatro columnas TAL CUAL, sin reformatear', () => {
    const r = readBalanzaComprobacion(
      archivo([{ numCta: '105-001', saldoIni: '1000.5', debe: '0.00', haber: '0.00', saldoFin: '1000.5' }])
    );
    expect(r.rows).toEqual([
      { fila: 1, numCta: '105-001', saldoIni: '1000.5', debe: '0.00', haber: '0.00', saldoFin: '1000.5' },
    ]);
  });

  it('una balanza sin cuentas BLOQUEA en vez de informar de un éxito sin efecto', () => {
    const r = readBalanzaComprobacion(archivo([]));
    expect(r.findings.map((f) => f.regla)).toContain('LEC-BAL-VACIA');
    expect(r.puedeImportarse).toBe(false);
  });

  it('sin NumCta el importe no tiene dónde posarse: bloquea con su número de fila', () => {
    const r = readBalanzaComprobacion(archivo([{ numCta: 'x', omitir: 'NumCta' }]));
    const h = r.findings.find((f) => f.regla === 'LEC-BAL-NUMCTA-AUSENTE');
    expect(h?.fila).toBe(1);
    expect(r.rows).toHaveLength(0);
  });

  it('un NumCta repetido bloquea y NOMBRA LAS DOS FILAS', () => {
    const r = readBalanzaComprobacion(
      archivo([{ numCta: '100' }, { numCta: '200' }, { numCta: '100' }])
    );
    const h = r.findings.find((f) => f.regla === 'LEC-BAL-NUMCTA-DUPLICADO');
    expect(h?.fila).toBe(3);
    expect(h?.mensaje).toContain('ya estaba en la 1');
    expect(r.puedeImportarse).toBe(false);
  });

  it('una columna ausente NO se supone cero: bloquea nombrando la columna', () => {
    const r = readBalanzaComprobacion(archivo([{ numCta: '100', omitir: 'Debe' }]));
    const h = r.findings.find((f) => f.regla === 'LEC-BAL-IMPORTE-AUSENTE');
    expect(h?.campo).toBe('Debe');
    expect(h?.numCta).toBe('100');
    expect(r.rows).toHaveLength(0);
  });

  it('un importe con separador de miles no se lee como número', () => {
    const r = readBalanzaComprobacion(archivo([{ numCta: '100', saldoIni: '1,000.00' }]));
    expect(r.findings.map((f) => f.regla)).toContain('LEC-BAL-IMPORTE-NO-NUMERICO');
  });

  it('un negativo entre paréntesis tampoco', () => {
    expect(reglas(archivo([{ numCta: '100', saldoFin: '(500.00)' }]))).toContain(
      'LEC-BAL-IMPORTE-NO-NUMERICO'
    );
  });

  it('el signo menos SÍ se admite: una acreedora sobregirada existe', () => {
    const r = readBalanzaComprobacion(
      archivo([{ numCta: '200', saldoIni: '-100.00', saldoFin: '-100.00' }])
    );
    expect(r.rows[0].saldoIni).toBe('-100.00');
    expect(r.puedeImportarse).toBe(true);
  });

  it('más decimales de los que el mayor guarda BLOQUEA, no se redondea a escondidas', () => {
    const r = readBalanzaComprobacion(
      archivo([{ numCta: '100', saldoIni: '1.000005', saldoFin: '1.000005' }])
    );
    const h = r.findings.find((f) => f.regla === 'LEC-BAL-ESCALA');
    expect(h?.mensaje).toContain('DECIMAL(19,4)');
    expect(r.puedeImportarse).toBe(false);
  });

  it('cuatro decimales entran: es exactamente la escala del mayor', () => {
    expect(
      reglas(archivo([{ numCta: '100', saldoIni: '1.0001', saldoFin: '1.0001' }]))
    ).not.toContain('LEC-BAL-ESCALA');
  });
});

// ------------------------------------------------------------
// 4 · EL RECÁLCULO QUE NO NECESITA LA NATURALEZA
// ------------------------------------------------------------

describe('el recálculo sin Natur', () => {
  it('cuadra como DEUDORA: ini + debe − haber', () => {
    expect(
      cuadraEnAlgunaNaturaleza({ SaldoIni: '100', Debe: '50', Haber: '20', SaldoFin: '130' })
    ).toBe(true);
  });

  it('cuadra como ACREEDORA: ini − debe + haber', () => {
    expect(
      cuadraEnAlgunaNaturaleza({ SaldoIni: '100', Debe: '20', Haber: '50', SaldoFin: '130' })
    ).toBe(true);
  });

  it('sin movimiento cuadra por las dos, y eso NO dice cuál es la naturaleza', () => {
    expect(
      cuadraEnAlgunaNaturaleza({ SaldoIni: '77', Debe: '0', Haber: '0', SaldoFin: '77' })
    ).toBe(true);
  });

  it('lo que no cuadra bajo NINGUNA naturaleza es un descuadre del ORIGEN', () => {
    const r = readBalanzaComprobacion(
      archivo([{ numCta: '105', saldoIni: '100', debe: '50', haber: '20', saldoFin: '999' }])
    );
    const h = r.findings.find((f) => f.regla === 'LEC-BAL-RECALCULO');
    expect(h?.severidad).toBe('bloquea');
    // Enseña las DOS restas: quien lo lee tiene que poder ver que ninguna da.
    expect(h?.mensaje).toContain('130');
    expect(h?.mensaje).toContain('70');
    expect(h?.mensaje).toContain('999');
    expect(r.rows).toHaveLength(0);
  });

  it('la fila con descuadre se descarta y las DEMÁS se siguen leyendo', () => {
    // La lista completa es el producto: un archivo de ochocientas cuentas no
    // puede exigir ochocientas corridas para descubrir ochocientos defectos.
    const r = readBalanzaComprobacion(
      archivo([
        { numCta: 'A', saldoIni: '10', debe: '0', haber: '0', saldoFin: '99' },
        { numCta: 'B', saldoIni: '10', debe: '0', haber: '0', saldoFin: '10' },
        { numCta: 'C', saldoIni: '10', debe: '0', haber: '0', saldoFin: '77' },
      ])
    );
    expect(r.rows.map((x) => x.numCta)).toEqual(['B']);
    expect(r.findings.filter((f) => f.regla === 'LEC-BAL-RECALCULO')).toHaveLength(2);
    expect(r.rowsLeidas).toBe(3);
  });
});

// ------------------------------------------------------------
// 5 · LO QUE fast-xml-parser HACE MAL, HEREDADO DE LA CAPA 1
// ------------------------------------------------------------

describe('las trampas del analizador', () => {
  it('la referencia NUMÉRICA de carácter se decodifica', () => {
    // Sin `htmlEntities` el NumCta entraría como la cadena literal `1&#48;0`.
    const xml = archivo([{ numCta: 'x' }]).replace('NumCta="x"', 'NumCta="1&#48;0"');
    expect(readBalanzaComprobacion(xml).rows[0].numCta).toBe('100');
  });

  it('un salto de línea dentro del atributo vale un espacio, y se AVISA', () => {
    const xml = archivo([{ numCta: 'x' }]).replace('NumCta="x"', 'NumCta="100&#10;01"');
    const r = readBalanzaComprobacion(xml);
    expect(r.rows[0].numCta).toBe('100 01');
    expect(r.findings.map((f) => f.regla)).toContain('LEC-ATRIBUTO-NORMALIZADO');
  });

  it('un código con espacios alrededor se recorta Y SE DENUNCIA', () => {
    const xml = archivo([{ numCta: 'x' }]).replace('NumCta="x"', 'NumCta=" 100 "');
    const r = readBalanzaComprobacion(xml);
    expect(r.rows[0].numCta).toBe('100');
    expect(r.findings.map((f) => f.regla)).toContain('LEC-ATRIBUTO-CON-ESPACIOS');
  });
});

// ------------------------------------------------------------
// 6 · LA IDA Y LA VUELTA — LA PRUEBA QUE MANDA
// ------------------------------------------------------------

describe('la ida y la vuelta contra el generador de F07b', () => {
  const cuenta = (
    num: string,
    natur: 'D' | 'A',
    ini: string,
    debe: string,
    haber: string,
    fin: string
  ): CuentaDeBalanza => ({
    account_id: `id-${num}`,
    num_cta: num,
    natur,
    saldo_ini_mayor: ini,
    debe,
    haber,
    saldo_fin_mayor: fin,
    codigo_agrupador: null,
    natur_del_agrupador: null,
    tiene_hijas: false,
  });

  it('lo que construirBalanzaXml escribe, este lector lo devuelve SIN UN SOLO HALLAZGO', () => {
    // El caso de F07b: la acreedora se declara en su naturaleza, y el mayor la
    // guarda en negativo. Si el lector no devolviera exactamente lo escrito,
    // el cotejo «al peso» de la migración compararía dos lecturas distintas.
    const xml = construirBalanzaXml({
      rfc: 'AAA010101AAA',
      anio: 2025,
      mes: '12',
      tipoEnvio: 'N',
      cuentas: [
        cuenta('1120', 'D', '4500.0000', '1300.0000', '400.0000', '5400.0000'),
        cuenta('4100', 'A', '-7000.0000', '0.0000', '-1300.0000', '-8300.0000'),
        cuenta('5100', 'D', '2500.0000', '400.0000', '0.0000', '2900.0000'),
      ],
    });

    const r = readBalanzaComprobacion(xml);
    expect(r.findings).toEqual([]);
    expect(r.puedeImportarse).toBe(true);
    expect(r.header.rfc).toBe('AAA010101AAA');
    expect(r.header.mes).toBe('12');
    expect(r.header.anio).toBe('2025');
    expect(r.rows).toEqual([
      { fila: 1, numCta: '1120', saldoIni: '4500.00', debe: '1300.00', haber: '400.00', saldoFin: '5400.00' },
      { fila: 2, numCta: '4100', saldoIni: '7000.00', debe: '0.00', haber: '-1300.00', saldoFin: '8300.00' },
      { fila: 3, numCta: '5100', saldoIni: '2500.00', debe: '400.00', haber: '0.00', saldoFin: '2900.00' },
    ]);
  });

  it('una complementaria con FechaModBal también da la vuelta entera', () => {
    const xml = construirBalanzaXml({
      rfc: 'XAXX010101000',
      anio: 2025,
      mes: '13',
      tipoEnvio: 'C',
      fechaModBal: '2026-02-15',
      cuentas: [cuenta('100', 'D', '1.0000', '0.0000', '0.0000', '1.0000')],
    });
    const r = readBalanzaComprobacion(xml);
    expect(r.findings).toEqual([]);
    expect(r.header.tipoEnvio).toBe('C');
    expect(r.header.fechaModBal).toBe('2026-02-15');
    expect(r.header.mes).toBe('13');
  });
});
