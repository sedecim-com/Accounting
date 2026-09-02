import Decimal from 'decimal.js';

// ============================================================
// LA ARITMÉTICA DEL FINIQUITO, SIN POSTGRES (D1a)
//
// Este archivo existe por lo mismo que `depreciation-math.ts` en F06a y
// `reconciliation-math.ts` en F05c: la cuenta estaba ENCERRADA dentro de
// `calculateFiniquito`, que abre una conexión antes de sumar nada. Para
// ejercitar un tramo de la tabla del art. 76 había que sembrar un empleado;
// por eso la tabla llevaba años pagando de menos sin que ninguna prueba lo
// dijera. Aquí un tramo es una llamada de una línea.
//
// Y no era teórico. Las TRES REPARACIONES que trae este módulo son dinero que
// hoy se paga mal a personas, cada una junto al código que la aplica:
//
//   1 · `diasDeVacacionesPorAnio` — la tabla del art. 76 crecía «+2 cada cinco
//       años» contando los quinquenios desde el año 9 en vez del 5, así que a
//       partir del año 11 pagaba DOS DÍAS DE MENOS en cuatro de cada cinco
//       años de antigüedad.
//   2 · el aguinaldo de `calcularFiniquito` — el proporcional se prorrateaba
//       desde el 1 de enero SIN MIRAR LA FECHA DE ALTA: quien entró a mitad de
//       año cobraba el año entero (art. 87).
//   3 · `salarioDiarioDesdeSbc` — la cuota diaria salía del SBC, que ya lleva
//       DENTRO el aguinaldo y la prima vacacional, así que el aguinaldo se
//       calculaba sobre una base inflada. Para prestaciones rige el salario
//       diario; el integrado es para las cuotas del IMSS.
//
// Y todo en `Decimal` con cadenas de cuatro decimales. Lo anterior era `float`
// con `Math.round(x * 100) / 100`: un finiquito calculado en coma flotante es
// un pago mal hecho a una persona, no un detalle de estilo.
//
// LO QUE ESTE MÓDULO NO DECIDE. No lee el panel de políticas. Recibe los días
// de aguinaldo y el porcentaje de prima ya resueltos y devuelve el desglose;
// de dónde salen es cosa del servicio. Un módulo puro que consultara el panel
// dejaría de ser puro por la puerta de atrás.
// ============================================================

/** Los decimales del dinero en este sistema. No se recorta a dos. */
const DECIMALES = 4;

/**
 * El divisor del factor de integración y de los prorrateos anuales que la ley
 * fija en días naturales. 365 aquí es la constante de la LSS art. 27, no una
 * aproximación del calendario: el año bisiesto se cuenta aparte, en
 * `diasDelEjercicio`.
 */
const DIAS_DEL_ANIO_LEGAL = 365;

// ============================================================
// LFT art. 76 — la tabla de vacaciones («vacaciones dignas», 2023)
// ============================================================

/**
 * Días de vacaciones que corresponden al AÑO DE SERVICIO en curso.
 *
 * El parámetro es el año de antigüedad en base 1: `1` es el primer año de la
 * relación, `13` es el decimotercero. No son «años cumplidos» — quien cumplió
 * 12 años está en su año 13.
 *
 * Texto del art. 76 reformado: doce días el primer año y dos más por cada año
 * siguiente hasta veinte al quinto; «después del quinto año, el periodo de
 * vacaciones aumentará en dos días por cada cinco de servicios».
 *
 *   año 1 → 12 · 2 → 14 · 3 → 16 · 4 → 18 · 5 → 20
 *   6-10 → 22 · 11-15 → 24 · 16-20 → 26 · 21-25 → 28 · 26-30 → 30
 *
 * POR QUÉ ESTABA MAL. La versión anterior devolvía `22` para todo el rango
 * 6-9 y luego `22 + Math.floor((años - 9) / 5) * 2` contando desde el año 9.
 * Ese corrimiento de cuatro años hace que el escalón llegue tarde: en el año
 * 11 —donde la tabla ya dice 24— seguía devolviendo 22, y sólo acertaba uno de
 * cada cinco años (el 14, el 19, el 24…). Dos días de vacaciones de menos son
 * dos días de prima vacacional de menos en cada finiquito desde el año 11.
 *
 * SIN TOPE A PROPÓSITO. La tabla que publica la STPS termina en 26-30 años,
 * y por eso las pruebas recorren 1..30. Pero el artículo no cierra la
 * progresión: «dos días por cada cinco de servicios» sigue corriendo, así que
 * el año 31 son 32 días. Recortar en 30 volvería a pagar de menos, que es
 * justo el defecto que este módulo repara.
 */
