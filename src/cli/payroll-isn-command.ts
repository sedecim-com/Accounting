import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import Decimal from 'decimal.js';
import { InvalidArgumentError, type Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { query } from '../database/connection.js';
import { getPolicy } from '../services/policy/policy-service.js';
import {
  basesIsnDeCorrida,
  calcularIsn,
  contarHallazgos as contarHallazgosDeNomina,
  vigenciasDeIsn,
  type HallazgoNomina,
  type RegimenIsn,
  type TasaIsn,
} from '../services/payroll/mx/isn-calculator.js';
import { confirmarConReintento, noEntendi, yesNoPrompt } from './kernel/confirmacion.js';
import { renderHallazgos } from './e-accounting-command.js';
import type { Palette } from './palette.js';
import { getLanguage, t, type TranslationKey } from '../i18n/index.js';
import {
  ExitCode,
  abortedByUser,
  checkExitCode,
  conflict,
  declareRisk,
  exitCodeFor,
  formatMoneyMx,
  gateMutation,
  notFound,
  render,
  requireExplicitEntity,
  resolveActiveEntity,
  usageError,
  validationFailed,
  withContext,
  withOutput,
  withSelection,
  withStrict,
  argumentByKey,
  describeCommand,
  describeOption,
  optionByKey,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';
import { calendarDateOf, isRealCalendarDate } from '../utils/calendar-date.js';
import { findingText } from '../i18n/payroll-finding-text.js';

// ============================================================
// mnemosine isn · mnemosine tax-deposit — LA PUERTA DEL IMPUESTO QUE NO
// EXISTÍA, Y LA DEL PASIVO QUE NADIE APUNTABA
//
// F08a puso el motor (services/payroll/mx/isn-calculator.ts) y el acumulador
// (services/payroll/common/employer-liability-service.ts) sobre la migración
// 067. Los dos nacen INÚTILES sin esta capa, y no por comodidad:
// `mx_isn_tasas_estatales` nace VACÍA a propósito —treinta y dos estados de
// memoria son treinta y dos números inventados— y el motor se NIEGA a calcular
// sin ella. Sin una superficie que la llene, el sistema tiene un impuesto que
// sabe calcular y no puede.
//
// CUATRO HOJAS, DOS FAMILIAS, y las dos familias son las que el catálogo ya
// nombra (docs/cli-command-catalog.md 1779, 1833):
//
//   isn rate set   · isn tasa fijar    — captura una tasa con su vigencia y su
//                                        fundamento. LA ÚNICA QUE ESCRIBE.
//   isn rate list  · isn tasa listar   — qué hay capturado, y qué rige hoy
//   isn calculate  · isn calcular      — el ISN de una corrida, estado por
//                                        estado, con lo que falta nombrado
//   tax-deposit list · entero listar   — el pasivo patronal acumulado, con su
//                                        fecha límite y su estado
//
// ── OCHO DECISIONES QUE NO SON DE ESTILO ──
//
// LA PRIMERA · UNA TASA SIN FUNDAMENTO NO SE CAPTURA, Y LA BASE NO LO IMPIDE.
// `fundamento TEXT NOT NULL` deja pasar la cadena vacía: NOT NULL no es
// «no vacío». La guarda de verdad está aquí, y es lo que separa una tasa
// auditable de un número que alguien recordaba. Cuando dentro de dos años el
// estado revise, la pregunta no va a ser cuánto se pagó sino de dónde salió
// el 3 %; una fila sin cita de ley no tiene respuesta.
//
// LA SEGUNDA · LA TASA SE TECLEA COMO FRACCIÓN O CON EL SIGNO DE PORCENTAJE, Y
// UN NÚMERO PELADO MAYOR QUE EL TOPE SE RECHAZA CON SU REMEDIO. `--rate 3`
// queriendo decir 3 % escribiría 300 %, y el CHECK de la 067 (tasa <= 0.15) lo
// pararía con un error de Postgres que no enseña nada. Aquí `3%` vale 0.03,
// `0.03` vale 0.03, y `3` a secas se rechaza diciendo las dos formas. El tope
// del CHECK se comprueba ANTES de viajar, para que el mensaje sea del dominio
// y no del driver.
//
// LA TERCERA · `--effective-from` Y `--superseded-on`, Y NO `--start`/`--end`.
// El diccionario congeló `--start`/`--end` en D1a como la ventana de cobertura
// de un contrato, que es INCLUSIVA por los dos extremos. El intervalo de una
// vigencia de ISN es SEMIABIERTO —[desde, hasta)— y no por gusto: es la
// convención que impone el disparador `trg_isn_sin_solape` de la 067, la misma
// que lee `vigenteEn`. Reutilizar `--end` para un extremo EXCLUSIVO sería una
// grafía con dos significados, que es justo lo que el diccionario existe para
// impedir, y el precio no sería una lista mal filtrada: sería la tasa vieja
// aplicada un día de más —o la nueva un día de menos— en cada cambio estatal.
// `--superseded-on` dice literalmente lo que la columna guarda: el día en que
// la SIGUIENTE tasa toma el relevo.
//
// LA CUARTA · `--regime` Y NO `--kind`. El diccionario tiene `--kind` para «de
// qué clase es esto» (lote, tarea, aprobación, ajuste). El régimen del ISN no
// es la clase del REGISTRO: es la forma en que la ley del estado cobra, y su
// vocabulario —`tasa_plana|escalonado|con_exencion`— sale de un CHECK de la
// 067. Una grafía compartida con otro juego de valores es peor que una con dos
// significados, porque el error no se ve al teclear sino al calcular. Es el
// mismo razonamiento con que D1a se negó a llamar `--method` a su convención.
//
// LA QUINTA · EL SOLAPE SE ENSEÑA ANTES DE INTENTARLO, Y AUN ASÍ EL CANDADO
// SIGUE EN LA BASE. `solapaCon` reproduce aquí el predicado del disparador
// para que la confirmación diga con QUÉ vigencia choca —el disparador sólo
// puede decir que choca—. La comprobación de este lado NO sustituye a la de la
// base: entre leer y escribir cabe otra sesión, y el candado que vale es el
// que no depende de quién llegue primero.
//
// LA SEXTA · LA CAPTURA COMPRUEBA SI ESA CLAVE LA USA ALGUIEN, Y ES LA
// COMPROBACIÓN MÁS ÚTIL DE LA HOJA. `mx_isn_tasas_estatales.estado` es
// VARCHAR(3) —la clave c_Estado del SAT, «JAL»— y `employees.work_state` es
// VARCHAR(2), porque nació para los estados de EE. UU. Una tasa capturada como
// «JAL» NO PUEDE casar nunca contra un `work_state` de dos caracteres: el
// motor no da error, da el hallazgo `isn_sin_tasa_capturada` sobre una tasa que
// está capturada. Así que antes de escribir se lee la plantilla real y se dice
// cuántos trabajadores llevan esa clave y cuáles llevan otra. Es lo que
// convierte «se capturó» en «se capturó y va a servir».
//
// LA SÉPTIMA · LAS CUATRO POLÍTICAS DEL PANEL SE LEEN, NO SE PREGUNTAN NI SE
// ELIGEN, Y UNA SIN CONTESTAR SE DICE EN VOZ ALTA. `isn_estado_que_causa`
// decide de qué columna sale el estado, e `isn_momento_de_causacion` con qué
// fecha se elige la vigencia. Cuando `defined` es falso rige un DEFECTO
// DECLARADO y no una decisión del despacho, y presentarlo como si lo fuera es
// la clase de mentira que este binario ya cazó en otras hojas: se marca
// «(default)» y se dice cómo contestarlo.
//
// LA OCTAVA · `tax-deposit list` LEE, Y NO ACUMULA. Quien escribe
// `employer_tax_liabilities` es `acumularPasivoPatronal`, con la corrida ya
// aprobada y dentro de su transacción. Una lista que acumulara de paso
// escribiría un pasivo cada vez que alguien mira, que es la manera exacta en
// que una tabla de impuestos se duplica. Cuando no hay nada que enseñar, la
// hoja lo dice y nombra la causa probable —la corrida todavía no se ha
// cerrado— en vez de imprimir una tabla vacía.
// ============================================================

export interface PayrollIsnCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Costura de prueba: responde la confirmación de `isn rate set`. */
  confirm?: (question: string) => Promise<boolean>;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
}

// ------------------------------------------------------------
// LO QUE SE TECLEA, VALIDADO ANTES DE TOCAR LA BASE
//
// Todas estas funciones son puras y se exportan: la prueba las corre sin
// conexión, que es la única forma de fijar reglas de dominio sin depender de
// que alguien levante Postgres.
// ------------------------------------------------------------

/** Los tres regímenes del CHECK de la 067, en el orden en que la ley los usa. */
export const REGIMENES_ISN: readonly RegimenIsn[] = Object.freeze([
  'tasa_plana',
  'escalonado',
  'con_exencion',
]);

/** El tope del CHECK `tasa <= 0.15` de la 067, escrito una vez. */
export const TASA_ISN_MAXIMA = '0.15';

/** Decimales que la columna `tasa DECIMAL(8,6)` conserva. */
const DECIMALES_DE_TASA = 6;

/** Mínimo de caracteres para que un fundamento sea una cita y no un relleno. */
const FUNDAMENTO_MINIMO = 6;

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const MES_RE = /^(\d{4})-(\d{2})$/;
const CLAVE_RE = /^[A-Z]{2,3}$/;

/**
 * La clave de la entidad federativa, normalizada como la normaliza el motor.
 *
 * `basesIsnDeCorrida` compara con `UPPER(TRIM(...))`, así que capturar en
 * minúsculas o con un espacio de más produciría una tasa que existe y que no
 * casa con nadie. Se normaliza AQUÍ, en la única puerta de escritura, para que
 * la tabla no acumule dos grafías de la misma entidad.
 *
 * Se exigen letras y sólo letras: la columna es VARCHAR(3) y la clave c_Estado
 * del SAT es alfabética. Un dígito colado —el código INEGI, por ejemplo— daría
 * una tasa que ningún trabajador puede reclamar.
 */
export function exigirClaveDeEstado(valor: string | undefined): string {
  const clave = (valor ?? '').trim().toUpperCase();
  if (clave === '') {
    throw usageError({ key: 'payroll.isn.state_missing' });
  }
  if (!CLAVE_RE.test(clave)) {
    throw usageError({ key: 'payroll.isn.state_invalid', params: { value: valor ?? '' } });
  }
  return clave;
}

/**
 * La tasa, como fracción (`0.03`) o con el signo de porcentaje (`3%`).
 *
 * Un número pelado por encima del tope se rechaza con las DOS formas escritas,
 * porque el error que este código existe para atrapar es teclear `3` queriendo
 * decir 3 %: eso son 300 % y produce un impuesto cien veces mayor sobre una
 * base correcta. Y más decimales de los que la columna guarda se rechazan en
 * vez de redondearse en silencio: una tasa que no es la que se tecleó es
 * exactamente el instrumento que miente.
 */
export function exigirTasaIsn(valor: string | undefined): string {
  const crudo = (valor ?? '').trim();
  if (crudo === '') {
    throw usageError({ key: 'payroll.isn.rate_missing' });
  }
  const esPorcentaje = crudo.endsWith('%');
  const numero = esPorcentaje ? crudo.slice(0, -1).trim() : crudo;
  if (!/^\d+(\.\d+)?$/.test(numero)) {
    throw usageError({ key: 'payroll.isn.rate_invalid', params: { value: crudo } });
  }
  let tasa = new Decimal(numero);
  if (esPorcentaje) tasa = tasa.dividedBy(100);
  if (tasa.decimalPlaces() > DECIMALES_DE_TASA) {
    throw usageError({ key: 'payroll.isn.rate_too_precise', params: { rate: tasa.toString(), decimals: DECIMALES_DE_TASA } });
  }
  if (tasa.greaterThan(TASA_ISN_MAXIMA)) {
    throw usageError({ key: 'payroll.isn.rate_above_ceiling', params: { rate: tasa.toString(), ceiling: TASA_ISN_MAXIMA } });
  }
  return tasa.toFixed(DECIMALES_DE_TASA);
}

/** Una fecha 'YYYY-MM-DD' que además existe en el calendario. */
export function exigirFechaIsn(bandera: string, valor: string | undefined): string {
  const fecha = (valor ?? '').trim();
  if (!FECHA_RE.test(fecha)) {
    throw usageError({ key: 'cli.flag.error_not_date', params: { name: bandera, value: valor ?? '' } });
  }
  // `new Date('2026-02-30')` NO es inválida: se desborda al 2 de marzo. Se
  // compara el ida y vuelta, que es lo único que caza el día que no existe.
  if (!isRealCalendarDate(fecha)) {
    throw usageError({ key: 'payroll.isn.date_not_real', params: { name: bandera, value: fecha } });
  }
  return fecha;
}

/** Uno de los tres regímenes del CHECK; nada más. */
export function exigirRegimen(valor: string | undefined): RegimenIsn {
  const r = (valor ?? 'tasa_plana').trim();
  if (!(REGIMENES_ISN as readonly string[]).includes(r)) {
    throw usageError({ key: 'payroll.isn.regime_unknown', params: { value: r, regimes: REGIMENES_ISN.join(', ') } });
  }
  return r as RegimenIsn;
}

/**
 * El fundamento: la cita de la ley que sostiene la tasa.
 *
 * `fundamento TEXT NOT NULL` no impide la cadena vacía, así que la guarda de
 * verdad es ésta. El piso de caracteres no juzga la calidad de la cita —eso no
 * lo puede hacer una máquina—: sólo impide el relleno de una letra, que es la
 * forma en que un campo obligatorio se vuelve opcional.
 */
export function exigirFundamento(valor: string | undefined): string {
  const f = (valor ?? '').trim();
  if (f === '') {
    throw usageError({ key: 'payroll.isn.legal_basis_missing' });
  }
  if (f.length < FUNDAMENTO_MINIMO) {
    throw usageError({ key: 'payroll.isn.legal_basis_too_short', params: { value: f } });
  }
  return f;
}

/**
 * La exención mensual, atada al régimen exactamente como el CHECK
 * `isn_exencion_solo_si_aplica` de la 067 la ata.
 *
 * Se comprueba aquí para que el mensaje nombre las dos banderas y no llegue del
 * driver como una violación de restricción sin remedio escrito. Dinero: cadena
 * y decimal.js, cuatro decimales, como la columna DECIMAL(14,4).
 */
export function exigirExencion(
  regimen: RegimenIsn,
  valor: string | undefined
): string | null {
  const crudo = (valor ?? '').trim();
  if (regimen === 'con_exencion') {
    if (crudo === '') {
      throw usageError({ key: 'payroll.isn.exemption_missing' });
    }
    if (!/^\d+(\.\d+)?$/.test(crudo)) {
      throw usageError({ key: 'payroll.isn.exemption_invalid', params: { value: crudo } });
    }
    return new Decimal(crudo).toFixed(4);
  }
  if (crudo !== '') {
    throw usageError({ key: 'payroll.isn.exemption_not_allowed', params: { regime: regimen } });
  }
  return null;
}

/** `--period YYYY-MM`, el mes del pasivo. */
export function exigirMesDeNomina(expr: string | undefined): { anio: number; mes: number } {
  const m = MES_RE.exec((expr ?? '').trim());
  if (!m) {
    throw usageError({ key: 'payroll.isn.period_not_month', params: { value: expr ?? '' } });
  }
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12) {
    throw usageError({ key: 'payroll.isn.period_month_range', params: { value: expr ?? '' } });
  }
  return { anio, mes };
}

