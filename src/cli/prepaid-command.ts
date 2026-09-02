import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import Decimal from 'decimal.js';
import { InvalidArgumentError, type Command } from 'commander';
import { confirmarConReintento, noEntendi } from './kernel/confirmacion.js';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { resolveAccount } from '../services/accounting/account-service.js';
import { resolvePeriod } from '../services/accounting/fiscal-calendar-service.js';
import { conLlave, hashDeCarga } from '../services/idempotency/idempotency-store.js';
import { indiceDeCalendario, primerDiaDelMes } from '../services/assets/depreciation-math.js';
import {
  CONVENCIONES_AMORTIZACION,
  calcularAmortizacion,
  esConvencionDeAmortizacion,
  esImporteCero,
  type AmortizationResult,
  type ConvencionAmortizacion,
} from '../services/accruals/amortization-math.js';
import {
  anticiposActivos,
  criteriosDeAnticipo,
  huecoDeAnticipados,
  medianocheLocal,
  registrarPagoAnticipado,
  revisionDeAmortizacionAlCierre,
  type CriteriosDeAnticipo,
  type PrepaidExpenseRow,
} from '../services/accruals/prepaid-service.js';
import {
  fechaDelAsiento,
  periodoDeLaCorrida,
  runMonthlyAmortization,
} from '../services/accruals/amortization-run.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  abortedByUser,
  dateOnly,
  declareRisk,
  exitCodeFor,
  gateMutation,
  notFound,
  render,
  requireExplicitEntity,
  resolveActiveEntity,
  usageError,
  validationFailed,
  withContext,
  withForce,
  withNote,
  withOutput,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine prepaid · pago-anticipado
//
// LA FAMILIA QUE FALTABA DEL OTRO LADO DE UNA PROMESA. La cuenta «1160 Pagos
// Anticipados» se siembra desde hace años con la descripción «…se devengan mes
// a mes» (account-roles-seed.ts:72-75) y el camino de ESCRITURA está vivo: el
// clasificador de CFDI ofrece «Prepaid expenses» y manda el importe a la 1160.
// El de LECTURA no existía —ni tabla, ni motor, ni comando—, así que el gasto
// no llegaba nunca al resultado y el balance cuadraba todos los meses. La 059 y
// `services/accruals` pusieron el motor; estas cuatro hojas son la puerta.
//
// SIETE DECISIONES QUE NO SON DE ESTILO.
//
// LA PRIMERA · `create` NO POSTEA NADA, Y POR ESO ES `escritura` Y NO
// `irreversible`. El módulo nunca carga la 1160: ADOPTA un saldo que ya está en
// el mayor —lo puso el CFDI capitalizado como anticipado, o un asiento manual—.
// Si el alta posteara el cargo, un anticipo dado de alta sobre una factura ya
// contabilizada cargaría la 1160 dos veces. Lo que escribe es la cabecera del
// calendario; el mayor no se toca hasta `run`.
//
// LA SEGUNDA · `create --dry-run` NO ENSAYA-Y-DESHACE COMO `asset create`, Y
// HAY QUE DECIRLO. Allí el ensayo llama al servicio real dentro de una
// transacción y la aborta; aquí no se puede: `registrarPagoAnticipado` no
// admite un `client` y `query` abre su propia conexión (connection.ts:224-253),
// de modo que un `withTransaction` alrededor no envolvería nada y el ensayo
// escribiría de verdad. Así que el ensayo hace las MISMAS preguntas a las
// MISMAS funciones que el alta —`criteriosDeAnticipo` (panel), `resolveAccount`
// (cuentas), `calcularAmortizacion` (calendario)— y sólo se salta el INSERT. Lo
// único que no reproduce es la guarda del RESPALDO, que vive dentro del
// servicio y necesita el saldo posteado: el ensayo lo dice en voz alta en vez
// de fingir que la comprobó. El arreglo verdadero es un `planDeAnticipo` en el
// servicio, como `planDeDepreciacion` en F06a; es del frente del motor.
//
// LA TERCERA · `--convention` DECLARA, NO ELIGE — y por eso NO se llama
// `--method`. El catálogo escribe `--method straight-line-day|month|usage` en
// la fila de `prepaid create`. Tres cosas van mal con esa fila y ninguna es de
// nombre: (a) `usage` no existe —no hay captura de producción para un seguro—;
// (b) el vocabulario del motor es `proporcional_dias|meses_completos`, que la
// 059 puso en un CHECK; y (c) `--method` está congelada desde F06a como el
// método CONTABLE de depreciación, con otro juego de valores, y una grafía con
// dos vocabularios es exactamente lo que el diccionario existe para impedir.
// Además la convención NO la elige una orden: es criterio del despacho y vive
// en `amortizacion_anticipados_convencion`. La bandera declara sobre cuál se
// cree estar operando y se contrasta con el panel, igual que `--book`.
//
// LA CUARTA · EL UMBRAL SE RESPETA Y SE PUEDE FORZAR, PERO FORZAR DEJA RASTRO.
// `umbral_anticipado_mxn` es materialidad (NIF A-4): una suscripción de 900
// pesos partida en doce asientos de 75 cuesta más en teneduría que la precisión
// que compra. Por debajo del umbral el servicio DETIENE el alta; `--force`
// —que el núcleo obliga a acompañar de `--reason`— la deja pasar y el motivo
// queda escrito en las notas de la fila.
//
// LA QUINTA · `run` ES IRREVERSIBLE Y POR TANTO IA ✗. Postea al mayor de la
// 041, donde un asiento no se edita ni se borra: se corrige por reversa. El
// núcleo le inyecta `--dry-run`, `--yes` y `--idempotency-key`.
//
// LA SEXTA · SON N ASIENTOS, NO UNO. `runMonthlyAmortization` crea un asiento
// de ajuste por anticipo, de dos líneas: cargo al gasto, abono a la 1160. La
// vista previa lo numera para que se vea que son N y no una, porque el día que
// alguien quiera reversar la corrida son N reversas.
//
// LA SÉPTIMA · LA VISTA PREVIA DE `run` PREGUNTA LO MISMO QUE EL MOTOR, Y
// DESPUÉS SE COMPARA CONTRA LO QUE PASÓ. El motor no expone un plan, así que
// la previa se arma con SUS funciones puras —`calcularAmortizacion`,
// `indiceDeCalendario`, `esImporteCero`— y con `revisionDeAmortizacionAlCierre`
// para el freno de doble corrida, que es la única de las tres guardas que
// necesita la base. Queda un cálculo repetido: el tope contra el saldo
// remanente (`min(teórico, restante)`). Por eso, tras la corrida real, se
// COMPARA lo procesado contra lo que la previa prometió y se dice en voz alta
// si no coincide, en vez de descubrirlo en una balanza.
// ============================================================