export function diasDeVacacionesPorAnio(anioDeServicio: number): number {
  const anio = Math.max(1, Math.floor(anioDeServicio));
  // Primer quinquenio: 12 el primer año, +2 por cada año, hasta 20 al quinto.
  if (anio <= 5) return 10 + anio * 2;
  // Del sexto en adelante el incremento es por QUINQUENIO, no por año:
  // ceil((año - 5) / 5) da 1 para 6-10, 2 para 11-15, 3 para 16-20…
  const quinquenios = Math.ceil((anio - 5) / 5);
  return 20 + quinquenios * 2;
}

// ============================================================
// Fechas — todo en UTC y a día entero
// ============================================================

/**
 * Normaliza a medianoche UTC.
 *
 * Acepta las dos formas en las que una fecha llega hasta aquí: la cadena
 * `YYYY-MM-DD` del cuerpo de la petición y el `Date` que el driver de Postgres
 * construye para una columna `DATE` —a medianoche LOCAL, no UTC—. Leer el
 * segundo con `getUTC*` corre la fecha un día en cualquier huso al oeste de
 * Greenwich, que es exactamente donde está México.
 */
export function aFechaUtc(valor: string | Date): Date {
  if (valor instanceof Date) {
    return new Date(Date.UTC(valor.getFullYear(), valor.getMonth(), valor.getDate()));
  }
  const [anio, mes, dia] = valor.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(anio, (mes ?? 1) - 1, dia ?? 1));
}

const MS_POR_DIA = 86_400_000;

/** Días enteros de `a` a `b`, sin contar el día de inicio. Puede ser negativo. */
function diasEntre(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_POR_DIA);
}

/** Días trabajados de `a` a `b` contando AMBOS extremos. Nunca negativo. */
function diasInclusive(a: Date, b: Date): number {
  return Math.max(0, diasEntre(a, b) + 1);
}