/** El primer y el último día de un mes, sin tabla de meses ni bisiestos. */
export function rangoDelMes(anio: number, mes: number): { desde: string; hasta: string } {
  return { desde: calendarDateOf(anio, mes, 1), hasta: calendarDateOf(anio, mes + 1, 0) };
}

/**
 * El parseador de `-n/--limit` y `--offset`.
 *
 * Va con `InvalidArgumentError` y no con `usageError` porque lo llama
 * Commander mientras interpreta la línea, antes de que exista la acción: es la
 * misma elección que hace el diccionario del núcleo para las suyas.
 */
function enteroNoNegativo(bandera: string) {
  return (valor: string): number => {
    const n = Number(valor);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new InvalidArgumentError(t('cli.flag.error_not_whole_number', { name: bandera, value: valor }));
    }
    return n;
  };
}

/** Días de `desde` a `hasta`; negativo si `hasta` ya pasó. */
export function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * ¿La vigencia que se va a capturar choca con alguna ya capturada?
 *
 * Reproduce el predicado de `trg_isn_sin_solape` (067) con su convención
 * SEMIABIERTA: `nuevoDesde < COALESCE(otroHasta, ∞) AND COALESCE(nuevoHasta, ∞)
 * > otroDesde`. Con ella, una tasa que cede el 2026-01-01 y la siguiente que
 * abre ese mismo día NO se solapan, y el 2026-01-01 pertenece a la segunda.
 *
 * Esto NO sustituye al disparador y no pretende hacerlo: entre leer y escribir
 * cabe otra sesión, y el candado que vale es el de la base. Lo que aporta es el
 * NOMBRE del choque —con qué vigencia, desde cuándo— antes de que el operador
 * confirme, que es lo que el disparador no puede dar.
 */