export interface PrepaidCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Costura de prueba: responde la confirmación de `prepaid run`. */
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

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const IMPORTE_RE = /^\d+(\.\d+)?$/;

/**
 * Una bandera mal escrita es error de USO (2), no una validación de dominio
 * fallida (4). La ida y vuelta rechaza los días que no existen: JavaScript
 * acepta `2026-02-31` y lo corre al 3 de marzo, que es como una cobertura
 * acaba empezando un día que nadie tecleó.
 */
export function exigirFecha(flag: string, valor: string): string {
  const d = new Date(`${valor}T00:00:00Z`);
  if (!FECHA_RE.test(valor) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) {
    throw usageError(`${flag} debe ser una fecha real en formato YYYY-MM-DD; llegó "${valor}".`);
  }
  return valor;
}

/**
 * El dinero entra como CADENA con los cuatro decimales de `DECIMAL(19,4)`.
 * Con Decimal y no con Number: un importe de nueve cifras con cuatro decimales
 * pierde por el flotante justo lo que la columna guarda.
 */
export function exigirImporte(flag: string, valor: string): string {
  const limpio = valor.trim().replace(/,/g, '');
  if (!IMPORTE_RE.test(limpio)) {
    throw usageError(
      `${flag} debe ser un importe decimal sin signo; llegó "${valor}". El punto separa los ` +
        'decimales y la coma se ignora: 1,250,000.50 y 1250000.50 son lo mismo.'
    );
  }
  return new Decimal(limpio).toFixed(4);
}

export function exigirPeriodo(periodo: string | undefined): string {
  if (!periodo) {
    throw usageError(
      'Falta --period. La amortización es de un mes concreto y no se adivina del reloj: correr ' +
        '«el periodo actual» un día 1 a las 00:05 devengaría el mes que acaba de empezar.'
    );
  }
  return periodo;
}

export const ORIGENES_DE_ANTICIPO = ['cfdi', 'manual', 'saldo_preexistente'] as const;
export type OrigenDeAnticipo = (typeof ORIGENES_DE_ANTICIPO)[number];

/**
 * De dónde salió el cargo que ya está en la 1160. NO tiene valor por omisión,
 * por lo mismo que `--capitalized` en `asset create`: adoptar el cargo de una
 * factura, adoptar un saldo heredado que nadie reclama y anotar un pago que
 * alguien contabilizó a mano son tres hechos distintos, y suponer uno de los
 * tres deja el rastro apuntando a un asiento que no es.
 */
export function exigirOrigen(valor: string | undefined): OrigenDeAnticipo {
  if (valor === undefined) {
    throw usageError(
      `Falta --origin. Los tres orígenes son: ${ORIGENES_DE_ANTICIPO.join(', ')} — el CFDI que se ` +
        'clasificó como anticipado (exige --source-entry), el saldo que ya estaba en la 1160 sin ' +
        'calendario, y el pago que se contabilizó a mano. No tiene valor por omisión: suponerlo ' +
        'deja el rastro apuntando a un asiento que no es.'
    );
  }
  const v = valor.trim().toLowerCase();
  if (!(ORIGENES_DE_ANTICIPO as readonly string[]).includes(v)) {
    throw usageError(`--origin "${valor}" no existe. Los tres son: ${ORIGENES_DE_ANTICIPO.join(', ')}.`);
  }
  return v as OrigenDeAnticipo;
}

/**
 * Rechaza una `--convention` que contradice al panel.
 *
 * Devuelve la del panel para que el llamador la imprima. Nunca la de la
 * bandera: cuál de los dos recortes del calendario se postea es criterio del
 * despacho, y una bandera que lo sobreescribiera dejaría que cada orden pusiera
 * un criterio contable distinto sin que nadie lo viera. Mismo trato que
 * `--book` en `asset create` (exigirLibroDelPanel).
 */
export function exigirConvencionDelPanel(
  declarada: string | undefined,
  criterios: { convencion: ConvencionAmortizacion; convencionDefinida: boolean }
): ConvencionAmortizacion {
  if (declarada === undefined) return criterios.convencion;
  const pedida = declarada.trim().toLowerCase();
  if (!esConvencionDeAmortizacion(pedida)) {
    throw usageError(
      `--convention "${declarada}" no existe: las dos convenciones son ` +
        `${CONVENCIONES_AMORTIZACION.join(' y ')} (los días que cada mes cubre, o el mes entero).`
    );
  }
  if (pedida !== criterios.convencion) {
    throw validationFailed(
      `--convention ${pedida} contradice al panel: \`amortizacion_anticipados_convencion\` vale ` +
        `"${criterios.convencion}"${criterios.convencionDefinida ? '' : ' (defecto declarado, nadie ha contestado)'}, ` +
        'y es lo que se congela en el calendario. Esta bandera declara con qué convención crees ' +
        'estar dando de alta, no la elige: se cambia con `mnemosine pending resolve ' +
        'amortizacion_anticipados_convencion`.'
    );
  }
  return criterios.convencion;
}

// ---- Las filas que se imprimen ------------------------------------------

