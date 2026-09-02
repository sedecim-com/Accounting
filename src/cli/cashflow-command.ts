import type { Command } from 'commander';
import Decimal from 'decimal.js';
import { bootstrapTenant, type AgentContext } from '../ai/context.js';
import { resolvePeriodRange } from '../services/reporting/report-service.js';
import {
  getCashFlowStatement,
  type CashFlowStatement,
  type LineaDeFlujo,
  type MetodoDeFlujo,
  type SeccionDeFlujo,
} from '../services/reporting/cash-flow-service.js';
import {
  movimientoRealDeEfectivo,
  type MovimientoRealDeEfectivo,
} from '../services/reporting/cash-flow-reconcile.js';
import {
  registerCashFlowReconcile,
  type ConstructorDeEstado,
} from './cashflow-reconcile-command.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withContext,
  withOutput,
  withTime,
  resolveActiveEntity,
  checkExitCode,
  usageError,
  exitCodeFor,
  ExitCode,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine cashflow · flujo — EL ESTADO DE FLUJOS DE EFECTIVO EN EL BINARIO
//
// Las dos filas de fase 1 del catálogo, y nada más:
//
//   generate  — construye el estado (NIF B-2 / ASC 230)
//   reconcile — lo amarra contra el efectivo real e imprime el residuo
//
// Hasta hoy este informe NO TENÍA COMANDO. Era el único que no se había
// extraído a `src/services/reporting/`: vivía entero dentro de la ruta REST,
// así que la única forma de obtener un estado de flujos era una petición
// HTTP — ni el humano en la terminal ni el agente lo tenían. Y lo que servía
// esa ruta era su silueta: `method` se aceptaba y se devolvía sin cambiar el
// cálculo, el financiamiento era la cadena '0.0000', y las cuentas por
// cobrar se buscaban con `name ILIKE '%receivable%'` contra un catálogo
// sembrado en español.
//
// LOS NÚMEROS NO SE CALCULAN AQUÍ. Los dos motores son
// `cash-flow-service.ts` (construye) y `cash-flow-reconcile.ts` (amarra);
// este archivo es la PUERTA. Lo único aritmético que hace es una resta —el
// residuo— y la hace con el mismo minuendo y sustraendo que
// `conciliarFlujoDeEfectivo`, en el mismo orden (derivado − real), para que
// las dos hojas de esta familia no puedan enseñar el mismo descuadre con el
// signo cambiado.
//
// ── POR QUÉ `generate` NO CONSTRUYE SU PROPIO ESTADO PARA `reconcile` ──
//
// `registerCashFlowReconcile` recibe el constructor INYECTADO. La raíz lo
// tiene a mano y se lo pasa, así que las dos hojas emiten forzosamente la
// misma cifra: si cada una resolviera el estado por su cuenta habría dos
// estados de flujos, el que se firma y el que se concilia, que es el defecto
// exacto que esta familia vino a cerrar.
//
// ── LA SALIDA ES UN ESTADO FINANCIERO, NO UN VOLCADO ──
//
// Encabezado con entidad, moneda y periodo; el MÉTODO declarado y de dónde
// salió (un estado que no dice por qué método se armó no es un estado); las
// tres secciones con su neto; y el amarre visible en banda —efectivo al
// inicio, movimiento, efectivo al final y el residuo si lo hay—, etiquetado
// por la columna `line` igual que los subtotales del balance. El amarre va
// dentro de las filas y no en una nota porque es parte del documento: un
// estado de flujos sin la conciliación con el saldo de caja es medio
// documento, y ponerlo en stderr lo dejaría fuera del csv que alguien
// importa.
// ============================================================

export interface CashFlowCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

interface GenerateOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  period?: string;
  since?: string;
  until?: string;
  asOf?: string;
  dateBasis?: string;
  method?: string;
  gross?: boolean;
}

/** Rango del estado, ya resuelto, con la frase que lo describe al lector. */
export interface RangoDeFlujo {
  startDate: string;
  endDate: string;
  scope: string;
}

