import Decimal from 'decimal.js';
import {
  aFechaUtc,
  aniosDeServicioCumplidos,
  diasDeVacacionesPorAnio,
  diasDelEjercicio,
  diasInclusive,
  factorDeIntegracion,
  salarioDiarioDesdeSbc,
  type PrestacionesAnuales,
} from '../payroll/mx/finiquito-math.js';

// ============================================================
// LA ARITMÉTICA DE LAS PROVISIONES DE PRESTACIONES (D1 · NIF D-3)
//
// UN DESPACHO QUE PAGA EL AGUINALDO EN DICIEMBRE Y NO LO PROVISIONA publica
// once meses de utilidad inflada y un diciembre catastrófico, y ninguno de los
// doce estados es firmable. La NIF D-3 reconoce el beneficio directo a corto
// plazo CONFORME EL TRABAJADOR PRESTA EL SERVICIO, no cuando se paga: el
// pasivo nace el día trabajado. Este módulo es esa cuenta, y nada más.
//
// POR QUÉ VIVE APARTE DEL MOTOR, como `amortization-math.ts` vive aparte de
// `amortization-run.ts`: la aritmética del devengo se puede equivocar de mil
// maneras —el escalón del art. 76 aplicado al mes entero, el denominador de
// 365 en un año bisiesto, el día de la baja cobrado de más— y NINGUNA de esas
// mil se ve en una prueba de integración, donde el escenario cuesta tanto de
// sembrar que nadie escribe el caso incómodo. Aquí un caso incómodo es una
// llamada de cuatro líneas. Y se escribe ANTES de la primera póliza, porque el
// mayor es inmutable (041): reparar una aritmética que ya posteó deja de ser
// una edición y pasa a ser una migración de importes firmados.
//
// ── LO QUE NO SE REESCRIBE ──────────────────────────────────────────────
//
// La tabla del art. 76, los años de servicio cumplidos, los días del ejercicio
// y el factor de integración SE IMPORTAN de `finiquito-math.ts`. No es
// comodidad: DOS TABLAS DE LA MISMA LEY DIVERGEN. La del art. 76 ya pagó dos
// días de menos a partir del año 11 mientras vivió copiada dentro de un
// servicio, y una segunda copia aquí volvería a abrir esa puerta —además de la
// puerta peor: que el finiquito y la provisión del mismo trabajador usen
// escalones distintos, y que la diferencia sólo aparezca el día de la baja,
// cuando ya no se puede corregir sin tocar el mayor—.
//
// ── LO QUE ESTE MÓDULO NO DECIDE ────────────────────────────────────────
//
// No lee el panel de políticas, no toca Postgres y no consulta el reloj. La
// base salarial y la convención de vacaciones ENTRAN POR PARÁMETRO ya
// resueltas; de dónde salen —`provision_base_salarial`, `devengo_vacaciones`,
// `dias_aguinaldo`, `prima_vacacional_pct`— es cosa del servicio, que además
// tiene que ANOTAR con qué valores calculó. Un módulo puro que consultara el
// panel dejaría de ser puro por la puerta de atrás.
//
// LA PTU NO ESTÁ AQUÍ, Y SU AUSENCIA ES DELIBERADA. La cuenta 2205 está
// sembrada y la política `provision_ptu_mensual` existe, pero la PTU es el
// 10 % de la RENTA GRAVABLE DE LA ENTIDAD (LFT art. 120), no una proporción
// del salario de una persona: no se reparte por trabajador ni se devenga por
// días. Meterla en esta función obligaría a inventar un prorrateo que la ley
// no manda. Cuando el panel la encienda, su base es una estimación de la
// utilidad fiscal y su cálculo es otro módulo.
// ============================================================

/** Los decimales que guarda `DECIMAL(19,4)`. El dinero es cadena, nunca `number`. */
const DECIMALES = 4;

/**
 * Restar 24 horas a una fecha NORMALIZADA A MEDIANOCHE UTC cae siempre en la
 * medianoche UTC anterior: en UTC no hay horario de verano, así que ningún día
 * dura 23 ni 25 horas. Es el motivo por el que todo aquí dentro pasa primero
 * por `aFechaUtc` — la misma frontera que traza `finiquito-math.ts`.
 */