export function solapaCon(
  vigencias: readonly TasaIsn[],
  desde: string,
  hasta: string | null
): TasaIsn[] {
  const INFINITO = '9999-12-31';
  const nuevoHasta = hasta ?? INFINITO;
  return vigencias.filter((v) => {
    if (v.vigenciaDesde === desde) return true; // misma llave primaria
    return desde < (v.vigenciaHasta ?? INFINITO) && nuevoHasta > v.vigenciaDesde;
  });
}

// ------------------------------------------------------------
// LAS FILAS QUE SALEN
// ------------------------------------------------------------

/** Una vigencia capturada, como fila. La tasa viaja también en porcentaje legible. */
export function filaDeTasa(t: TasaIsn, alDia?: string): Row {
  const vigente =
    alDia === undefined
      ? undefined
      : t.vigenciaDesde <= alDia && (t.vigenciaHasta === null || t.vigenciaHasta > alDia);
  return {
    estado: t.estado,
    tasa: t.tasa,
    porcentaje: `${new Decimal(t.tasa).times(100).toFixed(4)}%`,
    regimen: t.regimen,
    exencion_mensual: t.exencionMensual ?? '',
    vigencia_desde: t.vigenciaDesde,
    // El vacío dice «sigue vigente», que es lo que el NULL de la columna dice.
    superseded_on: t.vigenciaHasta ?? '',
    ...(vigente === undefined ? {} : { vigente }),
    fundamento: t.fundamento,
  };
}

/** Una fila de `employer_tax_liabilities` tal como se lee de la base. */
export interface FilaPasivoPatronal {
  id: string;
  entidad: string;
  pay_run_id: string | null;
  tax_type: string;
  jurisdiction: string;
  period_start: string;
  period_end: string;
  amount: string;
  due_date: string;
  deposit_frequency: string | null;
  status: string;
  deposited_at: Date | null;
  deposit_reference: string | null;
}

/**
 * El pasivo, como fila, con lo único que la tabla no guarda y el operador
 * necesita: cuántos días quedan y si ya venció.
 *
 * VENCIDO NO ES LO MISMO QUE `status = 'late'`. La columna `status` la mueve
 * una persona cuando registra el entero; `vencido` sale de comparar la fecha
 * límite con hoy. Un pasivo en 'pending' cuya fecha ya pasó está vencido
 * aunque nadie lo haya marcado, y ése es justo el que hay que ver primero.
 */
export function filaDePasivo(f: FilaPasivoPatronal, hoy: string): Row {
  const dias = diasEntre(hoy, f.due_date);
  const abierto = f.status === 'pending' || f.status === 'late';
  return {
    id: f.id,
    entidad: f.entidad,
    impuesto: f.tax_type,
    jurisdiccion: f.jurisdiction,
    periodo: `${f.period_start}..${f.period_end}`,
    importe: f.amount,
    fecha_limite: f.due_date,
    dias: dias,
    vencido: abierto && dias < 0,
    frecuencia: f.deposit_frequency ?? '',
    status: f.status,
    depositado_el: f.deposited_at === null ? '' : f.deposited_at.toISOString(),
    referencia: f.deposit_reference ?? '',
    corrida: f.pay_run_id ?? '',
  };
}

/** Lo que la plantilla real dice de una clave de estado, para la captura. */
export interface CoberturaDeClave {
  /** De dónde sale el estado, según `isn_estado_que_causa`. */
  criterio: 'centro_de_trabajo' | 'domicilio_fiscal';
  /** false = nadie contestó la política; rige su defecto declarado. */
  criterioDefinido: boolean;
  /** Cuántos trabajadores vivos llevan EXACTAMENTE la clave que se captura. */
  alcanzados: number;
  /** Las demás claves en uso, con su conteo, para ver el desajuste. */
  otras: Array<{ clave: string; trabajadores: number }>;
}

/**
 * One line of the ISN capture preview: the label in the user's language,
 * padded so every value starts at column 21 in both languages (MNE-001-221).
 */
function previewLine(label: TranslationKey, value: string): string {
  return `  ${t(label).padEnd(18)} ${value}`;
}

/**
 * A policy and its value, said as `name=value`, and marked as a default in the
 * user's language when nobody answered it (MNE-001-221). The name and the value
 * are identifiers and are never translated.
 */
export function policyPair(name: string, value: string, defined: boolean): string {
  return defined ? `${name}=${value}` : `${name}=${t('payroll.isn.policy_default', { value })}`;
}

/**
 * Las líneas que se enseñan ANTES de escribir.
 *
 * Es una función pura y separada del manejador a propósito: lo que un operador
 * ve antes de confirmar una escritura fiscal es parte del contrato de la hoja,
 * y un contrato que sólo existe dentro de un `action()` no lo puede fijar
 * ninguna prueba sin base de datos.
 */