/**
 * El rango que se informa.
 *
 * Un estado de flujos es un movimiento ENTRE DOS FECHAS, así que no hay
 * omisión razonable: sin rango se rehúsa en vez de inventar el mes en curso,
 * que es como alguien firma enero creyendo que firmó el ejercicio. Es la
 * misma negativa que `report income-statement show` y la misma que
 * `cashflow reconcile`; se exporta para que un día las tres la compartan en
 * vez de repetirla (hoy `cashflow-reconcile-command.ts` tiene la suya).
 */
export async function rangoDeFlujo(
  entityId: string,
  opts: Pick<GenerateOpts, 'period' | 'since' | 'until'>,
  note: (m: string) => void
): Promise<RangoDeFlujo> {
  if (opts.period) {
    const range = await resolvePeriodRange(entityId, opts.period);
    if (!range.matched_fiscal_period) {
      note(
        `"${opts.period}" matched no single fiscal period; using the calendar range ` +
          `${range.start_date} → ${range.end_date}.`
      );
    }
    return {
      startDate: range.start_date,
      endDate: range.end_date,
      scope: `${range.start_date} → ${range.end_date}`,
    };
  }
  if (opts.since && opts.until) {
    return { startDate: opts.since, endDate: opts.until, scope: `${opts.since} → ${opts.until}` };
  }
  throw usageError(
    'cashflow generate needs a period: pass --period (2026-07, 2026-Q3, FY2026) or both ' +
      '--since and --until. A statement of cash flows is a movement between two dates.'
  );
}

/**
 * `--method` del catálogo, en INGLÉS, traducido al vocabulario del motor.
 *
 * LA TRADUCCIÓN ES LO QUE IMPIDE QUE VUELVA EL DEFECTO. `comoMetodo` en el
 * servicio colapsa a «indirecto» todo lo que no sea la cadena 'directo', y
 * eso está bien para leer una política —el panel guarda español y un valor
 * corrupto no debe tumbar un informe— pero sería fatal para una bandera
 * explícita: `--method direct` se habría convertido en indirecto EN SILENCIO,
 * que es letra por letra lo que hacía la ruta REST. Aquí un valor que no
 * reconocemos es error de USO y nunca un valor por omisión.
 *
 * Se admiten las dos grafías porque el usuario ve las dos: el catálogo y el
 * `--help` dicen indirect|direct, y el panel de políticas guarda
 * indirecto|directo. Quien lea el panel y lo teclee tal cual tiene razón.
 */
export function metodoPedido(valor: string | undefined): MetodoDeFlujo | undefined {
  if (valor === undefined) return undefined;
  const v = valor.trim().toLowerCase();
  if (v === 'indirect' || v === 'indirecto') return 'indirecto';
  if (v === 'direct' || v === 'directo') return 'directo';
  throw usageError(
    `--method must be one of: indirect, direct (indirecto, directo); got "${valor}". ` +
      'The method is not cosmetic: it decides how the statement is built.'
  );
}

/** Cómo se rotula el método en la salida, con su procedencia. */
export function rotuloDelMetodo(
  estado: Pick<CashFlowStatement, 'method' | 'policies'>,
  pedido: MetodoDeFlujo | undefined
): string {
  const fuente = pedido ? '--method' : 'policy `flujo_efectivo_metodo`';
  return `method: ${estado.method} (${fuente} · ${estado.policies.metodo})`;
}

/** Una línea del motor, ya como fila del estado. */
function filaDeLinea(section: string, l: LineaDeFlujo): Row {
  return { section, line: 'account', code: l.code, name: l.name, amount: l.amount };
}

function filasDeSeccion(section: string, s: SeccionDeFlujo, rotulo: string, tipo: string): Row[] {
  return [
    ...s.lines.map((l) => filaDeLinea(section, l)),
    { section, line: tipo, code: '', name: rotulo, amount: s.total },
  ];
}

/**
 * EL ESTADO, COMO FILAS.
 *
 * Los subtotales viajan EN BANDA y etiquetados por `line`, igual que en
 * `report balance-sheet show`: un estado de flujos son sus subtotales, y un
 * csv que sólo trajera las cuentas obligaría a sumarlas otra vez para tener
 * el documento — que es cómo dos lectores acaban con dos utilidades.
 *
 * `unclassified` se imprime cuando existe y NO entra en ningún total: son las
 * cuentas que el motor no supo clasificar, y son exactamente el residuo. Por
 * eso salen con nombre y apellido en vez de absorberse en un renglón.
 */
