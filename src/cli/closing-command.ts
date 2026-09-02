import type { Command } from 'commander';
import { resolveEntity, bootstrapTenant, type AgentContext } from '../ai/context.js';
import {
  listClosablePeriods,
  nextPeriodToClose,
  getCloseReadiness,
  type ClosablePeriod,
  type CloseReadiness,
} from '../ai/close-service.js';
import {
  CLOSE_CHECK_CODES,
  CLOSE_CHECK_ITEMS,
  type PeriodCloseChecklistItem,
} from '../services/accounting/period-close.js';
import { explainCloseCheck } from '../services/accounting/close-explain.js';
import { translateDomainError } from './entry-command.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withContext,
  withOutput,
  withStrict,
  checkExitCode,
  usageError,
  notFound,
  exitCodeFor,
  ExitCode,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine closing · cierre-proceso — LA SUPERFICIE DE LECTURA DEL CIERRE
//
// F06d convertirá el cierre en un PROCESO (tareas, dueños, firma, paquete);
// este tramo entrega sólo sus tres hojas de LECTURA, que ya tienen backend:
// `getCloseReadiness` (motor + bloqueos de IA) y los detectores de
// `getPeriodCloseStatus`, ahora con código estable por casilla.
//
//   preview  — ¿puede el periodo entrar en cierre, y qué falta?
//   check    — el catálogo de verificaciones, o sólo las nombradas
//   explain  — los renglones ofensores de UNA verificación y su remedio
//
// Las tres son ✓ para el agente: leer nunca certifica nada. Las otras siete
// filas de `closing` (start/status/task*/approve/pack) son de F06d y aquí NO
// existen — ni siquiera como esqueleto, porque un comando que existe y no
// hace lo que su fila promete es peor que su ausencia.
//
// `close --check` SIGUE EXISTIENDO como bandera de la hoja `close` (REGISTRY
// §5 #6): `closing check` no la sustituye, la complementa con códigos
// estables y filtrado.
// ============================================================

export interface ClosingCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
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
  strict?: boolean;
}

const MARK = { done: '✔', missing: '✘' } as const;

/**
 * ¿Toca la ficha escrita a mano, o cede a `render`? La misma regla que
 * `bank account show` y por lo mismo: `--format` nace con valor 'table', así
 * que se compara contra él (no contra undefined), y un `--fields` declarado
 * que sólo se leyera en json sería una promesa incumplida — la mentira exacta
 * que ya se cazó en `ap reconcile`.
 */
function legible(opts: CommonOpts): boolean {
  return (
    !opts.json &&
    (opts.format ?? 'table') === 'table' &&
    !opts.quiet &&
    opts.output === undefined &&
    opts.fields === undefined
  );
}

/**
 * Cuenta lo que las casillas SELECCIONADAS pesan, para el código de salida:
 * una casilla incompleta cuenta según su `severity`. Pura y exportada: el
 * contrato de salida de `closing check --check a,b` se prueba sin base.
 */
export function conteoParaSalida(
  casillas: readonly PeriodCloseChecklistItem[]
): { blocking: number; warning: number } {
  let blocking = 0;
  let warning = 0;
  for (const c of casillas) {
    if (c.is_complete) continue;
    if (c.severity === 'blocking') blocking += 1;
    else warning += 1;
  }
  return { blocking, warning };
}

/** Render puro de las casillas, con su código: probable sin terminal. */
export function renderCasillas(
  casillas: readonly PeriodCloseChecklistItem[],
  c: Pick<Palette, 'dim' | 'red'>
): string[] {
  if (casillas.length === 0) return [c.dim('  (no checks selected)')];
  const ancho = Math.max(...casillas.map((x) => x.codigo.length));
  return casillas.map((item) => {
    const marca = item.is_complete ? MARK.done : MARK.missing;
    const peso = item.is_complete ? '' : item.severity === 'blocking' ? ' [blocking]' : ' [warning]';
    const linea = `  ${marca} ${item.codigo.padEnd(ancho)}  ${item.item}${peso}`;
    return item.details ? `${linea}${c.dim(`  ${item.details}`)}` : linea;
  });
}

function makeRunner(deps: ClosingCommandDeps) {
  return async (fn: () => Promise<ExitCodeValue | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? ExitCode.OK);
    } catch (err) {
      const mapped = translateDomainError(err);
      deps.reportError(mapped);
      await deps.shutdown(exitCodeFor(mapped));
    }
  };
}

/**
 * El periodo sobre el que se pregunta: el nombrado, o el más viejo abierto —
 * el mismo criterio que la hoja `close`, porque las dos superficies tienen
 * que contestar sobre EL MISMO mes o una previsualización no previsualiza.
 */
async function periodoOMasViejo(ctx: AgentContext, nombre?: string): Promise<ClosablePeriod> {
  const periodos = await listClosablePeriods(ctx);
  if (periodos.length === 0) {
    throw notFound('No open periods: nothing to preview or check.');
  }
  if (!nombre) {
    const siguiente = await nextPeriodToClose(ctx);
    if (!siguiente) throw notFound('No open periods: nothing to preview or check.');
    return siguiente;
  }
  const buscado = nombre.toLowerCase();
  const elegido = periodos.find(
    (p) => p.id === nombre || p.period_name.toLowerCase().includes(buscado)
  );
  if (!elegido) {
    throw notFound(
      `No open period matches "${nombre}". Available: ${periodos.map((p) => p.period_name).join(', ')}.`
    );
  }
  return elegido;
}

