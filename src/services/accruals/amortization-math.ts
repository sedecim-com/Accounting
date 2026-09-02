import Decimal from 'decimal.js';
import {
  diasDelMes,
  indiceDeCalendario,
  primerDiaDelMes,
  ultimoDiaDelMes,
} from '../assets/depreciation-math.js';

// ============================================================
// LA ARITMÉTICA DEL DEVENGO, SIN POSTGRES (D1a)
//
// Este archivo existe por lo mismo que `depreciation-math.ts` en F06a y
// `reconciliation-math.ts` en F05c: una comprobación que sólo se puede
// ejercitar con la base detrás es la que acaba mintiendo, porque el escenario
// cuesta tanto de sembrar que nadie escribe el caso incómodo. Aquí el caso
// incómodo —«los doce renglones de una póliza anual tienen que sumar la
// póliza EXACTA, sin un centavo de deriva»— es una llamada de tres líneas.
//
// Y el caso incómodo se escribe ANTES de la primera fila, no después: el día
// que existan calendarios posteados calculados con una aritmética torcida,
// repararla deja de ser una edición y pasa a ser una migración de importes ya
// en el mayor, que es inmutable (041).
//
// ── POR QUÉ EL CALENDARIO SE ARMA Y NO SE GUARDA ─────────────────────────
//
// Este módulo produce el calendario ENTERO en memoria a partir de tres datos
// —inicio, fin e importe— y la corrida sólo postea el renglón del periodo que
// le toca. No se persisten renglones teóricos, y no por ahorro: para guardar
// los doce renglones de una póliza anual habría que resolver hoy la fecha de
// cada mes a un `fiscal_period_id` que todavía no existe, con los cinco
// resolutores fecha→periodo del repositorio discrepando entre sí. Un
// calendario guardado que apunta a periodos inventados es peor que ninguno.
//
// ── LO QUE ESTE MÓDULO NO DECIDE ─────────────────────────────────────────
//
// No lee el panel de políticas. Recibe la convención ya resuelta y devuelve
// el calendario; qué convención rige, desde qué importe se difiere y si el
// cierre bloquea son decisiones del despacho que se leen en el servicio. Un
// módulo puro que consultara el panel dejaría de ser puro por la puerta de
// atrás — es la misma frontera que traza `depreciation-math.ts`.
//
// ── POR QUÉ IMPORTA EL CALENDARIO DE LA DEPRECIACIÓN ─────────────────────
//
// `primerDiaDelMes`, `ultimoDiaDelMes`, `diasDelMes` e `indiceDeCalendario`
// se importan de `depreciation-math.ts` en vez de copiarse. No es pereza: el
// defecto A de F06a fue exactamente un índice de calendario que derivaba
// (dividía milisegundos entre 30,44 días), y dos copias de la misma cuenta
// son dos sitios donde ese defecto puede volver a aparecer por separado. El
// sistema tiene UN calendario. La aritmética del DINERO sí es distinta y vive
// aquí entera.
// ============================================================

/** Los decimales que guarda `DECIMAL(19,4)`. No se recorta a dos. */
const DECIMALES = 4;

/**
 * Las dos convenciones de la política `amortizacion_anticipados_convencion`.
 *
 * El vocabulario se copia del panel a propósito: una lista local que se
 * separara de él haría pasar por válido un valor que el catálogo no ofrece.
 * Ojo con el parecido: la política hermana de la depreciación dice
 * `mes_completo` en singular y ésta `meses_completos` en plural. No se
 * unifican desde aquí porque el panel es de otro frente; se comprueba.
 */
export const CONVENCIONES_AMORTIZACION = ['proporcional_dias', 'meses_completos'] as const;
export type ConvencionAmortizacion = (typeof CONVENCIONES_AMORTIZACION)[number];

export function esConvencionDeAmortizacion(valor: string): valor is ConvencionAmortizacion {
  return (CONVENCIONES_AMORTIZACION as readonly string[]).includes(valor);
}