export function filasDelEstado(estado: CashFlowStatement): Row[] {
  const op = estado.operating_activities;
  const rows: Row[] = [
    { section: 'operating', line: 'account', code: '', name: 'Net income', amount: op.net_income },
    ...filasDeSeccion('operating', op.non_cash, 'Total non-cash items', 'subtotal'),
    ...filasDeSeccion(
      'operating',
      op.working_capital,
      'Total change in working capital',
      'subtotal'
    ),
    { section: 'operating', line: 'total', code: '', name: 'Net cash from operating activities', amount: op.total },
    ...filasDeSeccion('investing', estado.investing_activities, 'Net cash from investing activities', 'total'),
    ...filasDeSeccion('financing', estado.financing_activities, 'Net cash from financing activities', 'total'),
    { section: '', line: 'total', code: '', name: 'Net change in cash', amount: estado.net_cash_flow },
  ];
  if (estado.unclassified.lines.length > 0) {
    rows.push(
      ...filasDeSeccion(
        'unclassified',
        estado.unclassified,
        'Total unclassified (outside every section, and outside the net above)',
        'subtotal'
      )
    );
  }
  return rows;
}

/** El residuo del estado contra el mayor: derivado − real, el mismo orden que `conciliarFlujoDeEfectivo`. */
export function residuoDe(estado: CashFlowStatement, efectivo: MovimientoRealDeEfectivo): string {
  return new Decimal(estado.net_cash_flow).minus(new Decimal(efectivo.variacion)).toFixed(4);
}

/**
 * EL AMARRE VISIBLE: saldo inicial, movimiento, saldo final y el residuo.
 *
 * Las tres primeras son hechos del mayor y se imprimen SIEMPRE, incluso bajo
 * la política «silencio»: lo que esa política gobierna es si el residuo se
 * denuncia como hallazgo, no si el lector puede ver contra qué se compara.
 * Un estado de flujos cuyo lector no puede contrastar el saldo de caja es el
 * documento que nadie caza, y éste es el único estado financiero cuyo error
 * es comprobable desde fuera: cualquiera lo compara contra su banco.
 */
export function filasDelAmarre(
  estado: CashFlowStatement,
  efectivo: MovimientoRealDeEfectivo
): Row[] {
  const residuo = residuoDe(estado, efectivo);
  return [
    { section: 'cash', line: 'tie', code: '', name: 'Cash and equivalents, opening balance', amount: efectivo.saldo_inicial },
    { section: 'cash', line: 'tie', code: '', name: 'Cash and equivalents, movement in the ledger', amount: efectivo.variacion },
    { section: 'cash', line: 'tie', code: '', name: 'Cash and equivalents, closing balance', amount: efectivo.saldo_final },
    { section: 'cash', line: 'residue', code: '', name: 'Residue (statement net − ledger movement)', amount: residuo },
  ];
}

/**
 * POR QUÉ `--gross` SE DECLARA Y SE REHÚSA, EN VEZ DE HACER OTRA COSA.
 *
 * `--gross` es la BASE DE PRESENTACIÓN de NIF B-2 §40 y ASC 230-10-45-7:
 * cobros brutos y pagos brutos, sin compensar entradas contra salidas. Con
 * estos libros no es construible, y por la misma razón por la que no lo es el
 * método directo — no por un hueco que arregle una consulta más lista:
 *
 *  · El motor publica UN NETO POR CUENTA. Partirlo en el cargo y el abono de
 *    esa cuenta no da los flujos brutos: la baja de un activo abona la cuenta
 *    a valor en libros, y el efectivo cobrado es otro importe —la diferencia
 *    es la utilidad o pérdida, que vive en resultados—. Presentar el abono
 *    como «cobro por venta de activo» sería afirmar un cobro que no ocurrió.
 *  · Lo bruto es de la OPERACIÓN, no de la cuenta: un mismo asiento puede
 *    traer entrada y salida, y ningún dato del mayor dice cuál de las
 *    contrapartidas cobró el dinero.
 *
 * Lo que SÍ se puede hacer —enseñar cada cuenta en vez del subtotal— ya lo
 * hace la salida por omisión, y rebautizarlo «bruto» sería la misma clase de
 * mentira que devolver el indirecto rotulado como directo: la que este
 * trabajo existe para borrar. Así que se rehúsa diciendo qué falta.
 *
 * Se DECLARA aunque se rehúse porque el catálogo la nombra: sin la bandera,
 * `--gross` respondería «unknown option» y no enseñaría nada.
 */
