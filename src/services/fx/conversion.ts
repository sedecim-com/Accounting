import Decimal from 'decimal.js';
import { AccountingError } from '../../utils/errors.js';

// ============================================================
// LA CONVERSIÓN SE VERIFICA, NO SE CONFÍA (R4 · NIF B-15)
//
// `journal_entry_lines` trae las cuatro columnas de moneda extranjera desde
// la 001 —currency_code, foreign_debit, foreign_credit, exchange_rate— con un
// CHECK que las obliga a viajar juntas, y durante un año el INSERT de
// `createJournalEntry` las ignoró las cuatro: todo asiento en dólares perdía
// su origen al nacer. Este módulo es la mitad aritmética del arreglo: dado el
// importe de origen y el tipo de cambio, el importe funcional NO es un dato
// que el llamador afirme sino un cálculo que aquí se repite y se compara.
//
// NO TOCA POSTGRES, Y ESO ES UN REQUISITO. Igual que la aritmética de la
// conciliación (F05c): una verificación que sólo se ejercita con la base
// detrás acaba mintiendo, porque el caso incómodo —el medio centavo que
// redondea hacia el otro lado— cuesta tanto de sembrar que nadie lo escribe.
// Aquí es una llamada de tres líneas.
//
// EL REDONDEO ES HALF-UP Y ESTÁ ESCRITO A PROPÓSITO. El importe funcional
// vive en DECIMAL(19,4); el producto foreign × rate casi nunca cabe en cuatro
// decimales y hay que cortar. Se corta con half-up —0.00005 sube a 0.0001—
// (since MNE-001-862 the cut is at the currency's minor unit: half a cent goes up)
// porque es el redondeo comercial que usa el SAT en el Anexo 20 para los
// importes del CFDI, y usar otro (half-even, truncado) produciría centavos
// que no cuadran contra el comprobante. Decimal.js por omisión redondea
// half-up, pero aquí se pasa EXPLÍCITO: que el criterio se lea, no se herede.
//
// EL TIPO DE CAMBIO TIENE DIEZ DECIMALES, NO CUATRO. La columna es
// DECIMAL(19,10). Un tipo con más de diez decimales lo redondearía Postgres
// EN SILENCIO al guardar, y entonces el importe verificado aquí ya no saldría
// de la tasa guardada: por eso el exceso de precisión se rechaza en vez de
// recortarse.
// ============================================================

/** Decimales del importe funcional y extranjero (DECIMAL(19,4) en la 001). */
const DECIMALES_IMPORTE = 4;
/** Decimales del tipo de cambio (DECIMAL(19,10) en la 001). */
const DECIMALES_TASA = 10;

// El producto importe (hasta 19 dígitos significativos) × tasa (hasta 19)
// puede necesitar 38 dígitos exactos, y los 20 por defecto de decimal.js lo
// redondearían ANTES del corte a 4 decimales — con lo que esta verificación
// podría discrepar del convertidor (moneda-origen.ts usa el mismo clon de 40)
// justo en los importes grandes. Se clona en vez de tocar la configuración
// global, que comparten módulos que no pidieron esto.
const D = Decimal.clone({ precision: 40 });

/**
 * La forma mínima de una línea que este módulo sabe verificar. Es un
 * subconjunto estructural de `JournalEntryLineInput` (posting.ts) para que el
 * motor la pase tal cual sin adaptador.
 */
export interface LineaConOrigen {
  debit_amount: string | null;
  credit_amount: string | null;
  currency_code?: string | null;
  foreign_debit?: string | null;
  foreign_credit?: string | null;
  exchange_rate?: string | null;
}

/** ¿La línea trae ALGUNO de los cuatro campos de moneda extranjera? */
export function traeCamposFx(linea: LineaConOrigen): boolean {
  return (
    linea.currency_code != null ||
    linea.foreign_debit != null ||
    linea.foreign_credit != null ||
    linea.exchange_rate != null
  );
}

// MNE-001-862 (#1066) · THE FUNCTIONAL AMOUNT IS BOOKED AT ITS CURRENCY'S MINOR UNIT.
// The columns hold four decimals, but a peso has cents and the Anexo 24
// declares two (`t_Importe`): two products kept at four decimals on one
// account left a trial balance that did not add up once rounded (570.7552 +
// 100.0058 declared as 570.76 + 100.01 = 670.77 against 670.76). The decimals
// are the currency's own, read from ICU as `i18n/format.ts` reads them.

/** The peso: the functional currency a caller that holds none converts to. */
export const DEFAULT_FUNCTIONAL_CURRENCY = 'MXN';

const minorUnitByCurrency = new Map<string, number>();

