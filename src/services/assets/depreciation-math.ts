import Decimal from 'decimal.js';
import { DepreciationMethod } from '../../types/index.js';

// ============================================================
// LA ARITMÉTICA DE LA DEPRECIACIÓN, SIN POSTGRES (F06a)
//
// Este archivo existe por lo mismo que `reconciliation-math.ts` en F05c y las
// siete pruebas del extracto en F05a: una comprobación que sólo se puede
// ejercitar con la base detrás es la que acaba mintiendo, porque el escenario
// cuesta tanto de sembrar que nadie escribe el caso incómodo. Aquí el caso
// incómodo —«los doce meses de un activo consumen ONCE filas y la última no se
// consume nunca»— es una llamada de tres líneas.
//
// Y no era teórico: los seis calculadores llevaban desde la migración 003 con
// 0 % de cobertura, ningún activo dado de alta y, por lo tanto, ningún importe
// posteado que delatara los defectos. Se separan AHORA, antes de la primera
// alta, porque el día que existan filas de producción indexadas con la
// aritmética rota, repararla deja de ser una edición y pasa a ser una
// migración de datos ya posteados al mayor.
//
// LAS CUATRO REPARACIONES QUE TRAE, cada una junto al código que la aplica:
//
//   A · el índice del calendario se calculaba dividiendo milisegundos entre
//       30,44 días —la longitud MEDIA de un mes—, así que derivaba: marzo
//       repetía la fila de febrero y desde abril el índice quedaba atrasado
//       para siempre. Ver `indiceDeCalendario`.
//   C · el tapón del último mes se hacía sobre el valor en libros SIN
//       redondear, así que la suma de lo posteado no daba costo menos
//       salvamento. Ver `armarCalendario`.
//
// (B —la fecha del asiento— y D —el asiento y los metadatos que nadie
// ataba— viven en `depreciation.ts`, que es quien habla con el mayor.)
//
// LO QUE ESTE MÓDULO NO DECIDE. No lee el panel de políticas. Recibe la
// convención ya resuelta y devuelve el calendario; qué base rige el gasto
// —contable o fiscal— y si el cierre bloquea son decisiones del despacho que
// se leen en el servicio. Un módulo puro que consultara el panel dejaría de
// ser puro por la puerta de atrás.
// ============================================================

/** Los decimales que guarda `DECIMAL(19,4)`. No se recorta a dos. */
const DECIMALES = 4;

/**
 * Las dos bases de la política `base_depreciacion`.
 *
 * El vocabulario se copia del panel a propósito: una lista local que se
 * separara de él haría pasar por válido un valor que el catálogo no ofrece.
 */
export const BASES_DE_DEPRECIACION = ['vida_util_nif', 'tasa_lisr'] as const;
export type BaseDepreciacion = (typeof BASES_DE_DEPRECIACION)[number];

/** Las dos convenciones de la política `convencion_primer_mes`. */
export const CONVENCIONES_PRIMER_MES = ['mes_completo', 'proporcional_dias'] as const;
export type ConvencionPrimerMes = (typeof CONVENCIONES_PRIMER_MES)[number];

/**
 * El `schedule_type` que corresponde a cada base (003:207).
 *
 * El motor clavaba `'book'` viniera de donde viniera el número. Con la base
 * fiscal eso hacía que la fila mintiera sobre su propia procedencia, y la
 * UNIQUE (asset_id, fiscal_period_id, schedule_type) dejaba de poder guardar
 * las dos corridas del mismo mes.
 */
export const TIPO_DE_CALENDARIO: Record<BaseDepreciacion, 'book' | 'tax'> = {
  vida_util_nif: 'book',
  tasa_lisr: 'tax',
};