function rechazarGross(): never {
  throw usageError(
    'El estado en términos BRUTOS (NIF B-2 §40 / ASC 230-10-45-7) no se puede construir con ' +
      'estos datos, y no se devuelve el neto rotulado como bruto. Lo bruto exige cobros y pagos ' +
      'separados, y eso es un dato de la OPERACIÓN, no de la cuenta: el motor publica un neto ' +
      'por cuenta, y partirlo en su cargo y su abono no da flujos —la baja de un activo abona a ' +
      'valor en libros mientras el efectivo cobrado es otro importe—. La salida por omisión ya ' +
      'muestra cada cuenta de cada sección, que es el detalle que estos libros sí sostienen. ' +
      'Vuelve a correr sin --gross.'
  );
}

export function registerCashFlowCommand(program: Command, deps: CashFlowCommandDeps): void {
  const cashflow = program
    .command('cashflow')
    .alias('flujo')
    .description('Statement of cash flows (NIF B-2 / ASC 230): build it, and tie it to real cash');

  const p = deps.palette;
  const note = (message: string) => process.stderr.write(p.dim(`${message}\n`));
  const warn = (message: string) => process.stderr.write(p.yellow(`${message}\n`));

  const run = async (fn: () => Promise<ExitCodeValue | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? ExitCode.OK);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  const entityOf = async (opts: GenerateOpts): Promise<AgentContext> => {
    // Inquilino PRIMERO, como en toda la casa: bajo RLS una conexión sin
    // app.current_tenant ve cero filas en legal_entities.
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity({ entity: opts.entity }, { home: deps.home, warn });
    return ctx;
  };

  // ---- cashflow generate -------------------------------------------
  const generate = cashflow
    .command('generate')
    .alias('generar')
    .description('Build the statement of cash flows for a period, with the tie-out to real cash');
  withOutput(withTime(withContext(generate)));
  generate
    .option(
      '--method <indirect|direct>',
      'method to build the statement with (default: the `flujo_efectivo_metodo` policy)'
    )
    .option(
      '--gross',
      'present gross receipts and payments instead of net (NIF B-2 §40 / ASC 230-10-45-7); refused with a reason — these books cannot support it'
    );
  declareRisk(generate, { risk: 'lectura', agent: true });

  generate.addHelpText(
    'after',
    `
Examples:
  # The statement for a closed month, with its tie-out to real cash. The method
  # comes from the \`flujo_efectivo_metodo\` policy unless you override it.
  mnemosine cashflow generate --period 2026-07
  # The direct method when the firm answered the panel the other way, or when a
  # working paper needs both presentations side by side.
  mnemosine cashflow generate --period 2026-07 --method direct --format csv -o flujo-julio.csv
`
  );
  generate.action((opts: GenerateOpts) =>
    run(async () => {
      // Las dos banderas se validan ANTES de tocar la base: un typo en
      // `--method` no debe costar una conexión, y `--gross` no va a poder
      // servirse con ninguna cifra que traigamos.
      const metodo = metodoPedido(opts.method);
      if (opts.gross) rechazarGross();

      const ctx = await entityOf(opts);
      const { startDate, endDate, scope } = await rangoDeFlujo(ctx.entityId, opts, note);

      const estado = await getCashFlowStatement(ctx.entityId, { startDate, endDate, metodo });

      // El movimiento real sale del MISMO módulo que usa `cashflow reconcile`
      // —una sola implementación del efectivo real— y con el mismo criterio
      // del panel. Sin esto el estado se publicaría sin nada contra qué
      // contrastarlo, que es como vivió este informe hasta hoy.
      const efectivo = await movimientoRealDeEfectivo(ctx.entityId, { startDate, endDate });

      // EL ENCABEZADO DE UN ESTADO FINANCIERO: quién, en qué moneda, de qué
      // periodo, y POR QUÉ MÉTODO. Va a stderr como toda nota, de modo que un
      // csv canalizado siga siendo importable.
      note(`Statement of cash flows · ${ctx.entityName} · ${ctx.currency} · ${scope}`);
      note(rotuloDelMetodo(estado, metodo));
      note(
        `Cash and equivalents: ${estado.cash_accounts.map((c) => c.code).join(', ') || '—'} ` +
          `(criterio «${estado.policies.cuentasDeEfectivo}»)`
      );
      // El aviso del cierre del ejercicio viaja con el estado por la misma
      // razón que en la balanza: la utilidad neta del primer renglón tiene
      // que poder atarse con la del estado de resultados.
      if (estado.closing) note(estado.closing.note);

      const rows = [...filasDelEstado(estado), ...filasDelAmarre(estado, efectivo)];
      render(rows, { ...opts, idField: 'name', total: rows.length, numeric: ['amount'] });

      // LAS OPERACIONES QUE NO MOVIERON EFECTIVO SE REVELAN, NO SE OMITEN.
      // NIF B-2 y ASC 230-10-50-3 las excluyen del cuerpo del estado y piden
      // revelarlas: el activo comprado a crédito no es una salida de efectivo,
      // y meterlo dentro inventaría una. Van como nota justamente porque no
      // son flujos — una fila suya se sumaría con las demás.
      if (estado.non_cash_transactions.length > 0) {
        note(
          `${estado.non_cash_transactions.length} non-cash investing/financing transaction(s), ` +
            'excluded from the statement and disclosed here: ' +
            estado.non_cash_transactions
              .map((t) => `${t.entry_number} (${t.entry_date}) ${t.amount}`)
              .join('; ')
        );
      }

      // EL RESIDUO, Y QUIÉN DECIDE SU GRAVEDAD.
      //
      // El importe es siempre el mismo (derivado − real) y ya está impreso en
      // banda; lo que cambia con `flujo_efectivo_descuadre` es si además es un
      // hallazgo. «bloquear» ya hizo fallar al motor cuando el hueco eran
      // cuentas sin clasificar; llega aquí el caso en que el motor cuadra
      // consigo mismo y aun así el mayor dice otra cosa —una cuenta de
      // efectivo fuera del criterio, por ejemplo—, y bajo esa política eso
      // también impide emitir. «silencio» degrada a nota y LO DICE: apagar el
      // aviso no es lo mismo que no haber medido.
      const residuo = new Decimal(residuoDe(estado, efectivo));
      if (residuo.isZero()) {
        note('Ties: the statement net equals the movement of cash and equivalents in the ledger.');
        return ExitCode.OK;
      }
      const frase =
        `The statement does not tie to cash: it states a net of ${estado.net_cash_flow} and cash ` +
        `and equivalents moved ${efectivo.variacion} in the ledger. Residue of ${residuo.toFixed(4)}, ` +
        'printed above and absorbed into no line. Run `mnemosine cashflow reconcile --show-candidates`.';
      switch (estado.policies.descuadre) {
        case 'bloquear':
          warn(`${frase} Policy \`flujo_efectivo_descuadre\` is «bloquear»: the statement does not stand.`);
          return checkExitCode({ blocking: 1, warning: 0 });
        case 'silencio':
          note(`${frase} Policy \`flujo_efectivo_descuadre\` is «silencio»: reported as a note, not as a finding.`);
          return ExitCode.OK;
        default:
          warn(frase);
          // Con «avisar» el residuo es advertencia y no veredicto: el
          // veredicto es de `cashflow reconcile`, que es la hoja que existe
          // para eso y la única de las dos que lleva --strict.
          return checkExitCode({ blocking: 0, warning: 1 });
      }
    })
  );

  // ---- cashflow reconcile ------------------------------------------
  //
  // La hoja del amarre vive en su propio archivo y se registra aquí con el
  // constructor de estado INYECTADO: es lo que hace imposible que `generate`
  // y `reconcile` publiquen dos cifras distintas del mismo periodo.
  const construirEstado: ConstructorDeEstado = (entityId, { startDate, endDate }) =>
    getCashFlowStatement(entityId, { startDate, endDate });
  registerCashFlowReconcile(cashflow, { ...deps, construirEstado });
}