function cabeceraDePeriodo(r: CloseReadiness, c: Palette): string {
  const p = r.period;
  return (
    c.bold(p.period_name) +
    c.dim(`  ${p.start_date} → ${p.end_date} · ${p.status}${p.overdue ? ' · overdue' : ''}`)
  );
}

export function registerClosingCommand(program: Command, deps: ClosingCommandDeps): void {
  const closing = program
    .command('closing')
    .alias('cierre-proceso')
    .description('The close as a process: its read-only surface — readiness, named checks, offenders');

  const run = makeRunner(deps);
  const entityOf = async (opts: CommonOpts) => {
    // Tenant PRIMERO, como en toda la familia: bajo RLS una conexión sin
    // app.current_tenant ve cero filas en legal_entities.
    bootstrapTenant(opts.tenant);
    return resolveEntity(opts.entity);
  };

  // ---- closing preview ---------------------------------------------
  const preview = closing
    .command('preview')
    .alias('previsualizar')
    .argument('[period]', 'period name, YYYY-MM, or id (default: the oldest open one)')
    .description('Read-only twin of closing start: says whether the period can enter close and what is missing');
  withStrict(withOutput(withContext(preview)));
  declareRisk(preview, { risk: 'lectura', agent: true });
  preview.action((periodArg: string | undefined, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const periodo = await periodoOMasViejo(ctx, periodArg);
      const readiness = await getCloseReadiness(ctx, periodo);

      if (!legible(opts)) {
        // UN documento con la listeza entera (periodo, veredicto, bloqueos,
        // casillas anidadas), como `ap reconcile`: la respuesta de la máquina
        // y la del agente no divergen de la del humano.
        render([readiness as unknown as Row], { ...opts, idField: 'canClose' });
      } else {
        // process.stdout.write y no console.log, como ap/bank: console es
        // interceptable (vitest lo secuestra) y el contrato de salida dice
        // que los DATOS van al stream, no al logger.
        const c = deps.palette;
        const out = process.stdout;
        out.write(`\n${cabeceraDePeriodo(readiness, c)}\n\n`);
        for (const linea of renderCasillas(readiness.checklist, c)) out.write(`${linea}\n`);
        if (readiness.blockingIssues.length > 0) {
          out.write(`\n${c.red('  Blocking:')}\n`);
          for (const b of readiness.blockingIssues) out.write(c.red(`    · ${b}`) + '\n');
        }
        if (readiness.warnings.length > 0) {
          out.write('\n  Warnings:\n');
          for (const w of readiness.warnings) out.write(c.dim(`    · ${w}`) + '\n');
        }
        out.write(
          '\n' +
            (readiness.canClose
              ? '  The period can enter close.'
              : c.red('  The period cannot enter close yet: resolve the blocking items above.')) +
            '\n\n'
        );
      }
      // El contrato §4: limpio 0, hallazgo bloqueante 4, advertencia 0
      // salvo --strict. Los bloqueos de IA cuentan como hallazgos: un
      // borrador sin revisar detiene el cierre igual que una casilla roja.
      return checkExitCode(
        { blocking: readiness.blockingIssues.length, warning: readiness.warnings.length },
        { strict: opts.strict }
      );
    })
  );

  // ---- closing check -----------------------------------------------
  const check = closing
    .command('check')
    .alias('verificar')
    .description('Run the close verification catalog, or only the named checks; bare --check lists the names');
  withStrict(withOutput(withContext(check)));
  check
    .option('--check [codes]', 'comma-separated check codes; with no value, prints the available ones')
    .option('--period <name>', 'period to check (default: the oldest open one)');
  declareRisk(check, { risk: 'lectura', agent: true });
  check.action((opts: CommonOpts & { check?: string | boolean; period?: string }) =>
    run(async () => {
      // `--check` sin valor: el registro, sin tocar la base — la pregunta
      // «¿qué se puede verificar?» no debería costar una conexión (el mismo
      // criterio que `bank statement check --check`).
      if (opts.check === true) {
        render(
          CLOSE_CHECK_CODES.map((codigo) => ({ check: codigo, item: CLOSE_CHECK_ITEMS[codigo] })),
          { ...opts, idField: 'check' }
        );
        return ExitCode.OK;
      }

      const pedidos =
        typeof opts.check === 'string'
          ? opts.check.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
          : undefined;
      if (pedidos) {
        const desconocidos = pedidos.filter(
          (p) => !(CLOSE_CHECK_CODES as readonly string[]).includes(p)
        );
        if (desconocidos.length > 0) {
          // Un código desconocido es error de USO, nunca un filtro vacío que
          // sale 0: la lección de los filtros de ledger-checks, aplicada aquí.
          throw usageError(
            `Unknown check code(s): ${desconocidos.join(', ')}. Available: ${CLOSE_CHECK_CODES.join(', ')}.`
          );
        }
      }

      const ctx = await entityOf(opts);
      const periodo = await periodoOMasViejo(ctx, opts.period);
      const readiness = await getCloseReadiness(ctx, periodo);
      const seleccion = pedidos
        ? readiness.checklist.filter((c) => pedidos.includes(c.codigo))
        : readiness.checklist;

      if (!legible(opts)) {
        // Las casillas SON las filas: un csv de verificaciones con su código,
        // peso y detalle, `--fields` incluido. El documento completo — con
        // los bloqueos de IA y el veredicto — es `closing preview --json`.
        render(seleccion as unknown as Row[], { ...opts, idField: 'codigo' });
      } else {
        const c = deps.palette;
        const out = process.stdout;
        out.write(`\n${cabeceraDePeriodo(readiness, c)}\n\n`);
        for (const linea of renderCasillas(seleccion, c)) out.write(`${linea}\n`);
        out.write('\n');
      }

      // Los bloqueos de la capa IA no son casillas pero SÍ pesan en el
      // veredicto completo (abajo): se dicen por stderr —también en formato
      // máquina, como toda nota— o un exit 4 con todas las casillas en ✔
      // sería un misterio para el guion que lo lee.
      if (!pedidos) {
        const err = process.stderr;
        const { pendingDrafts, pendingQuestions, pendingExternalOps } = readiness.ai;
        if (pendingDrafts > 0) {
          err.write(
            deps.palette.red(
              `  · ${pendingDrafts} AI draft(s) dated inside the period block this close (mnemosine review)\n`
            )
          );
        }
        if (pendingQuestions > 0) {
          err.write(
            deps.palette.dim(`  · ${pendingQuestions} unanswered AI question(s) (mnemosine questions)\n`)
          );
        }
        if (pendingExternalOps > 0) {
          err.write(
            deps.palette.dim(`  · ${pendingExternalOps} queued external write(s) (mnemosine outbox)\n`)
          );
        }
      }

      // Filtrado, el veredicto es SÓLO de lo pedido (para eso se pide);
      // completo, cuentan también los bloqueos de IA y los avisos del motor.
      const conteo = pedidos
        ? conteoParaSalida(seleccion)
        : { blocking: readiness.blockingIssues.length, warning: readiness.warnings.length };
      return checkExitCode(conteo, { strict: opts.strict });
    })
  );

  // ---- closing explain ---------------------------------------------
  const explain = closing
    .command('explain')
    .alias('explicar')
    .argument('<code>', `check code, one of: ${CLOSE_CHECK_CODES.join(', ')}`)
    .description('Print the offending rows of one check (ids, amounts, dates) and the exact command that fixes it');
  withOutput(withContext(explain));
  explain
    // `--limit` suelta y no con `withSelection()`: el grupo entero arrastra
    // `--offset`, `--status` y `--all`, y una explicación no pagina ni filtra
    // por estado — acota cuántos renglones enseña. El diccionario gobierna la
    // grafía y la forma corta (`-n`), no el grupo (el precedente de
    // `ap reconcile --as-of`).
    .option('-n, --limit <n>', 'maximum offending rows to print', (v: string) => Number(v))
    .option('--period <name>', 'period to explain (default: the oldest open one)');
  declareRisk(explain, { risk: 'lectura', agent: true });
  explain.action(
    (
      code: string,
      opts: CommonOpts & { limit?: number; period?: string }
    ) =>
      run(async () => {
        const ctx = await entityOf(opts);
        const periodo = await periodoOMasViejo(ctx, opts.period);
        const explicacion = await explainCloseCheck(ctx.entityId, periodo.id, code, {
          limit: opts.limit,
        });

        if (!legible(opts)) {
          // Los renglones SON las filas — un csv de ofensores con `-o` es el
          // anexo que pide un auditor. El total real viaja en el sobre
          // (`total`), así el recorte de `--limit` nunca pasa en silencio; el
          // remedio va por stderr, que es donde viven las notas.
          render(explicacion.renglones, {
            ...opts,
            total: explicacion.total,
          });
          if (explicacion.total > 0) {
            process.stderr.write(deps.palette.dim(`fix with: ${explicacion.remedio}\n`));
          }
          return ExitCode.OK;
        }

        const c = deps.palette;
        const out = process.stdout;
        out.write(
          `\n${c.bold(explicacion.item)}  ${c.dim(`(${explicacion.codigo} · ${periodo.period_name})`)}\n`
        );
        if (explicacion.total === 0) {
          out.write(c.dim('  nothing to explain: the check is clean for this period') + '\n\n');
          return ExitCode.OK;
        }
        out.write('\n');
        render(explicacion.renglones, {
          format: 'table',
          total: explicacion.total,
        });
        out.write(`\n  ${c.dim('fix with:')} ${explicacion.remedio}\n\n`);
        // Explicar es una LENTE, no un veredicto: el código de salida del
        // hallazgo lo da `closing check`; esta hoja sale 0 si pudo mirar.
        return ExitCode.OK;
      })
  );
}