const MS_POR_DIA = 86_400_000;

// ============================================================
// El vocabulario del panel, copiado a propósito
// ============================================================

/**
 * Los valores de la política `provision_base_salarial`.
 *
 * Se declaran aquí para que un valor que el catálogo no ofrece no llegue a
 * calcular nada, y no se importan del panel porque este módulo no depende del
 * panel. Si el panel cambia de vocabulario, esta lista tiene que cambiar con
 * él y la prueba que las compara es la que lo dirá.
 */
export const BASES_SALARIALES = ['nominal', 'integrado'] as const;
export type BaseSalarial = (typeof BASES_SALARIALES)[number];

export function esBaseSalarial(valor: string): valor is BaseSalarial {
  return (BASES_SALARIALES as readonly string[]).includes(valor);
}

/** Los valores de la política `devengo_vacaciones`. */
export const CONVENCIONES_VACACIONES = ['proporcional', 'aniversario'] as const;
export type ConvencionVacaciones = (typeof CONVENCIONES_VACACIONES)[number];

export function esConvencionDeVacaciones(valor: string): valor is ConvencionVacaciones {
  return (CONVENCIONES_VACACIONES as readonly string[]).includes(valor);
}

// ============================================================
// Fechas: días de calendario, sin ambigüedad de huso
// ============================================================

function fechaISO(f: Date): string {
  const mes = String(f.getUTCMonth() + 1).padStart(2, '0');
  const dia = String(f.getUTCDate()).padStart(2, '0');
  return `${f.getUTCFullYear()}-${mes}-${dia}`;
}