/** El calendario teórico, renglón a renglón. */
export function filasDelCalendario(calendario: AmortizationResult[]): Row[] {
  return calendario.map((r) => ({
    periodo: r.period_number,
    indice: r.indice_calendario,
    mes: r.period_start_date,
    cobertura_inicio: r.coverage_start_date,
    cobertura_fin: r.coverage_end_date,
    dias: r.days_covered,
    amortizacion: r.amortization_amount,
    acumulada: r.accumulated_amortization,
    saldo: r.remaining_balance,
  }));
}

/**
 * Cuántos renglones del calendario quedan por delante de una fecha.
 *
 * Se cuenta sobre el calendario TEÓRICO y no sobre lo posteado, y por eso la
 * columna se llama así y no «meses que faltan por devengar»: el motor no
 * expone un lector de `prepaid_amortization_schedules`, de modo que un mes
 * saltado sigue contando aquí como pasado. Lo que sí es del mayor —cuánto se
 * lleva devengado— viaja en su propia columna.
 */
export function periodosRestantes(calendario: AmortizationResult[], alDia: Date): number {
  return calendario.filter((r) => r.period_end_date.getTime() >= alDia.getTime()).length;
}

/** El calendario de un anticipo, o null si su convención guardada no se entiende. */
function calendarioDe(a: PrepaidExpenseRow): AmortizationResult[] | null {
  if (!esConvencionDeAmortizacion(a.amortization_convention)) return null;
  return calcularAmortizacion({
    importe: a.total_amount,
    inicio: medianocheLocal(a.coverage_start_date),
    fin: medianocheLocal(a.coverage_end_date),
    convencion: a.amortization_convention,
  });
}

export function filasDeAnticipos(anticipos: PrepaidExpenseRow[], alDia: Date): Row[] {
  return anticipos.map((a) => {
    const calendario = calendarioDe(a);
    return {
      id: a.id,
      description: a.description,
      vendor: a.vendor_name ?? '',
      total_amount: a.total_amount,
      amortized_to_date: a.amortized_to_date,
      remaining_amount: a.remaining_amount,
      coverage_start: a.coverage_start_date,
      coverage_end: a.coverage_end_date,
      convencion: a.amortization_convention,
      periodos: calendario === null ? '' : calendario.length,
      periodos_restantes: calendario === null ? '' : periodosRestantes(calendario, alDia),
      origen: a.origin,
      ultima_amortizacion: a.last_amortization_date,
    };
  });
}

// ---- La previa de la corrida --------------------------------------------

export interface RenglonPrevisto {
  estado: 'entra';
  id: string;
  description: string;
  convencion: ConvencionAmortizacion;
  indice: number;
  periodos: number;
  dias: number;
  /** Lo que el calendario dice que tocaría este mes. */
  teorico: string;
  /** Lo que se postearía: el teórico topado contra lo que queda. */
  importe: string;
  topado: boolean;
  expense_account_id: string;
  prepaid_account_id: string;
}

export interface RenglonOmitido {
  estado: 'omitido';
  id: string;
  description: string;
  motivo: string;
}

export type PrevisionDelPeriodo = RenglonPrevisto | RenglonOmitido;

/**
 * Qué haría la corrida con UN anticipo en UN periodo.
 *
 * Reproduce los pasos 2 y 3 de `devengarUnAnticipo` (amortization-run.ts) con
 * sus mismas funciones puras. El paso 1 —¿ya tiene renglón este mes?— no está
 * aquí: lo contesta la base y lo trae el llamador. Ver la SÉPTIMA decisión de
 * la cabecera: esto es una repetición conocida y por eso la corrida real se
 * compara contra la previa al terminar.
 */
export function renglonDelPeriodo(a: PrepaidExpenseRow, inicioDelPeriodo: Date): PrevisionDelPeriodo {
  const omitido = (motivo: string): RenglonOmitido => ({
    estado: 'omitido',
    id: a.id,
    description: a.description,
    motivo,
  });

  if (!esConvencionDeAmortizacion(a.amortization_convention)) {
    return omitido(`convención guardada desconocida ("${a.amortization_convention}")`);
  }
  const convencion: ConvencionAmortizacion = a.amortization_convention;
  const inicio = medianocheLocal(a.coverage_start_date);
  const calendario = calcularAmortizacion({
    importe: a.total_amount,
    inicio,
    fin: medianocheLocal(a.coverage_end_date),
    convencion,
  });

  // El índice es una diferencia de MESES DE CALENDARIO y no una división de
  // milisegundos: fue el defecto A de F06a, donde marzo repetía la fila de
  // febrero y desde abril el índice quedaba atrasado para siempre.
  const indice = indiceDeCalendario(primerDiaDelMes(inicio), inicioDelPeriodo);
  if (indice < 0) return omitido('la cobertura todavía no empieza');
  const fila = calendario[indice];
  if (!fila) return omitido('la cobertura ya terminó');
  if (esImporteCero(fila.amortization_amount)) return omitido('el renglón del mes es cero');

  const restante = new Decimal(a.remaining_amount);
  if (restante.lessThanOrEqualTo(0)) return omitido('no queda saldo por devengar');

  const teorico = new Decimal(fila.amortization_amount);
  const monto = teorico.greaterThan(restante) ? restante : teorico;
  return {
    estado: 'entra',
    id: a.id,
    description: a.description,
    convencion,
    indice,
    periodos: calendario.length,
    dias: fila.days_covered,
    teorico: teorico.toFixed(4),
    importe: monto.toFixed(4),
    topado: !monto.equals(teorico),
    expense_account_id: a.expense_account_id,
    prepaid_account_id: a.prepaid_account_id,
  };
}

/** Un renglón por anticipo, entre o no, con su motivo. */
export function filasPrevistas(previsiones: PrevisionDelPeriodo[]): Row[] {
  return previsiones.map((p) =>
    p.estado === 'entra'
      ? {
          id: p.id,
          description: p.description,
          estado: 'entra',
          motivo: '',
          convencion: p.convencion,
          indice: p.indice,
          periodos: p.periodos,
          dias: p.dias,
          amortizacion: p.importe,
          topado: p.topado ? p.teorico : '',
        }
      : {
          id: p.id,
          description: p.description,
          estado: 'omitido',
          motivo: p.motivo,
          convencion: '',
          indice: '',
          periodos: '',
          dias: '',
          amortizacion: '',
          topado: '',
        }
  );
}

