import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stdin } from 'node:process';
import type { Command } from 'commander';
import { resolveEntity, bootstrapTenant, type AgentContext } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
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
import {
  conductClose,
  describeOpenRun,
  isClosingStep,
  latestRunOf,
  openRunOf,
  CLOSING_STEPS,
  type ClosingRunOutcome,
} from '../services/accounting/closing-conductor.js';
import {
  buildClosingPack,
  latestClosedPeriodOf,
  parseClosingPack,
  storeClosingPack,
  verdictFindings,
  verifyClosingPack,
  type ClosingPack,
} from '../services/accounting/closing-pack.js';
import { resolvePeriod } from '../services/accounting/fiscal-calendar-service.js';
import { confirmarConReintento, noEntendi } from './kernel/confirmacion.js';
import { translateDomainError } from './entry-command.js';
import type { Palette } from './palette.js';
import {
  abortedByUser,
  blockedByState,
  declareRisk,
  gateMutation,
  render,
  requireExplicitEntity,
  resolveActiveEntity,
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
// mnemosine closing · cierre-proceso — EL CIERRE COMO PROCESO
//
// F06b entregó las tres hojas de LECTURA, que ya tenían backend:
// `getCloseReadiness` (motor + bloqueos de IA) y los detectores de
// `getPeriodCloseStatus`, con código estable por casilla.
//
//   preview  — ¿puede el periodo entrar en cierre, y qué falta?
//   check    — el catálogo de verificaciones, o sólo las nombradas
//   explain  — los renglones ofensores de UNA verificación y su remedio
//
// Las tres son ✓ para el agente: leer nunca certifica nada.
//
// A6 AÑADE EL CONDUCTOR, y sólo él:
//
//   run           — conduce el cierre: devengo, amortización, depreciación,
//                   checklist y cierre suave, en ese orden y una vez cada uno
//   pack generate — sella las cifras del periodo en un expediente
//   pack verify   — el expediente vuelve a correrse contra los libros
//
// Las filas de F06d que siguen sin existir —`start`, `status`, `task*`,
// `approve`, `calendar*`, `template*`— siguen sin existir NI COMO ESQUELETO,
// porque un comando que existe y no hace lo que su fila promete es peor que su
// ausencia. Lo que A6 entrega son las dos que su tarjeta nombra: el conductor y
// su expediente.
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
  /** Costura de prueba: responde la confirmación de `closing run`. */
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
 * El reparto de los pasos en pantalla. Puro y exportado: el contrato de lo que
 * el operador lee no necesita una base para probarse.
 */
export function renderPasos(
  outcome: ClosingRunOutcome,
  c: Pick<Palette, 'dim' | 'red'>
): string[] {
  const MARCA: Record<string, string> = {
    done: MARK.done,
    skipped: '·',
    pending: '·',
    blocked: MARK.missing,
    failed: MARK.missing,
  };
  const ancho = Math.max(...CLOSING_STEPS.map((s) => s.length));
  return outcome.steps.map((p) => {
    const marca = MARCA[p.status] ?? '?';
    const cuerpo = `  ${marca} ${p.step.padEnd(ancho)}  ${p.detail}`;
    const cola = p.priorAttempt ? c.dim('  (also recorded by an earlier attempt of this run)') : '';
    return p.status === 'blocked' || p.status === 'failed'
      ? c.red(cuerpo) + cola
      : cuerpo + cola;
  });
}

/**
 * El código de salida de una corrida, en UNA regla para el ensayo y para la
 * corrida de verdad.
 *
 * La lección es de `payroll accrue`, y se paga cara: allí el ensayo y la
 * corrida contestaban distinto a la misma condición, de modo que un mes con
 * todas las fichas rotas salía 4 en ensayo y 0 corriendo. Aquí la condición se
 * lee de los PASOS, que son los mismos en los dos modos.
 *
 * Y un paso fallido no sale siempre 1. Si el motor LANZÓ, sale lo que su error
 * merece —un panel mal contestado es un 4 en `depreciation run`, y tiene que
 * serlo aquí también, o un guion no distingue un criterio roto de un proceso
 * caído—. Si el motor devolvió errores por renglón, son hallazgos de datos: 4.
 */
export function salidaDeLaCorrida(outcome: ClosingRunOutcome): ExitCodeValue {
  const fallido = outcome.steps.find((p) => p.status === 'failed');
  if (fallido) {
    return fallido.cause !== undefined
      ? exitCodeFor(translateDomainError(fallido.cause))
      : ExitCode.VALIDATION;
  }
  return checkExitCode({
    blocking: outcome.steps.filter((p) => p.status === 'blocked').length,
    warning: 0,
  });
}

/**
 * La última línea de la corrida, dicha según lo que de verdad pasó.
 *
 * Decía «arregla la causa y vuelve a correr con --resume» en cualquier alto, y
 * tras un ensayo eso se negaba (el ensayo no abre corrida), y tras un
 * `--stop-at` no había causa que arreglar.
 */
export function cierreDeLaCorrida(outcome: ClosingRunOutcome, stopAt?: string): string {
  const paso = outcome.haltedAtStep;
  switch (outcome.status) {
    case 'completed':
      return `The close is conducted. Seal the dossier with \`mnemosine closing pack generate "${outcome.periodName}"\`.`;
    case 'stopped':
      return `Stopped before ${paso}, as asked. The period stays open; continue with --resume.`;
    case 'blocked':
      return `Blocked at ${paso}. Clear the blocking items, then continue with --resume.`;
    case 'failed':
      return `Failed at ${paso}. Fix the cause, then continue with --resume.`;
    case 'previewed':
      if (paso && paso === stopAt) return `Nothing was written. A real run would stop before ${paso}.`;
      if (paso) return `Nothing was written. The checklist would block at ${paso}: clear it before conducting.`;
      return 'Nothing was written. Run it without --dry-run to conduct.';
  }
}

/**
 * Escribe el expediente donde se pidió.
 *
 * Los bytes son los del documento sellado, con salto final: `closing pack
 * verify` los vuelve a leer y `sealOf` los vuelve a hashear, así que el disco
 * y el sello no pueden discrepar. Crea la carpeta si falta, como el XML del
 * Anexo 24: pedir un destino y que falle por un directorio inexistente es
 * fricción sin ganancia.
 */
function escribirExpediente(destino: string, pack: ClosingPack): void {
  mkdirSync(path.dirname(path.resolve(destino)), { recursive: true });
  writeFileSync(destino, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
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

/**
 * El periodo que el conductor conduce: uno ABIERTO.
 *
 * `listClosablePeriods` devuelve abiertos Y en cierre suave, porque es la
 * lista de lo que `close` puede cerrar del todo. Para el conductor un periodo
 * en cierre suave no tiene nada que conducir, y tomarlo por omisión volvía a
 * correr los motores sobre el mes ya cerrado mientras el abierto esperaba.
 */
async function periodoParaConducir(ctx: AgentContext, nombre?: string): Promise<ClosablePeriod> {
  const todos = await listClosablePeriods(ctx);
  if (!nombre) {
    const abiertos = todos.filter((p) => p.status === 'open');
    const elegido = abiertos.find((p) => p.overdue) ?? abiertos[0];
    if (!elegido) throw notFound('No open periods: nothing to conduct.');
    return elegido;
  }
  const buscado = nombre.toLowerCase();
  const elegido = todos.find(
    (p) => p.id === nombre || p.period_name.toLowerCase().includes(buscado)
  );
  if (!elegido) {
    throw notFound(
      `No open period matches "${nombre}". Open: ${todos.filter((p) => p.status === 'open').map((p) => p.period_name).join(', ') || 'none'}.`
    );
  }
  if (elegido.status !== 'open') {
    throw blockedByState(
      `${elegido.period_name} is already ${elegido.status}: there is nothing left to conduct. ` +
        `Seal it with \`mnemosine closing pack generate "${elegido.period_name}"\`.`
    );
  }
  return elegido;
}

/**
 * El periodo que se sella: CUALQUIERA, en cualquier estado.
 *
 * Un expediente se pide casi siempre de un mes ya cerrado —el cierre duro
 * incluido—, y la lista de periodos «por cerrar» no los tiene. Por omisión, el
 * último cerrado: el mes que se acaba de entregar, no el más viejo abierto.
 */
async function periodoParaSellar(
  ctx: AgentContext,
  nombre?: string
): Promise<{ id: string; period_name: string }> {
  if (nombre) {
    const p = await resolvePeriod(ctx.entityId, nombre);
    return { id: p.id, period_name: p.period_name };
  }
  const ultimo = await latestClosedPeriodOf(ctx.entityId);
  if (!ultimo) {
    throw notFound(
      'No closed period to seal yet. Name the period to seal an open one on purpose, e.g. `closing pack generate 2026-07`.'
    );
  }
  return ultimo;
}

function cabeceraDePeriodo(r: CloseReadiness, c: Palette): string {
  const p = r.period;
  return (
    c.bold(p.period_name) +
    c.dim(`  ${p.start_date} → ${p.end_date} · ${p.status}${p.overdue ? ' · overdue' : ''}`)
  );
}

// ============================================================
// EJEMPLOS · invocaciones copiables, con datos mexicanos
//
// El periodo se nombra por el NOMBRE que el calendario acuñó ("July 2026") o
// por su id, y `periodoOMasViejo` casa por subcadena del nombre: sin argumento
// se contesta sobre el más viejo abierto, que es el mismo criterio de la hoja
// `close` — dos superficies que contestaran sobre meses distintos no
// previsualizarían nada.
//
// Los códigos de `explain` son los estables de `CLOSE_CHECK_CODES`, y por eso
// `check --check` sin valor los imprime sin tocar la base: preguntar qué se
// puede verificar no debería costar una conexión.
//
// Prosa en inglés (idioma del nodo); los datos son mexicanos.
// ============================================================
const EJEMPLOS = {
  preview: `
Examples:
  # Can the oldest open period enter close, and what is missing?
  mnemosine closing preview
  # A named month. Blocking items come from the engine AND from the AI queues:
  # a draft dated inside the period stops the close like a red checkbox does.
  mnemosine closing preview "July 2026"
  # Warnings block too, for a scripted gate: exit 4 where it would have been 0.
  mnemosine closing preview "July 2026" --strict
`,
  check: `
Examples:
  # The whole catalog over the oldest open period.
  mnemosine closing check
  # What can be verified at all, without touching the database.
  mnemosine closing check --check
  # Two checks only, on a named month. Filtered, the verdict is about WHAT WAS
  # ASKED and nothing else; unfiltered it also weighs the AI blockers.
  mnemosine closing check --period "July 2026" --check trial-balance,ledger-integrity
`,
  explain: `
Examples:
  # The rows keeping one check red, and the exact command that clears them.
  mnemosine closing explain entries-posted
  # Bank lines nobody explained, on a named month, ten rows at most.
  mnemosine closing explain bank-lines-unexplained --period "July 2026" -n 10
  # The offenders as CSV, which is the annex an auditor asks for. The real total
  # travels with the rows, so the --limit cut never passes in silence.
  mnemosine closing explain depreciation-posted --format csv -o cierre-julio-depreciacion.csv
`,
  run: `
Examples:
  # ALWAYS this one first: it says what is pending WITHOUT writing, and it
  # really evaluates the checklist -- the one step that can be asked for free.
  mnemosine closing run --dry-run
  # Conduct the whole month. Three of its steps post to the ledger.
  mnemosine closing run "July 2026" --entity "Acme SA de CV" --yes
  # Do the month but leave the period open: --stop-at stops BEFORE the step.
  mnemosine closing run --stop-at soft-close --yes
  # Continue a run somebody left halted. Without --resume it refuses, on
  # purpose: continuing another person's run in silence is how "I ran it"
  # stops being a claim anybody can stand behind. Every step runs again; the
  # engines post only what is still missing.
  mnemosine closing run --resume --yes
`,
  packGenerate: `
Examples:
  # Seal the month just closed, and write the file the third party gets.
  mnemosine closing pack generate "July 2026" -o cierre-julio.json
  # Without -o the receipt carries the whole document, for a machine that
  # would rather pipe it than write it. Quote the jq filter: zsh globs [0].
  mnemosine closing pack generate 2026-07 --json | jq '.rows[0].document' > cierre-julio.json
`,
  packVerify: `
Examples:
  # The acceptance test of A6: the third party re-runs the dossier.
  mnemosine closing pack verify cierre-julio.json --entity "Acme SA de CV"
  # One row per field that differs, as CSV -- the annex an auditor asks for.
  mnemosine closing pack verify cierre-julio.json --format csv -o deriva.csv
  # A renamed entity or a moved reporting panel is a warning; make it fail too.
  mnemosine closing pack verify cierre-julio.json --strict
`,
} as const;

export function registerClosingCommand(program: Command, deps: ClosingCommandDeps): void {
  const closing = program
    .command('closing')
    .alias('cierre-proceso')
    .description('The close as a process: conduct it, read it, and hand over the dossier that proves it');

  const run = makeRunner(deps);

  /**
   * La confirmación, con la gramática del núcleo y no una escrita a mano:
   * «sí» tecleado en español cuenta como sí en todo el CLI, y una comparación
   * local volvería a contarlo como no.
   */
  const ask = async (question: string): Promise<boolean> => {
    if (deps.confirm) return deps.confirm(question);
    if (!stdin.isTTY) return false;
    // La pregunta va a STDERR: con `--json | jq` en una terminal, una pregunta
    // escrita en stdout se mete en la tubería y rompe el documento.
    const rl = readline.createInterface({ input: stdin, output: process.stderr });
    try {
      const veredicto = await confirmarConReintento(
        (prompt) => rl.question(prompt).catch(() => null),
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
    // NO dice «YYYY-MM»: `periodoOMasViejo` casa por id o por subcadena del
    // nombre acuñado, y sólo sobre periodos ABIERTOS. `period show 2026-07` sí
    // resuelve porque va por `resolvePeriod`; éste no. Prometer las tres formas
    // mandaba al usuario a un «no encontrado» sobre un periodo que existe.
    .argument('[period]', 'open period name or id (default: the oldest open one)')
    .description('Read-only twin of closing start: says whether the period can enter close and what is missing');
  withStrict(withOutput(withContext(preview)));
  declareRisk(preview, { risk: 'lectura', agent: true });
  preview.addHelpText('after', EJEMPLOS.preview);
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
  check.addHelpText('after', EJEMPLOS.check);
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
  explain.addHelpText('after', EJEMPLOS.explain);
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
  // ---- closing run -------------------------------------------------
  //
  // A6 · EL CONDUCTOR. Everything it does, some other command could already do
  // by hand and in the right order; what it adds is that nobody has to
  // remember the order, and that what it did is written down.
  const corrida = closing
    .command('run')
    .alias('ejecutar')
    .argument('[period]', 'open period name or id (default: the oldest open one)')
    .description(
      'Conduct the close: accrue, amortize, depreciate, verify the checklist and soft-close, in that order'
    );
  withContext(corrida);
  withOutput(corrida);
  corrida.option(
    '--stop-at <step>',
    `stop BEFORE this step: ${CLOSING_STEPS.join(', ')}`
  );
  corrida.option('--resume', 'continue the open run of this period; every step runs again, posting only what is missing');
  // IRREVERSIBLE, and it does not pretend otherwise: three of its five steps
  // post to the ledger of migration 041, where nothing is edited or deleted.
  // The agent is refused: it proposes, a human conducts.
  //
  // LA LLAVE ES INNECESARIA, y se declara para que la ayuda lo diga en vez de
  // prometer una deduplicación que otro mecanismo ya da: cada motor se niega a
  // postear dos veces el mismo mes por su cuenta (la depreciación pregunta al
  // mayor, la amortización al calendario, el devengo a la cédula), el cierre
  // suave mira el estado del periodo antes de tocarlo, y un candado consultivo
  // impide que dos conductores corran el mismo periodo a la vez. Una llave
  // encima habría sido una cuarta guarda que además ROMPE la continuación:
  // devolvería el resultado grabado en vez de volver a correr los pasos.
  declareRisk(corrida, {
    risk: 'irreversible',
    agent: false,
    writes:
      'journal_entries + journal_entry_lines (through the accrual, amortization and depreciation engines), ' +
      'closing_runs, closing_run_steps, and fiscal_periods.status on the soft close',
    llave: {
      innecesaria:
        'los motores no postean dos veces el mismo mes y un candado consultivo impide dos conductores ' +
        'sobre el mismo periodo: volver a correr, con --resume si hay una corrida abierta, no duplica nada',
    },
  });
  corrida.addHelpText('after', EJEMPLOS.run);
  corrida.action(
    (
      periodArg: string | undefined,
      opts: CommonOpts & {
        stopAt?: string;
        resume?: boolean;
        dryRun?: boolean;
        yes?: boolean;
      }
    ) =>
      run(async () => {
        const { dryRun } = gateMutation(corrida, opts as unknown as Record<string, unknown>);

        if (opts.stopAt !== undefined && !isClosingStep(opts.stopAt)) {
          // Un paso desconocido es error de USO y no un filtro vacío que sale
          // 0: la misma lección que `closing check --check`.
          throw usageError(
            `Unknown step "${opts.stopAt}". The steps are: ${CLOSING_STEPS.join(', ')}.`
          );
        }
        const stopAt = opts.stopAt;

        bootstrapTenant(opts.tenant);
        // LA MISMA ENTIDAD EN EL ENSAYO QUE EN LA CORRIDA. Un ensayo resuelto
        // por otro camino —sin la entidad fijada, sin MNEMOSINE_ENTITY—
        // previsualizaría una sociedad y la corrida actuaría sobre otra.
        const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
        const periodo = await periodoParaConducir(ctx, periodArg);

        // UNA CORRIDA ABIERTA NO SE CONTINÚA EN SILENCIO.
        //
        // Esta comprobación es la CORTESÍA: llega antes de la pregunta, para no
        // hacer confirmar a nadie algo que se le va a negar. La regla vive en
        // el conductor, bajo el candado (`openRun`), donde ningún llamador
        // puede saltársela. Es un estado de los libros y no un error de las
        // banderas: sale 5, no 2.
        if (!dryRun) {
          const abierta = await openRunOf(ctx.entityId, periodo.id);
          if (abierta && opts.resume !== true) {
            throw blockedByState(
              `This period already has an open close run (${describeOpenRun(abierta)}). ` +
                'Continue it with --resume, or look at it first with --dry-run.'
            );
          }
          if (!abierta && opts.resume === true) {
            throw blockedByState(
              'Nothing to resume: this period has no open close run. Run it without --resume to start one.'
            );
          }
        }

        if (!dryRun && opts.yes !== true) {
          const si = await ask(
            `Conduct the close of ${periodo.period_name}? Three of its steps post to the ledger, ` +
              'which does not admit undo, and the last one soft-closes the period.'
          );
          if (!si) {
            throw abortedByUser(
              stdin.isTTY
                ? 'Nothing was done: the ledger was not touched.'
                : 'Nothing was done: there is no terminal to confirm on. Add -y to conduct without asking, ' +
                  'or --dry-run to see what is pending without writing.'
            );
          }
        }

        const outcome = await conductClose(ctx, periodo, {
          userId: (await resolveReviewer(ctx.tenantId, opts.user)).userId,
          stopAt,
          dryRun,
          resume: opts.resume === true,
        });

        if (!legible(opts)) {
          // UN documento y no dos tablas: con --json, dos `render` seguidos
          // escriben dos sobres pegados y `JSON.parse` revienta. La causa de un
          // paso fallido no viaja: es un objeto de error, y su mensaje ya está
          // en `detail`.
          render([{ ...outcome, steps: outcome.steps.map(({ cause: _cause, ...s }) => s) }], {
            ...opts,
            idField: 'periodId',
          });
        } else {
          const c = deps.palette;
          const out = process.stdout;
          out.write(`\n${c.bold(periodo.period_name)}  ${c.dim(outcome.status)}\n\n`);
          for (const linea of renderPasos(outcome, c)) out.write(`${linea}\n`);
          out.write(`\n  ${cierreDeLaCorrida(outcome, stopAt)}\n\n`);
        }

        return salidaDeLaCorrida(outcome);
      })
  );

  // ---- closing pack ------------------------------------------------
  const expediente = closing
    .command('pack')
    // `paquete` y no `expediente`: el catálogo publicó `cierre-proceso paquete
    // generar` antes de que esto existiera, y un alias que no case con la fila
    // publicada obliga a mantener dos nombres del mismo acto. La prosa sigue
    // diciendo «expediente», que es la palabra de la tarjeta de A6.
    .alias('paquete')
    .description('The dossier of a close: generate it, and verify that its figures still reproduce');

  // ---- closing pack generate ---------------------------------------
  const generar = expediente
    .command('generate')
    .alias('generar')
    .argument('[period]', 'period name, YYYY-MM or id, in any status (default: the most recently closed one)')
    .description('Seal the period figures into a dossier a third party can re-run');
  withContext(generar);
  withOutput(generar);
  declareRisk(generar, {
    risk: 'escritura',
    agent: false,
    writes: 'closing_packs (append-only: a correction is a NEW dossier, never a rewrite)',
  });
  // `-o` AQUÍ NOMBRA EL EXPEDIENTE, NO LA TABLA, igual que en las dos
  // `e-accounting ... generate` con su XML. La descripción que inyecta
  // `withOutput` dice lo contrario, y una ayuda que promete algo distinto de lo
  // que el código hace es la clase de mentira que este repositorio ya cazó en
  // `ap reconcile`: se corrige la DESCRIPCIÓN de esta hoja, y la grafía y la
  // forma corta las sigue gobernando el diccionario.
  const destinoDelExpediente = generar.options.find((o) => o.long === '--output');
  if (destinoDelExpediente) {
    destinoDelExpediente.description =
      'write the dossier to this path (closing_packs keeps its own copy)';
  }
  generar.addHelpText('after', EJEMPLOS.packGenerate);
  generar.action((periodArg: string | undefined, opts: CommonOpts) =>
    run(async () => {
      bootstrapTenant(opts.tenant);
      const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
      const periodo = await periodoParaSellar(ctx, periodArg);
      const ultima = await latestRunOf(ctx.entityId, periodo.id);

      const pack = await buildClosingPack(ctx.entityId, periodo.id, {
        runId: ultima?.id ?? null,
        userId: (await resolveReviewer(ctx.tenantId, opts.user)).userId,
      });

      // EL ARCHIVO ANTES QUE EL REGISTRO. `closing_packs` es de sólo agregar:
      // una fila escrita antes de un `-o` que falla (carpeta sin permiso,
      // disco lleno) quedaría para siempre como un expediente EMITIDO que
      // nadie recibió, y cada reintento añadiría otro. Al revés, un registro
      // que falla después de escribir el archivo se deshace borrando el
      // archivo, que sí se puede borrar.
      const destino = typeof opts.output === 'string' && opts.output !== '' ? opts.output : null;
      if (destino) escribirExpediente(destino, pack);
      let id: string;
      try {
        id = await storeClosingPack(ctx.entityId, periodo.id, pack);
      } catch (err) {
        if (destino) rmSync(destino, { force: true });
        throw err;
      }

      const recibo = {
        pack: id,
        period: periodo.period_name,
        as_of: pack.sealed.as_of,
        seal: pack.seal,
        accounts: pack.sealed.figures.trial_balance.length,
        debit: pack.sealed.figures.totals.debit,
        credit: pack.sealed.figures.totals.credit,
        balanced: pack.sealed.figures.totals.balanced,
        run: pack.envelope.run_id,
        file: destino,
      };

      // El recibo se lee en pantalla aunque haya `-o`: ese destino lo ocupa el
      // expediente, así que `legible` no puede mirarlo aquí (e-accounting toma
      // la misma excepción por la misma razón).
      const reciboLegible =
        !opts.json && (opts.format ?? 'table') === 'table' && !opts.quiet && opts.fields === undefined;
      if (reciboLegible) {
        render([recibo], { format: 'table', idField: 'pack' });
        process.stderr.write(
          deps.palette.dim(`verify it with: mnemosine closing pack verify ${recibo.file ?? '<file>'}\n`)
        );
      } else {
        // El destino ya lo ocupa el expediente: el recibo sale por stdout sin
        // `output`, como el recibo del XML del Anexo 24. Y lleva el expediente
        // ENTERO dentro, para que una máquina que no usó `-o` no se quede sin
        // el documento que acaba de sellar.
        const { output: _destino, ...sinDestino } = opts;
        render([{ ...recibo, document: pack }], { ...sinDestino, idField: 'pack' });
      }
      return ExitCode.OK;
    })
  );

  // ---- closing pack verify -----------------------------------------
  const verificar = expediente
    .command('verify')
    // `comprobar`, no `verificar`: el diccionario del núcleo asigna
    // «verificar» a `check` y «comprobar» a `verify`, y dos hojas hermanas que
    // se llamaran igual en castellano —`closing check` es «verificar»— serían
    // dos nombres para dos actos distintos.
    .alias('comprobar')
    .argument('<file>', 'the dossier to verify')
    .description(
      'Re-run a dossier against the books: was it issued here, do its figures still reproduce, and exactly what moved'
    );
  withContext(verificar);
  withOutput(verificar);
  withStrict(verificar);
  declareRisk(verificar, { risk: 'lectura', agent: true });
  verificar.addHelpText('after', EJEMPLOS.packVerify);
  verificar.action((file: string, opts: CommonOpts) =>
    run(async () => {
      let texto: string;
      try {
        texto = readFileSync(file, 'utf8');
      } catch {
        throw notFound(`Cannot read ${file}.`);
      }
      // UN ARCHIVO QUE NO ES UN EXPEDIENTE ES ERROR DE USO, no un fallo
      // genérico: quien lo teclea se equivocó de ruta, y el 1 —«último
      // recurso» del contrato §4— no le dice eso. El motor lanza un Error
      // pelado a propósito: los códigos de salida son del CLI, no suyos.
      let pack: ClosingPack;
      try {
        pack = parseClosingPack(texto);
      } catch (err) {
        throw usageError(err instanceof Error ? err.message : String(err));
      }

      bootstrapTenant(opts.tenant);
      // LA ENTIDAD LA DICE EL EXPEDIENTE, y se comprueba contra la que el
      // operador tiene delante —resuelta como la resuelve toda hoja: bandera,
      // variable, entidad fijada—. Verificar el expediente de una sociedad
      // mientras se cree estar mirando el de su hermana es exactamente el modo
      // en que una verificación en verde no prueba nada.
      const { ctx } = await resolveActiveEntity({ entity: opts.entity }, { home: deps.home });
      if (ctx.entityId !== pack.sealed.entity.id) {
        throw usageError(
          `This dossier belongs to "${pack.sealed.entity.name}" and the active entity is ` +
            `"${ctx.entityName}". Name the right one with --entity.`
        );
      }

      const veredicto = await verifyClosingPack(pack);
      const hallazgos = verdictFindings(veredicto);

      const tabular = !opts.json && ['csv', 'tsv', 'md'].includes(opts.format ?? '');
      if (tabular) {
        // EL ANEXO QUE PIDE UN AUDITOR ES UNA FILA POR CAMPO, no un veredicto
        // con las diferencias apretadas en una celda JSON: en csv, tsv y md las
        // FILAS son las diferencias. El veredicto entero es de --json.
        render(veredicto.differences as unknown as Row[], { ...opts, idField: 'path' });
      } else if (!legible(opts)) {
        render([veredicto as unknown as Row], { ...opts, idField: 'expectedSeal' });
      } else {
        const c = deps.palette;
        const out = process.stdout;
        const marca = (ok: boolean) => (ok ? MARK.done : MARK.missing);
        out.write(
          `\n${c.bold(pack.sealed.period.name)}  ${c.dim(`${pack.sealed.entity.name} · as of ${pack.sealed.as_of}`)}\n\n`
        );
        out.write(`  ${marca(veredicto.sealIntact)} the file agrees with its seal\n`);
        out.write(
          `  ${marca(veredicto.issued)} these books issued a dossier with this seal` +
            `${veredicto.issuedAt ? c.dim(` (${veredicto.issuedAt})`) : ''}\n`
        );
        out.write(`  ${marca(veredicto.figuresReproduce)} the figures reproduce against the books\n`);
        const avisos: string[] = [];
        if (!veredicto.identityUnchanged) {
          avisos.push('the entity or period identity changed since sealing (see the rows marked identity)');
        }
        if (!veredicto.criteriaUnchanged) {
          const panel = veredicto.differences
            .filter((d) => d.kind === 'criteria')
            .map((d) => `${d.path}: ${d.expected} → ${d.actual}`)
            .join('; ');
          avisos.push(
            `the reporting panel moved since sealing (${panel}); rows marked figure are what differs in the ledger's figures, whatever the cause`
          );
        }
        if (veredicto.issued && !veredicto.envelopeMatches) {
          avisos.push('the envelope (who, when, which run) is not the one registered when it was issued');
        }
        for (const a of avisos) out.write(`\n  ${c.dim('warning:')} ${a}`);
        if (avisos.length > 0) out.write('\n');
        if (veredicto.differences.length > 0) {
          out.write('\n');
          render(veredicto.differences as unknown as Row[], { format: 'table', idField: 'path' });
        }
        out.write('\n');
      }

      return checkExitCode(hallazgos, { strict: opts.strict });
    })
  );
}
