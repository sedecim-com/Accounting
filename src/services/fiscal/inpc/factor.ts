import Decimal from 'decimal.js';
import { AccountingError, ValidationError } from '../../../utils/errors.js';
import {
  compararPeriodos,
  formatearPeriodo,
  mesesDelPeriodo,
  nombrarPeriodo,
  sumarMeses,
  type Periodo,
} from './periodo.js';

// ============================================================
// F07c · EL FACTOR DE ACTUALIZACIÓN (LISR art. 6 fr. II)
//
// EL CORAZÓN DE ESTE FRENTE ES UNA NEGATIVA. El factor es una división de dos
// índices, y una división siempre da un número: ahí está el peligro. El INEGI
// ha REBASADO la serie del INPC varias veces —base 2010=100, base segunda
// quincena de julio de 2018=100— y dividir un índice de una base entre uno de
// otra produce un número perfectamente plausible y completamente sin
// significado. No revienta, no sale negativo, no sale enorme: sale «1.34» y
// se firma. Por eso la 065 metió la base en la LLAVE PRIMARIA y por eso esta
// función se NIEGA cuando las dos puntas no la comparten. Es la única
// protección que existe contra ese error, porque la aritmética no protege de
// nada.
//
// LA REGLA, literal: «el factor de actualización se obtendrá dividiendo el
// INPC del mes más reciente del periodo entre el citado índice correspondiente
// al mes más antiguo de dicho periodo» (LISR art. 6, fr. II — el que invoca el
// art. 31 para la deducción de inversiones).
//
// NO ES LA REGLA DEL CFF. El art. 17-A del CFF actualiza contribuciones con el
// INPC del mes ANTERIOR al más reciente entre el del mes ANTERIOR al más
// antiguo. Es otro corrimiento y da otro número. Aquí NO está implementada, a
// propósito: mezclarlas bajo un solo nombre sería exactamente la clase de
// error que este módulo existe para impedir. Cuando haga falta (recargos,
// actualización de saldos a favor) se añade como función HERMANA con su
// nombre, no como una bandera de ésta.
//
// CUATRO DECIMALES POR OMISIÓN: el diezmilésimo del art. 17-A del CFF, que es
// como se publica y se revisa el factor. Se puede pedir más precisión para un
// papel de trabajo, nunca menos de dos.
// ============================================================

/** El diezmilésimo: el corte con el que el factor se publica y se revisa. */
export const DECIMALES_FACTOR = 4;
const MIN_DECIMALES_FACTOR = 2;
const MAX_DECIMALES_FACTOR = 10;

// Los índices traen hasta 12 dígitos con 6 decimales (DECIMAL(12,6) en la
// 065). Un cociente de dos de ellos necesita holgura muy por encima de los 20
// dígitos por omisión de decimal.js para que el corte al diezmilésimo salga
// del número exacto y no de uno ya redondeado. Se clona, como en R4, en vez de
// tocar la configuración global que comparten módulos que no pidieron esto.
const D = Decimal.clone({ precision: 40 });

/** Un índice puntual: el valor, su mes y —lo que importa— su BASE. */
export interface IndiceEnPeriodo {
  periodo: Periodo;
  /** El índice como STRING: nunca float, igual que el dinero de la casa. */
  valor: string;
  /** La base a la que está referido, p. ej. «2018-Jul2=100». */
  base: string;
}

export interface FactorDeActualizacion {
  /** El factor, string con `decimales` posiciones. */
  factor: string;
  /** La punta antigua (divisor) y la reciente (dividendo), tal como entraron. */
  antiguo: IndiceEnPeriodo;
  reciente: IndiceEnPeriodo;
  /** La base compartida. Si no la compartieran no habría factor. */
  base: string;
  decimales: number;
  /** Meses comprendidos entre las dos puntas, ambas incluidas. */
  meses: number;
}