/** Decimals of a currency's minor unit (MXN and USD 2, JPY 0, KWD 3), never above the ledger's four. */
export function minorUnitDecimals(currency: string): number {
  let decimals = minorUnitByCurrency.get(currency);
  if (decimals === undefined) {
    const own = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions();
    decimals = Math.min(own.minimumFractionDigits ?? 2, DECIMALES_IMPORTE);
    minorUnitByCurrency.set(currency, decimals);
  }
  return decimals;
}

let whenNotTwo: string | undefined;

/** `minorUnitDecimals` as SQL over a currency expression, built once from the same table. */
export function minorUnitDecimalsSql(currencySql: string): string {
  whenNotTwo ??= Intl.supportedValuesOf('currency')
    .filter((currency) => minorUnitDecimals(currency) !== 2)
    .map((currency) => `WHEN '${currency}' THEN ${minorUnitDecimals(currency)}`)
    .join(' ');
  return `CASE ${currencySql} ${whenNotTwo} ELSE 2 END`;
}

/**
 * Converts an origin amount to the functional currency: foreign × rate,
 * half-up at the minor unit of the functional currency, written with the
 * column's four decimals. It is THE definition of the conversion: the engine,
 * the check, `convertirAFuncional` and the tests call this one function, so
 * no two arithmetics can disagree.
 */
export function convertirImporte(
  importeExtranjero: string,
  tipoDeCambio: string,
  functionalCurrency: string = DEFAULT_FUNCTIONAL_CURRENCY
): string {
  return new D(importeExtranjero)
    .times(new D(tipoDeCambio))
    .toDecimalPlaces(minorUnitDecimals(functionalCurrency), Decimal.ROUND_HALF_UP)
    .toFixed(DECIMALES_IMPORTE);
}

function esDecimalValido(v: string): boolean {
  try {
    const d = new Decimal(v);
    return d.isFinite();
  } catch {
    return false;
  }
}

function decimalesDe(v: string): number {
  return new Decimal(v).decimalPlaces();
}

function falta(numeroDeLinea: number, mensaje: string, detalles?: Record<string, unknown>): AccountingError {
  return new AccountingError('FX_ORIGEN_INCOMPLETO', `Línea ${numeroDeLinea}: ${mensaje}`, detalles);
}

/**
 * Verifica que una línea en moneda extranjera lleve su origen COMPLETO y que
 * la conversión CUADRE. Lanza `AccountingError` con un mensaje legible; el
 * CHECK de la 001 queda como última red, no como el error que ve el usuario.
 *
 * REGLA DURA (la razón de ser de R4): ninguna línea pierde su origen en
 * silencio. Una `currency_code` distinta de la moneda funcional SIN los
 * importes de origen y su tipo se rechaza nombrando qué falta — antes, esa
 * línea se guardaba convertida sin rastro del importe original.
 */