/**
 * Las líneas de los asientos que la corrida crearía, anticipo por anticipo.
 *
 * Es la vista previa que el mayor inmutable exige: un asiento posteado no se
 * edita, así que la única oportunidad de mirarlo es antes. Las descripciones
 * son LITERALMENTE las que escribe `devengarUnAnticipo`, para que lo que se lee
 * aquí sea lo que quedará en el mayor.
 */
export function filasDelAsiento(
  entran: RenglonPrevisto[],
  fecha: Date,
  cuenta: (id: string) => string
): Row[] {
  const filas: Row[] = [];
  entran.forEach((r, i) => {
    const asiento = `${i + 1}/${entran.length}`;
    filas.push({
      asiento,
      fecha,
      anticipo: r.description,
      cuenta: cuenta(r.expense_account_id),
      descripcion: `Accrued expense - ${r.description}`,
      debe: r.importe,
      haber: '',
    });
    filas.push({
      asiento,
      fecha,
      anticipo: r.description,
      cuenta: cuenta(r.prepaid_account_id),
      descripcion: `Prepaid expenses - ${r.description}`,
      debe: '',
      haber: r.importe,
    });
  });
  return filas;
}

export function registerPrepaidCommand(program: Command, deps: PrepaidCommandDeps): void {
  const prepaid = program
    .command('prepaid')
    .alias('pago-anticipado')
    .description('Prepaid expenses: the schedule that takes them out of 1160, month by month');

  const run = async (fn: () => Promise<ExitCodeValue | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? 0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  const entityOf = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity(
      { entity: opts.entity },
      { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
    );
    return ctx;
  };

  /** Una escritura no adivina la entidad: la nombra o la tiene fijada. */
  const entityForWrite = async (opts: CommonOpts) => {
    // Inquilino PRIMERO: la resolución de entidad va acotada por RLS, así que
    // un --tenant aplicado después no resuelve nada.
    bootstrapTenant(opts.tenant);
    return requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
  };

  const ask = async (question: string): Promise<boolean> => {
    if (deps.confirm) return deps.confirm(question);
    if (!stdin.isTTY) return false;
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      // Por el kernel: la gramática de «sí» es una sola en todo el CLI y
      // entiende los dos idiomas. Una escrita a mano aquí volvería a contar
      // como NO un «sí» tecleado en español.
      const veredicto = await confirmarConReintento(
        (p) => rl.question(p).catch(() => null),
        deps.palette.cyan(`${question} [y/N] `)
      );
      if (veredicto.incomprendida !== undefined) {
        process.stderr.write(`${noEntendi(veredicto.incomprendida)}; lo tomo como no.\n`);
      }
      return veredicto.si;
    } finally {
      rl.close();
    }
  };

  /** Cede la ficha escrita a mano en cuanto el usuario pide otra forma. */
  const legible = (opts: CommonOpts): boolean =>
    !opts.json &&
    (opts.format ?? 'table') === 'table' &&
    !opts.quiet &&
    opts.output === undefined &&
    opts.fields === undefined;

  /**
   * El aviso de la deuda heredada.
   *
   * Va siempre a stderr y en todos los formatos: el hueco no es una fila de la
   * tabla —es dinero que NINGUNA fila reclama—, y esconderlo en la salida
   * legible lo dejaría invisible justo para quien lee con `--json`.
   */
  const avisoDelHueco = async (entityId: string): Promise<void> => {
    const hueco = await huecoDeAnticipados(entityId);
    if (!hueco.hayHueco) return;
    process.stderr.write(
      deps.palette.yellow(
        `  ⚠ ${new Decimal(hueco.hueco).toFixed(2)} MXN posteados en la cuenta de pagos ` +
          `anticipados que ningún calendario va a devengar, en ${hueco.asientos.length} asiento(s). ` +
          'Ese gasto no llegará nunca al resultado. Cada asiento se adopta con `mnemosine prepaid ' +
          'create --origin saldo_preexistente --source-entry <id> --start <fecha> --end <fecha>`, ' +
          'con la ventana de cobertura que diga el documento — no se adivina: vive en la póliza, ' +
          'no en el CFDI.\n'
      )
    );
    for (const a of hueco.asientos) {
      process.stderr.write(
        deps.palette.dim(
          `      · ${a.entry_number} ${new Decimal(a.cargo).toFixed(2)} — ${a.description ?? ''} [${a.journal_entry_id}]\n`
        )
      );
    }
  };

  const cabeceraDeCriterios = (criterios: CriteriosDeAnticipo): void => {
    process.stderr.write(
      deps.palette.dim(
        `convención ${criterios.convencion}${criterios.convencionDefinida ? '' : ' (defecto)'} · ` +
          `umbral ${new Decimal(criterios.umbral).toFixed(2)} MXN` +
          `${criterios.umbralDefinido ? '' : ' (defecto)'}\n`
      )
    );
    if (!criterios.convencionDefinida || !criterios.umbralDefinido) {
      process.stderr.write(
        deps.palette.yellow(
          '  ⚠ Rige al menos un defecto declarado y no una elección del despacho. Se contesta con ' +
            '`mnemosine pending resolve amortizacion_anticipados_convencion` / ' +
            '`umbral_anticipado_mxn`.\n'
        )
      );
    }
  };

  // ---- prepaid create --------------------------------------------------
  const crear = prepaid
    .command('create')
    .alias('crear')
    .argument('<description>', 'what the prepayment covers, as it will read in the entries')
    .description(
      'Register the amortisation schedule of a charge already sitting in prepaid expenses — posts nothing'
    );
  withContext(crear);
  withOutput(crear);
  withNote(crear);
  withForce(crear);
  crear
    .option('--amount <amount>', 'amount to accrue, as a decimal')
    .option('--start <date>', 'first day the coverage runs (YYYY-MM-DD)')
    .option('--end <date>', 'last day the coverage runs, inclusive (YYYY-MM-DD)')
    .option(
      `--origin <${ORIGENES_DE_ANTICIPO.join('|')}>`,
      'where the charge already in the account came from — no default'
    )
    .option('--source-entry <id>', 'the journal entry that charged the account; required with --origin cfdi')
    .option('--cfdi-uuid <uuid>', 'the CFDI this prepayment came in on, for the trail')
    .option('--vendor <name>', 'vendor name kept on the schedule')
    .option('--reference <text>', 'the document this points at: policy number, contract, order')
    .option(
      '--convention <convention>',
      `the convention you believe you are registering (${CONVENCIONES_AMORTIZACION.join('|')}); checked against the panel`
    )
    .option('--prepaid-account <idOrCode>', 'prepaid-expenses account the charge sits in (defaults to the `gasto_anticipado` role)')
    .option('--expense-account <idOrCode>', 'account the accrual will charge each month (defaults to the `gasto` role)')
    .option('--reason <text>', 'why the threshold is being overridden; required with --force')
    .option('--dry-run', 'show the schedule that would be registered; write nothing');
  // ESCRITURA de dato maestro, y el agente NO puede llamarla. `prepaid_expenses`
  // no es una cola de revisión y `declareRisk` sólo admite escritura + agente
  // con `draftOnly`, que aquí sería mentira. Misma resolución que `asset
  // create`, `customer create` e `invoice create`.
  declareRisk(crear, {
    risk: 'escritura',
    agent: false,
    writes: 'prepaid_expenses (la cabecera del calendario); ninguna póliza — el cargo ya está en el mayor',
  });
  crear.action((
    descripcion: string,
    opts: CommonOpts & {
      amount?: string;
      start?: string;
      end?: string;
      origin?: string;
      sourceEntry?: string;
      cfdiUuid?: string;
      vendor?: string;
      reference?: string;
      convention?: string;
      prepaidAccount?: string;
      expenseAccount?: string;
      note?: string;
      force?: boolean;
      reason?: string;
      dryRun?: boolean;
    },
    cmd: Command
  ) =>
    run(async () => {
      // La compuerta primero: es la que exige --reason junto a --force.
      const { dryRun, reason } = gateMutation(cmd, opts as unknown as Record<string, unknown>);

      // Las cuatro obligatorias se nombran JUNTAS: pedirlas de una en una
      // obliga a cuatro viajes por una orden que se teclea entera.
      const faltantes = [
        opts.amount ? null : '--amount',
        opts.start ? null : '--start',
        opts.end ? null : '--end',
        opts.origin ? null : '--origin',
      ].filter((f): f is string => f !== null);
      if (faltantes.length > 0) {
        throw usageError(
          `Faltan ${faltantes.join(', ')}. Un calendario sin importe, sin ventana de cobertura o ` +
            'sin decir de dónde salió el cargo no es una ficha incompleta: es una ficha que no se ' +
            'puede devengar ni cuadrar contra la cuenta.'
        );
      }

      const importe = exigirImporte('--amount', opts.amount as string);
      const inicio = exigirFecha('--start', opts.start as string);
      const fin = exigirFecha('--end', opts.end as string);
      const origen = exigirOrigen(opts.origin);
      if (origen === 'cfdi' && opts.sourceEntry === undefined) {
        throw usageError(
          '`--origin cfdi` exige `--source-entry <id>`: si el calendario nace de una factura ya ' +
            'contabilizada, el asiento que cargó la cuenta se conoce, y no anotarlo es perderlo ' +
            'para siempre.'
        );
      }

      const ctx = await entityForWrite(opts);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

      // Los criterios del panel se leen ANTES que nada, porque la convención
      // que se congela en la cabecera sale de ahí y la bandera sólo la declara.
      const criterios = await criteriosDeAnticipo(ctx.tenantId, ctx.entityId);
      const convencion = exigirConvencionDelPanel(opts.convention, criterios);

      // Las dos cuentas se aceptan por CÓDIGO o por id, y se resuelven DENTRO
      // de la entidad: `resolveAccount` lleva el `entity_id` en el SQL.
      const prepaidAccountId =
        opts.prepaidAccount === undefined
          ? undefined
          : (await resolveAccount(ctx.entityId, opts.prepaidAccount)).id;
      const expenseAccountId =
        opts.expenseAccount === undefined
          ? undefined
          : (await resolveAccount(ctx.entityId, opts.expenseAccount)).id;

      cabeceraDeCriterios(criterios);

      if (dryRun) {
        // EL ENSAYO. Ver la SEGUNDA decisión de la cabecera: se hacen las
        // mismas preguntas a las mismas funciones y se salta el INSERT. Lo
        // único que no se reproduce es la guarda del respaldo, y se dice.
        const calendario = calcularAmortizacion({
          importe,
          inicio: medianocheLocal(inicio),
          fin: medianocheLocal(fin),
          convencion,
        });
        render(filasDelCalendario(calendario), {
          ...opts,
          idField: 'periodo',
          numeric: ['amortizacion', 'acumulada', 'saldo', 'dias', 'periodo', 'indice'],
        });
        const err = process.stderr;
        const bajoUmbral = new Decimal(importe).lessThan(criterios.umbral);
        if (bajoUmbral && opts.force !== true) {
          err.write(
            deps.palette.yellow(
              `  ⚠ ${new Decimal(importe).toFixed(2)} queda por debajo del umbral de ` +
                `${new Decimal(criterios.umbral).toFixed(2)} MXN (\`umbral_anticipado_mxn\`): el ` +
                'alta real se detendría por materialidad (NIF A-4). Con --force y --reason se da ' +
                'de alta igual y el motivo queda escrito en la fila.\n'
            )
          );
        }
        err.write(
          deps.palette.dim(
            `Ensayo: no se escribió ninguna fila. ${calendario.length} renglón(es) por ` +
              `${new Decimal(importe).toFixed(2)} MXN, convención ${convencion}.\n`
          )
        );
        err.write(
          deps.palette.dim(
            'El ensayo NO comprueba el respaldo en la cuenta —cuánto saldo posteado queda sin ' +
              'calendario—: esa guarda vive dentro del alta y necesita el mayor. El alta real ' +
              'puede rechazar por ese motivo.\n'
          )
        );
        return ExitCode.OK;
      }

      const alta = await registrarPagoAnticipado({
        entityId: ctx.entityId,
        descripcion,
        importe,
        inicio,
        fin,
        origen,
        createdBy: reviewer.userId,
        proveedor: opts.vendor,
        referencia: opts.reference,
        cfdiUuid: opts.cfdiUuid,
        sourceJournalEntryId: opts.sourceEntry,
        cuentas:
          prepaidAccountId === undefined && expenseAccountId === undefined
            ? undefined
            : { prepaidAccountId, expenseAccountId },
        // El motivo del `--force` viaja a las notas: forzar el umbral es una
        // decisión humana explícita y tiene que quedar escrita en la fila, no
        // sólo en la bitácora.
        notas: [opts.note, reason ? `--force: ${reason}` : null].filter(Boolean).join(' · ') || undefined,
        forzarBajoUmbral: opts.force === true,
      });

      const fila: Row = {
        id: alta.anticipo.id,
        description: alta.anticipo.description,
        total_amount: alta.anticipo.total_amount,
        coverage_start: alta.anticipo.coverage_start_date,
        coverage_end: alta.anticipo.coverage_end_date,
        convencion: alta.anticipo.amortization_convention,
        periodos: alta.calendario.length,
        origen: alta.anticipo.origin,
        remaining_amount: alta.anticipo.remaining_amount,
        status: alta.anticipo.status,
      };
      // `--fields` lo aplica `render`, así que se honra también en la tabla por
      // omisión y no sólo en --json.
      render([fila], { ...opts, idField: 'id', numeric: ['total_amount', 'remaining_amount', 'periodos'] });

      const err = process.stderr;
      for (const aviso of alta.avisos) err.write(deps.palette.yellow(`  ⚠ ${aviso}\n`));
      if (legible(opts)) {
        err.write(
          deps.palette.green(
            `✔ Calendario de ${alta.calendario.length} renglón(es) dado de alta. El mayor no se ` +
              'tocó: el cargo ya estaba. Se devenga con `mnemosine prepaid run --period <mes>`.\n'
          )
        );
      }
      return ExitCode.OK;
    })
  );

  // ---- prepaid list ----------------------------------------------------
  const listar = prepaid
    .command('list')
    .alias('listar')
    .description('Live schedules with their remaining balance and how many periods are left');
  withContext(listar);
  withOutput(listar);
  // LAS CUATRO BANDERAS DE ESTA HOJA SE DECLARAN A MANO Y NO CON
  // `withSelection`, Y NO ES CAPRICHO: ese grupo trae también `-s/--status`, y
  // el lector que el motor expone (`anticiposActivos`) devuelve SÓLO los
  // vivos. Una `--status` que no filtra nada es la bandera declarada que nadie
  // lee — el defecto que este repositorio ya cazó en `ap reconcile`. Por lo
  // mismo `-a/--all` se documenta por lo que de verdad hace aquí: quitar la
  // ventana de `--as-of` y el tope de filas, no resucitar los cancelados.
  listar
    .option('-n, --limit <n>', 'maximum rows to return', enteroPositivo('--limit'))
    .option('--offset <n>', 'skip this many rows', enteroPositivo('--offset'))
    .option('-a, --all', 'every live schedule, including those not started yet and already ended')
    .option('--as-of <date>', 'only schedules whose coverage is open on this date (YYYY-MM-DD; default today)');
  declareRisk(listar, { risk: 'lectura', agent: true });
  listar.action((opts: CommonOpts & { limit?: number; offset?: number; all?: boolean; asOf?: string }) =>
    run(async () => {
      const alDia = medianocheLocal(opts.asOf === undefined ? new Date() : exigirFecha('--as-of', opts.asOf));
      const ctx = await entityOf(opts);
      const todos = await anticiposActivos(ctx.entityId);

      // EL FILTRO ES DE PRESENTACIÓN Y SE DICE. Las filas ya vienen acotadas
      // por entidad dentro del SQL; lo que se recorta aquí es la ventana de
      // cobertura, que se calcula de columnas que ya están en la fila.
      const enVentana = opts.all === true
        ? todos
        : todos.filter(
            (a) =>
              medianocheLocal(a.coverage_start_date).getTime() <= alDia.getTime() &&
              medianocheLocal(a.coverage_end_date).getTime() >= alDia.getTime()
          );
      const desde = opts.offset ?? 0;
      const pagina =
        opts.all === true || opts.limit === undefined
          ? enVentana.slice(desde)
          : enVentana.slice(desde, desde + opts.limit);

      render(filasDeAnticipos(pagina, alDia), {
        ...opts,
        idField: 'id',
        total: enVentana.length,
        numeric: ['total_amount', 'amortized_to_date', 'remaining_amount', 'periodos', 'periodos_restantes'],
      });

      if (legible(opts) && enVentana.length === 0) {
        process.stderr.write(
          deps.palette.dim(
            opts.all === true
              ? 'No hay ningún calendario vivo en esta entidad.\n'
              : `Ningún calendario cubre el ${dateOnly(alDia)}. Con -a se listan todos.\n`
          )
        );
      }
      // La deuda heredada al final, cuando el operador ya vio lo que SÍ tiene
      // calendario: es la comparación que hace que el número signifique algo.
      await avisoDelHueco(ctx.entityId);
      return ExitCode.OK;
    })
  );

  // ---- prepaid show ----------------------------------------------------
  const ver = prepaid
    .command('show')
    .alias('ver')
    .argument('<idOrDescription>', 'the schedule: its id, or enough of its description to be unambiguous')
    .description('One schedule with its period-by-period table');
  withContext(ver);
  withOutput(ver);
  declareRisk(ver, { risk: 'lectura', agent: true });
  ver.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const anticipo = elegirAnticipo(await anticiposActivos(ctx.entityId), ref);
      const calendario = calendarioDe(anticipo);
      if (calendario === null) {
        throw validationFailed(
          `El calendario "${anticipo.description}" guarda la convención ` +
            `"${anticipo.amortization_convention}", que no es ninguna de las declaradas ` +
            `(${CONVENCIONES_AMORTIZACION.join(', ')}). Ningún importe se puede calcular con ella.`
        );
      }

      render(filasDelCalendario(calendario), {
        ...opts,
        idField: 'periodo',
        numeric: ['amortizacion', 'acumulada', 'saldo', 'dias', 'periodo', 'indice'],
      });

      const err = process.stderr;
      err.write(
        deps.palette.dim(
          `${anticipo.description} · ${new Decimal(anticipo.total_amount).toFixed(2)} MXN · ` +
            `${anticipo.amortization_convention} · origen ${anticipo.origin} · ` +
            `devengado ${new Decimal(anticipo.amortized_to_date).toFixed(2)}, queda ` +
            `${new Decimal(anticipo.remaining_amount).toFixed(2)}\n`
        )
      );
      // LA TABLA ES EL CALENDARIO, NO LO POSTEADO, y la diferencia importa: el
      // motor no expone hoy un lector de `prepaid_amortization_schedules`, así
      // que no se puede marcar qué renglones ya tienen asiento. Lo que sí sale
      // del mayor es el devengado de arriba, que la corrida reescribe con la
      // SUMA de lo posteado. Decirlo evita leer esta tabla como un extracto.
      err.write(
        deps.palette.dim(
          'Los renglones son el calendario que la corrida seguirá, no lo ya posteado: lo posteado ' +
            'es el devengado de la línea anterior.\n'
        )
      );
      return ExitCode.OK;
    })
  );

  // ---- prepaid run -----------------------------------------------------
  const ejecutar = prepaid
    .command('run')
    .alias('ejecutar')
    .description('Post the month accrual — one adjusting entry per schedule, irreversible');
  withContext(ejecutar);
  withOutput(ejecutar);
  ejecutar.option('--period <expr>', 'period to accrue: 2026-08, or any unambiguous part of its name');
  // IRREVERSIBLE: postea al mayor de la 041, donde un asiento no se edita ni se
  // borra. El núcleo inyecta --dry-run, --yes y --idempotency-key, y
  // `declareRisk` REHÚSA arrancar si alguien intenta darle acceso al agente.
  declareRisk(ejecutar, {
    risk: 'irreversible',
    agent: false,
    writes:
      'journal_entries + journal_entry_lines (un asiento de ajuste por anticipo), ' +
      'prepaid_amortization_schedules, prepaid_expenses',
  });
  ejecutar.action((
    opts: CommonOpts & {
      period?: string;
      dryRun?: boolean;
      yes?: boolean;
      idempotencyKey?: string;
    },
    cmd: Command
  ) =>
    run(async () => {
      const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
      const ctx = await entityForWrite(opts);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const periodo = await resolvePeriod(ctx.entityId, exigirPeriodo(opts.period));

      // Las dos preguntas que el motor hace contra la base, hechas con SUS
      // funciones: el periodo acotado por entidad, y qué calendarios no tienen
      // todavía renglón en él. La revisión del cierre contesta exactamente el
      // freno de doble corrida; su veredicto de bloqueo NO se usa aquí —esta
      // hoja es la que repara lo que esa casilla denuncia, negarse a correr
      // porque hay pendientes sería negarse a arreglarlos—.
      const corrida = await periodoDeLaCorrida(ctx.entityId, periodo.id);
      const revision = await revisionDeAmortizacionAlCierre(ctx.entityId, periodo.id);
      const pendientes = new Set(revision.pendientes.map((p) => p.id));
      const vivos = await anticiposActivos(ctx.entityId);
      const candidatos = vivos.filter((a) => pendientes.has(a.id));
      const yaCorridos = vivos.length - candidatos.length;

      const previsiones = candidatos.map((a) => renglonDelPeriodo(a, corrida.inicio));
      const entran = previsiones.filter((p): p is RenglonPrevisto => p.estado === 'entra');
      const total = entran.reduce((s, r) => s.plus(r.importe), new Decimal(0));
      const fecha = fechaDelAsiento(corrida);

      const err = process.stderr;
      err.write(
        deps.palette.dim(
          `${corrida.nombre} (${dateOnly(corrida.inicio)}..${dateOnly(corrida.fin)}) · asientos ` +
            `con fecha ${dateOnly(fecha)} · ${entran.length} calendario(s) entran, ` +
            `${previsiones.length - entran.length} se omiten, ${yaCorridos} ya tienen renglón de ` +
            `este mes · total ${total.toFixed(4)}\n`
        )
      );

      if (entran.length === 0) {
        render(filasPrevistas(previsiones), { ...opts, idField: 'id' });
        err.write(
          deps.palette.dim(`Nada que devengar en ${corrida.nombre}: el mayor no se tocó.\n`)
        );
        return ExitCode.OK;
      }

      // Las cuentas se resuelven a CÓDIGO para la vista previa —un asiento que
      // enseña UUIDs no se puede revisar—, memoizadas: dos consultas y no dos
      // por anticipo.
      const codigos = new Map<string, string>();
      for (const id of new Set(entran.flatMap((r) => [r.expense_account_id, r.prepaid_account_id]))) {
        const cuenta = await resolveAccount(ctx.entityId, id);
        codigos.set(id, `${cuenta.code} ${cuenta.name}`);
      }

      // EL ASIENTO, ANTES DE CREARLO. En dry-run es toda la salida; en el
      // camino real es lo que se enseña antes de preguntar.
      render(filasDelAsiento(entran, fecha, (id) => codigos.get(id) ?? id), {
        ...opts,
        idField: 'asiento',
        numeric: ['debe', 'haber'],
      });
      if (legible(opts)) {
        for (const p of previsiones) {
          if (p.estado === 'omitido') {
            err.write(deps.palette.dim(`  · omitido ${p.description}: ${p.motivo}\n`));
          } else if (p.topado) {
            err.write(
              deps.palette.yellow(
                `  ⚠ ${p.description}: el renglón teórico es ${p.teorico} y se topa en ` +
                  `${p.importe} contra lo que queda por devengar.\n`
              )
            );
          }
        }
        err.write(
          deps.palette.dim(
            `${entran.length} asiento(s) de ajuste de dos líneas, uno por calendario — no uno de ` +
              `la corrida. Reversar esta corrida son ${entran.length} reversas.\n`
          )
        );
      }

      if (dryRun) {
        err.write(deps.palette.dim('Ensayo: el mayor no se tocó y no se escribió ningún renglón.\n'));
        return ExitCode.OK;
      }

      if (opts.yes !== true) {
        const ok = await ask(
          `¿Devengar ${total.toFixed(2)} MXN en ${entran.length} asiento(s) de ${corrida.nombre}? ` +
            'El mayor no admite deshacer.'
        );
        if (!ok) {
          throw abortedByUser(
            stdin.isTTY
              ? 'Sin cambios: el mayor no se tocó.'
              : 'Sin cambios: no hay terminal donde confirmar. Añade -y para devengar sin ' +
                'preguntar, o --dry-run para ver los asientos completos sin escribir nada.'
          );
        }
      }

      // `--idempotency-key`, HONRADA Y NO ANUNCIADA. La misma llave con la
      // misma carga devuelve el resultado GRABADO sin volver a correr. La carga
      // incluye el total previsto: reintentar la misma orden sobre otros
      // importes no es un reintento, es otra corrida.
      const { repetido, resultado } = await conLlave<{
        processed: number;
        total: string;
        skipped: number;
        errors: string[];
      }>(
        { tenantId: ctx.tenantId, entityId: ctx.entityId },
        {
          scope: 'prepaid run',
          clave: opts.idempotencyKey,
          payloadHash: hashDeCarga(ctx.entityId, corrida.id, entran.length, total.toFixed(4)),
        },
        // El resultado se copia a un objeto llano porque `conLlave` lo guarda
        // como JSON y su firma lo exige indexable; `ResultadoDeCorrida` es una
        // interfaz y no lleva índice implícito.
        async () => ({ ...(await runMonthlyAmortization(ctx.entityId, corrida.id, reviewer.userId)) })
      );

      if (repetido) {
        err.write(
          deps.palette.dim(
            'Llave de idempotencia ya consumada: se devuelve el resultado grabado y no se volvió ' +
              'a devengar.\n'
          )
        );
      }

      // LA COMPARACIÓN CONTRA LO QUE DE VERDAD PASÓ. La previa y el motor
      // comparten las funciones puras pero no el bucle, y ésta es la red que
      // impide que se separen en silencio (ver la SÉPTIMA decisión).
      if (!repetido && resultado.processed !== entran.length) {
        err.write(
          deps.palette.yellow(
            `  ⚠ La vista previa enseñaba ${entran.length} asiento(s) y la corrida hizo ` +
              `${resultado.processed}. La previa y el motor no coincidieron: revisa los errores ` +
              'antes de dar el mes por cerrado.\n'
          )
        );
      }
      if (!repetido && !new Decimal(resultado.total).equals(total)) {
        err.write(
          deps.palette.yellow(
            `  ⚠ La vista previa sumaba ${total.toFixed(4)} y la corrida devengó ` +
              `${resultado.total}.\n`
          )
        );
      }
      for (const e of resultado.errors) err.write(deps.palette.yellow(`  ⚠ ${e}\n`));
      err.write(
        deps.palette.green(
          `✔ ${resultado.processed} asiento(s) de devengo contabilizados en ${corrida.nombre} por ` +
            `${resultado.total}.\n`
        )
      );

      return resultado.errors.length > 0 ? ExitCode.VALIDATION : ExitCode.OK;
    })
  );
}