/**
 * Dos bases se consideran la misma sólo si su texto coincide tras recortar
 * espacios. NO se normaliza más —ni mayúsculas, ni signos— a propósito: dar
 * por equivalentes dos escrituras distintas es adivinar, y adivinar aquí es
 * justo el error que la base en la llave impide. Dos grafías del mismo INPC
 * se resuelven arreglando la captura, no relajando la comparación.
 */
export function normalizarBase(base: string): string {
  return base.trim().replace(/\s+/g, ' ');
}

function exigirIndice(i: IndiceEnPeriodo, papel: string): Decimal {
  const base = normalizarBase(i.base);
  if (base === '') {
    throw new ValidationError(
      `El índice ${papel} de ${nombrarPeriodo(i.periodo)} no declara base, y sin base no hay factor.`
    );
  }
  let v: Decimal;
  try {
    v = new D(i.valor);
  } catch {
    throw new ValidationError(`El índice ${papel} de ${nombrarPeriodo(i.periodo)} "${i.valor}" no es un número.`);
  }
  if (!v.isFinite() || v.lte(0)) {
    throw new ValidationError(
      `El índice ${papel} de ${nombrarPeriodo(i.periodo)} "${i.valor}" debe ser un número positivo.`
    );
  }
  return v;
}

export interface OpcionesFactor {
  /** Posiciones del factor. Por omisión 4, el diezmilésimo. */
  decimales?: number;
}

/**
 * Factor de actualización: índice del mes MÁS RECIENTE entre índice del mes
 * MÁS ANTIGUO, con las dos puntas en la MISMA base.
 *
 * Se niega en tres casos y ninguno es negociable:
 *  · bases distintas — el número saldría y no significaría nada;
 *  · puntas invertidas — un factor no se calcula «hacia atrás» sin decirlo;
 *  · índice no positivo — el CHECK de la 065 ya lo impide en la base, pero
 *    esta función también se llama con datos a mano.
 *
 * Dos puntas en el MISMO mes dan 1.0000 y eso es correcto: adquirir y
 * actualizar en el mismo mes no actualiza nada. Es lo contrario del 1.0 que el
 * catálogo prohíbe, que es el que aparecería si un mes FALTARA — ése no se
 * calcula aquí, se rechaza antes, al resolver el índice.
 */
export function factorDeActualizacion(
  antiguo: IndiceEnPeriodo,
  reciente: IndiceEnPeriodo,
  opts: OpcionesFactor = {}
): FactorDeActualizacion {
  const decimales = opts.decimales ?? DECIMALES_FACTOR;
  if (
    !Number.isInteger(decimales) ||
    decimales < MIN_DECIMALES_FACTOR ||
    decimales > MAX_DECIMALES_FACTOR
  ) {
    throw new ValidationError(
      `Los decimales del factor deben ser un entero entre ${MIN_DECIMALES_FACTOR} y ` +
        `${MAX_DECIMALES_FACTOR}; llegó "${decimales}".`
    );
  }

  const vAntiguo = exigirIndice(antiguo, 'del mes más antiguo');
  const vReciente = exigirIndice(reciente, 'del mes más reciente');

  const baseAntiguo = normalizarBase(antiguo.base);
  const baseReciente = normalizarBase(reciente.base);
  if (baseAntiguo !== baseReciente) {
    // LA NEGATIVA QUE SOSTIENE ESTE MÓDULO.
    throw new AccountingError(
      'INPC_BASES_DISTINTAS',
      `No calculo el factor: el INPC de ${nombrarPeriodo(antiguo.periodo)} está en base ` +
        `"${baseAntiguo}" y el de ${nombrarPeriodo(reciente.periodo)} en base "${baseReciente}". ` +
        'Dividir índices de bases distintas da un número plausible y sin significado. ' +
        'Carga los dos meses en la misma base (el INEGI republica la serie completa cada vez ' +
        'que rebasa) y vuelve a pedirlo.',
      {
        antiguo: formatearPeriodo(antiguo.periodo),
        baseAntiguo,
        reciente: formatearPeriodo(reciente.periodo),
        baseReciente,
      }
    );
  }

  if (compararPeriodos(antiguo.periodo, reciente.periodo) > 0) {
    throw new AccountingError(
      'INPC_PERIODO_INVERTIDO',
      `El mes "más antiguo" (${nombrarPeriodo(antiguo.periodo)}) es posterior al "más reciente" ` +
        `(${nombrarPeriodo(reciente.periodo)}). El factor de la LISR divide el índice reciente ` +
        'entre el antiguo; invertir las puntas da el recíproco, que es otra cosa. Ordénalos.',
      {
        antiguo: formatearPeriodo(antiguo.periodo),
        reciente: formatearPeriodo(reciente.periodo),
      }
    );
  }

  return {
    factor: vReciente.dividedBy(vAntiguo).toFixed(decimales, Decimal.ROUND_HALF_UP),
    antiguo: { ...antiguo, base: baseAntiguo },
    reciente: { ...reciente, base: baseReciente },
    base: baseAntiguo,
    decimales,
    meses: mesesDelPeriodo(antiguo.periodo, reciente.periodo),
  };
}

