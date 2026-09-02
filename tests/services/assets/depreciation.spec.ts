import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  BASES_DE_DEPRECIACION,
  CONVENCIONES_PRIMER_MES,
  MACRS_TABLES,
  TIPO_DE_CALENDARIO,
  baseDeLaVida,
  calculateDecliningBalance,
  calculateDepreciation,
  calculateMACRS,
  calculateStraightLine,
  calculateSumOfYearsDigits,
  calculateUnitsOfProduction,
  esImporteCero,
  fraccionDelPrimerMes,
  indiceDeCalendario,
  metadatosDeCalculo,
  primerDiaDelMes,
  ultimoDiaDelMes,
  type DepreciationInput,
  type DepreciationResult,
} from '../../../src/services/assets/depreciation-math.js';
import { DepreciationMethod } from '../../../src/types/index.js';

/**
 * LA ARITMÉTICA DE LA DEPRECIACIÓN, SIN POSTGRES DETRÁS.
 *
 * Los seis calculadores llevaban desde la migración 003 con 0 % de cobertura y
 * tres defectos medidos que ninguna prueba podía ver, porque no había un solo
 * activo dado de alta contra el que verlos. Cada caso de aquí —los doce meses
 * que consumían once filas, los 100.000 que sumaban 100.000,0008, las dos
 * convenciones que tienen que dar el mismo total— habría necesitado sembrar
 * una entidad, un catálogo de cuentas, un ejercicio con sus periodos y un
 * activo para preguntar algo que es una división. Escritos así cuestan cuatro
 * líneas, y por eso están escritos.
 */

const enero = (dia = 1) => new Date(2026, 0, dia);

const activo = (over: Partial<DepreciationInput> = {}): DepreciationInput => ({
  acquisition_cost: '100000.0000',
  salvage_value: '0.0000',
  useful_life_months: 36,
  depreciation_start_date: enero(),
  method: DepreciationMethod.STRAIGHT_LINE,
  ...over,
});

const sumaDeGastos = (filas: DepreciationResult[]): string =>
  filas
    .reduce((acc, f) => acc.plus(f.depreciation_expense), new Decimal(0))
    .toFixed(4);