export interface DepreciationInput {
  asset_id?: string;
  /**
   * DINERO COMO STRING. Era `number` y llegaba por `parseFloat` de una columna
   * DECIMAL(19,4): la conversión pierde exactamente lo que la columna guarda
   * para no perderlo.
   */
  acquisition_cost: string;
  salvage_value: string;
  useful_life_months: number;
  /** Fecha en que el activo entra en servicio, a MEDIANOCHE LOCAL. */
  depreciation_start_date: Date;
  method: DepreciationMethod;
  macrs_class?: string;
  /** Por omisión, mes completo: es lo que cuenta la LISR. */
  convencion?: ConvencionPrimerMes;
}

export interface DepreciationResult {
  period_number: number;
  /**
   * Meses de CALENDARIO desde el mes en que el activo entró en servicio. Es
   * la misma cuenta que hace `indiceDeCalendario` con el periodo que se corre,
   * y por eso `calendario[i].indice_calendario === i`.
   */
  indice_calendario: number;
  period_start_date: Date;
  period_end_date: Date;
  beginning_book_value: string;
  depreciation_expense: string;
  accumulated_depreciation: string;
  ending_book_value: string;
}

// ---- El calendario: meses, no milisegundos -------------------------------

/** Primer día del mes de `fecha`, a medianoche LOCAL. */
export function primerDiaDelMes(fecha: Date): Date {
  return new Date(fecha.getFullYear(), fecha.getMonth(), 1);
}

/** Último día del mes de `fecha`, a medianoche LOCAL (día 0 del siguiente). */
export function ultimoDiaDelMes(fecha: Date): Date {
  return new Date(fecha.getFullYear(), fecha.getMonth() + 1, 0);
}

export function diasDelMes(fecha: Date): number {
  return ultimoDiaDelMes(fecha).getDate();
}

/**
 * DEFECTO A · EL ÍNDICE ES UNA DIFERENCIA DE MESES DE CALENDARIO.
 *
 * Se calculaba dividiendo la diferencia de milisegundos entre 30,44 días —la
 * longitud MEDIA de un mes—, y un promedio no indexa un calendario: para un
 * activo que arranca el 1 de enero, marzo (59 días) volvía a dar 1 y repetía
 * la fila de febrero; desde abril el índice quedaba atrasado un mes para
 * siempre. Doce meses consumían ONCE filas distintas, la última no se consumía
 * NUNCA, y el activo no llegaba a depreciarse del todo: la suma posteada no
 * daba jamás costo menos salvamento.
 *
 * Negativo significa que el periodo es anterior a la entrada en servicio, y el
 * llamador tiene que tratarlo como «este activo aún no deprecia» y no como
 * `schedule[-1]`, que en JavaScript es `undefined` y se salta en silencio.
 */
export function indiceDeCalendario(inicioServicio: Date, inicioPeriodo: Date): number {
  return (
    (inicioPeriodo.getFullYear() - inicioServicio.getFullYear()) * 12 +
    (inicioPeriodo.getMonth() - inicioServicio.getMonth())
  );
}

/**
 * Qué parte del primer mes se posee el activo, cuando la convención prorratea.
 *
 * Se cuenta el día de compra como día poseído —del 20 al 31 son doce días, no
 * once—, que es como cuenta el SAT los días de un periodo.
 */
export function fraccionDelPrimerMes(inicioServicio: Date): Decimal {
  const dias = diasDelMes(inicioServicio);
  return new Decimal(dias - inicioServicio.getDate() + 1).dividedBy(dias);
}

// ---- Las series crudas: un importe por mes, sin redondear ----------------

/**
 * Lo que produce cada método antes de tocar el calendario.
 *
 * `agotaBase` es la diferencia entre «esta serie tiene que sumar la base
 * exacta» y «esta serie suma lo que la producción del periodo diga». Sin ese
 * bit, el tapón del último renglón convertiría un activo medio usado en uno
 * totalmente depreciado.
 */
interface SerieCruda {
  importes: Decimal[];
  agotaBase: boolean;
  /** Lo que hay que repartir a lo largo de la vida. */
  base: Decimal;
}

function baseDepreciable(input: DepreciationInput): Decimal {
  return new Decimal(input.acquisition_cost).minus(input.salvage_value);
}

