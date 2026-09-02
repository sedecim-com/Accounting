import type { Command } from 'commander';
import { bootstrapTenant, type AgentContext } from '../ai/context.js';
import { resolvePeriodRange } from '../services/reporting/report-service.js';
import {
  conciliarFlujoDeEfectivo,
  type Conciliacion,
  type FlujoDerivado,
  type Sospechoso,
} from '../services/reporting/cash-flow-reconcile.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withContext,
  withOutput,
  withStrict,
  withTime,
  resolveActiveEntity,
  checkExitCode,
  usageError,
  exitCodeFor,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine cashflow reconcile · flujo conciliar
//
// El amarre del estado de flujos contra el efectivo real, y la única fila de
// esta familia cuyo trabajo es DESCONFIAR de las otras.
//
// El estado de flujos es el único estado financiero cuyo error es
// comprobable desde fuera: cualquiera lo compara contra su banco. Hasta hoy
// nada lo comparaba — la ruta REST publicaba un neto derivado que podía no
// tener ninguna relación con la variación de caja y bancos, y nadie lo
// decía. Este comando pone las dos cifras una al lado de la otra e IMPRIME
// EL RESIDUO en vez de absorberlo: meterlo dentro de un renglón esconde
// justo lo que el lector habría cazado, y deja el documento con aspecto de
// cuadrado.
//
// EL CONTRATO DE SALIDA es el del núcleo, el mismo que `ar check` y
// `doctor`: 0 cuando amarra, 4 cuando el residuo es bloqueante (la política
// `flujo_efectivo_descuadre` en «bloquear») y 4 con --strict siempre que
// haya residuo. Ningún código inventado aquí — `checkExitCode` es la tabla.
// ============================================================

/**
 * Cómo se construye el estado de flujos que se va a conciliar.
 *
 * SE INYECTA Y NO SE IMPORTA, y la razón no es de acoplamiento sino
 * contable: `cashflow generate` y `cashflow reconcile` tienen que publicar
 * FORZOSAMENTE la misma cifra. Si cada subcomando resolviera el estado por
 * su cuenta acabaríamos con dos estados de flujos —el que se firma y el que
 * se concilia—, que es exactamente el defecto que `report-service` existe
 * para evitar y por el que este informe llevaba tres copias. La raíz
 * `cashflow` tiene el constructor a mano para `generate`; lo pasa aquí y el
 * amarre queda atado al mismo documento que se emite.
 */
export type ConstructorDeEstado = (
  entityId: string,
  opts: { startDate: string; endDate: string }
) => Promise<FlujoDerivado>;

export interface CashFlowReconcileDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  construirEstado: ConstructorDeEstado;
}

interface ReconcileOpts {
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
  showCandidates?: boolean;
  strict?: boolean;
}

/** Cuántos sospechosos se ofrecen. Una lista más larga deja de ser una pista. */
const SOSPECHOSOS_POR_OMISION = 10;

/** Fila del contraste. Las tres cifras que el lector compara contra su banco. */
function filasDelContraste(c: Conciliacion): Row[] {
  const vacio = {
    entry_number: '',
    entry_date: '',
    counterpart_code: '',
    counterpart_name: '',
    category: '',
    reason: '',
  };
  return [
    {
      line: 'derivado',
      concept: `Estado de flujos, neto (método ${c.method})`,
      amount: c.residuo.derivado,
      ...vacio,
    },
    {
      line: 'real',
      concept: 'Caja y bancos, variación en el mayor',
      amount: c.residuo.real,
      ...vacio,
    },
    {
      line: 'residuo',
      concept: 'Residuo (derivado − real)',
      amount: c.residuo.importe,
      ...vacio,
    },
  ];
}

/**
 * Los sospechosos viajan en la MISMA tabla que el contraste, discriminados
 * por la columna `line`.
 *
 * Dos render() seguidos escribirían dos encabezados en un csv y romperían el
 * archivo que alguien va a importar; y un residuo publicado sin los
 * movimientos que pueden explicarlo obliga a correr el comando dos veces
 * para tener el documento completo.
 */
function filasDeSospechosos(sospechosos: Sospechoso[]): Row[] {
  return sospechosos.map((s) => ({
    line: 'sospechoso',
    concept: s.description ?? '',
    amount: s.efecto_en_efectivo,
    entry_number: s.entry_number,
    entry_date: s.entry_date,
    counterpart_code: s.counterpart_code,
    counterpart_name: s.counterpart_name,
    category: s.categoria_probable,
    reason: s.motivo,
  }));
}

