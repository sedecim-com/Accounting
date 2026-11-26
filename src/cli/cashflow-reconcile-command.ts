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
  describeCommand,
  optionByKey,
  type Row,
} from './kernel/index.js';
import { t, type TranslationKey } from '../i18n/index.js';

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

/**
 * The label of each contrast row, by its `line` (MNE-001-218, #263).
 *
 * The ROW carries the English catalogue and the TABLE the user's language:
 * --json and csv are read by scripts, and a script must read the same text
 * under any locale (the amendment to decision 2 on #263). The table renders
 * through the kernel's `labelled` hook, which only the human branches call.
 */
const CONTRAST_CONCEPT: Readonly<Record<string, TranslationKey>> = {
  derivado: 'report.cashflow_reconcile.derived_concept',
  real: 'report.cashflow_reconcile.ledger_concept',
  residuo: 'report.cashflow_reconcile.residue_concept',
};

/** The `concept` of the table in the user's language; a suspect's own description passes through. */
function conceptLabel(method: string): (value: string, row: Row) => string {
  return (value, row) => {
    const key = CONTRAST_CONCEPT[String(row.line)];
    return key === undefined ? value : t(key, { method });
  };
}

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
      concept: t('report.cashflow_reconcile.derived_concept', { method: c.method }, 'en'),
      amount: c.residuo.derivado,
      ...vacio,
    },
    {
      line: 'real',
      concept: t('report.cashflow_reconcile.ledger_concept', {}, 'en'),
      amount: c.residuo.real,
      ...vacio,
    },
    {
      line: 'residuo',
      concept: t('report.cashflow_reconcile.residue_concept', {}, 'en'),
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

  const reconcile = describeCommand(
    cashflow.command('reconcile').alias('conciliar'),
    'help.cashflow.reconcile.description'
  );
  withOutput(withStrict(withTime(withContext(reconcile))));
  optionByKey(reconcile, '--show-candidates', 'help.cashflow.reconcile.option.show_candidates');
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

        note(t('report.cashflow_reconcile.heading', { entity: ctx.entityName, currency: ctx.currency, scope }));
        note(
          t('report.cashflow_reconcile.cash_accounts', {
            accounts: c.efectivo.cuentas.map((x) => x.code).join(', '),
            criterion: c.efectivo.criterio,
            defaulted: c.efectivo.criterio_definido ? 'no' : 'yes',
            opening: c.efectivo.saldo_inicial,
            closing: c.efectivo.saldo_final,
          })
        );

        const rows = [...filasDelContraste(c), ...filasDeSospechosos(c.candidatos ?? [])];
        render(rows, {
          ...opts,
          idField: 'line',
          total: rows.length,
          numeric: ['amount'],
          labelled: { concept: conceptLabel(c.method) },
        });

        // EL RESIDUO SE NOMBRA Y SE CUANTIFICA, y va a stderr para que un csv
        // canalizado siga siendo importable. Nunca se reparte en un renglón.
        if (c.aviso) warn(c.aviso);
        else note(t('report.cashflow_reconcile.ties'));

        if (c.candidatos?.length) {
          note(t('report.cashflow_reconcile.suspects', { count: c.candidatos.length }));
          // La segunda cifra es la que dice si hay que seguir buscando. Sin
          // ella, una lista que cubre 50 000 de un residuo de 65 000 se lee
          // como si lo explicara entero.
          if (c.cobertura) {
            note(
              t('report.cashflow_reconcile.coverage', {
                explained: c.cobertura.explicado,
                amount: c.residuo.importe,
                unexplained: c.cobertura.sin_explicar,
              })
            );
          }
        } else if (opts.showCandidates && !c.residuo.cuadra) {
          note(t('report.cashflow_reconcile.no_suspects'));
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
      note(t('report.period.calendar_fallback', { period: opts.period, start: range.start_date, end: range.end_date }));
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
  throw usageError({ key: 'report.period.required', params: { command: 'cashflow reconcile' } });
}