/**
 * Lo que la vida entera del activo tiene que repartir, según su método.
 *
 * MACRS es la excepción y por eso esto no es una resta suelta: la ley que lo
 * define ignora el salvamento y deprecia el costo entero.
 */
export function baseDeLaVida(input: DepreciationInput): string {
  const base =
    input.method === DepreciationMethod.MACRS
      ? new Decimal(input.acquisition_cost)
      : baseDepreciable(input);
  return base.toFixed(DECIMALES);
}

/** Un importe de la corrida que no mueve nada. Con Decimal, no con `=== 0`. */
export function esImporteCero(monto: string): boolean {
  return new Decimal(monto).isZero();
}

export function serieLineaRecta(input: DepreciationInput): SerieCruda {
  const base = baseDepreciable(input);
  const mensual = base.dividedBy(input.useful_life_months);
  const importes: Decimal[] = [];
  for (let mes = 0; mes < input.useful_life_months; mes++) importes.push(mensual);
  return { importes, agotaBase: true, base };
}

export function serieSaldosDecrecientes(input: DepreciationInput, factor: number): SerieCruda {
  const base = baseDepreciable(input);
  const tasaAnual = new Decimal(factor).dividedBy(input.useful_life_months / 12);
  const tasaMensual = tasaAnual.dividedBy(12);

  const importes: Decimal[] = [];
  let acumulado = new Decimal(0);
  let valorEnLibros = new Decimal(input.acquisition_cost);

  for (let mes = 1; mes <= input.useful_life_months; mes++) {
    const restante = base.minus(acumulado);
    let gasto = valorEnLibros.times(tasaMensual);

    // El cambio a línea recta cuando ésta da más: sin él, un porcentaje sobre
    // un saldo que decrece nunca llega a cero y el activo se queda sin
    // depreciar el último tramo de su vida.
    const mesesRestantes = input.useful_life_months - mes + 1;
    const lineaRecta = restante.dividedBy(mesesRestantes);
    if (lineaRecta.greaterThan(gasto)) gasto = lineaRecta;

    if (gasto.greaterThan(restante)) gasto = restante;
    if (gasto.lessThanOrEqualTo(0)) break;

    importes.push(gasto);
    acumulado = acumulado.plus(gasto);
    valorEnLibros = valorEnLibros.minus(gasto);
  }

  return { importes, agotaBase: true, base };
}

export function serieSumaDeDigitos(input: DepreciationInput): SerieCruda {
  const base = baseDepreciable(input);
  const anios = input.useful_life_months / 12;
  const sumaDeDigitos = new Decimal(anios).times(new Decimal(anios).plus(1)).dividedBy(2);

  const importes: Decimal[] = [];
  for (let mes = 1; mes <= input.useful_life_months; mes++) {
    const anio = Math.ceil(mes / 12);
    const vidaRestante = anios - anio + 1;
    const anual = base.times(vidaRestante).dividedBy(sumaDeDigitos);
    importes.push(anual.dividedBy(12));
  }

  // Los dígitos son ANUALES: con una vida que no es un número entero de años
  // (30 meses, por ejemplo) los pesos no suman la base y el tapón del último
  // renglón absorbe un resto que no es de redondeo. Se deja así —y se dice—
  // porque el activo tiene que quedar depreciado al terminar su vida útil, y
  // porque la vida se captura en años (`useful_life_years`) y los meses salen
  // de ahí: el caso fraccionario entra por la puerta de atrás, no por la de
  // alta.
  return { importes, agotaBase: true, base };
}

/**
 * Las tablas MACRS del IRS (media anualidad).
 *
 * Viven aquí por el mismo motivo que en la 003: son las que un activo
 * declarado bajo esa convención necesita. En México no rigen —la deducción la
 * fijan los artículos 31-38 de la LISR— y por eso el método existe pero no es
 * el defecto de nada.
 */