function esBisiesto(anio: number): boolean {
  return (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0;
}

/**
 * Días naturales del ejercicio: 366 si es bisiesto.
 *
 * Prorratear siempre entre 365 le daría a quien trabajó un año bisiesto
 * completo 366/365 = 15.04 días de aguinaldo, más que el año entero. El
 * divisor tiene que ser el mismo año que se está midiendo.
 */
export function diasDelEjercicio(anio: number): number {
  return esBisiesto(anio) ? 366 : DIAS_DEL_ANIO_LEGAL;
}

/**
 * Años de servicio CUMPLIDOS, contados por aniversario de calendario.
 *
 * No por `Math.floor(días / 365)`: esa división mete el día bisiesto en la
 * cuenta y adelanta el aniversario de quien lleva suficientes años, justo en
 * el tramo donde la tabla del art. 76 cambia de escalón.
 */
export function aniosDeServicioCumplidos(alta: Date, baja: Date): number {
  let anios = baja.getUTCFullYear() - alta.getUTCFullYear();
  const meses = baja.getUTCMonth() - alta.getUTCMonth();
  if (meses < 0 || (meses === 0 && baja.getUTCDate() < alta.getUTCDate())) anios -= 1;
  return Math.max(0, anios);
}

/** El aniversario de alta más reciente en o antes de `baja`. */
function ultimoAniversario(alta: Date, baja: Date): Date {
  const cumplidos = aniosDeServicioCumplidos(alta, baja);
  const aniversario = new Date(
    Date.UTC(alta.getUTCFullYear() + cumplidos, alta.getUTCMonth(), alta.getUTCDate())
  );
  // Un alta del 29 de febrero desborda al 1 de marzo en los años no bisiestos.
  // Es la convención habitual y se deja explícita en vez de escondida.
  return aniversario > baja ? alta : aniversario;
}

// ============================================================
// Factor de integración — y cómo deshacerlo
// ============================================================

export interface PrestacionesAnuales {
  /** Días de aguinaldo por año (política `dias_aguinaldo`, mínimo legal 15). */
  dias_aguinaldo: number;
  /** Días de vacaciones del año de servicio en curso (art. 76). */
  dias_vacaciones: number;
  /** Prima vacacional como fracción (política `prima_vacacional_pct`, mínimo 0.25). */
  prima_vacacional_pct: string;
}

/**
 * Factor de integración del salario (LSS art. 27):
 *
 *   FI = (365 + días de aguinaldo + días de vacaciones × prima) / 365
 *
 * Es lo que separa el salario diario del salario base de cotización.
 */
export function factorDeIntegracion(p: PrestacionesAnuales): Decimal {
  const prestaciones = new Decimal(p.dias_aguinaldo).plus(
    new Decimal(p.dias_vacaciones).times(new Decimal(p.prima_vacacional_pct))
  );
  return new Decimal(DIAS_DEL_ANIO_LEGAL).plus(prestaciones).dividedBy(DIAS_DEL_ANIO_LEGAL);
}

/**
 * Recupera el salario diario a partir del SBC deshaciendo la integración.
 *
 * POR QUÉ HACE FALTA. El SBC es el salario diario INTEGRADO: ya trae dentro el
 * aguinaldo y la prima vacacional prorrateados, porque para eso existe —es la
 * base de las cuotas obrero-patronales del IMSS—. Tomarlo como cuota diaria
 * para calcular el aguinaldo cobra aguinaldo sobre el aguinaldo, y la prima
 * sobre la prima. Las prestaciones de la LFT se calculan sobre el salario
 * diario; el integrado no tiene nada que hacer aquí.
 *
 * Es una RECONSTRUCCIÓN, no un dato: el SBC está topado en 25 UMA, así que
 * des-integrar un SBC topado subestima al que gana por encima del tope. La
 * fuente fiable sigue siendo el salario contratado, y este camino es el
 * respaldo para cuando no está capturado.
 */
export function salarioDiarioDesdeSbc(sbc: string, p: PrestacionesAnuales): string {
  return new Decimal(sbc).dividedBy(factorDeIntegracion(p)).toFixed(DECIMALES);
}

// ============================================================
// El finiquito
// ============================================================

export interface EntradaFiniquito {
  fecha_alta: string | Date;
  fecha_baja: string | Date;
  /** Último día ya cubierto por una nómina ordinaria. */
  pagado_hasta: string | Date;
  /** Salario diario NO integrado, como cadena. */
  salario_diario: string;
  /** Días de vacaciones de años ya cumplidos que quedaron sin disfrutar. */
  dias_vacaciones_pendientes?: number;
  /** Política `dias_aguinaldo` (LFT art. 87 fija 15 como mínimo). */
  dias_aguinaldo_por_anio: number;
  /** Política `prima_vacacional_pct` (LFT art. 80 fija 0.25 como mínimo). */
  prima_vacacional_pct: string;
}

/** Todo el dinero en cadenas de cuatro decimales. Ni un `number` de importe. */
export interface DesgloseFiniquito {
  antiguedad_anios_cumplidos: number;
  anio_de_servicio_en_curso: number;
  dias_vacaciones_del_anio: number;
  salario_diario: string;
  salario_pendiente_dias: number;
  salario_pendiente_importe: string;
  aguinaldo_dias_trabajados: number;
  aguinaldo_dias: string;
  aguinaldo_importe: string;
  prima_vacacional_dias: string;
  prima_vacacional_importe: string;
  vacaciones_pendientes_importe: string;
  total: string;
}

export function calcularFiniquito(entrada: EntradaFiniquito): DesgloseFiniquito {
  const alta = aFechaUtc(entrada.fecha_alta);
  const baja = aFechaUtc(entrada.fecha_baja);
  const pagadoHasta = aFechaUtc(entrada.pagado_hasta);
  const salarioDiario = new Decimal(entrada.salario_diario);

  const cumplidos = aniosDeServicioCumplidos(alta, baja);
  const anioEnCurso = cumplidos + 1;
  const diasVacacionesDelAnio = diasDeVacacionesPorAnio(anioEnCurso);

  // ── 1 · Salarios devengados y no pagados ──
  // Diferencia EXCLUSIVA: `pagado_hasta` ya se cobró, así que el primer día
  // pendiente es el siguiente.
  const salarioDias = Math.max(0, diasEntre(pagadoHasta, baja));
  const salarioImporte = salarioDiario.times(salarioDias);

  // ── 2 · Aguinaldo proporcional (LFT art. 87) ──
  //
  // «Los que no hayan cumplido el año de servicios [...] tendrán derecho a que
  // se les pague, en proporción al tiempo que hubieren trabajado, cualquiera
  // que fuere éste.» La proporción se mide sobre el EJERCICIO, y el ejercicio
  // de quien entró en julio empieza en julio.
  //
  // POR QUÉ ESTABA MAL. El cálculo anterior arrancaba siempre en el 1 de enero
  // del año de la baja e ignoraba `hire_date` por completo: un alta del 1 de
  // julio con baja el 31 de diciembre cobraba los 15 días enteros en vez de
  // los 7.55 que le tocan. El sistema le regalaba a la empresa nada —le
  // regalaba al trabajador un aguinaldo que no devengó, y con ello desviaba el
  // gasto del ejercicio—; en el caso simétrico, el del alta de años anteriores,
  // el error de un día por contar en exclusiva sí pagaba de menos.
  const inicioEjercicio = new Date(Date.UTC(baja.getUTCFullYear(), 0, 1));
  const inicioDevengo = alta > inicioEjercicio ? alta : inicioEjercicio;
  // Inclusive: quien trabaja del 1 de enero al 31 de diciembre trabajó 365
  // días, no 364. La resta a secas se comía un día en TODOS los finiquitos.
  const aguinaldoDiasTrabajados = baja < alta ? 0 : diasInclusive(inicioDevengo, baja);
  const aguinaldoDias = new Decimal(entrada.dias_aguinaldo_por_anio)
    .times(aguinaldoDiasTrabajados)
    .dividedBy(diasDelEjercicio(baja.getUTCFullYear()));
  const aguinaldoImporte = aguinaldoDias.times(salarioDiario);

  // ── 3 · Prima vacacional proporcional (LFT arts. 79 y 80) ──
  //
  // El art. 80 fija la prima en «no menor de veinticinco por ciento sobre los
  // salarios que les correspondan durante el periodo de vacaciones», y el 79
  // manda pagarla «en proporción al tiempo de servicios prestados» cuando la
  // relación termina antes de cumplir el año.
  //
  // El año que se prorratea es el AÑO DE SERVICIO —de aniversario a
  // aniversario—, no el año calendario: las vacaciones se devengan al cumplir
  // años de servicio, no el 31 de diciembre. El cálculo anterior usaba los días
  // corridos desde el 1 de enero, lo que para un alta de mitad de año paga la
  // fracción equivocada en las dos direcciones según el mes de la baja.
  const aniversario = ultimoAniversario(alta, baja);
  const siguienteAniversario = new Date(
    Date.UTC(aniversario.getUTCFullYear() + 1, aniversario.getUTCMonth(), aniversario.getUTCDate())
  );
  const diasDelAnioDeServicio = Math.max(1, diasEntre(aniversario, siguienteAniversario));
  const primaDiasTrabajados = baja < alta ? 0 : diasInclusive(aniversario, baja);
  const primaDias = new Decimal(diasVacacionesDelAnio)
    .times(primaDiasTrabajados)
    .dividedBy(diasDelAnioDeServicio);
  const primaImporte = primaDias
    .times(salarioDiario)
    .times(new Decimal(entrada.prima_vacacional_pct));

  // ── 4 · Vacaciones de años cumplidos que quedaron sin disfrutar ──
  const vacacionesPendientes = new Decimal(entrada.dias_vacaciones_pendientes ?? 0).times(
    salarioDiario
  );

  // El total suma lo REDONDEADO, no los intermedios: así el importe que se
  // paga es siempre la suma exacta de los conceptos que el recibo enumera.
  const conceptos = [salarioImporte, aguinaldoImporte, primaImporte, vacacionesPendientes].map(
    (d) => new Decimal(d.toFixed(DECIMALES))
  );
  const total = conceptos.reduce((suma, c) => suma.plus(c), new Decimal(0));

  return {
    antiguedad_anios_cumplidos: cumplidos,
    anio_de_servicio_en_curso: anioEnCurso,
    dias_vacaciones_del_anio: diasVacacionesDelAnio,
    salario_diario: salarioDiario.toFixed(DECIMALES),
    salario_pendiente_dias: salarioDias,
    salario_pendiente_importe: salarioImporte.toFixed(DECIMALES),
    aguinaldo_dias_trabajados: aguinaldoDiasTrabajados,
    aguinaldo_dias: aguinaldoDias.toFixed(DECIMALES),
    aguinaldo_importe: aguinaldoImporte.toFixed(DECIMALES),
    prima_vacacional_dias: primaDias.toFixed(DECIMALES),
    prima_vacacional_importe: primaImporte.toFixed(DECIMALES),
    vacaciones_pendientes_importe: vacacionesPendientes.toFixed(DECIMALES),
    total: total.toFixed(DECIMALES),
  };
}