export function lineasDeLaCaptura(datos: {
  estado: string;
  tasa: string;
  regimen: RegimenIsn;
  exencion: string | null;
  desde: string;
  hasta: string | null;
  fundamento: string;
  cobertura: CoberturaDeClave;
  choques: readonly TasaIsn[];
}): string[] {
  const { estado, tasa, regimen, exencion, desde, hasta, fundamento, cobertura, choques } = datos;
  const porcentaje = `${new Decimal(tasa).times(100).toFixed(4)}%`;
  const lineas = [
    previewLine('payroll.isn_rate_set.state', estado),
    previewLine('payroll.isn_rate_set.rate', `${tasa}  (${porcentaje})`),
    previewLine('payroll.isn_rate_set.regime', regimen),
    ...(exencion === null ? [] : [previewLine('payroll.isn_rate_set.monthly_exemption', formatMoneyMx(exencion))]),
    previewLine('payroll.isn_rate_set.in_force', `${desde} -> ${hasta ?? t('payroll.isn_rate_set.open_ended')}`),
    previewLine('payroll.isn_rate_set.legal_basis', fundamento),
    previewLine('payroll.isn_rate_set.table', `mx_isn_tasas_estatales ${t('payroll.isn_rate_set.table_note')}`),
  ];

  // EL DESAJUSTE DE CLAVES, que es el defecto que de verdad se cobra caro.
  const fuente =
    cobertura.criterio === 'domicilio_fiscal'
      ? 'legal_entities.state_province'
      : 'employees.work_state';
  lineas.push(
    previewLine(
      'payroll.isn_rate_set.criterion',
      `${policyPair('isn_estado_que_causa', cobertura.criterio, cobertura.criterioDefinido)} -> ${fuente}`
    )
  );
  if (cobertura.alcanzados > 0) {
    lineas.push(previewLine('payroll.isn_rate_set.reaches', t('payroll.isn_rate_set.reaches_count', { count: cobertura.alcanzados, state: estado })));
  } else {
    lineas.push(previewLine('payroll.isn_rate_set.reaches', t('payroll.isn_rate_set.reaches_nobody', { state: estado, source: fuente })));
    // The continuation lines start at column 21, under the values.
    if (cobertura.otras.length > 0) {
      const keys = cobertura.otras.map((o) => `${o.clave === '' ? t('payroll.isn_rate_set.blank_key') : o.clave}=${o.trabajadores}`).join(', ');
      lineas.push(`${' '.repeat(21)}${t('payroll.isn_rate_set.keys_in_use', { keys })}`);
    }
    if (estado.length === 3 && cobertura.criterio === 'centro_de_trabajo') {
      lineas.push(`${' '.repeat(21)}${t('payroll.isn_rate_set.key_too_long')}`);
    }
  }

  for (const c of choques) {
    const to = c.vigenciaHasta ?? t('payroll.isn.open_end');
    lineas.push(previewLine('payroll.isn_rate_set.overlap', t('payroll.isn_rate_set.overlap_detail', { state: c.estado, from: c.vigenciaDesde, to, rate: c.tasa })));
  }
  return lineas;
}

// ------------------------------------------------------------
// EL PASIVO: SU VOCABULARIO
// ------------------------------------------------------------

/** Los cuatro estados del CHECK de `employer_tax_liabilities` (008). */
export const ESTADOS_DE_PASIVO: readonly string[] = Object.freeze([
  'pending',
  'deposited',
  'late',
  'waived',
]);

/**
 * Lo que se enseña sin pedir nada: lo que TODAVÍA SE DEBE.
 *
 * Un listado que por omisión incluyera lo ya depositado enterraría los tres
 * renglones que vencen esta semana entre doscientos que ya se pagaron. `-a`
 * los trae todos, y `-s` filtra a mano.
 */
export const PASIVO_QUE_SE_DEBE: readonly string[] = Object.freeze(['pending', 'late']);

export function exigirEstadosDePasivo(valores: readonly string[] | undefined): string[] {
  if (valores === undefined || valores.length === 0) return [...PASIVO_QUE_SE_DEBE];
  const pedidos = valores.map((v) => v.trim()).filter((v) => v !== '');
  const desconocidos = pedidos.filter((p) => !ESTADOS_DE_PASIVO.includes(p));
  if (desconocidos.length > 0) {
    throw usageError({ key: 'payroll.tax_deposit.status_unknown', params: { values: desconocidos.join(', '), statuses: ESTADOS_DE_PASIVO.join(', ') } });
  }
  if (pedidos.length === 0) {
    throw usageError({ key: 'payroll.tax_deposit.status_empty', params: { statuses: ESTADOS_DE_PASIVO.join(', ') } });
  }
  return pedidos;
}

// ------------------------------------------------------------
// LOS ERRORES DE LA BASE, TRADUCIDOS AL DOMINIO
// ------------------------------------------------------------

/**
 * El disparador y la llave primaria de la 067 hablan en SQLSTATE. Aquí se
 * convierten en lo que le pasa al operador, con su remedio.
 *
 * Se distingue el choque de LLAVE —ya hay una vigencia que empieza ese mismo
 * día— del SOLAPE, porque los remedios son distintos: el primero se arregla
 * mirando lo capturado, el segundo cerrando la vigencia anterior.
 */
export function traducirErrorDeCaptura(err: unknown, estado: string, desde: string): unknown {
  const codigo = (err as { code?: unknown } | null)?.code;
  const mensaje = err instanceof Error ? err.message : String(err);
  if (codigo === '23505') {
    return conflict(
      { key: 'payroll.isn_rate_set.duplicate', params: { state: estado, from: desde, command: `mnemosine isn rate list --state ${estado} -a` } },
      { estado, desde }
    );
  }
  if (codigo === '23514' || /solapa/i.test(mensaje)) {
    return validationFailed({ key: 'payroll.isn_rate_set.db_refused', params: { message: mensaje } }, { estado, desde });
  }
  return err;
}

// ============================================================
// EL REGISTRO
// ============================================================

/**
 * Las dos familias que este archivo trae. El integrador engancha una sola
 * línea; las dos funciones sueltas existen para que una prueba pueda auditar
 * cada árbol por separado.
 */
export function registerPayrollIsnCommands(program: Command, deps: PayrollIsnCommandDeps): void {
  registerIsnCommand(program, deps);
  registerTaxDepositCommand(program, deps);
}

/** Herramientas compartidas por las dos familias. */
function utilidades(deps: PayrollIsnCommandDeps) {
  const run = async (fn: () => Promise<ExitCodeValue | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? ExitCode.OK);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  // Inquilino PRIMERO, como en toda la casa: bajo RLS una conexión sin
  // app.current_tenant no ve una sola fila de legal_entities, y una resolución
  // de entidad hecha antes del bootstrap no resuelve nada.
  const entidad = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity(
      { entity: opts.entity },
      { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
    );
    return ctx;
  };

  const entidadParaEscribir = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    return requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
  };

  /** Cede la ficha escrita a mano en cuanto el usuario pide otra forma. */
  const legible = (opts: CommonOpts): boolean =>
    !opts.json &&
    (opts.format ?? 'table') === 'table' &&
    !opts.quiet &&
    opts.output === undefined &&
    opts.fields === undefined;

  const ask = async (question: string): Promise<boolean> => {
    if (deps.confirm) return deps.confirm(question);
    if (!stdin.isTTY) return false;
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      // Por el kernel, siempre: la gramática del «sí» es una sola en todo el
      // CLI y entiende los dos idiomas. Una escrita a mano aquí volvería a
      // contar como NO un «sí» tecleado en español, y el censo de
      // tests/cli/confirmacion-gramatica.spec.ts la acusaría.
      const veredicto = await confirmarConReintento(
        (p) => rl.question(p).catch(() => null),
        deps.palette.cyan(yesNoPrompt(question))
      );
      if (veredicto.incomprendida !== undefined) {
        process.stderr.write(`${t('bank.confirm.taken_as_no', { reason: noEntendi(veredicto.incomprendida) })}\n`);
      }
      return veredicto.si;
    } finally {
      rl.close();
    }
  };

  return { run, entidad, entidadParaEscribir, legible, ask };
}

/** Hoy, en fecha local: la fecha límite de un impuesto se compara con el día del despacho. */
function hoyLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const EJEMPLOS = {
  rateSet: `
Examples:
  # Capture Jalisco at 3%, effective from the day the reform took effect.
  mnemosine isn rate set JAL 3% --effective-from 2026-01-01 --legal-basis "Ley de Hacienda de Jalisco art. 41, POE 2025-12-15"
  # Close a rate the state replaced, then capture the new one.
  mnemosine isn rate set JAL 0.03 --effective-from 2025-01-01 --superseded-on 2026-01-01 --legal-basis "Jalisco art. 41 (2025)"
  # See exactly what would be written, and who it reaches, without writing.
  mnemosine isn rate set NLE 3% --effective-from 2026-01-01 --legal-basis "..." --dry-run
`,
  rateList: `
Examples:
  # What is in force today, state by state.
  mnemosine isn rate list
  # Every vigencia ever captured for one state, history included.
  mnemosine isn rate list --state JAL --all
  # What was in force on the day a pay period closed.
  mnemosine isn rate list --as-of 2026-03-31 --json
`,
  calculate: `
Examples:
  # The ISN of one pay run, state by state, with whatever is missing named.
  mnemosine isn calculate --run 5f1c8e3a-0000-4000-8000-000000000001
  # Only one state, for the paper that goes to that state.
  mnemosine isn calculate --run 5f1c8e3a-0000-4000-8000-000000000001 --state JAL
`,
  depositList: `
Examples:
  # What the employer still owes, soonest due first.
  mnemosine tax-deposit list
  # One month, everything in it, including what is already deposited.
  mnemosine tax-deposit list --period 2026-07 --all
  # Anything falling due before the 17th, as JSON for a reminder job.
  mnemosine tax-deposit list --until 2026-08-17 --json
`,
};

