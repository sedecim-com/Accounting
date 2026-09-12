import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  compareToSource,
  renderBalanceComparison,
  rollUp,
  shapesFromRows,
  type AccountShape,
} from '../../src/services/accounting/opening-balance-check.js';
import type { BalanceFileRow } from '../../src/services/sat/anexo24/balance-reader.js';

// ============================================================
// O1 · EL COTEJO AL PESO
//
// El criterio de aceptación de la tarjeta, probado sin base de datos: dos
// listas de filas de balanza y la forma del árbol. Lo que aquí se fija es
// exactamente lo que la prueba de integración vuelve a exigir contra Postgres.
// ============================================================

let siguiente = 1;
const fila = (numCta: string, saldoFin: string, extra: Partial<BalanceFileRow> = {}): BalanceFileRow => ({
  fila: siguiente++,
  numCta,
  saldoIni: '0.00',
  debe: '0.00',
  haber: '0.00',
  saldoFin,
  ...extra,
});

const forma = (code: string, parentCode: string | null, natur: 'D' | 'A' = 'D'): AccountShape => ({
  code,
  parentCode,
  natur,
});

describe('shapesFromRows · la traducción de normal_balance', () => {
  it('credit es ACREEDORA y todo lo demás DEUDORA', () => {
    expect(
      shapesFromRows([
        { code: '100', parent_code: null, normal_balance: 'debit' },
        { code: '200', parent_code: null, normal_balance: 'credit' },
      ])
    ).toEqual([
      { code: '100', parentCode: null, natur: 'D' },
      { code: '200', parentCode: null, natur: 'A' },
    ]);
  });
});

describe('rollUp · sumar el árbol hacia arriba', () => {
  const arbol: AccountShape[] = [
    forma('1000', null),
    forma('1100', '1000'),
    forma('1110', '1100'),
    forma('1120', '1100'),
    forma('2000', null, 'A'),
  ];

  it('cada cuenta recibe lo suyo MÁS lo de toda su descendencia', () => {
    const r = rollUp(
      arbol,
      new Map([
        ['1110', new Decimal(100)],
        ['1120', new Decimal(30)],
        ['1100', new Decimal(7)],
      ])
    );
    expect(r.get('1110')?.toString()).toBe('100');
    expect(r.get('1100')?.toString()).toBe('137');
    expect(r.get('1000')?.toString()).toBe('137');
    // AUSENTE ES CERO: la cuenta que no recibió nada no ocupa una fila.
    expect(r.get('2000')).toBeUndefined();
  });

  it('el cero no se propaga: no cuesta un recorrido ni fabrica filas', () => {
    const r = rollUp(arbol, new Map([['1110', new Decimal(0)]]));
    expect(r.size).toBe(0);
  });

  it('un padre que no está entre las cuentas conocidas no inventa una fila', () => {
    const r = rollUp([forma('X', 'NO-EXISTE')], new Map([['X', new Decimal(5)]]));
    expect(r.get('NO-EXISTE')).toBeUndefined();
    expect(r.get('X')?.toString()).toBe('5');
  });

  it('un ciclo en parent_id NO cuelga el proceso', () => {
    // La base no debería permitirlo; un `parent_id` corregido a mano sí lo
    // produce, y un cotejo que se queda colgado es peor que uno que acusa.
    const r = rollUp(
      [forma('A', 'B'), forma('B', 'A')],
      new Map([['A', new Decimal(9)]])
    );
    expect(r.get('A')?.toString()).toBe('9');
    expect(r.get('B')?.toString()).toBe('9');
  });
});