/**
 * El calendario que el operador nombró: por id exacto, o por un trozo de la
 * descripción que sólo case con uno.
 *
 * Ambiguo no es «el primero»: es una pregunta. Se enumeran los candidatos con
 * su id, porque el id siempre desambigua.
 */
export function elegirAnticipo(anticipos: PrepaidExpenseRow[], ref: string): PrepaidExpenseRow {
  const buscado = ref.trim().toLowerCase();
  const porId = anticipos.find((a) => a.id.toLowerCase() === buscado);
  if (porId) return porId;
  const candidatos = anticipos.filter((a) => a.description.toLowerCase().includes(buscado));
  if (candidatos.length === 1) return candidatos[0];
  if (candidatos.length === 0) {
    throw notFound(
      `No hay ningún calendario vivo que case con "${ref}" en esta entidad. ` +
        '`mnemosine prepaid list -a` los enumera todos.',
      ref
    );
  }
  throw usageError(
    `"${ref}" casa con ${candidatos.length} calendarios vivos: ` +
      candidatos.map((a) => `${a.description} [${a.id}]`).join(', ') +
      '. Nombra el id, o un trozo de descripción que sólo case con uno.'
  );
}

/**
 * Con `InvalidArgumentError` y no con `usageError`: Commander parsea las
 * banderas ANTES de entrar a la acción, así que un CliError lanzado aquí caería
 * fuera del `try` que traduce errores a códigos de salida.
 */
function enteroPositivo(nombre: string) {
  return (valor: string): number => {
    const n = Number(valor);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new InvalidArgumentError(`${nombre} must be a non-negative whole number; got "${valor}".`);
    }
    return n;
  };
}