export interface AmortizationInput {
  /**
   * DINERO COMO STRING, con decimal.js detrás. Nunca `number`: la columna
   * guarda cuatro decimales y `parseFloat` tira exactamente lo que la columna
   * guarda para no perderlo.
   */
  importe: string;
  /** Primer día CUBIERTO por el anticipo, a medianoche local. Inclusive. */
  inicio: Date;
  /** Último día CUBIERTO por el anticipo, a medianoche local. Inclusive. */
  fin: Date;
  /** Por omisión, por días: es lo que dice el postulado de devengo (NIF A-2). */
  convencion?: ConvencionAmortizacion;
}

export interface AmortizationResult {
  period_number: number;
  /**
   * Meses de CALENDARIO desde el mes en que arranca la cobertura. Es la misma
   * cuenta que hace `indiceDeCalendario` con el periodo que se corre, y por
   * eso `calendario[i].indice_calendario === i`.
   */
  indice_calendario: number;
  /** Primer y último día del MES al que pertenece el renglón. */
  period_start_date: Date;
  period_end_date: Date;
  /** Tramo de la cobertura imputado a ese mes (ver `ventanasMensuales`). */
  coverage_start_date: Date;
  coverage_end_date: Date;
  days_covered: number;
  amortization_amount: string;
  accumulated_amortization: string;
  /** Lo que queda por devengar DESPUÉS de este renglón. */
  remaining_balance: string;
}

// ---- Los días, contados sin husos horarios ------------------------------

/**
 * El día absoluto de una fecha, tomando sus componentes LOCALES.
 *
 * Restar dos `Date` y dividir entre 86.400.000 se equivoca en los dos meses
 * del año en que cambia el horario de verano: el día del cambio dura 23 o 25
 * horas, y la división trunca hacia abajo. México suprimió el horario de
 * verano en 2022, pero este sistema también contabiliza en otros husos, y una
 * póliza que cruza un cambio de hora no puede perder un día de cobertura por
 * eso. Pasando por `Date.UTC` con los componentes locales, la resta es exacta
 * por construcción.
 */
function diaAbsoluto(fecha: Date): number {
  return Math.floor(Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()) / 86_400_000);
}

/** Días que cubre una ventana con AMBOS extremos incluidos. Del 20 al 31 son doce. */
export function diasDeCobertura(inicio: Date, fin: Date): number {
  return diaAbsoluto(fin) - diaAbsoluto(inicio) + 1;
}

/**
 * 'YYYY-MM-DD' por COMPONENTES LOCALES, no por `toISOString`.
 *
 * `toISOString` imprime el día UTC: en un huso al este de Greenwich, la
 * medianoche local del día 20 es el día 19 a las 22:00 UTC, y la fecha
 * guardada en los metadatos sería la víspera. Es la misma trampa que
 * `medianocheLocal` cierra en el otro extremo (depreciation.ts:77-88).
 */
function fechaISO(fecha: Date): string {
  const mes = String(fecha.getMonth() + 1).padStart(2, '0');
  const dia = String(fecha.getDate()).padStart(2, '0');
  return `${fecha.getFullYear()}-${mes}-${dia}`;
}

// ---- El reparto de la ventana en meses ----------------------------------

export interface VentanaMensual {
  indice: number;
  mes_inicio: Date;
  mes_fin: Date;
  cobertura_inicio: Date;
  cobertura_fin: Date;
  dias: number;
}

/**
 * La ventana de cobertura, partida por meses de calendario.
 *
 * LAS DOS CONVENCIONES SON DOS RECORTES DISTINTOS DE LA MISMA VENTANA, y por
 * eso el reparto se hace aquí y no en el cálculo del importe:
 *
 *   · `proporcional_dias` recorta la ventana REAL. Una póliza del 20 de marzo
 *     al 19 de marzo del año siguiente da TRECE renglones: doce días de marzo
 *     del primer año, once meses enteros, y diecinueve días de marzo del
 *     segundo. Es lo que dice el postulado de devengo — el gasto pertenece al
 *     periodo que consumió el servicio.
 *
 *   · `meses_completos` trata la cobertura COMO SI corriera desde el día 1 del
 *     mes de arranque durante N meses enteros: el mes inicial devenga entero y
 *     el mes final parcial no devenga nada. La misma póliza da DOCE renglones,
 *     de marzo a febrero, cada uno por su mes completo. Se representa así
 *     —cada renglón cubre su mes entero— y no arrastrando días sueltos al
 *     último renglón, porque un renglón que dijera cubrir del 1 de febrero al
 *     19 de marzo estaría mintiendo sobre su propio mes.
 *
 * El único caso en que no se puede quitar la cola parcial es cuando ES el
 * único renglón: un anticipo del 15 al 20 de enero devenga en enero o no
 * devenga nunca.
 */