function menor(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

function mayor(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function diaAnterior(f: Date): Date {
  return new Date(f.getTime() - MS_POR_DIA);
}

/**
 * El mes que se provisiona, EN CADENAS Y NO EN `Date`.
 *
 * Un `Date` no dice qué medianoche es la suya: el driver de Postgres construye
 * las columnas `DATE` a medianoche LOCAL y `Date.UTC` produce medianoche UTC,
 * y leer la una con los captadores de la otra corre la fecha un día entero en
 * cualquier huso al oeste de Greenwich —que es donde está México—. Una cadena
 * `YYYY-MM-DD` no tiene ese problema porque no tiene hora, así que el mes se
 * nombra y no se construye.
 */
export function mesDeCalendario(anio: number, mes: number): { inicio: string; fin: string } {
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) {
    throw new Error(`El mes de una provisión va de 1 a 12; llegó ${String(mes)}.`);
  }
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  const mm = String(mes).padStart(2, '0');
  return {
    inicio: `${anio}-${mm}-01`,
    fin: `${anio}-${mm}-${String(ultimo).padStart(2, '0')}`,
  };
}

/** El aniversario número `n` del alta. `n = 0` es el alta misma. */
function aniversario(alta: Date, n: number): Date {
  // Un alta del 29 de febrero desborda al 1 de marzo en los años no bisiestos.
  // Es la MISMA convención que usa `ultimoAniversario` en el finiquito, y tiene
  // que serlo: si el finiquito y la provisión cambiaran de escalón en días
  // distintos, la diferencia sólo saldría a la luz en la liquidación.
  return new Date(Date.UTC(alta.getUTCFullYear() + n, alta.getUTCMonth(), alta.getUTCDate()));
}

// ============================================================
// El mes, partido por años de servicio
// ============================================================

export interface SegmentoDeServicio {
  /** Medianoche UTC. Primer día devengado del segmento. */
  inicio: Date;
  /** Medianoche UTC. Último día devengado del segmento. */
  fin: Date;
  /** Días con AMBOS extremos dentro. Del 20 al 31 son doce. */
  dias: number;
  /** Año de servicio en base 1: `1` es el primer año de la relación. */
  anio_de_servicio: number;
  /** El escalón del art. 76 que rige EN ESTE SEGMENTO. */
  dias_vacaciones_del_anio: number;
  inicio_del_anio_de_servicio: Date;
  /** Víspera del aniversario: el día en que el año de servicio queda cumplido. */
  fin_del_anio_de_servicio: Date;
  /** 365 o 366, medidos de aniversario a aniversario. */
  dias_del_anio_de_servicio: number;
}

/**
 * EL MES SE PARTE EN EL ANIVERSARIO, y esto es lo que separa un motor que
 * sirve de uno que paga de menos.
 *
 * El trabajador que cumple años de servicio el 10 de marzo cambia de escalón
 * del art. 76 A MITAD DEL MES: del 1 al 9 devenga sobre el escalón viejo y del
 * 10 al 31 sobre el nuevo. Las dos alternativas cómodas están mal en una
 * dirección cada una:
 *
 *   · aplicar el escalón NUEVO a todo el mes regala días que no se prestaron;
 *   · aplicar el VIEJO a todo el mes paga de menos —y se los paga justo al
 *     trabajador con más antigüedad, que es a quien más le pesa, y cada año en
 *     que cambia de quinquenio otra vez—.
 *
 * Partir el mes no es una tercera aproximación: es la cuenta exacta, y por
 * construcción la suma de los dos tramos es el mes completo, porque son la
 * misma ventana sin solapes ni huecos.
 *
 * La ventana ya viene recortada por el alta y por la baja: ni un día antes de
 * que empiece la relación, ni uno después de que termine.
 */
export function tramosDeDevengo(
  alta: Date,
  baja: Date | null,
  ventanaInicio: Date,
  ventanaFin: Date
): SegmentoDeServicio[] {
  const inicio = mayor(alta, ventanaInicio);
  const fin = baja ? menor(baja, ventanaFin) : ventanaFin;
  // Sin intersección no hay devengo: el trabajador aún no entra, o ya salió.
  // No es un error —una corrida mensual recorre a toda la plantilla histórica—,
  // es cero.
  if (fin.getTime() < inicio.getTime()) return [];

  const segmentos: SegmentoDeServicio[] = [];
  let cursor = inicio;
  while (cursor.getTime() <= fin.getTime()) {
    const anio = aniosDeServicioCumplidos(alta, cursor) + 1;
    const inicioAnio = aniversario(alta, anio - 1);
    // La víspera del siguiente aniversario. Por definición de `anio`, `cursor`
    // cae dentro de [inicioAnio, finAnio], así que el corte nunca retrocede y
    // el bucle siempre avanza al menos un día.
    const finAnio = diaAnterior(aniversario(alta, anio));
    const corte = menor(finAnio, fin);
    segmentos.push({
      inicio: cursor,
      fin: corte,
      dias: diasInclusive(cursor, corte),
      anio_de_servicio: anio,
      dias_vacaciones_del_anio: diasDeVacacionesPorAnio(anio),
      inicio_del_anio_de_servicio: inicioAnio,
      fin_del_anio_de_servicio: finAnio,
      dias_del_anio_de_servicio: diasInclusive(inicioAnio, finAnio),
    });
    cursor = new Date(corte.getTime() + MS_POR_DIA);
  }
  return segmentos;
}

// ============================================================
// La entrada y la salida
// ============================================================

export interface EntradaProvisionMensual {
  fecha_alta: string | Date;
  /** Ausente mientras la relación siga viva. */
  fecha_baja?: string | Date | null;
  /**
   * La ventana que se provisiona, con ambos extremos dentro. Normalmente un
   * mes de calendario (`mesDeCalendario`), pero se admite cualquier tramo
   * DENTRO DE UN MISMO EJERCICIO: partir un mes en dos llamadas y sumarlas
   * tiene que dar el mes entero, y ésa es una propiedad que se prueba.
   */
  periodo: { inicio: string | Date; fin: string | Date };
  /** Salario diario NO integrado, como cadena. */
  salario_diario?: string;
  /** Salario base de cotización (el diario INTEGRADO), como cadena. */
  sbc?: string;
  /** Política `dias_aguinaldo` (LFT art. 87 fija 15 como mínimo). */
  dias_aguinaldo_por_anio: number;
  /** Política `prima_vacacional_pct` (LFT art. 80 fija 0.25 como mínimo). */
  prima_vacacional_pct: string;
  /** Política `provision_base_salarial`. Por omisión, la del panel: nominal. */
  base_salarial?: BaseSalarial;
  /** Política `devengo_vacaciones`. Por omisión, la del panel: proporcional. */
  convencion_vacaciones?: ConvencionVacaciones;
}

export interface TramoProvisionado {
  /** `YYYY-MM-DD`, para que la cédula no herede la ambigüedad de un `Date`. */
  inicio: string;
  fin: string;
  dias: number;
  anio_de_servicio: number;
  dias_vacaciones_del_anio: number;
  /** El salario diario con el que se calculó ESTE tramo. */
  base_diaria: string;
  aguinaldo: string;
  vacaciones: string;
  prima_vacacional: string;
}

export interface ProvisionMensual {
  base_salarial: BaseSalarial;
  convencion_vacaciones: ConvencionVacaciones;
  /** Días efectivamente devengados en la ventana, ya recortados por alta/baja. */
  dias_devengados: number;
  /**
   * Los tramos que produjeron los importes. Un auditor reconstruye el mes con
   * esto y sólo con esto: los días, el año de servicio y el escalón del art. 76
   * que rigió en cada uno.
   */
  tramos: TramoProvisionado[];
  aguinaldo: string;
  vacaciones: string;
  prima_vacacional: string;
  total: string;
}

// ============================================================
// Validación: lo que no se calcula
// ============================================================

function importeNoNegativo(valor: string, campo: string): Decimal {
  let d: Decimal;
  try {
    d = new Decimal(valor);
  } catch {
    throw new Error(`${campo} tiene que ser un número en cadena; llegó "${String(valor)}".`);
  }
  if (!d.isFinite()) {
    throw new Error(`${campo} tiene que ser finito; llegó "${String(valor)}".`);
  }
  if (d.isNegative()) {
    // NEGATIVO SE RECHAZA, CERO NO. Un salario negativo no es un dato, es un
    // registro corrupto, y provisionar sobre él ABONARÍA el resultado: el motor
    // cargaría la provisión al revés y publicaría una utilidad que nadie ganó,
    // en silencio y a razón de un renglón por mes. Un salario CERO, en cambio,
    // es aritmética bien definida —cero por lo que sea es cero— y suele ser un
    // permiso sin goce o una ficha a medio capturar: parar la corrida entera de
    // doscientos trabajadores por una ficha en blanco deja al despacho sin
    // cierre, que es peor que un renglón en cero que se ve en la cédula.
    throw new Error(
      `${campo} no puede ser negativo (llegó "${String(valor)}"). Un devengo negativo abona el ` +
        'resultado y publica una utilidad que nadie ganó; una ficha mal capturada se corrige en ' +
        'la ficha, no en la provisión.'
    );
  }
  return d;
}

// ============================================================
// El devengo acumulado, que es como se evita la deriva
// ============================================================

/**
 * LO DEVENGADO DE UN BENEFICIO DESDE EL PRINCIPIO DE SU PERIODO HASTA UN DÍA,
 * redondeado a cuatro decimales.
 *
 * ── POR QUÉ ACUMULADO Y NO MES A MES ────────────────────────────────────
 *
 * El importe de un mes es SIEMPRE la diferencia de dos acumulados redondeados,
 * nunca una división independiente. La razón es que doce divisiones
 * independientes derivan: 15 días de aguinaldo sobre 100 pesos son 1 500 al
 * año, y 1 500 × 31/365 = 127,3973 se redondea doce veces en direcciones que
 * no se compensan; la suma del año no da 1 500,0000 y quedan centésimas de
 * milésima flotando en una cuenta de pasivo que nadie sabe de quién son. Es el
 * mismo defecto que la depreciación tuvo que reparar posteando 2 777,7778
 * treinta y seis veces para acabar en 100 000,0008.
 *
 * Con la diferencia de acumulados la serie TELESCOPIA: la suma de los doce
 * meses es el acumulado del último día menos el del primero, exactamente, y el
 * resto de cada división cae donde tiene que caer —en el mes siguiente, una
 * sola vez— sin que ningún renglón dependa de cuántos meses tenga el año. Un
 * auditor reconstruye cualquier renglón con dos restas y el escalón del tramo.
 *
 * Y la propiedad vale igual si el mes se parte: la suma de los tramos es la
 * diferencia de los extremos, porque los acumulados intermedios se cancelan.
 */
function devengadoHasta(
  base: Decimal,
  diasDelBeneficio: Decimal,
  diasTranscurridos: number,
  diasDelPeriodo: number
): Decimal {
  return base
    .times(diasDelBeneficio)
    .times(diasTranscurridos)
    .dividedBy(diasDelPeriodo)
    .toDecimalPlaces(DECIMALES);
}

// ============================================================
// El cálculo
// ============================================================

export function calcularProvisionMensual(entrada: EntradaProvisionMensual): ProvisionMensual {
  const baseSalarial = entrada.base_salarial ?? 'nominal';
  if (!esBaseSalarial(baseSalarial)) {
    throw new Error(
      `Base salarial desconocida: "${String(baseSalarial)}". Las que declara la política ` +
        `provision_base_salarial son ${BASES_SALARIALES.join(', ')}.`
    );
  }
  const convencion = entrada.convencion_vacaciones ?? 'proporcional';
  if (!esConvencionDeVacaciones(convencion)) {
    throw new Error(
      `Convención de devengo de vacaciones desconocida: "${String(convencion)}". Las que declara ` +
        `la política devengo_vacaciones son ${CONVENCIONES_VACACIONES.join(', ')}.`
    );
  }

  const alta = aFechaUtc(entrada.fecha_alta);
  const baja = entrada.fecha_baja ? aFechaUtc(entrada.fecha_baja) : null;
  if (baja && baja.getTime() < alta.getTime()) {
    throw new Error(
      `La baja (${fechaISO(baja)}) es anterior al alta (${fechaISO(alta)}). Con las fechas ` +
        'invertidas el devengo saldría negativo y abonaría la provisión.'
    );
  }

  const ventanaInicio = aFechaUtc(entrada.periodo.inicio);
  const ventanaFin = aFechaUtc(entrada.periodo.fin);
  if (ventanaFin.getTime() < ventanaInicio.getTime()) {
    throw new Error(
      `El periodo que se provisiona no puede terminar antes de empezar: ${fechaISO(ventanaInicio)}` +
        ` → ${fechaISO(ventanaFin)}.`
    );
  }
  if (ventanaInicio.getUTCFullYear() !== ventanaFin.getUTCFullYear()) {
    // El aguinaldo se prorratea sobre EL EJERCICIO (art. 87) y el ejercicio son
    // 365 días o 366: una ventana que cruza el 31 de diciembre tiene dos
    // denominadores y ninguno de los dos es el correcto para toda ella. Se corre
    // un periodo de cada ejercicio, que además es como está partido el
    // calendario fiscal del sistema.
    throw new Error(
      `El periodo ${fechaISO(ventanaInicio)} → ${fechaISO(ventanaFin)} cruza el fin de ejercicio. ` +
        'El aguinaldo se prorratea sobre el ejercicio (LFT art. 87), que dura 365 días o 366: una ' +
        'ventana a caballo de dos años tendría dos denominadores. Corre un periodo por ejercicio.'
    );
  }

  const primaPct = importeNoNegativo(entrada.prima_vacacional_pct, 'prima_vacacional_pct');
  const diasAguinaldo = importeNoNegativo(
    String(entrada.dias_aguinaldo_por_anio),
    'dias_aguinaldo_por_anio'
  );
  const nominal =
    entrada.salario_diario !== undefined
      ? importeNoNegativo(entrada.salario_diario, 'salario_diario')
      : null;
  const sbc = entrada.sbc !== undefined ? importeNoNegativo(entrada.sbc, 'sbc') : null;
  if (!nominal && !sbc) {
    throw new Error(
      'Una provisión necesita un salario: pasa `salario_diario` (el contratado) o `sbc` (el ' +
        'integrado). Sin ninguno de los dos no hay base, y una base inventada es un pasivo ' +
        'inventado.'
    );
  }

  // ── El ejercicio del aguinaldo, recortado por el alta y por la baja ──
  //
  // LFT art. 87: quien no cumplió el año cobra «en proporción al tiempo que
  // hubiere trabajado». La proporción se mide sobre el ejercicio, y el
  // ejercicio de quien entró en julio empieza en julio — es la misma cuenta que
  // hace el finiquito, y tiene que dar lo mismo: el aguinaldo provisionado de
  // enero a la baja más el que el finiquito liquida no puede sumar dos veces.
  const anioEjercicio = ventanaInicio.getUTCFullYear();
  const diasEjercicio = diasDelEjercicio(anioEjercicio);
  const inicioEjercicio = mayor(alta, new Date(Date.UTC(anioEjercicio, 0, 1)));
  const finEjercicio = new Date(Date.UTC(anioEjercicio, 11, 31));
  const diasDeEjercicioHasta = (d: Date): number =>
    d.getTime() < inicioEjercicio.getTime()
      ? 0
      : diasInclusive(inicioEjercicio, menor(d, finEjercicio));

  const segmentos = tramosDeDevengo(alta, baja, ventanaInicio, ventanaFin);

  const tramos: TramoProvisionado[] = [];
  let aguinaldoMes = new Decimal(0);
  let vacacionesMes = new Decimal(0);
  let primaMes = new Decimal(0);

  for (const seg of segmentos) {
    // ── La base salarial del tramo ──
    //
    // El factor de integración lleva DENTRO los días de vacaciones del año
    // (LSS art. 27), así que en el mes del aniversario el factor cambia junto
    // con el escalón. Se resuelve por tramo y no por mes por la misma razón por
    // la que el mes se parte: aplicar un solo factor a los dos tramos usaría el
    // escalón equivocado en uno de ellos.
    const prestaciones: PrestacionesAnuales = {
      dias_aguinaldo: entrada.dias_aguinaldo_por_anio,
      dias_vacaciones: seg.dias_vacaciones_del_anio,
      prima_vacacional_pct: primaPct.toString(),
    };
    let base: Decimal;
    if (baseSalarial === 'integrado') {
      // Si el despacho tiene capturado el SBC, ÉSE manda: es el número que el
      // IMSS conoce y el que el patrón cotiza. Reconstruirlo con el factor es
      // el respaldo para cuando no está, no la fuente preferida.
      base = sbc ?? (nominal as Decimal).times(factorDeIntegracion(prestaciones));
    } else {
      // Y al revés: el nominal se reconstruye des-integrando el SBC, con la
      // función que ya existe. Tomar el SBC como si fuera el diario cobraría
      // aguinaldo sobre el aguinaldo.
      base =
        nominal ?? new Decimal(salarioDiarioDesdeSbc((sbc as Decimal).toString(), prestaciones));
    }
    base = base.toDecimalPlaces(DECIMALES);

    const vispera = diaAnterior(seg.inicio);

    // ── Aguinaldo (LFT art. 87) ──
    const aguinaldo = devengadoHasta(
      base,
      diasAguinaldo,
      diasDeEjercicioHasta(seg.fin),
      diasEjercicio
    ).minus(devengadoHasta(base, diasAguinaldo, diasDeEjercicioHasta(vispera), diasEjercicio));

    // ── Vacaciones (LFT art. 76) y prima vacacional (art. 80) ──
    //
    // El periodo de las vacaciones es el AÑO DE SERVICIO —de aniversario a
    // aniversario—, no el año calendario: el derecho se gana cumpliendo años de
    // servicio, no el 31 de diciembre. Usar el calendario aquí es el mismo
    // defecto que el finiquito ya reparó.
    const diasVacaciones = new Decimal(seg.dias_vacaciones_del_anio);
    const diasPrima = diasVacaciones.times(primaPct);
    const transcurridoHasta = (d: Date): number =>
      d.getTime() < seg.inicio_del_anio_de_servicio.getTime()
        ? 0
        : diasInclusive(seg.inicio_del_anio_de_servicio, menor(d, seg.fin_del_anio_de_servicio));

    let vacaciones: Decimal;
    let prima: Decimal;
    if (convencion === 'proporcional') {
      vacaciones = devengadoHasta(
        base,
        diasVacaciones,
        transcurridoHasta(seg.fin),
        seg.dias_del_anio_de_servicio
      ).minus(
        devengadoHasta(
          base,
          diasVacaciones,
          transcurridoHasta(vispera),
          seg.dias_del_anio_de_servicio
        )
      );
      prima = devengadoHasta(
        base,
        diasPrima,
        transcurridoHasta(seg.fin),
        seg.dias_del_anio_de_servicio
      ).minus(
        devengadoHasta(base, diasPrima, transcurridoHasta(vispera), seg.dias_del_anio_de_servicio)
      );
    } else {
      // ── Convención `aniversario` ──
      //
      // EL RECONOCIMIENTO CAE EL DÍA EN QUE EL AÑO DE SERVICIO QUEDA CUMPLIDO,
      // que es la VÍSPERA del aniversario, no el aniversario mismo. La
      // diferencia parece de un día y no lo es: para un alta del 1 de enero, el
      // año se cumple el 31 de diciembre y el aniversario cae el 1 de enero
      // SIGUIENTE — o sea, en otro ejercicio. Reconociendo el día que se cumple,
      // las dos convenciones suman EXACTAMENTE lo mismo sobre un año de
      // servicio; reconociendo el aniversario, el importe se iría al año
      // siguiente y la bifurcación dejaría de ser de presentación para pasar a
      // ser de importe, que es justo lo que no puede pasar.
      //
      // Lo que esta convención NO reconoce es el año en curso de quien se va
      // antes de cumplirlo: bajo `aniversario` no hay derecho consolidado y la
      // provisión es cero, aunque el finiquito sí pague la parte proporcional
      // (art. 79). Es la consecuencia declarada de la convención —y la razón de
      // que el panel traiga `proporcional` por omisión, que es lo que pide la
      // NIF D-3—, no un descuido.
      const cumpleAqui = seg.fin.getTime() === seg.fin_del_anio_de_servicio.getTime();
      vacaciones = cumpleAqui
        ? base.times(diasVacaciones).toDecimalPlaces(DECIMALES)
        : new Decimal(0);
      prima = cumpleAqui ? base.times(diasPrima).toDecimalPlaces(DECIMALES) : new Decimal(0);
    }

    aguinaldoMes = aguinaldoMes.plus(aguinaldo);
    vacacionesMes = vacacionesMes.plus(vacaciones);
    primaMes = primaMes.plus(prima);

    tramos.push({
      inicio: fechaISO(seg.inicio),
      fin: fechaISO(seg.fin),
      dias: seg.dias,
      anio_de_servicio: seg.anio_de_servicio,
      dias_vacaciones_del_anio: seg.dias_vacaciones_del_anio,
      base_diaria: base.toFixed(DECIMALES),
      aguinaldo: aguinaldo.toFixed(DECIMALES),
      vacaciones: vacaciones.toFixed(DECIMALES),
      prima_vacacional: prima.toFixed(DECIMALES),
    });
  }

  // El importe del mes es la suma de lo que dicen los tramos, sin un
  // redondeo más: la cédula que se publica y el asiento que se postea tienen
  // que cuadrar renglón a renglón, no aproximadamente.
  const total = aguinaldoMes.plus(vacacionesMes).plus(primaMes);

  return {
    base_salarial: baseSalarial,
    convencion_vacaciones: convencion,
    dias_devengados: segmentos.reduce((suma, s) => suma + s.dias, 0),
    tramos,
    aguinaldo: aguinaldoMes.toFixed(DECIMALES),
    vacaciones: vacacionesMes.toFixed(DECIMALES),
    prima_vacacional: primaMes.toFixed(DECIMALES),
    total: total.toFixed(DECIMALES),
  };
}

/** Un mes que no mueve nada. Con Decimal, no con `=== 0`. */
export function esProvisionCero(p: ProvisionMensual): boolean {
  return new Decimal(p.total).isZero();
}