export const MACRS_TABLES: Record<string, number[]> = {
  '3-year': [33.33, 44.45, 14.81, 7.41],
  '5-year': [20.0, 32.0, 19.2, 11.52, 11.52, 5.76],
  '7-year': [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46],
  '10-year': [10.0, 18.0, 14.4, 11.52, 9.22, 7.37, 6.55, 6.55, 6.56, 6.55, 3.28],
  '15-year': [5.0, 9.5, 8.55, 7.7, 6.93, 6.23, 5.9, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 2.95],
  '20-year': [
    3.75, 7.219, 6.677, 6.177, 5.713, 5.285, 4.888, 4.522, 4.462, 4.461, 4.462, 4.461, 4.462,
    4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 2.231,
  ],
};

export function serieMACRS(input: DepreciationInput): SerieCruda {
  const clase = input.macrs_class || '5-year';
  const tabla = MACRS_TABLES[clase];
  if (!tabla) {
    throw new Error(
      `Clase MACRS desconocida: "${clase}". Las declaradas son ${Object.keys(MACRS_TABLES).join(', ')}.`
    );
  }

  // MACRS deprecia el COSTO ENTERO: la ley fiscal que lo define ignora el
  // valor de salvamento a propósito. Por eso la base de esta serie no es
  // costo menos salvamento como en las demás.
  const base = new Decimal(input.acquisition_cost);
  const importes: Decimal[] = [];

  for (let anio = 0; anio < tabla.length; anio++) {
    const anual = base.times(new Decimal(tabla[anio]).dividedBy(100));
    // Media anualidad: el primer y el último ejercicio valen seis meses.
    const meses = anio === 0 || anio === tabla.length - 1 ? 6 : 12;
    const mensual = anual.dividedBy(meses);
    for (let m = 0; m < meses; m++) importes.push(mensual);
  }

  return { importes, agotaBase: true, base };
}

export function serieUnidadesDeProduccion(
  input: DepreciationInput,
  totalCapacity: string | number,
  periodsUnits: Array<{ period: number; units: string | number }>
): SerieCruda {
  const base = baseDepreciable(input);
  const capacidad = new Decimal(totalCapacity);
  if (capacidad.lessThanOrEqualTo(0)) {
    throw new Error('La capacidad total de un activo por unidades de producción tiene que ser mayor que cero.');
  }

  // La serie es DENSA aunque la producción venga salteada: el índice de una
  // fila es su mes de calendario, y una lista que sólo trajera los meses
  // productivos correría el calendario hacia atrás y postearía la producción
  // de mayo con fecha de marzo. Un mes sin producción vale cero, que es
  // exactamente lo que se depreció.
  const ultimo = periodsUnits.reduce((max, p) => Math.max(max, p.period), 0);
  const importes: Decimal[] = new Array<Decimal>(ultimo).fill(new Decimal(0));

  let unidades = new Decimal(0);
  let acumulado = new Decimal(0);
  // En orden de periodo aunque la lista no venga ordenada: el tope contra la
  // base restante depende de lo ya depreciado, y con la lista al revés el mes
  // recortado sería el que no toca.
  for (const periodo of [...periodsUnits].sort((a, b) => a.period - b.period)) {
    if (periodo.period < 1) continue;
    const restante = base.minus(acumulado);
    let gasto = base.times(periodo.units).dividedBy(capacidad);
    if (gasto.greaterThan(restante)) gasto = restante;
    if (gasto.isNegative()) gasto = new Decimal(0);
    importes[periodo.period - 1] = gasto;
    acumulado = acumulado.plus(gasto);
    unidades = unidades.plus(periodo.units);
  }

  // Sólo se agota la base si la máquina agotó su capacidad. Un activo usado a
  // medias NO se termina de depreciar con un tapón: eso sería inventar un
  // gasto que la producción no respalda.
  return { importes, agotaBase: unidades.greaterThanOrEqualTo(capacidad), base };
}

// ---- Del importe crudo a la fila que se guarda --------------------------