export interface MitadDelPeriodo {
  /** El mes hasta el que se actualiza: último mes de la primera mitad. */
  mes: Periodo;
  /** Meses comprendidos en el periodo de uso, las dos puntas dentro. */
  meses: number;
  /** true cuando el número de meses es impar y aplicó el ajuste del art. 31. */
  impar: boolean;
}

/**
 * LISR art. 31: la deducción de inversiones se actualiza «desde el mes en que
 * se adquirió el bien y hasta el ÚLTIMO MES DE LA PRIMERA MITAD del periodo en
 * el que el bien haya sido utilizado durante el ejercicio», y «cuando sea
 * impar el número de meses comprendidos en el periodo, se considerará como
 * último mes de la primera mitad el mes inmediato anterior al que corresponda
 * la mitad del periodo».
 *
 * Las dos reglas colapsan en la misma cuenta —la posición ⌊n/2⌋ del periodo—,
 * y aun así el ajuste se calcula y se REPORTA aparte (`impar`) porque el papel
 * de trabajo tiene que poder enseñarlo.
 *
 * ESTA FUNCIÓN NO ACTUALIZA NADA. Sólo dice CUÁL mes es el tope; el factor lo
 * calcula `factorDeActualizacion` y el cableado con la depreciación fiscal NO
 * existe todavía (ver la cabecera del servicio).
 */
export function ultimoMesDeLaPrimeraMitad(inicio: Periodo, fin: Periodo): MitadDelPeriodo {
  const meses = mesesDelPeriodo(inicio, fin);
  if (meses === 1) {
    // BIFURCACIÓN DE CRITERIO, NO HUECO DE CÓDIGO. Con un solo mes de uso la
    // «primera mitad» termina dentro de ese mes y el «mes inmediato anterior»
    // que la ley manda tomar cae FUERA del periodo. Hay dos lecturas usadas en
    // la práctica —tomar el mes mismo (factor 1.0000) o no actualizar—, y
    // elegir una por el despacho es elegirle criterio fiscal. Se bloquea, que
    // es la lectura conservadora: la alternativa produce en silencio el 1.0
    // que el catálogo prohíbe justamente porque no se distingue de un mes
    // faltante. La política que zanja esto NO existe en el panel; queda
    // reportada, no inventada.
    throw new AccountingError(
      'INPC_MEDIO_PERIODO_DE_UN_MES',
      `El periodo de uso es un solo mes (${nombrarPeriodo(inicio)}), y con un mes la regla del ` +
        'art. 31 manda tomar «el mes inmediato anterior al que corresponda la mitad», que cae ' +
        'fuera del periodo. No elijo por ti entre actualizar con factor 1.0000 y no actualizar: ' +
        'es criterio fiscal y no hay política que lo resuelva. Indica el mes tope a mano.',
      { inicio: formatearPeriodo(inicio), fin: formatearPeriodo(fin) }
    );
  }
  return {
    mes: sumarMeses(inicio, Math.floor(meses / 2) - 1),
    meses,
    impar: meses % 2 === 1,
  };
}