export function ventanasMensuales(
  inicio: Date,
  fin: Date,
  convencion: ConvencionAmortizacion
): VentanaMensual[] {
  const base = primerDiaDelMes(inicio);
  const meses = indiceDeCalendario(base, primerDiaDelMes(fin));

  const ventanas: VentanaMensual[] = [];
  for (let i = 0; i <= meses; i++) {
    const mesInicio = new Date(base.getFullYear(), base.getMonth() + i, 1);
    const mesFin = ultimoDiaDelMes(mesInicio);
    const coberturaInicio = i === 0 ? inicio : mesInicio;
    const coberturaFin = fin.getTime() < mesFin.getTime() ? fin : mesFin;
    ventanas.push({
      indice: i,
      mes_inicio: mesInicio,
      mes_fin: mesFin,
      cobertura_inicio: coberturaInicio,
      cobertura_fin: coberturaFin,
      dias: diasDeCobertura(coberturaInicio, coberturaFin),
    });
  }

  if (convencion === 'proporcional_dias') return ventanas;

  // Meses completos: se descarta la cola parcial —salvo que sea lo único que
  // hay— y cada renglón pasa a cubrir su mes entero.
  const ultima = ventanas[ventanas.length - 1];
  if (ventanas.length > 1 && ultima.cobertura_fin.getTime() < ultima.mes_fin.getTime()) {
    ventanas.pop();
  }
  return ventanas.map((v) => ({
    ...v,
    cobertura_inicio: v.mes_inicio,
    cobertura_fin: v.mes_fin,
    dias: diasDelMes(v.mes_inicio),
  }));
}

// ---- Del importe al renglón --------------------------------------------

/**
 * EL CALENDARIO DE AMORTIZACIÓN: un renglón por mes, y la suma EXACTA.
 *
 * EL TAPÓN DEL ÚLTIMO RENGLÓN es lo que hace que Σ renglones == importe sin
 * un centavo de deriva, y no es un adorno: es el defecto C que F06a tuvo que
 * reparar sobre la depreciación, donde 100.000 a 36 meses posteaba
 * 2.777,7778 treinta y seis veces —100.000,0008 en el mayor, ocho
 * diezmilésimas que no eran de nadie—. Aquí el acumulado es la suma de lo que
 * REALMENTE se postea y el último renglón es la RESTA contra el importe, no
 * una división más. Con 1.000 a tres meses eso da 333,3333 · 333,3333 ·
 * 333,3334, y la diezmilésima cae donde tiene que caer: en el último mes, una
 * sola vez.
 *
 * Y el tapón va en el ÚLTIMO renglón y no repartido: repartir el resto entre
 * todos vuelve a producir un resto, y además haría que el importe de un mes
 * dependiera de cuántos meses tenga el anticipo entero, que es justo lo que
 * un auditor no puede reconstruir mirando el renglón.
 */