/**
 * La convención del primer mes, aplicada como un CORRIMIENTO.
 *
 * Cada mes se queda con la fracción `f` de lo suyo y hereda `1 − f` de lo del
 * mes anterior, y al final aparece un mes más con la cola. Escrito así, el
 * TOTAL DE LA VIDA NO CAMBIA por construcción —cada importe crudo aporta
 * `f + (1 − f)`— y la propiedad vale para cualquier método, no sólo para la
 * línea recta: lo único que cambia es qué periodo carga cada peso, que es
 * justo lo que la política dice que decide.
 */
function repartirPrimerMes(
  importes: Decimal[],
  convencion: ConvencionPrimerMes,
  inicioServicio: Date
): Decimal[] {
  if (convencion === 'mes_completo' || importes.length === 0) return importes;

  const propia = fraccionDelPrimerMes(inicioServicio);
  // Un activo que entra en servicio el día 1 posee el mes entero: prorratear
  // ahí añadiría un mes final de importe cero.
  if (propia.equals(1)) return importes;
  const heredada = new Decimal(1).minus(propia);

  const salida: Decimal[] = [];
  for (let i = 0; i <= importes.length; i++) {
    const deEste = i < importes.length ? importes[i].times(propia) : new Decimal(0);
    const delAnterior = i > 0 ? importes[i - 1].times(heredada) : new Decimal(0);
    salida.push(deEste.plus(delAnterior));
  }
  return salida;
}

/**
 * DEFECTO C · EL TAPÓN SE HACE SOBRE LO YA REDONDEADO.
 *
 * El motor redondeaba a cuatro decimales al imprimir la fila pero arrastraba
 * el valor en libros SIN redondear, y cerraba con `bookValue − salvamento`.
 * Con 100.000 a 36 meses eso posteaba 2.777,7778 treinta y seis veces: la suma
 * daba 100.000,0008 y el mayor quedaba con ocho diezmilésimas que no eran de
 * nadie. Aquí el acumulado es la suma de lo que REALMENTE se postea, y el
 * último renglón es la resta contra la base, no una división más: Σ posteado
 * es exacto por construcción.
 *
 * El tapón sólo se aplica si la serie tiene que agotar la base (`agotaBase`).
 */
function armarCalendario(input: DepreciationInput, serie: SerieCruda): DepreciationResult[] {
  const costo = new Decimal(input.acquisition_cost);
  const convencion = input.convencion ?? 'mes_completo';
  const importes = repartirPrimerMes(serie.importes, convencion, input.depreciation_start_date);
  const mesInicial = primerDiaDelMes(input.depreciation_start_date);

  const filas: DepreciationResult[] = [];
  let acumulado = new Decimal(0);

  for (let i = 0; i < importes.length; i++) {
    const restante = serie.base.minus(acumulado);
    let gasto: Decimal;
    if (serie.agotaBase && i === importes.length - 1) {
      gasto = restante;
    } else {
      gasto = importes[i].toDecimalPlaces(DECIMALES);
      if (gasto.greaterThan(restante)) gasto = restante;
    }
    if (gasto.isNegative()) gasto = new Decimal(0);

    acumulado = acumulado.plus(gasto);
    const inicioDelMes = new Date(mesInicial.getFullYear(), mesInicial.getMonth() + i, 1);
    const enLibros = costo.minus(acumulado);

    filas.push({
      period_number: i + 1,
      indice_calendario: i,
      period_start_date: inicioDelMes,
      period_end_date: ultimoDiaDelMes(inicioDelMes),
      beginning_book_value: enLibros.plus(gasto).toFixed(DECIMALES),
      depreciation_expense: gasto.toFixed(DECIMALES),
      accumulated_depreciation: acumulado.toFixed(DECIMALES),
      ending_book_value: enLibros.toFixed(DECIMALES),
    });
  }

  return filas;
}

// ---- Los seis calculadores, ahora ejercitables sin base de datos --------