export function registerCashFlowReconcile(
  cashflow: Command,
  deps: CashFlowReconcileDeps
): Command {
  const p = deps.palette;
  const note = (message: string) => process.stderr.write(p.dim(`${message}\n`));
  const warn = (message: string) => process.stderr.write(p.yellow(`${message}\n`));

  const reconcile = cashflow
    .command('reconcile')
    .alias('conciliar')
    .description(
      'Reconcile the derived statement of cash flows against the real movement ' +
        'of cash and equivalents, and print the residue instead of absorbing it'
    );
  withOutput(withStrict(withTime(withContext(reconcile))));
  reconcile.option(
    '--show-candidates',
    'list the journal lines that most likely explain the residue (suspects, not a verdict)'
  );
  declareRisk(reconcile, { risk: 'lectura', agent: true });

  reconcile.addHelpText(
    'after',
    `
Examples:
  # Tie the derived statement against the real movement of cash: the residue is
  # PRINTED, never absorbed, because a statement that always ties proves nothing.
  mnemosine cashflow reconcile --period 2026-07
  # When there IS a residue: the journal lines that most likely explain it —
  # suspects, not a verdict — and --strict to make CI stop on it (exit 4).
  mnemosine cashflow reconcile --period 2026-07 --show-candidates --strict
`
  );
  reconcile.action((opts: ReconcileOpts) =>
    (async () => {
      try {
        bootstrapTenant(opts.tenant);
        const { ctx } = await resolveActiveEntity({ entity: opts.entity }, { home: deps.home, warn });
        const { startDate, endDate, scope } = await rangoDe(ctx, opts, note);

        const derivado = await deps.construirEstado(ctx.entityId, { startDate, endDate });
        const c = await conciliarFlujoDeEfectivo(ctx.entityId, {
          startDate,
          endDate,
          derivado,
          candidatos: opts.showCandidates ? SOSPECHOSOS_POR_OMISION : undefined,
        });

        note(`Cash flow reconciliation · ${ctx.entityName} · ${ctx.currency} · ${scope}`);
        note(
          `Efectivo: ${c.efectivo.cuentas.map((x) => x.code).join(', ')} ` +
            `(criterio «${c.efectivo.criterio}»${c.efectivo.criterio_definido ? '' : ', por omisión'}) · ` +
            `${c.efectivo.saldo_inicial} → ${c.efectivo.saldo_final}`
        );

        const rows = [...filasDelContraste(c), ...filasDeSospechosos(c.candidatos ?? [])];
        render(rows, { ...opts, idField: 'line', total: rows.length, numeric: ['amount'] });

        // EL RESIDUO SE NOMBRA Y SE CUANTIFICA, y va a stderr para que un csv
        // canalizado siga siendo importable. Nunca se reparte en un renglón.
        if (c.aviso) warn(c.aviso);
        else note('Amarra: el estado de flujos equivale al movimiento real de efectivo.');

        if (c.candidatos?.length) {
          note(
            `${c.candidatos.length} sospechoso(s) — es una LISTA DE SOSPECHOSOS, no un veredicto: ` +
              `son movimientos de efectivo que ninguna sección del estado parece reclamar, o que ` +
              `puede estar contando dos veces. Verifícalos antes de tocar nada.`
          );
          // La segunda cifra es la que dice si hay que seguir buscando. Sin
          // ella, una lista que cubre 50 000 de un residuo de 65 000 se lee
          // como si lo explicara entero.
          if (c.cobertura) {
            note(
              `Explican ${c.cobertura.explicado} del residuo ${c.residuo.importe}; ` +
                `quedan ${c.cobertura.sin_explicar} que no explica ninguno.`
            );
          }
        } else if (opts.showCandidates && !c.residuo.cuadra) {
          note(
            'Sin sospechosos que ofrecer: todo movimiento de efectivo del periodo cae en una ' +
              'sección del estado, así que el residuo está en CÓMO se suman, no en qué se omitió.'
          );
        }

        const code = checkExitCode(c.hallazgos, { strict: opts.strict === true });
        await deps.shutdown(code);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    })()
  );

  return reconcile;
}

/**
 * El rango que se concilia. Un estado de flujos es un movimiento ENTRE dos
 * fechas, así que no hay omisión razonable: sin rango se rehúsa en vez de
 * inventar el mes en curso, que es como alguien concilia enero creyendo que
 * concilió el ejercicio.
 */
async function rangoDe(
  ctx: AgentContext,
  opts: ReconcileOpts,
  note: (m: string) => void
): Promise<{ startDate: string; endDate: string; scope: string }> {
  if (opts.period) {
    const range = await resolvePeriodRange(ctx.entityId, opts.period);
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
    return {
      startDate: opts.since,
      endDate: opts.until,
      scope: `${opts.since} → ${opts.until}`,
    };
  }
  throw usageError(
    'cashflow reconcile needs a period: pass --period (2026-07, 2026-Q3, FY2026) or both ' +
      '--since and --until. A statement of cash flows is a movement between two dates.'
  );
}