export function calcularAmortizacion(input: AmortizationInput): AmortizationResult[] {
  const convencion = input.convencion ?? 'proporcional_dias';
  if (!esConvencionDeAmortizacion(convencion)) {
    throw new Error(
      `Convención de amortización desconocida: "${String(convencion)}". Las declaradas son ` +
        `${CONVENCIONES_AMORTIZACION.join(', ')}.`
    );
  }

  const importe = new Decimal(input.importe);
  if (!importe.isFinite() || importe.lessThanOrEqualTo(0)) {
    throw new Error(
      `Un pago anticipado tiene que tener importe positivo (llegó "${input.importe}"). Una ` +
        'devolución o una nota de crédito se registra por reversa contra el asiento que la ' +
        'causó, no como un anticipo con signo.'
    );
  }
  if (input.fin.getTime() < input.inicio.getTime()) {
    throw new Error(
      'La cobertura de un pago anticipado no puede terminar antes de empezar: ' +
        `${fechaISO(input.inicio)} → ${fechaISO(input.fin)}.`
    );
  }

  const ventanas = ventanasMensuales(input.inicio, input.fin, convencion);
  const diasTotales = ventanas.reduce((suma, v) => suma + v.dias, 0);
  const n = ventanas.length;

  const filas: AmortizationResult[] = [];
  let acumulado = new Decimal(0);

  for (let i = 0; i < n; i++) {
    const v = ventanas[i];
    const restante = importe.minus(acumulado);

    let monto: Decimal;
    if (i === n - 1) {
      // EL TAPÓN. No se vuelve a dividir: lo que queda es lo que queda.
      monto = restante;
    } else if (convencion === 'proporcional_dias') {
      monto = importe.times(v.dias).dividedBy(diasTotales).toDecimalPlaces(DECIMALES);
    } else {
      monto = importe.dividedBy(n).toDecimalPlaces(DECIMALES);
    }

    // Dos topes que sólo muerden en lo absurdo —un anticipo de 0,0005 pesos
    // repartido en doce meses— y que están porque el CHECK de la tabla exige
    // importe positivo y saldo no negativo: sin ellos, ese caso reventaría en
    // Postgres con un mensaje que no dice nada del motivo.
    if (monto.greaterThan(restante)) monto = restante;
    if (monto.isNegative()) monto = new Decimal(0);

    acumulado = acumulado.plus(monto);
    filas.push({
      period_number: i + 1,
      indice_calendario: v.indice,
      period_start_date: v.mes_inicio,
      period_end_date: v.mes_fin,
      coverage_start_date: v.cobertura_inicio,
      coverage_end_date: v.cobertura_fin,
      days_covered: v.dias,
      amortization_amount: monto.toFixed(DECIMALES),
      accumulated_amortization: acumulado.toFixed(DECIMALES),
      remaining_balance: importe.minus(acumulado).toFixed(DECIMALES),
    });
  }

  return filas;
}

/** Un importe de la corrida que no mueve nada. Con Decimal, no con `=== 0`. */
export function esImporteCero(monto: string): boolean {
  return new Decimal(monto).isZero();
}

/**
 * Lo que queda escrito de cada renglón.
 *
 * El importe solo no permite reconstruir por qué es ése: el mismo anticipo da
 * números distintos según la convención, y la convención se decide fuera del
 * renglón. Se guarda para que la corrida del mes que viene pueda comprobar
 * que sigue el mismo criterio, y para que quien audite vea si el criterio
 * venía del despacho o del defecto declarado.
 *
 * `convencion_del_panel` es la que dice la política HOY, que puede no ser la
 * congelada en el anticipo: cambiar el panel no recorta calendarios vivos
 * —el mayor es inmutable—, así que la divergencia se anota en vez de
 * aplicarse a la fuerza.
 */
export function metadatosDeAmortizacion(a: {
  convencion: ConvencionAmortizacion;
  convencionDelPanel: ConvencionAmortizacion;
  convencionDefinida: boolean;
  indice: number;
  periodos: number;
  diasCubiertos: number;
  importeTotal: string;
  cobertura: { inicio: Date; fin: Date };
  topadoPorSaldo?: string;
}): Record<string, unknown> {
  return {
    convencion: a.convencion,
    indice_calendario: a.indice,
    periodos_totales: a.periodos,
    dias_cubiertos: a.diasCubiertos,
    importe_total: a.importeTotal,
    cobertura_inicio: fechaISO(a.cobertura.inicio),
    cobertura_fin: fechaISO(a.cobertura.fin),
    // Sólo aparece cuando el renglón teórico pedía más de lo que queda
    // posteado en la 1160. Es una anomalía, y se deja escrita en la fila.
    ...(a.topadoPorSaldo ? { topado_por_saldo_restante: a.topadoPorSaldo } : {}),
    politicas: {
      amortizacion_anticipados_convencion: {
        valor_congelado: a.convencion,
        valor_del_panel: a.convencionDelPanel,
        definida: a.convencionDefinida,
        coincide: a.convencion === a.convencionDelPanel,
      },
    },
  };
}