describe('compareToSource · iguales al peso', () => {
  it('con el saldo en las hojas, la cuenta de mayor CUADRA aunque el mayor no agregue', () => {
    // Éste es el falso descuadre que un cotejo sin agregar produciría: el
    // origen declara 130 en la cuenta de mayor y nuestro mayor tiene ahí un
    // cero, con el dinero repartido en las dos subcuentas.
    const shapes = [forma('1100', null), forma('1110', '1100'), forma('1120', '1100')];
    const origen = [fila('1100', '130.00'), fila('1110', '100.00'), fila('1120', '30.00')];
    const nuestra = [fila('1100', '0.00'), fila('1110', '100.00'), fila('1120', '30.00')];
    const c = compareToSource(origen, nuestra, shapes);
    expect(c.iguales).toBe(true);
    expect(c.comparadas).toBe(3);
    expect(renderBalanceComparison(c)).toContain('IGUALES AL PESO');
  });

  it('LA TRAMPA DEL SIGNO: la depreciación acumulada NO se suma, se resta', () => {
    // 1200 Activo fijo (deudora) con 1290 Depreciación acumulada (ACREEDORA)
    // debajo. El archivo declara las dos en POSITIVO, cada una en su
    // naturaleza. Agregar las cifras declaradas daría 1 000 + 200 = 1 200; el
    // activo fijo neto es 800. Sólo el eje del mayor da la respuesta buena.
    const shapes = [forma('1200', null, 'D'), forma('1210', '1200', 'D'), forma('1290', '1200', 'A')];
    const origen = [fila('1200', '800.00'), fila('1210', '1000.00'), fila('1290', '200.00')];
    const nuestra = [fila('1200', '0.00'), fila('1210', '1000.00'), fila('1290', '200.00')];
    expect(compareToSource(origen, nuestra, shapes).iguales).toBe(true);
  });

  it('un peso de diferencia se NOMBRA con la cuenta y el importe', () => {
    const shapes = [forma('1110', null)];
    const c = compareToSource([fila('1110', '100.00')], [fila('1110', '99.00')], shapes);
    expect(c.iguales).toBe(false);
    expect(c.diferencias).toEqual([
      { numCta: '1110', esperado: '100.0000', obtenido: '99.0000', diferencia: '-1.0000' },
    ]);
    expect(renderBalanceComparison(c)).toContain('el origen dice 100.0000 y aquí hay 99.0000');
  });

  it('la diferencia se imprime EN LA NATURALEZA de la cuenta, que es donde se busca', () => {
    // Acreedora: el origen declara 500 y aquí hay 400. En el eje del mayor eso
    // es −500 contra −400; en la balanza del contador es 500 contra 400.
    const c = compareToSource(
      [fila('2110', '500.00')],
      [fila('2110', '400.00')],
      [forma('2110', null, 'A')]
    );
    expect(c.diferencias[0]).toEqual({
      numCta: '2110',
      esperado: '500.0000',
      obtenido: '400.0000',
      diferencia: '-100.0000',
    });
  });

  it('una cuenta del origen que no existe en el plan sale como FALTANTE, no como diferencia', () => {
    const c = compareToSource([fila('9999', '10.00')], [], [forma('1110', null)]);
    expect(c.faltantes).toEqual(['9999']);
    expect(c.diferencias).toEqual([]);
    expect(c.comparadas).toBe(0);
    expect(c.iguales).toBe(false);
    expect(renderBalanceComparison(c)).toContain('no existe en el plan de cuentas');
  });

  it('dinero nuestro que el origen no declara NI BAJO UN PADRE SUYO sale como sobrante', () => {
    const shapes = [forma('1110', null), forma('7777', null)];
    const c = compareToSource([fila('1110', '10.00')], [fila('1110', '10.00'), fila('7777', '5.00')], shapes);
    expect(c.sobrantes).toEqual([{ numCta: '7777', importe: '5.0000' }]);
    expect(renderBalanceComparison(c)).toContain('7777');
  });

  it('una subcuenta nuestra que el origen no enumera NO es sobrante: cuenta dentro de su padre', () => {
    // El exportador entregó hasta el nivel 2. Nuestras subcuentas de nivel 3
    // no aparecen en el archivo y su dinero ya está dentro del agregado del
    // padre: enumerarlas sería llenar el informe de ecos.
    const shapes = [forma('1100', null), forma('1110', '1100'), forma('1110-01', '1110')];
    const c = compareToSource(
      [fila('1100', '10.00')],
      [fila('1110-01', '10.00')],
      shapes
    );
    expect(c.sobrantes).toEqual([]);
    expect(c.iguales).toBe(true);
  });

  it('una cuenta que el origen declara y que en nuestro mayor está EN CERO difiere por todo su importe', () => {
    // El caso del renglón que la carga se saltó: aquí no hay nada, y la
    // diferencia tiene que valer el saldo entero, no pasar por «igual a cero».
    const c = compareToSource([fila('1110', '250.00')], [], [forma('1110', null)]);
    expect(c.diferencias).toEqual([
      { numCta: '1110', esperado: '250.0000', obtenido: '0.0000', diferencia: '-250.0000' },
    ]);
  });

  it('el ascenso que llega a una raíz sin encontrar nada declarado termina', () => {
    // «X» cuelga de «Y», y «Y» es raíz y tampoco está declarada: el dinero de
    // X no está dentro de ningún agregado del origen, así que es sobrante.
    const c = compareToSource(
      [fila('1110', '1.00')],
      [fila('1110', '1.00'), fila('X', '4.00')],
      [forma('1110', null), forma('X', 'Y'), forma('Y', null)]
    );
    expect(c.sobrantes).toEqual([{ numCta: 'X', importe: '4.0000' }]);
  });

  it('un ciclo de padres tampoco cuelga el reparto de sobrantes', () => {
    // El mismo `parent_id` corregido a mano: aquí el ascenso busca un
    // antepasado declarado y podría dar vueltas para siempre.
    const c = compareToSource(
      [fila('1110', '1.00')],
      [fila('1110', '1.00'), fila('A', '3.00')],
      [forma('1110', null), forma('A', 'B'), forma('B', 'A')]
    );
    // B no lleva saldo propio, así que no es un sobrante: sólo A.
    expect(c.sobrantes.map((x) => x.numCta)).toEqual(['A']);
  });

  it('se puede cotejar otra columna: SaldoIni es la que cuadra a partir del segundo periodo', () => {
    const shapes = [forma('1110', null)];
    const origen = [fila('1110', '0.00', { saldoIni: '77.00' })];
    const nuestra = [fila('1110', '0.00', { saldoIni: '77.00' })];
    const c = compareToSource(origen, nuestra, shapes, 'SaldoIni');
    expect(c.columna).toBe('SaldoIni');
    expect(c.iguales).toBe(true);
  });

  it('Debe y Haber también se pueden cotejar, y se agregan igual', () => {
    const shapes = [forma('1100', null), forma('1110', '1100')];
    const origen = [fila('1100', '0.00', { debe: '5.00', haber: '2.00' })];
    const nuestra = [fila('1110', '0.00', { debe: '5.00', haber: '2.00' })];
    expect(compareToSource(origen, nuestra, shapes, 'Debe').iguales).toBe(true);
    expect(compareToSource(origen, nuestra, shapes, 'Haber').iguales).toBe(true);
  });

  it('…y CON UNA HIJA ACREEDORA, que es donde el movimiento NO lleva signo', () => {
    // ESTA ES LA PRUEBA QUE FALTABA, y su ausencia escondía un defecto: la de
    // arriba usa un árbol enteramente DEUDOR, donde la traducción al eje del
    // mayor multiplica por +1 y por tanto no puede fallar nunca.
    //
    // Un SALDO lleva la naturaleza dentro y hay que llevarlo al eje único del
    // mayor antes de sumarlo. Un CARGO no: el Debe de una cuenta de mayor es
    // la suma llana de los cargos de sus subcuentas, y un cargo sobre una
    // cuenta acreedora sigue siendo un cargo. Con «171 Depreciación» —Natur A—
    // colgando de «100 Activo», tratar el Debe como si fuera un saldo le
    // cambia el signo a la hija y el padre sale con la RESTA de los
    // movimientos: un descuadre inventado del doble del Debe de la
    // contracuenta, en el cotejo cuyo trabajo entero es no inventarlos.
    const shapes = [forma('100', null), forma('101', '100'), forma('171', '100', 'A')];
    const origen = [
      fila('100', '0.00', { debe: '1500.00', haber: '300.00' }),
      fila('101', '0.00', { debe: '1000.00', haber: '100.00' }),
      fila('171', '0.00', { debe: '500.00', haber: '200.00' }),
    ];
    // Nuestra balanza declara el movimiento PROPIO: «100» no agrega.
    const nuestra = [
      fila('100', '0.00'),
      fila('101', '0.00', { debe: '1000.00', haber: '100.00' }),
      fila('171', '0.00', { debe: '500.00', haber: '200.00' }),
    ];
    expect(compareToSource(origen, nuestra, shapes, 'Debe').diferencias).toEqual([]);
    expect(compareToSource(origen, nuestra, shapes, 'Haber').diferencias).toEqual([]);
  });

  it('una cuenta NUESTRA que el plan no conoce no envenena la comparación', () => {
    // `nuestra` puede traer una fila cuya cuenta no está en `shapes` si el
    // plan se leyó antes de crearla: se ignora en vez de contarse como cero.
    const c = compareToSource([fila('1110', '1.00')], [fila('1110', '1.00'), fila('ZZZ', '9.00')], [
      forma('1110', null),
    ]);
    expect(c.iguales).toBe(true);
  });
});