// ============================================================
// mnemosine isn · isn
// ============================================================

export function registerIsnCommand(program: Command, deps: PayrollIsnCommandDeps): void {
  const { run, entidad, entidadParaEscribir, legible, ask } = utilidades(deps);
  const c = deps.palette;

  // Sin `.alias()`: «ISN» son las siglas del impuesto y se escriben igual en
  // los dos idiomas, como `diot`, `cfdi` y `sat`. Los VERBOS sí llevan el suyo.
  const familia = describeCommand(program.command('isn'), 'help.isn.description');

  const tasa = describeCommand(familia.command('rate').alias('tasa'), 'help.isn.rate.description');

  // ---- isn rate set · isn tasa fijar -----------------------------------
  const fijar = describeCommand(tasa.command('set').alias('fijar'), 'help.isn.rate.set.description');
  argumentByKey(fijar, '<state>', 'help.isn.rate.set.argument.state');
  argumentByKey(fijar, '<rate>', 'help.isn.rate.set.argument.rate');
  withContext(fijar);
  withOutput(fijar);
  optionByKey(fijar, '--effective-from <date>', 'help.isn.rate.set.option.effective_from');
  optionByKey(fijar, '--superseded-on <date>', 'help.isn.rate.set.option.superseded_on');
  optionByKey(fijar, '--legal-basis <text>', 'help.isn.rate.set.option.legal_basis');
  optionByKey(fijar, `--regime <${REGIMENES_ISN.join('|')}>`, 'help.isn.rate.set.option.regime', {
    defaultValue: 'tasa_plana',
  });
  optionByKey(fijar, '--exemption <amount>', 'help.isn.rate.set.option.exemption');
  optionByKey(fijar, '--dry-run', 'help.isn.rate.set.option.dry_run');
  optionByKey(fijar, '-y, --yes', 'help.isn.rate.set.option.yes');
  // ESCRITURA, y el agente NO puede llamarla. `mx_isn_tasas_estatales` no es
  // una cola de revisión: lo que se escribe aquí multiplica cada nómina del
  // estado a partir de esa fecha. `declareRisk` sólo admite escritura + agente
  // con `draftOnly`, que aquí sería mentira.
  declareRisk(fijar, {
    risk: 'escritura',
    agent: false,
    writes:
      'mx_isn_tasas_estatales (one effective period); no journal entry and no liability: ' +
      'each pay run computes them later',
  });
  fijar.addHelpText('after', EJEMPLOS.rateSet);
  fijar.action(
    (
      estadoArg: string,
      tasaArg: string,
      opts: CommonOpts & {
        effectiveFrom?: string;
        supersededOn?: string;
        legalBasis?: string;
        regime?: string;
        exemption?: string;
        dryRun?: boolean;
        yes?: boolean;
      }
    ) =>
      run(async () => {
        // LA COMPUERTA PRIMERO, aunque esta clase de riesgo no exija banderas:
        // `gateMutation` FALLA CERRADO ante una hoja que muta sin declaración,
        // y llamarla es lo que hace que esa red cubra también a esta. De aquí
        // sale el `dryRun` efectivo, que no se vuelve a leer de `opts`.
        const { dryRun } = gateMutation(fijar, opts as unknown as Record<string, unknown>);

        // Todo lo tecleable se valida ANTES de tocar la base: un typo no debe
        // costar una conexión, y menos aún media escritura.
        const estado = exigirClaveDeEstado(estadoArg);
        const valorTasa = exigirTasaIsn(tasaArg);
        const regimen = exigirRegimen(opts.regime);
        const exencion = exigirExencion(regimen, opts.exemption);
        const fundamento = exigirFundamento(opts.legalBasis);
        if (opts.effectiveFrom === undefined) {
          throw usageError({ key: 'payroll.isn_rate_set.effective_from_missing' });
        }
        const desde = exigirFechaIsn('--effective-from', opts.effectiveFrom);
        const hasta =
          opts.supersededOn === undefined
            ? null
            : exigirFechaIsn('--superseded-on', opts.supersededOn);
        if (hasta !== null && hasta <= desde) {
          throw usageError({ key: 'payroll.isn_rate_set.superseded_before', params: { to: hasta, from: desde } });
        }

        const ctx = await entidadParaEscribir(opts);

        // De qué columna sale el estado lo decide el PANEL, y aquí sólo se
        // lee: `isn_estado_que_causa`. Su respuesta no cambia lo que se
        // escribe —la tabla es catálogo—, cambia CONTRA QUÉ se comprueba que
        // la clave sirva, que es la mitad del valor de esta hoja.
        const politica = await getPolicy(
          { tenantId: ctx.tenantId, entityId: ctx.entityId },
          'isn_estado_que_causa'
        );
        const criterio =
          politica.value === 'domicilio_fiscal' ? 'domicilio_fiscal' : 'centro_de_trabajo';

        const cobertura = await coberturaDeClave(
          ctx.tenantId,
          ctx.entityId,
          estado,
          criterio,
          politica.defined
        );
        const yaCapturadas = await todasLasVigencias(estado);
        const choques = solapaCon(yaCapturadas, desde, hasta);

        const lineas = lineasDeLaCaptura({
          estado,
          tasa: valorTasa,
          regimen,
          exencion,
          desde,
          hasta,
          fundamento,
          cobertura,
          choques,
        });
        const err = process.stderr;
        err.write(`\n${c.bold(t('payroll.isn_rate_set.heading'))}\n`);
        const marks = [t('payroll.isn_rate_set.overlap'), t('payroll.isn_rate_set.nobody')];
        for (const l of lineas) {
          err.write(`${marks.some((m) => l.includes(m)) ? c.yellow(l) : c.dim(l)}\n`);
        }
        if (regimen !== 'tasa_plana') {
          err.write(c.yellow(`  ${t('payroll.isn_rate_set.regime_not_computed', { regime: regimen })}\n`));
        }
        err.write('\n');

        if (dryRun) {
          // EL ENSAYO IMPRIME LA FILA QUE ESCRIBIRÍA, con la MISMA forma que la
          // real. Un `--dry-run --json` que no imprimiera nada dejaría al guion
          // que revisa la captura sin nada que revisar, y un ensayo con otra
          // forma que la escritura no serviría para compararlos.
          render(
            [
              filaDeTasa({
                estado,
                vigenciaDesde: desde,
                vigenciaHasta: hasta,
                tasa: valorTasa,
                regimen,
                exencionMensual: exencion,
                fundamento,
              }),
            ],
            { ...opts, idField: 'estado' }
          );
          err.write(c.dim(`${t('payroll.isn_rate_set.dry_run')}\n`));
          return ExitCode.OK;
        }

        // El solape se rechaza AQUÍ además de en la base, para no gastar una
        // confirmación humana en una escritura que el disparador va a tirar.
        if (choques.length > 0) {
          const clashes = choques
            .map((v) => t('payroll.isn_rate_set.clash', { from: v.vigenciaDesde, to: v.vigenciaHasta ?? t('payroll.isn.open_end'), rate: v.tasa }))
            .join(', ');
          throw validationFailed(
            { key: 'payroll.isn_rate_set.overlap_refused', params: { state: estado, count: choques.length, from: desde, to: hasta ?? 'none', clashes } },
            { estado, choques: choques.length }
          );
        }

        if (opts.yes !== true) {
          const ok = await ask(t('payroll.isn_rate_set.confirm', { state: estado, rate: valorTasa, from: desde }));
          if (!ok) {
            throw abortedByUser({ key: stdin.isTTY ? 'payroll.isn_rate_set.aborted' : 'payroll.isn_rate_set.aborted_no_terminal' });
          }
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        let fila: TasaIsn;
        try {
          // La tabla es CATÁLOGO y no lleva tenant_id —la ley es la misma para
          // todos los inquilinos, como en inpc_serie o sat_bancos—, así que no
          // hay frontera de inquilino que acotar en este SQL. Lo que sí queda
          // es QUIÉN capturó, que es la única cota real de una escritura
          // compartida: `capturado_por`.
          const r = await query<{
            estado: string;
            vigencia_desde: string;
            vigencia_hasta: string | null;
            tasa: string;
            regimen: RegimenIsn;
            exencion_mensual: string | null;
            fundamento: string;
          }>(
            `INSERT INTO mx_isn_tasas_estatales
               (estado, vigencia_desde, vigencia_hasta, tasa, regimen, exencion_mensual,
                fundamento, capturado_por)
             VALUES ($1, $2::date, $3::date, $4, $5, $6, $7, $8)
             RETURNING estado,
                       vigencia_desde::text AS vigencia_desde,
                       vigencia_hasta::text AS vigencia_hasta,
                       tasa::text AS tasa,
                       regimen,
                       exencion_mensual::text AS exencion_mensual,
                       fundamento`,
            [estado, desde, hasta, valorTasa, regimen, exencion, fundamento, reviewer.userId]
          );
          const f = r.rows[0];
          fila = {
            estado: f.estado,
            vigenciaDesde: f.vigencia_desde,
            vigenciaHasta: f.vigencia_hasta,
            tasa: f.tasa,
            regimen: f.regimen,
            exencionMensual: f.exencion_mensual,
            fundamento: f.fundamento,
          };
        } catch (e) {
          throw traducirErrorDeCaptura(e, estado, desde);
        }

        render([filaDeTasa(fila)], { ...opts, idField: 'estado' });
        if (legible(opts)) {
          const captured = { state: estado, rate: fila.tasa, from: fila.vigenciaDesde, to: fila.vigenciaHasta ?? 'none' };
          err.write(c.green(`${t('payroll.isn_rate_set.captured', captured)}\n`));
        }
        return ExitCode.OK;
      })
  );

  // ---- isn rate list · isn tasa listar ---------------------------------
  const listar = describeCommand(tasa.command('list').alias('listar'), 'help.isn.rate.list.description');
  withContext(listar);
  withOutput(listar);
  // LAS CUATRO BANDERAS DE SELECCIÓN SE DECLARAN A MANO Y NO CON
  // `withSelection`, POR LA MISMA RAZÓN QUE EN `prepaid list`: ese grupo trae
  // `-s/--status`, y una vigencia de tasa NO tiene ciclo de vida — ni se
  // archiva, ni se cancela, ni se aprueba. Una `--status` que no filtra nada es
  // la bandera declarada que nadie lee, el defecto que este repositorio ya cazó
  // en `ap reconcile`. Y `-a/--all` se documenta por lo que de verdad hace
  // aquí: quitar la ventana de `--as-of`, es decir, enseñar la historia.
  optionByKey(listar, '-n, --limit <n>', 'help.isn.rate.list.option.limit', { parser: enteroNoNegativo('--limit') });
  optionByKey(listar, '--offset <n>', 'help.isn.rate.list.option.offset', { parser: enteroNoNegativo('--offset') });
  optionByKey(listar, '-a, --all', 'help.isn.rate.list.option.all');
  optionByKey(listar, '--state <key>', 'help.isn.rate.list.option.state');
  optionByKey(listar, '--as-of <date>', 'help.isn.rate.list.option.as_of');
  declareRisk(listar, { risk: 'lectura', agent: true });
  listar.addHelpText('after', EJEMPLOS.rateList);
  listar.action(
    (
      opts: CommonOpts & {
        state?: string;
        asOf?: string;
        limit?: number;
        offset?: number;
        all?: boolean;
      }
    ) =>
      run(async () => {
        const estado = opts.state === undefined ? undefined : exigirClaveDeEstado(opts.state);
        const alDia = opts.asOf === undefined ? hoyLocal() : exigirFechaIsn('--as-of', opts.asOf);
        bootstrapTenant(opts.tenant);

        // La frontera aquí no es de inquilino —la tabla es catálogo— sino de
        // TIEMPO: sin `-a` sólo sale la vigencia que rige al día pedido, que es
        // lo que un contador necesita para cerrar el mes. Con `-a` sale la
        // historia, que es lo que necesita para entender un cambio de tasa.
        const filas = await todasLasVigencias(estado);
        const vistas =
          opts.all === true
            ? filas
            : filas.filter(
                (t) => t.vigenciaDesde <= alDia && (t.vigenciaHasta === null || t.vigenciaHasta > alDia)
              );
        const desde = opts.offset ?? 0;
        const pagina =
          opts.all === true || opts.limit === undefined
            ? vistas.slice(desde)
            : vistas.slice(desde, desde + opts.limit);

        render(
          pagina.map((t) => filaDeTasa(t, alDia)),
          { ...opts, idField: 'estado', total: vistas.length, numeric: ['tasa', 'exencion_mensual'] }
        );

        if (legible(opts) && vistas.length === 0) {
          const err = process.stderr;
          const why =
            filas.length === 0
              ? t('payroll.isn_rate_list.none_captured')
              : t('payroll.isn_rate_list.none_in_force', { date: alDia, state: estado ?? 'none', count: filas.length });
          err.write(c.yellow(`  ${why}\n`));
          const command = 'mnemosine isn rate set <STATE> <rate> --effective-from <date> --legal-basis "<law, article, gazette>"';
          err.write(c.dim(`  ${t('payroll.isn_rate_list.capture_hint', { command })}\n`));
        }
        return ExitCode.OK;
      })
  );

  // ---- isn calculate · isn calcular ------------------------------------
  const calcular = describeCommand(familia.command('calculate').alias('calcular'), 'help.isn.calculate.description');
  withContext(calcular);
  withOutput(calcular);
  withStrict(calcular);
  optionByKey(calcular, '--run <payRunId>', 'help.isn.calculate.option.run');
  optionByKey(calcular, '--state <key>', 'help.isn.calculate.option.state');
  declareRisk(calcular, { risk: 'lectura', agent: true });
  calcular.addHelpText('after', EJEMPLOS.calculate);
  calcular.action(
    (opts: CommonOpts & { run?: string; state?: string; strict?: boolean }) =>
      run(async () => {
        if (opts.run === undefined || opts.run.trim() === '') {
          throw usageError({ key: 'payroll.isn_calculate.run_required' });
        }
        const payRunId = opts.run.trim();
        const filtro = opts.state === undefined ? undefined : exigirClaveDeEstado(opts.state);
        const ctx = await entidad(opts);

        // LAS DOS FRONTERAS VAN DENTRO DEL SQL: `pr.tenant_id` acota el
        // inquilino y `ps.entity_id` la entidad. Un id de corrida adivinado no
        // debe poder leer la nomina de la entidad hermana, y eso no se
        // consigue con un `if` despues de traer la fila.
        //
        // Las fechas salen como TEXTO: sin setTypeParser el driver convierte un
        // DATE en un Date a medianoche LOCAL, y el mes de causacion se corre en
        // cuanto la maquina no esta en UTC.
        const corrida = await query<{
          status: string;
          period_start: string;
          period_end: string;
          pay_date: string;
        }>(
          `SELECT pr.status,
                  pp.period_start::text AS period_start,
                  pp.period_end::text AS period_end,
                  pp.pay_date::text AS pay_date
             FROM pay_runs pr
             JOIN pay_periods pp ON pp.id = pr.pay_period_id AND pp.tenant_id = pr.tenant_id
             JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id AND ps.tenant_id = pp.tenant_id
            WHERE pr.id = $1 AND pr.tenant_id = $2 AND ps.entity_id = $3`,
          [payRunId, ctx.tenantId, ctx.entityId]
        );
        if (corrida.rowCount === 0) {
          throw notFound({ key: 'payroll.isn_calculate.run_not_found', params: { id: payRunId } });
        }
        const r = corrida.rows[0];

        // `isn_momento_de_causacion` mueve la fecha con la que se ELIGE la
        // vigencia, y con un periodo que cruza el fin de mes las dos respuestas
        // dan tasas distintas. Se lee del panel; no se pregunta ni se elige.
        const pCausacion = await getPolicy(
          { tenantId: ctx.tenantId, entityId: ctx.entityId },
          'isn_momento_de_causacion'
        );
        const causacionPorPago = pCausacion.value === 'pago';
        const fechaCausacion = causacionPorPago ? r.pay_date : r.period_end;

        const { criterio, criterioDefinido, bases } = await basesIsnDeCorrida({
          tenantId: ctx.tenantId,
          entityId: ctx.entityId,
          payRunId,
        });
        const isn = await calcularIsn({
          bases,
          periodoInicio: r.period_start,
          periodoFin: r.period_end,
          fechaCausacion,
        });

        // EL FILTRO ES DE PRESENTACIÓN Y NUNCA ESCONDE UN HALLAZGO SIN ESTADO.
        // Un `--state JAL` que se tragara el hallazgo del trabajador sin estado
        // capturado dejaría al lector creyendo que sólo falta lo de Jalisco.
        const porEstado = filtro === undefined ? isn.porEstado : isn.porEstado.filter((x) => x.estado === filtro);
        const hallazgos =
          filtro === undefined
            ? isn.hallazgos
            : isn.hallazgos.filter((h) => h.estado == null || h.estado === filtro);
        const conteo = contarHallazgosDeNomina(hallazgos);
        const total = porEstado
          .reduce((s, x) => s.plus(x.importe), new Decimal(0))
          .toFixed(4);

        const err = process.stderr;
        const cabecera =
          `\n${c.bold(t('payroll.isn_calculate.heading', { id: payRunId }))}  ` +
          c.dim(`${t('payroll.isn_calculate.window', { start: r.period_start, end: r.period_end, status: r.status, date: fechaCausacion })}\n`) +
          c.dim(
            `  ${policyPair('isn_estado_que_causa', criterio, criterioDefinido)} · ` +
              `${policyPair('isn_momento_de_causacion', causacionPorPago ? 'pago' : 'devengo', pCausacion.defined)}\n`
          );

        if (legible(opts)) err.write(cabecera);
        if (!criterioDefinido || !pCausacion.defined) {
          // The panel keys travel inside the commands, untranslated.
          const define = (policy: string) => `mnemosine pending define ${policy}`;
          const commands = { stateCommand: define('isn_estado_que_causa'), momentCommand: define('isn_momento_de_causacion') };
          err.write(c.yellow(`  ${t('payroll.isn_calculate.defaults_unanswered', commands)}\n`));
        }

        render(
          porEstado.map((x) => ({
            estado: x.estado,
            base: x.base,
            tasa: x.tasa,
            importe: x.importe,
            trabajadores: x.trabajadores,
            vigencia_desde: x.vigenciaDesde,
            fundamento: x.fundamento,
          })),
          { ...opts, idField: 'estado', numeric: ['base', 'tasa', 'importe', 'trabajadores'] }
        );

        const lineas = renderHallazgos(
          hallazgos.map((h: HallazgoNomina) => ({
            severity: h.severidad === 'bloqueante' ? 'blocking' : 'warning',
            nombre: h.codigo,
            referencia: h.estado ?? '',
            detalle: findingText(h, getLanguage()),
          })),
          c
        );
        if (lineas.length > 0) {
          err.write('\n');
          for (const l of lineas) err.write(`${l}\n`);
        }
        if (legible(opts)) {
          err.write(
            '\n' +
              c.bold(`  ${t('payroll.isn_calculate.total', { amount: formatMoneyMx(total), count: porEstado.length })}\n`) +
              c.dim(
                `  ${t('payroll.isn_calculate.findings', { blocking: conteo.bloqueante, warnings: conteo.aviso })}\n` +
                  `  ${t('payroll.isn_calculate.not_accrued')}\n`
              )
          );
        }
        return checkExitCode(
          { blocking: conteo.bloqueante, warning: conteo.aviso },
          { strict: opts.strict }
        );
      })
  );
}

// ============================================================
// mnemosine tax-deposit · entero
// ============================================================

export function registerTaxDepositCommand(program: Command, deps: PayrollIsnCommandDeps): void {
  const { run, entidad, legible } = utilidades(deps);
  const c = deps.palette;

  const familia = describeCommand(program.command('tax-deposit').alias('entero'), 'help.tax_deposit.description');

  const listar = describeCommand(familia.command('list').alias('listar'), 'help.tax_deposit.list.description');
  withContext(listar);
  withOutput(listar);
  withSelection(listar);
  optionByKey(listar, '--period <YYYY-MM>', 'help.tax_deposit.list.option.period');
  optionByKey(listar, '--until <date>', 'help.tax_deposit.list.option.until');
  optionByKey(listar, '--all-entities', 'help.tax_deposit.list.option.all_entities');
  // LAS DOS DESCRIPCIONES QUE `withSelection` INYECTA NO DICEN LA VERDAD AQUÍ,
  // y una ayuda que promete algo distinto de lo que el código hace es la clase
  // de mentira que este repositorio ya cazó en `ap reconcile`. La GRAFÍA y la
  // forma corta las sigue gobernando el diccionario; lo que se corrige es lo
  // que la línea dice. `-a` no quita el tope de filas —lo quita no pasar
  // `-n`— y en esta tabla no hay nada «archivado»: hay depositado y dispensado.
  // MNE-001-239: the rewording goes by key, through describeOption (#314).
  {
    const todo = listar.options.find((o) => o.long === '--all');
    if (todo) describeOption(todo, 'help.tax_deposit.list.option.all');
    const estado = listar.options.find((o) => o.long === '--status');
    if (estado) {
      describeOption(estado, 'help.tax_deposit.list.option.status', { states: ESTADOS_DE_PASIVO.join('|') });
    }
  }
  declareRisk(listar, { risk: 'lectura', agent: true });
  listar.addHelpText('after', EJEMPLOS.depositList);
  listar.action(
    (
      opts: CommonOpts & {
        period?: string;
        until?: string;
        status?: string[];
        allEntities?: boolean;
        limit?: number;
        offset?: number;
        all?: boolean;
      }
    ) =>
      run(async () => {
        const mes = opts.period === undefined ? undefined : exigirMesDeNomina(opts.period);
        const ventana = mes === undefined ? undefined : rangoDelMes(mes.anio, mes.mes);
        const hasta = opts.until === undefined ? null : exigirFechaIsn('--until', opts.until);
        // `-a/--all` aquí significa «también lo ya saldado», no «sin tope de
        // filas»: en una tabla de impuestos lo interesante es lo que se debe, y
        // lo depositado es historia que entierra a los tres que vencen.
        const estados =
          opts.all === true && opts.status === undefined
            ? [...ESTADOS_DE_PASIVO]
            : exigirEstadosDePasivo(opts.status);

        const ctx = await entidad(opts);
        const soloEstaEntidad = opts.allEntities !== true;
        const hoy = hoyLocal();

        // LA FRONTERA DE INQUILINO VA DENTRO DEL SQL, SIEMPRE, y la de entidad
        // también salvo que se pida explícitamente lo contrario: `--all-entities`
        // amplía a las entidades DEL MISMO INQUILINO, nunca más allá, porque
        // `l.tenant_id = $1` no es opcional en ninguna rama.
        const filtros =
          `l.tenant_id = $1
             AND ($2::uuid IS NULL OR l.entity_id = $2::uuid)
             AND ($3::date IS NULL OR l.period_end >= $3::date)
             AND ($4::date IS NULL OR l.period_start <= $4::date)
             AND ($5::date IS NULL OR l.due_date <= $5::date)
             AND l.status = ANY($6::text[])`;
        const params = [
          ctx.tenantId,
          soloEstaEntidad ? ctx.entityId : null,
          ventana?.desde ?? null,
          ventana?.hasta ?? null,
          hasta,
          estados,
        ];

        // El total se cuenta aparte para que `render` pueda decir la verdad
        // sobre el truncado: un `--limit` que recorta en silencio produce un
        // pasivo incompleto, que es la clase de dato que nadie vuelve a mirar.
        const cuenta = await query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM employer_tax_liabilities l WHERE ${filtros}`,
          params
        );
        const total = Number(cuenta.rows[0]?.total ?? '0');

        const limite = opts.limit ?? null;
        const salto = opts.offset ?? 0;
        const filas = await query<FilaPasivoPatronal>(
          `SELECT l.id,
                  le.name AS entidad,
                  l.pay_run_id,
                  l.tax_type,
                  l.jurisdiction,
                  l.period_start::text AS period_start,
                  l.period_end::text AS period_end,
                  l.amount::text AS amount,
                  l.due_date::text AS due_date,
                  l.deposit_frequency,
                  l.status,
                  l.deposited_at,
                  l.deposit_reference
             FROM employer_tax_liabilities l
             JOIN legal_entities le ON le.id = l.entity_id AND le.tenant_id = l.tenant_id
            WHERE ${filtros}
            ORDER BY l.due_date ASC, l.tax_type ASC, l.jurisdiction ASC
            LIMIT $7::int OFFSET $8::int`,
          [...params, limite, salto]
        );

        const pintadas = filas.rows.map((f) => filaDePasivo(f, hoy));
        render(pintadas, {
          ...opts,
          idField: 'id',
          total,
          numeric: ['importe', 'dias'],
        });

        if (!legible(opts)) return ExitCode.OK;

        const err = process.stderr;
        if (total === 0) {
          err.write(c.yellow(`  ${t('payroll.tax_deposit.none')}\n`));
          return ExitCode.OK;
        }

        const vencidos = pintadas.filter((p) => p.vencido === true);
        const suma = pintadas
          .reduce((s, p) => s.plus(String(p.importe)), new Decimal(0))
          .toFixed(2);
        const summary = { shown: pintadas.length, total, amount: formatMoneyMx(suma), statuses: estados.join(','), scope: soloEstaEntidad ? 'entity' : 'all' };
        err.write(c.dim(`  ${t('payroll.tax_deposit.summary', summary)}\n`));
        if (vencidos.length > 0) {
          err.write(c.red(`  ${t('payroll.tax_deposit.overdue', { count: vencidos.length })}\n`));
        }
        err.write(c.dim(`  ${t('payroll.tax_deposit.due_date_rule')}\n`));
        return ExitCode.OK;
      })
  );
}

// ------------------------------------------------------------
// LAS DOS LECTURAS QUE ESTE ARCHIVO HACE POR SU CUENTA
// ------------------------------------------------------------

/**
 * Todas las vigencias capturadas, opcionalmente de un estado.
 *
 * `vigenciasDeIsn` del motor sirve para UN estado y UN periodo, que es lo que
 * el cálculo necesita; el catálogo completo —para listar y para detectar
 * solapes contra toda la historia de un estado— no tiene lector allí, y este
 * SQL es el mismo con el filtro de periodo quitado. El día que el motor
 * publique un lector de catálogo, esto lo llama y se borra.
 *
 * Las fechas salen como TEXTO por la misma razón que en el motor: un DATE
 * convertido a Date a medianoche local corre el día entero fuera de UTC.
 */
async function todasLasVigencias(estado?: string): Promise<TasaIsn[]> {
  const r = await query<{
    estado: string;
    vigencia_desde: string;
    vigencia_hasta: string | null;
    tasa: string;
    regimen: RegimenIsn;
    exencion_mensual: string | null;
    fundamento: string;
  }>(
    `SELECT estado,
            vigencia_desde::text AS vigencia_desde,
            vigencia_hasta::text AS vigencia_hasta,
            tasa::text AS tasa,
            regimen,
            exencion_mensual::text AS exencion_mensual,
            fundamento
       FROM mx_isn_tasas_estatales
      WHERE ($1::text IS NULL OR estado = $1::text)
      ORDER BY estado, vigencia_desde`,
    [estado ?? null]
  );
  return r.rows.map((f) => ({
    estado: f.estado,
    vigenciaDesde: f.vigencia_desde,
    vigenciaHasta: f.vigencia_hasta,
    tasa: f.tasa,
    regimen: f.regimen,
    exencionMensual: f.exencion_mensual,
    fundamento: f.fundamento,
  }));
}

/**
 * ¿A cuántos trabajadores alcanza la clave que se va a capturar?
 *
 * Lee la MISMA columna que el motor leerá al calcular, elegida por la misma
 * política. Sin esto, capturar «JAL» sobre una plantilla cuyo `work_state` dice
 * «JA» se ve exactamente igual que capturarla bien: la escritura funciona, y el
 * fallo aparece un mes después como `isn_sin_tasa_capturada` sobre una tasa que
 * está capturada.
 *
 * Las dos fronteras van dentro del SQL. Los dados de baja quedan fuera: una
 * tasa que sólo alcanza a gente que ya no está no alcanza a nadie.
 */
async function coberturaDeClave(
  tenantId: string,
  entityId: string,
  estado: string,
  criterio: 'centro_de_trabajo' | 'domicilio_fiscal',
  criterioDefinido: boolean
): Promise<CoberturaDeClave> {
  const sql =
    criterio === 'domicilio_fiscal'
      ? `SELECT UPPER(TRIM(COALESCE(le.state_province, ''))) AS clave,
                COUNT(e.id)::int AS trabajadores
           FROM legal_entities le
           LEFT JOIN employees e
                  ON e.entity_id = le.id AND e.tenant_id = le.tenant_id
                 AND e.country_code = 'MX' AND e.status <> 'terminated'
          WHERE le.tenant_id = $1 AND le.id = $2
          GROUP BY 1`
      : `SELECT UPPER(TRIM(COALESCE(e.work_state, ''))) AS clave,
                COUNT(*)::int AS trabajadores
           FROM employees e
          WHERE e.tenant_id = $1 AND e.entity_id = $2
            AND e.country_code = 'MX' AND e.status <> 'terminated'
          GROUP BY 1
          ORDER BY 2 DESC`;
  const r = await query<{ clave: string; trabajadores: number }>(sql, [tenantId, entityId]);
  const propia = r.rows.find((f) => f.clave === estado);
  return {
    criterio,
    criterioDefinido,
    alcanzados: propia?.trabajadores ?? 0,
    otras: r.rows.filter((f) => f.clave !== estado).map((f) => ({ clave: f.clave, trabajadores: f.trabajadores })),
  };
}

// El motor publica `vigenciasDeIsn` para el cálculo; se reexporta para que un
// consumidor de esta capa no tenga que saber en qué archivo vive el lector
// acotado por periodo cuando ya conoce el de esta familia.
export { vigenciasDeIsn };