export function verificarOrigenFx(
  linea: LineaConOrigen,
  monedaFuncional: string,
  numeroDeLinea: number,
  /**
   * MNE-001-862 · The line is the mirror of a posted one (a reversal). An
   * entry posted before the cent rule holds foreign × rate at four decimals,
   * and its mirror is what was posted, not a new conversion: it passes at
   * either figure. Without this no earlier foreign entry could be reversed.
   */
  mirror = false
): void {
  if (!traeCamposFx(linea)) return;

  const { currency_code, foreign_debit, foreign_credit, exchange_rate } = linea;

  // Campos FX sueltos sin moneda: no hay forma de saber de qué origen hablan.
  if (currency_code == null) {
    const presentes = [
      foreign_debit != null ? 'foreign_debit' : null,
      foreign_credit != null ? 'foreign_credit' : null,
      exchange_rate != null ? 'exchange_rate' : null,
    ].filter((c): c is string => c !== null);
    throw falta(
      numeroDeLinea,
      `trae ${presentes.join(', ')} sin currency_code. Un importe de origen sin su moneda ` +
        'no es un origen: di en qué moneda está la línea.',
      { presentes }
    );
  }

  if (!/^[A-Z]{3}$/.test(currency_code)) {
    throw falta(
      numeroDeLinea,
      `currency_code "${currency_code}" no es un código ISO 4217 de tres letras mayúsculas (p. ej. USD, EUR).`
    );
  }

  // La moneda funcional no lleva columnas FX: un «origen» en la propia moneda
  // con tipo distinto de 1 sería una puerta para desfigurar importes, y con
  // tipo 1 sería ruido. NIF B-15 habla de operaciones EN MONEDA EXTRANJERA.
  if (currency_code === monedaFuncional) {
    throw falta(
      numeroDeLinea,
      `currency_code ${currency_code} ES la moneda funcional de la entidad: una línea en la ` +
        'moneda funcional no lleva columnas de origen. Quita currency_code, foreign_debit/' +
        'foreign_credit y exchange_rate, o usa la moneda extranjera real de la operación.'
    );
  }

  // REGLA DURA: moneda extranjera declarada exige el origen completo.
  const faltantes = [
    exchange_rate == null ? 'exchange_rate' : null,
    foreign_debit == null && foreign_credit == null ? 'foreign_debit o foreign_credit' : null,
  ].filter((c): c is string => c !== null);
  if (faltantes.length > 0) {
    throw falta(
      numeroDeLinea,
      `declara moneda ${currency_code} pero no trae ${faltantes.join(' ni ')}. ` +
        'Sin el importe de origen y su tipo de cambio la línea perdería su origen al nacer, ' +
        'que es exactamente lo que NIF B-15 prohíbe: da los cuatro campos juntos.',
      { faltantes }
    );
  }

  // El lado extranjero espeja al funcional: cargo con cargo, abono con abono.
  if (linea.debit_amount != null && foreign_debit == null) {
    throw falta(
      numeroDeLinea,
      'es un CARGO (debit_amount) pero su origen viene como foreign_credit: el importe de ' +
        'origen va del mismo lado que el funcional (foreign_debit).'
    );
  }
  if (linea.credit_amount != null && foreign_credit == null) {
    throw falta(
      numeroDeLinea,
      'es un ABONO (credit_amount) pero su origen viene como foreign_debit: el importe de ' +
        'origen va del mismo lado que el funcional (foreign_credit).'
    );
  }
  if (foreign_debit != null && foreign_credit != null) {
    throw falta(
      numeroDeLinea,
      'trae foreign_debit Y foreign_credit a la vez: una línea tiene un solo lado, también en su origen.'
    );
  }

  const importeExtranjero = (foreign_debit ?? foreign_credit) as string;
  const importeFuncional = linea.debit_amount ?? linea.credit_amount;

  if (!esDecimalValido(importeExtranjero) || new Decimal(importeExtranjero).lte(0)) {
    throw falta(numeroDeLinea, `el importe de origen "${importeExtranjero}" no es un número positivo.`);
  }
  if (decimalesDe(importeExtranjero) > DECIMALES_IMPORTE) {
    throw falta(
      numeroDeLinea,
      `el importe de origen "${importeExtranjero}" trae más de ${DECIMALES_IMPORTE} decimales: ` +
        'la columna es DECIMAL(19,4) y Postgres lo redondearía en silencio al guardar.'
    );
  }
  if (exchange_rate == null || !esDecimalValido(exchange_rate) || new Decimal(exchange_rate).lte(0)) {
    throw falta(numeroDeLinea, `el tipo de cambio "${String(exchange_rate)}" no es un número positivo.`);
  }
  if (decimalesDe(exchange_rate) > DECIMALES_TASA) {
    throw falta(
      numeroDeLinea,
      `el tipo de cambio "${exchange_rate}" trae más de ${DECIMALES_TASA} decimales: la columna ` +
        'es DECIMAL(19,10) y Postgres lo redondearía en silencio, con lo que el importe ya ' +
        'verificado dejaría de salir de la tasa guardada.'
    );
  }
  if (importeFuncional == null || !esDecimalValido(importeFuncional)) {
    // La regla de cargo-xor-abono la exige el CHECK de la 001 y la valida el
    // motor; aquí sólo se necesita que el lado funcional exista para comparar.
    throw falta(numeroDeLinea, 'no trae importe funcional (debit_amount/credit_amount) que verificar.');
  }

  // THE CHECK: the functional amount must BE foreign × rate, half-up at the
  // minor unit of the functional currency (MNE-001-862): exact, no tolerance.
  // The 0.01 tolerance of validation.ts forgives old readings; a NEW line has
  // no excuse not to foot.
  const esperado = convertirImporte(importeExtranjero, exchange_rate, monedaFuncional);
  const asPostedBefore = (): string =>
    new D(importeExtranjero).times(new D(exchange_rate)).toFixed(DECIMALES_IMPORTE, Decimal.ROUND_HALF_UP);
  if (
    !new Decimal(importeFuncional).equals(new Decimal(esperado)) &&
    !(mirror && new Decimal(importeFuncional).equals(asPostedBefore()))
  ) {
    throw new AccountingError(
      'FX_CONVERSION_NO_CASA',
      `Línea ${numeroDeLinea}: la conversión no casa. ${importeExtranjero} ${currency_code} × ` +
        `${exchange_rate} = ${esperado} (redondeo half-up a ${minorUnitDecimals(monedaFuncional)} decimales, ` +
        `la unidad mínima de ${monedaFuncional}), pero la línea dice ` +
        `${new Decimal(importeFuncional).toFixed(DECIMALES_IMPORTE)}. El importe funcional se ` +
        'calcula del origen, no se afirma.',
      {
        importe_origen: importeExtranjero,
        tipo_de_cambio: exchange_rate,
        esperado,
        recibido: importeFuncional,
      }
    );
  }
}