export function calculateStraightLine(input: DepreciationInput): DepreciationResult[] {
  return armarCalendario(input, serieLineaRecta(input));
}

export function calculateDecliningBalance(input: DepreciationInput, rate: number): DepreciationResult[] {
  return armarCalendario(input, serieSaldosDecrecientes(input, rate));
}

export function calculateSumOfYearsDigits(input: DepreciationInput): DepreciationResult[] {
  return armarCalendario(input, serieSumaDeDigitos(input));
}

export function calculateMACRS(input: DepreciationInput): DepreciationResult[] {
  return armarCalendario(input, serieMACRS(input));
}

export function calculateUnitsOfProduction(
  input: DepreciationInput,
  totalCapacity: string | number,
  periodsUnits: Array<{ period: number; units: string | number }>
): DepreciationResult[] {
  // La convención del primer mes NO se aplica aquí. Prorratear por días lo que
  // se depreció por unidades producidas movería a otro mes una producción que
  // está medida, no devengada: la convención existe para repartir un importe
  // que el tiempo causa, y aquí lo causa la máquina.
  return armarCalendario(
    { ...input, convencion: 'mes_completo' },
    serieUnidadesDeProduccion(input, totalCapacity, periodsUnits)
  );
}

export function calculateDepreciation(
  input: DepreciationInput,
  unitsOfProductionData?: { totalCapacity: string | number; periodsUnits: Array<{ period: number; units: string | number }> }
): DepreciationResult[] {
  switch (input.method) {
    case DepreciationMethod.STRAIGHT_LINE:
      return calculateStraightLine(input);
    case DepreciationMethod.DECLINING_BALANCE_150:
      return calculateDecliningBalance(input, 1.5);
    case DepreciationMethod.DECLINING_BALANCE_200:
      return calculateDecliningBalance(input, 2.0);
    case DepreciationMethod.SUM_OF_YEARS_DIGITS:
      return calculateSumOfYearsDigits(input);
    case DepreciationMethod.MACRS:
      return calculateMACRS(input);
    case DepreciationMethod.UNITS_OF_PRODUCTION:
      if (!unitsOfProductionData) {
        throw new Error(
          'La depreciación por unidades de producción necesita la capacidad total y la producción del periodo: sin producción no hay importe que calcular.'
        );
      }
      return calculateUnitsOfProduction(
        input,
        unitsOfProductionData.totalCapacity,
        unitsOfProductionData.periodsUnits
      );
    default:
      return calculateStraightLine(input);
  }
}

// ---- Lo que queda escrito de cada renglón -------------------------------

/**
 * DEFECTO D (mitad pura) · `calculation_metadata`, que no se escribía nunca.
 *
 * El importe solo no permite reconstruir por qué es ése: el mismo activo da
 * tres números distintos según la base, la convención y el método, y las tres
 * cosas se deciden fuera de la fila. Se guarda para que la corrida del mes que
 * viene pueda comprobar que sigue el mismo criterio —y para que quien audite
 * la deducción vea si el criterio venía del despacho o del defecto declarado.
 */
export function metadatosDeCalculo(a: {
  metodo: DepreciationMethod;
  base: BaseDepreciacion;
  convencion: ConvencionPrimerMes;
  indice: number;
  periodos: number;
  vidaUtilMeses: number;
  baseDepreciable: string;
  baseDefinida: boolean;
  convencionDefinida: boolean;
}): Record<string, unknown> {
  return {
    metodo: a.metodo,
    base: a.base,
    tipo_calendario: TIPO_DE_CALENDARIO[a.base],
    convencion: a.convencion,
    indice_calendario: a.indice,
    periodos_totales: a.periodos,
    vida_util_meses: a.vidaUtilMeses,
    base_depreciable: a.baseDepreciable,
    politicas: {
      base_depreciacion: { valor: a.base, definida: a.baseDefinida },
      convencion_primer_mes: { valor: a.convencion, definida: a.convencionDefinida },
    },
  };
}