describe('el índice del calendario (defecto A)', () => {
  it('cuenta MESES DE CALENDARIO, no milisegundos entre 30,44 días', () => {
    // El corrido que delató el defecto: 2026-03-01 está a 59 días del
    // 2026-01-01 y 59/30,44 truncado da 1 — la fila de febrero otra vez.
    expect(indiceDeCalendario(enero(), new Date(2026, 2, 1))).toBe(2);
    expect(indiceDeCalendario(enero(), new Date(2026, 3, 1))).toBe(3);
    expect(indiceDeCalendario(enero(), new Date(2026, 11, 1))).toBe(11);
  });

  it('cruza el año y devuelve negativo antes de la entrada en servicio', () => {
    expect(indiceDeCalendario(enero(), new Date(2027, 0, 1))).toBe(12);
    expect(indiceDeCalendario(new Date(2025, 10, 1), new Date(2026, 1, 1))).toBe(3);
    expect(indiceDeCalendario(enero(), new Date(2025, 11, 1))).toBe(-1);
  });

  it('no depende del día del mes: el activo del día 20 indexa como el del día 1', () => {
    expect(indiceDeCalendario(enero(20), new Date(2026, 1, 1))).toBe(1);
    expect(indiceDeCalendario(enero(20), new Date(2026, 1, 28))).toBe(1);
  });

  it('los doce meses de un activo que empieza el 1 de enero consumen DOCE filas distintas', () => {
    const calendario = calculateStraightLine(
      activo({ acquisition_cost: '12000.0000', useful_life_months: 12 })
    );

    const consumidas = new Set<number>();
    const importes: string[] = [];
    for (let mes = 0; mes < 12; mes++) {
      const indice = indiceDeCalendario(enero(), new Date(2026, mes, 1));
      const fila = calendario[indice];
      expect(fila, `el periodo ${mes + 1} no encontró fila`).toBeDefined();
      consumidas.add(indice);
      importes.push(fila.depreciation_expense);
    }

    // Doce, no once: con el índice viejo marzo repetía la fila de febrero y la
    // duodécima no se consumía NUNCA — el activo no llegaba a depreciarse.
    expect(consumidas.size).toBe(12);
    expect(calendario).toHaveLength(12);
    expect([...consumidas].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(new Decimal(importes.reduce((a, b) => new Decimal(a).plus(b).toFixed(4), '0')).toFixed(4))
      .toBe('12000.0000');
  });
});

describe('el tapón del último mes (defecto C)', () => {
  it('un activo de 100.000 a 36 meses acumula EXACTAMENTE 100.000,0000', () => {
    const calendario = calculateStraightLine(activo());

    expect(calendario).toHaveLength(36);
    expect(sumaDeGastos(calendario)).toBe('100000.0000');
    expect(calendario[35].accumulated_depreciation).toBe('100000.0000');
    expect(calendario[35].ending_book_value).toBe('0.0000');
    // 100000/36 no cabe en cuatro decimales: treinta y cinco renglones de
    // 2.777,7778 y el último absorbe las ocho diezmilésimas que sobraban.
    expect(calendario[0].depreciation_expense).toBe('2777.7778');
    expect(calendario[35].depreciation_expense).toBe('2777.7770');
  });

  it('el acumulado de cada renglón es la suma de lo REALMENTE posteado', () => {
    const calendario = calculateStraightLine(activo());
    let corrido = new Decimal(0);
    for (const fila of calendario) {
      corrido = corrido.plus(fila.depreciation_expense);
      expect(fila.accumulated_depreciation).toBe(corrido.toFixed(4));
      expect(fila.ending_book_value).toBe(new Decimal('100000').minus(corrido).toFixed(4));
      expect(fila.beginning_book_value).toBe(
        new Decimal(fila.ending_book_value).plus(fila.depreciation_expense).toFixed(4)
      );
    }
  });

  it('respeta el salvamento: se reparte costo menos salvamento, ni un peso más', () => {
    const calendario = calculateStraightLine(
      activo({ acquisition_cost: '50000.0000', salvage_value: '5000.0000', useful_life_months: 24 })
    );
    expect(sumaDeGastos(calendario)).toBe('45000.0000');
    expect(calendario[23].ending_book_value).toBe('5000.0000');
  });

  it('guarda los CUATRO decimales de la columna, no dos', () => {
    const calendario = calculateStraightLine(
      activo({ acquisition_cost: '1000.0000', useful_life_months: 3 })
    );
    expect(calendario[0].depreciation_expense).toBe('333.3333');
    expect(calendario[2].depreciation_expense).toBe('333.3334');
    expect(sumaDeGastos(calendario)).toBe('1000.0000');
  });
});

describe('la convención del primer mes', () => {
  it('las dos convenciones dan el MISMO total de vida', () => {
    const base = activo({ depreciation_start_date: enero(20), useful_life_months: 12 });
    const completo = calculateStraightLine({ ...base, convencion: 'mes_completo' });
    const prorrateo = calculateStraightLine({ ...base, convencion: 'proporcional_dias' });

    expect(sumaDeGastos(completo)).toBe('100000.0000');
    expect(sumaDeGastos(prorrateo)).toBe('100000.0000');
    // Lo que cambia es QUÉ periodo carga cada peso, no cuánto se carga.
    expect(prorrateo).toHaveLength(completo.length + 1);
    expect(prorrateo[0].depreciation_expense).not.toBe(completo[0].depreciation_expense);
  });

  it('el prorrateo cobra los días poseídos y empuja el resto al mes de más', () => {
    const calendario = calculateStraightLine(
      activo({
        acquisition_cost: '12000.0000',
        useful_life_months: 12,
        depreciation_start_date: enero(20),
        convencion: 'proporcional_dias',
      })
    );

    // Del 20 al 31 de enero son DOCE días poseídos de 31.
    expect(fraccionDelPrimerMes(enero(20)).toFixed(6)).toBe(new Decimal(12).dividedBy(31).toFixed(6));
    expect(calendario[0].depreciation_expense).toBe(
      new Decimal(1000).times(12).dividedBy(31).toDecimalPlaces(4).toFixed(4)
    );
    expect(calendario[1].depreciation_expense).toBe('1000.0000');
    expect(calendario).toHaveLength(13);
    expect(sumaDeGastos(calendario)).toBe('12000.0000');
  });

  it('un activo que entra en servicio el día 1 no gana un mes de cola', () => {
    const completo = calculateStraightLine(activo({ useful_life_months: 12 }));
    const prorrateo = calculateStraightLine(
      activo({ useful_life_months: 12, convencion: 'proporcional_dias' })
    );
    expect(fraccionDelPrimerMes(enero()).toString()).toBe('1');
    expect(prorrateo).toHaveLength(12);
    expect(prorrateo.map((f) => f.depreciation_expense)).toEqual(
      completo.map((f) => f.depreciation_expense)
    );
  });

  it('el prorrateo tampoco cambia el total con saldos decrecientes', () => {
    const base = activo({
      salvage_value: '10000.0000',
      useful_life_months: 60,
      depreciation_start_date: enero(20),
      method: DepreciationMethod.DECLINING_BALANCE_200,
    });
    expect(sumaDeGastos(calculateDepreciation({ ...base, convencion: 'mes_completo' }))).toBe('90000.0000');
    expect(sumaDeGastos(calculateDepreciation({ ...base, convencion: 'proporcional_dias' }))).toBe('90000.0000');
  });
});

describe('las fechas de cada renglón', () => {
  it('van ancladas al mes de calendario, a medianoche LOCAL', () => {
    const calendario = calculateStraightLine(activo({ depreciation_start_date: enero(20), useful_life_months: 3 }));
    expect(calendario[0].period_start_date.getTime()).toBe(new Date(2026, 0, 1).getTime());
    expect(calendario[0].period_end_date.getTime()).toBe(new Date(2026, 0, 31).getTime());
    expect(calendario[1].period_start_date.getMonth()).toBe(1);
    expect(calendario[1].period_end_date.getDate()).toBe(28);
    for (const fila of calendario) {
      expect(fila.period_start_date.getDate()).toBe(1);
      expect(fila.period_start_date.getHours()).toBe(0);
      expect(fila.indice_calendario).toBe(fila.period_number - 1);
    }
  });

  it('primerDiaDelMes y ultimoDiaDelMes no se van a UTC', () => {
    const bisiesto = new Date(2028, 1, 17);
    expect(primerDiaDelMes(bisiesto).getDate()).toBe(1);
    expect(ultimoDiaDelMes(bisiesto).getDate()).toBe(29);
    expect(ultimoDiaDelMes(new Date(2026, 11, 5)).getTime()).toBe(new Date(2026, 11, 31).getTime());
  });
});

describe('los seis calculadores', () => {
  it('línea recta reparte por igual y cierra exacto', () => {
    const calendario = calculateStraightLine(
      activo({ acquisition_cost: '24000.0000', useful_life_months: 24 })
    );
    expect(calendario).toHaveLength(24);
    expect(calendario[0].depreciation_expense).toBe('1000.0000');
    expect(calendario[23].depreciation_expense).toBe('1000.0000');
    expect(sumaDeGastos(calendario)).toBe('24000.0000');
  });

  it('saldos decrecientes al 200 % carga más al principio y nunca baja del salvamento', () => {
    const calendario = calculateDecliningBalance(
      activo({ acquisition_cost: '100000.0000', salvage_value: '10000.0000', useful_life_months: 60 }),
      2.0
    );
    expect(new Decimal(calendario[0].depreciation_expense).greaterThan(calendario[30].depreciation_expense)).toBe(true);
    for (const fila of calendario) {
      expect(new Decimal(fila.ending_book_value).greaterThanOrEqualTo('10000')).toBe(true);
    }
    expect(sumaDeGastos(calendario)).toBe('90000.0000');
    expect(calendario[calendario.length - 1].ending_book_value).toBe('10000.0000');
  });

  it('saldos decrecientes al 150 % deprecia menos por mes que el 200 % en el primer año', () => {
    const entrada = activo({ useful_life_months: 60 });
    const suave = calculateDecliningBalance(entrada, 1.5);
    const fuerte = calculateDecliningBalance(entrada, 2.0);
    expect(new Decimal(suave[0].depreciation_expense).lessThan(fuerte[0].depreciation_expense)).toBe(true);
    expect(sumaDeGastos(suave)).toBe('100000.0000');
    expect(sumaDeGastos(fuerte)).toBe('100000.0000');
  });

  it('suma de dígitos pesa el primer año más que el último y cierra exacto', () => {
    const calendario = calculateSumOfYearsDigits(activo({ useful_life_months: 24 }));
    // Dos años: 2/3 el primero, 1/3 el segundo.
    expect(calendario[0].depreciation_expense).toBe(
      new Decimal(100000).times(2).dividedBy(3).dividedBy(12).toDecimalPlaces(4).toFixed(4)
    );
    expect(new Decimal(calendario[0].depreciation_expense).dividedBy(calendario[12].depreciation_expense).toFixed(4))
      .toBe('2.0000');
    expect(sumaDeGastos(calendario)).toBe('100000.0000');
  });

  it('MACRS deprecia el costo ENTERO —ignora el salvamento— con media anualidad', () => {
    const calendario = calculateMACRS(
      activo({ acquisition_cost: '60000.0000', salvage_value: '5000.0000', macrs_class: '5-year', method: DepreciationMethod.MACRS })
    );
    // Seis renglones de tabla: 6 meses + 12·4 + 6 meses.
    expect(calendario).toHaveLength(60);
    expect(sumaDeGastos(calendario)).toBe('60000.0000');
    expect(calendario[59].ending_book_value).toBe('0.0000');
    // Primer año 20 % del costo repartido en seis meses.
    expect(calendario[0].depreciation_expense).toBe('2000.0000');
  });

  it('las seis tablas MACRS suman el 100 % del costo', () => {
    for (const clase of Object.keys(MACRS_TABLES)) {
      const calendario = calculateMACRS(
        activo({ acquisition_cost: '10000.0000', macrs_class: clase, method: DepreciationMethod.MACRS })
      );
      expect(sumaDeGastos(calendario), `clase ${clase}`).toBe('10000.0000');
    }
  });

  it('MACRS rechaza una clase que no existe en vez de inventar una tabla', () => {
    expect(() =>
      calculateMACRS(activo({ macrs_class: '4-year', method: DepreciationMethod.MACRS }))
    ).toThrow(/4-year/);
  });

  it('unidades de producción deprecia lo producido y NO tapona lo no usado', () => {
    const calendario = calculateUnitsOfProduction(
      activo({ method: DepreciationMethod.UNITS_OF_PRODUCTION }),
      1000,
      [
        { period: 1, units: 100 },
        { period: 3, units: 50 },
      ]
    );
    // Un activo usado a medias no se termina de depreciar con un tapón.
    expect(sumaDeGastos(calendario)).toBe('15000.0000');
    // La serie es DENSA: el mes sin producción vale cero y NO corre el
    // calendario hacia atrás; la producción del periodo 3 sigue en el 3.
    expect(calendario).toHaveLength(3);
    expect(calendario[0].depreciation_expense).toBe('10000.0000');
    expect(calendario[1].depreciation_expense).toBe('0.0000');
    expect(calendario[2].depreciation_expense).toBe('5000.0000');
    expect(calendario[2].period_start_date.getMonth()).toBe(2);
  });

  it('unidades de producción cierra exacto cuando la máquina agota su capacidad', () => {
    const calendario = calculateUnitsOfProduction(
      activo({ acquisition_cost: '90000.0000', salvage_value: '9000.0000', method: DepreciationMethod.UNITS_OF_PRODUCTION }),
      3,
      [
        { period: 1, units: 1 },
        { period: 2, units: 1 },
        { period: 3, units: 1 },
      ]
    );
    expect(sumaDeGastos(calendario)).toBe('81000.0000');
    expect(calendario[2].ending_book_value).toBe('9000.0000');
  });

  it('el maestro despacha por método y exige la producción cuando hace falta', () => {
    expect(calculateDepreciation(activo({ method: DepreciationMethod.STRAIGHT_LINE }))).toHaveLength(36);
    expect(calculateDepreciation(activo({ method: DepreciationMethod.SUM_OF_YEARS_DIGITS })).length).toBe(36);
    expect(() =>
      calculateDepreciation(activo({ method: DepreciationMethod.UNITS_OF_PRODUCTION }))
    ).toThrow(/unidades de producción/);
  });
});

describe('lo que queda escrito del cálculo', () => {
  it('la base de la vida es costo menos salvamento, salvo en MACRS', () => {
    expect(baseDeLaVida(activo({ salvage_value: '10000.0000' }))).toBe('90000.0000');
    expect(baseDeLaVida(activo({ salvage_value: '10000.0000', method: DepreciationMethod.MACRS })))
      .toBe('100000.0000');
  });

  it('metadatosDeCalculo guarda método, base, convención e índice', () => {
    const meta = metadatosDeCalculo({
      metodo: DepreciationMethod.STRAIGHT_LINE,
      base: 'tasa_lisr',
      convencion: 'proporcional_dias',
      indice: 7,
      periodos: 37,
      vidaUtilMeses: 36,
      baseDepreciable: '90000.0000',
      baseDefinida: true,
      convencionDefinida: false,
    });
    expect(meta.metodo).toBe('straight_line');
    expect(meta.base).toBe('tasa_lisr');
    expect(meta.convencion).toBe('proporcional_dias');
    expect(meta.indice_calendario).toBe(7);
    expect(meta.tipo_calendario).toBe('tax');
    expect(meta.periodos_totales).toBe(37);
    expect(meta.base_depreciable).toBe('90000.0000');
    // Si el criterio venía del despacho o del defecto declarado se guarda
    // también: es lo que permite auditar por qué el importe es ése.
    expect(meta.politicas).toEqual({
      base_depreciacion: { valor: 'tasa_lisr', definida: true },
      convencion_primer_mes: { valor: 'proporcional_dias', definida: false },
    });
  });

  it('el tipo de calendario corresponde con la base, y el vocabulario es el del panel', () => {
    expect(TIPO_DE_CALENDARIO.vida_util_nif).toBe('book');
    expect(TIPO_DE_CALENDARIO.tasa_lisr).toBe('tax');
    expect([...BASES_DE_DEPRECIACION]).toEqual(['vida_util_nif', 'tasa_lisr']);
    expect([...CONVENCIONES_PRIMER_MES]).toEqual(['mes_completo', 'proporcional_dias']);
  });

  it('un importe de cero se reconoce con Decimal y no con coma flotante', () => {
    expect(esImporteCero('0.0000')).toBe(true);
    expect(esImporteCero('0.0001')).toBe(false);
    expect(esImporteCero('-0.0000')).toBe(true);
  });
});
