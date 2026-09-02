import * as readline from 'node:readline/promises';
import { confirmarConReintento, noEntendi } from './kernel/confirmacion.js';
import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { attestEntryAsync } from '../services/accounting/posting.js';
import {
  listBatches,
  showBatch,
  checkBatch,
  postBatch,
  reverseBatch,
  ESTADOS_LOTE,
  CLASES_DE_LOTE,
  CATEGORIAS_DE_HALLAZGO,
  type ContextoLote,
  type HallazgoDeFila,
  type ResultadoAplicacion,
  type ResultadoReversa,
} from '../services/accounting/batch-service.js';
import { conLlave, hashDeCarga } from '../services/idempotency/idempotency-store.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  gateMutation,
  render,
  withContext,
  withOutput,
  withReadFlags,
  withStrict,
  resolveActiveEntity,
  requireExplicitEntity,
  checkExitCode,
  exitCodeFor,
  usageError,
  abortedByUser,
  ExitCode,
  type ExitCodeValue,
} from './kernel/index.js';

// ============================================================
// mnemosine batch · lote
//
// La salida del almacén que F01 dejó sin puerta: `entry import` deposita
// pólizas en el staging de la 045 desde el primer día, y hasta hoy nadie
// podía listarlas, verificarlas, aplicarlas ni reversarlas. Cinco hojas de
// fase 1 sobre services/accounting/batch-service.ts, que es quien habla con
// la máquina de estados (staged → checked → posted) y con el mayor.
//
// `batch` es sustantivo RAÍZ y no `entry batch` a propósito (catálogo,
// §lotes): un lote también lo producirá una corrida recurrente, una
// revaluación o un cierre; hoy la única clase viva es `import`.
//
// SEIS DECISIONES QUE NO SON DE ESTILO.
//
// LA PRIMERA · el riesgo sale del CATÁLOGO, no del criterio de esta sesión:
// list/show/check son `lectura` con IA ✓; post/reverse son `irreversible`
// con IA ✗ sin excepción — postean y espejan el mayor. `check` MUEVE estado
// (staged→checked) y aun así el catálogo lo marca lectura: no toca el mayor,
// su producto entero es un informe, y la transición es la contabilidad del
// propio informe. Se acata la fila; si un día duele, se corrige la fila y no
// este archivo.
//
// LA SEGUNDA · `--status` habla el vocabulario de la 045
// (staged|checked|posted|discarded), NO el del catálogo
// (pending|running|completed|failed|cancelled). El mapeo es ambiguo
// (`checked` no tiene contraparte, `failed` no existe en el CHECK) y el
// servicio ya se negó a inventarlo; mentir aquí sería peor que rechazar en
// voz alta. El error de uso nombra los cuatro estados reales.
//
// LA TERCERA · `--check <name,…>` filtra el INFORME por categoría cerrada
// (parse|forma|cuenta|periodo|validacion); la batería completa corre
// siempre. `validateJournalEntry` es una unidad de siete reglas y partirla
// exigiría reimplementarla — exactamente la divergencia que el reuso del
// servicio existe para impedir. Si el filtro esconde hallazgos bloqueantes,
// se dice en stderr y el código de salida sigue contando TODO: un 0 por
// haber mirado poco sería el mismo defecto que un `--limit` que trunca en
// silencio.
//
// LA CUARTA · las dos hojas irreversibles siguen el patrón de F05d: el acto
// se ENSAYA de verdad (el dryRun del servicio recorre el camino real y
// revierte), se imprime lo que devolvió el ensayo y se pregunta sobre ESO;
// con `-y` no hay ensayo previo, y `--idempotency-key` se HONRA con
// `conLlave` — la misma llave con la misma carga devuelve el resultado
// grabado sin volver a postear, y con otra carga acusa reuso (salida 6).
//
// LA QUINTA · la atestación se dispara DESPUÉS del commit y sólo cuando el
// acto corrió: nunca en ensayo (el servicio ya devuelve `attestations`
// vacías) y nunca en un hit de idempotencia — el resultado grabado describe
// pólizas que se atestaron en su momento, y re-atestarlas desde un reintento
// atestaría sobre un acto que esta corrida no ejecutó.
//
// LA SEXTA · `discard` existe en el CHECK de la 045 y NO existe aquí: no
// tiene fila de fase 1 y el servicio jamás lo escribe. Se reporta, no se
// inventa — un verbo de descarte sin catálogo sería una decisión de
// superficie tomada por nadie.
// ============================================================

export interface BatchCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Costura de prueba para la confirmación de post/reverse. */
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
  limit?: number;
  offset?: number;
  all?: boolean;
  status?: string[];
  since?: string;
  strict?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  reason?: string;
  idempotencyKey?: string;
}

/** Columnas de dinero y conteo: se alinean a la derecha y jamás son number. */
const NUMERICAS = ['rows_total', 'rows_invalid', 'entries_posted', 'total_debe', 'lineas', 'row_number'];

/** Fecha corta para pantalla; las columnas de la base ya vienen como Date o texto. */
const dia = (v: Date | string | null | undefined): string => {
  if (v === null || v === undefined) return '';
  return (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
};

// ============================================================
// EJEMPLOS · invocaciones copiables, con datos mexicanos
//
// El identificador de un lote es el UUID que `entry import` imprimió al
// dejarlo en el almacén; no hay folio corto que teclear. Los estados son los
// de la 045 —staged, checked, posted, discarded— y NO el vocabulario de colas
// (pending/running/…), que es de otra tabla. Las categorías de hallazgo de
// `check` son las cinco cerradas del servicio: la batería corre entera
// siempre, `--check` sólo acota EL INFORME.
//
// Prosa en inglés (idioma del nodo); los datos son mexicanos.
// ============================================================
const EJEMPLOS = {
  list: `
Examples:
  # Everything entry import left staged and nobody has applied yet.
  mnemosine batch list --status staged
  # What was prepared since the first of July. This family filters by WHEN THE
  # BATCH WAS PREPARED: --since only; there is no upper bound and no date basis.
  mnemosine batch list --since 2026-07-01 --kind import --limit 20
`,
  show: `
Examples:
  # One batch in full: every row, the entry each one produced, and the file hash.
  mnemosine batch show 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13
  # Only the rows the parser rejected, as CSV, to send back to whoever built the file.
  mnemosine batch show 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --errors-only --format csv
`,
  check: `
Examples:
  # Run the whole battery over every row. Exit 4 means it found something.
  mnemosine batch check 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13
  # Narrow the REPORT to two of the five finding categories. The battery still
  # runs whole, and a blocking finding left outside the filter still counts
  # towards the exit code (it says so on stderr).
  mnemosine batch check 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --check cuenta,periodo
  # Warnings block too, for a scripted gate before the close.
  mnemosine batch check 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --strict
`,
  post: `
Examples:
  # See the whole effect first: every entry the batch would post, with its total.
  # Do this before the real one — the ledger has no UPDATE and no DELETE.
  mnemosine batch post 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --dry-run
  # Apply the batch in ONE transaction: all the rows or none of them. A batch
  # that has not passed check is refused.
  mnemosine batch post 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13
  # Apply what is valid and leave the invalid rows staged, unattended. Replaying
  # the same key returns the recorded result instead of posting a second time.
  mnemosine batch post 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --partial --yes --idempotency-key lote-julio-2026
`,
  reverse: `
Examples:
  # Mirror every entry the batch posted, as the unit it always was. --reason is
  # required: an import error is batch-shaped, not entry-shaped.
  mnemosine batch reverse 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --reason "El archivo traia el mes equivocado"
  # Which entries would be mirrored, without keeping anything. One entry already
  # reversed by hand stops the whole thing, naming its folio.
  mnemosine batch reverse 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --dry-run
  # Date every mirror into the month being closed instead of today.
  mnemosine batch reverse 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --as-of 2026-07-31 --reason "Reversa del lote de julio"
`,
} as const;

export function registerBatchCommand(program: Command, deps: BatchCommandDeps): void {
  const batch = program
    .command('batch')
    .alias('lote')
    .description(
      'Staged entry batches: list, inspect, check, post transactionally and reverse as a unit'
    );

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
    // un --tenant aplicado después no resolvería nada.
    bootstrapTenant(opts.tenant);
    return requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
  };

  const contexto = (ctx: { tenantId: string; entityId: string }): ContextoLote => ({
    tenantId: ctx.tenantId,
    entityId: ctx.entityId,
  });

  const ask = async (question: string): Promise<boolean> => {
    if (deps.confirm) return deps.confirm(question);
    if (!process.stdin.isTTY) return false;
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      // Por el kernel: la gramática de «sí» es una sola en todo el CLI y
      // entiende los dos idiomas. La de aquí sólo aceptaba `y`/`yes`, de modo
      // que un «sí» tecleado en español contaba como NO.
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

  /** El aborto que NO parece un fallo: sin TTY se nombra `-y` por su nombre. */
  const exigirConfirmacion = async (pregunta: string, comando: string): Promise<void> => {
    if (await ask(pregunta)) return;
    throw abortedByUser(
      process.stdin.isTTY
        ? 'Sin cambios: el mayor no se tocó.'
        : `Sin cambios: no hay terminal donde confirmar. Añade -y para que \`${comando}\` corra ` +
            'sin preguntar, o --dry-run para ver el efecto completo sin escribir nada.'
    );
  };

  /** Aviso de idempotencia: stderr, para que un tubo --json siga siendo JSON. */
  const avisarRepetido = (clave: string | undefined, que: string): void => {
    process.stderr.write(
      deps.palette.yellow(
        `↩ Idempotency hit: la llave "${clave ?? ''}" ya consumó este acto — ${que}. ` +
          'Nada se ejecutó otra vez; esto es el resultado grabado.\n'
      )
    );
  };

  /** Cede la ficha escrita a mano en cuanto el usuario pide otra forma. */
  const legible = (opts: CommonOpts): boolean =>
    !opts.json &&
    (opts.format ?? 'table') === 'table' &&
    !opts.quiet &&
    opts.output === undefined &&
    opts.fields === undefined;

  /**
   * Un valor de --status que no existe es un error de USO (2), no una
   * validación fallida del dominio (4): un guion que confunde un typo con
   * «los libros están mal» es un guion que nadie puede vigilar. Aquí además
   * se le dice al que tecleó el vocabulario del catálogo que esta tabla habla
   * el de la 045.
   */
  const unSoloEstado = (status?: string[]): string | undefined => {
    if (!status || status.length === 0) return undefined;
    if (status.length > 1) {
      throw usageError(
        'Un estado a la vez: el flujo del lote es corto (staged → checked → posted) y un filtro ' +
          'múltiple no responde ninguna pregunta que dos corridas no respondan mejor.'
      );
    }
    const s = status[0];
    if (!(ESTADOS_LOTE as readonly string[]).includes(s)) {
      throw usageError(
        `--status "${s}" no existe en el flujo del lote. Los estados reales (045): ` +
          `${ESTADOS_LOTE.join(', ')}. El vocabulario pending|running|completed|failed|cancelled ` +
          'no corresponde a esta tabla.'
      );
    }
    return s;
  };

  /** El filtro de `--check`, contra el vocabulario cerrado del servicio. */
  const filtroDeCategorias = (spec?: string): Set<string> | undefined => {
    if (!spec) return undefined;
    const pedidas = spec.split(',').map((c) => c.trim()).filter(Boolean);
    if (pedidas.length === 0) return undefined;
    const desconocidas = pedidas.filter(
      (c) => !(CATEGORIAS_DE_HALLAZGO as readonly string[]).includes(c)
    );
    if (desconocidas.length > 0) {
      throw usageError(
        `--check no reconoce: ${desconocidas.join(', ')}. Las categorías cerradas son ` +
          `${CATEGORIAS_DE_HALLAZGO.join(', ')}. La batería completa corre siempre; ` +
          'el filtro sólo acota el informe.'
      );
    }
    return new Set(pedidas);
  };

  // ---- batch list --------------------------------------------------
  const list = batch
    .command('list')
    .alias('listar')
    .description('List batches with their state, row counts, posted entries and content hash');
  withReadFlags(list);
  list.option('--kind <kind>', `batch class (available: ${CLASES_DE_LOTE.join(', ')})`);
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', EJEMPLOS.list);
  list.action((opts: CommonOpts & { kind?: string }, cmd: Command) =>
    run(async () => {
      const ctx = await entityOf(opts);

      // El grupo de tiempo completo se declara (contrato de lista) y lo que el
      // servicio no puede honrar se rechaza EN VOZ ALTA: una bandera aceptada
      // y no leída es una promesa incumplida — el defecto exacto que `ap
      // reconcile` ya cazó con --fields.
      for (const [flag, opcion] of [
        ['--period', 'period'],
        ['--until', 'until'],
        ['--as-of', 'asOf'],
        ['--date-basis', 'dateBasis'],
      ] as const) {
        if (cmd.getOptionValueSource(opcion) === 'cli') {
          throw usageError(
            `${flag} no aplica a los lotes: un lote se filtra por cuándo se preparó, con --since ` +
              '(created_at >= fecha). No hay rango superior ni base de fecha que elegir.'
          );
        }
      }
      if (opts.offset !== undefined) {
        throw usageError(
          '--offset no está implementado en esta familia: la consulta ordena por created_at y ' +
            'acota con --limit, sin cursor estable. Acota con --since o sube --limit.'
        );
      }

      const limit = opts.all ? 1000 : (opts.limit ?? 50);
      const lotes = await listBatches(contexto(ctx), {
        status: unSoloEstado(opts.status),
        kind: opts.kind,
        since: opts.since,
        limit,
      });

      render(
        lotes.map((l) => ({ ...l, created_at: dia(l.created_at) })),
        {
          ...opts,
          idField: 'id',
          numeric: NUMERICAS,
          // `--fields` manda TAMBIÉN en la tabla por omisión; sin él, las
          // columnas que caben en una terminal. file_hash y created_by quedan
          // disponibles por --fields.
          fields:
            opts.fields ??
            'id,status,layout,file_name,rows_total,rows_invalid,entries_posted,created_at',
        }
      );
      if (lotes.length === limit) {
        process.stderr.write(
          deps.palette.yellow(
            `Se listaron ${lotes.length} lote(s), que es el tope de --limit: puede haber más. ` +
              'Sube --limit o acota con --since.\n'
          )
        );
      }
    })
  );

  // ---- batch show --------------------------------------------------
  const show = batch
    .command('show')
    .alias('ver')
    .argument('<id>', 'batch id')
    .description(
      'One batch in full: rows with their generated entries, stored parse errors by category, ' +
        'and the file hash'
    );
  withOutput(withContext(show));
  show.option('--errors-only', 'only the rows whose parser rejected them');
  declareRisk(show, { risk: 'lectura', agent: true });
  show.addHelpText('after', EJEMPLOS.show);
  show.action((id: string, opts: CommonOpts & { errorsOnly?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const detalle = await showBatch(contexto(ctx), id);
      const filas = opts.errorsOnly
        ? detalle.filas.filter((f) => f.parse_error !== null)
        : detalle.filas;
      const p = deps.palette;

      if (!legible(opts)) {
        // Un solo documento con las filas anidadas: la respuesta de la máquina
        // es el mismo objeto que la del servicio, para que no diverjan.
        render(
          [
            {
              ...detalle.lote,
              created_at: dia(detalle.lote.created_at),
              filas,
              errores_por_categoria: detalle.errores_por_categoria,
            },
          ],
          { ...opts, idField: 'id' }
        );
        return;
      }

      const l = detalle.lote;
      const out = process.stdout;
      out.write(`\n${p.bold(`LOTE ${l.id}`)} ${p.dim(`· ${l.status} · ${l.kind}/${l.layout}`)}\n`);
      const ficha = (etiqueta: string, valor: string) =>
        out.write(`  ${p.dim(etiqueta.padEnd(12))}${valor}\n`);
      ficha('archivo', `${l.file_name ?? '(sin nombre)'} · sha256 ${l.file_hash.slice(0, 12)}…`);
      ficha(
        'filas',
        `${l.rows_total} total · ${l.rows_invalid} inválida(s) · ${l.entries_posted} póliza(s) en el mayor`
      );
      ficha('preparado', `${dia(l.created_at)} por ${l.created_by}`);

      out.write(`\n${p.bold('FILAS')} ${p.dim(`(${filas.length})`)}\n`);
      if (filas.length === 0) {
        out.write(
          p.dim(opts.errorsOnly ? '  ninguna fila con error de parseo\n' : '  el lote está vacío\n')
        );
      } else {
        render(
          filas.map((f) => ({
            fila: f.row_number,
            fecha: f.date ?? '',
            lineas: f.lineas ?? '',
            total_debe: f.total_debe ?? '',
            poliza: f.entry_number ?? '',
            reversada: f.entry_reversed ? '✓' : '',
            error: f.parse_error ? `[${f.categoria ?? 'otro'}] ${f.parse_error}` : '',
          })),
          { format: 'table', idField: 'fila', numeric: ['fila', 'lineas', 'total_debe'] }
        );
      }

      const categorias = Object.entries(detalle.errores_por_categoria);
      if (categorias.length > 0) {
        out.write(
          `\n  ${p.dim('errores de parseo por categoría:')} ` +
            categorias.map(([c, n]) => `${c}=${n}`).join(' · ') +
            '\n'
        );
      }
      out.write('\n');
    })
  );

  // ---- batch check -------------------------------------------------
  const check = batch
    .command('check')
    .alias('verificar')
    .argument('<id>', 'batch id')
    .description(
      'Run the posting validations over every row and report each finding; exits 4 when any blocks'
    );
  withOutput(withStrict(withContext(check)));
  check.option(
    '--check <names>',
    // OJO, y está medido: `cuenta`, `periodo` y `forma` son VALORES que el
    // usuario teclea —vocabulario cerrado del servicio—, pero salen aquí
    // desnudos dentro de una frase inglesa, así que el censo de superficie
    // (`npm run ux:status`) cuenta esta hoja como prosa fuera del idioma
    // canónico y tiene razón. Los acentos graves de la línea de abajo son los
    // delimitadores de la plantilla, no marcas del valor: un comentario
    // anterior afirmaba que sí lo eran, y era falso.
    //
    // No se renombran aquí a propósito: el idioma de un VALOR de bandera es
    // superficie visible y pertenece a la decisión §5.1 del plan maestro, que
    // sigue abierta y es del dueño. La línea base del censo queda en 7 con
    // esta razón escrita, no maquillada a 6.
    `finding categories to display, comma-separated (available: ${CATEGORIAS_DE_HALLAZGO.join(', ')}); ` +
      'the full battery always runs'
  );
  declareRisk(check, { risk: 'lectura', agent: true });
  check.addHelpText('after', EJEMPLOS.check);
  check.action((id: string, opts: CommonOpts & { check?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const pedidas = filtroDeCategorias(opts.check);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const p = deps.palette;

      const r = await checkBatch(contexto(ctx), id, reviewer.userId, {
        strict: opts.strict === true,
      });

      const conHallazgo = r.filas.filter((f) => !f.ok || f.advertencias.length > 0);
      const visibles = pedidas
        ? conHallazgo.filter((f) => f.categoria !== null && pedidas.has(f.categoria))
        : conHallazgo;
      const bloqueantesOcultas = pedidas
        ? conHallazgo.filter((f) => !f.ok && !visibles.includes(f)).length
        : 0;

      if (!legible(opts)) {
        render(
          visibles.map((f: HallazgoDeFila) => ({
            row_number: f.row_number,
            ok: f.ok,
            categoria: f.categoria ?? '',
            errores: f.errores.join(' | '),
            advertencias: f.advertencias.join(' | '),
          })),
          { ...opts, idField: 'row_number', numeric: ['row_number'] }
        );
      } else {
        const out = process.stdout;
        out.write(
          `\n${p.bold(`LOTE ${r.batchId}`)} ${p.dim(
            `· ${r.validas + r.invalidas} fila(s) verificadas` +
              (opts.strict ? ' · estricto' : '') +
              (pedidas ? ` · informe acotado a ${[...pedidas].join(',')}` : '')
          )}\n\n`
        );
        for (const f of visibles) {
          if (!f.ok) {
            out.write(
              `  ${p.red('✘')} fila ${f.row_number} ${p.dim(`[${f.categoria ?? 'otro'}]`)} — ` +
                `${f.errores.join('; ')}\n`
            );
          } else {
            out.write(
              `  ${p.yellow('!')} fila ${f.row_number} — ${f.advertencias.join('; ')}\n`
            );
          }
        }
        if (visibles.length === 0) out.write(p.dim('  ningún hallazgo que enseñar\n'));
        out.write(
          r.invalidas === 0
            ? `\n${p.green('✔')} ${r.validas} fila(s) válidas: el lote queda '${r.status}'.\n`
            : `\n${p.red('✘')} ${r.invalidas} inválida(s) y ${r.validas} válida(s): el lote se ` +
                `queda '${r.status}'. Corrige el archivo y reimporta, o aplica lo válido con ` +
                '`batch post --partial`.\n'
        );
      }

      if (bloqueantesOcultas > 0) {
        process.stderr.write(
          p.yellow(
            `${bloqueantesOcultas} hallazgo(s) bloqueante(s) quedaron fuera del informe por --check; ` +
              'el código de salida los cuenta igual.\n'
          )
        );
      }

      // 4 es «encontré algo», nunca «no pude mirar»: los fallos de
      // infraestructura suben como error y salen 1/2/3 por exitCodeFor.
      const advertencias = r.filas.filter((f) => f.ok && f.advertencias.length > 0).length;
      return checkExitCode(
        { blocking: r.invalidas, warning: advertencias },
        { strict: opts.strict === true }
      );
    })
  );

  // ---- batch post --------------------------------------------------
  const post = batch
    .command('post')
    .alias('contabilizar')
    .argument('<id>', 'batch id')
    .description(
      'Post the whole batch in one transaction; --partial applies the valid rows and leaves the ' +
        'rest staged'
    );
  withContext(post);
  post
    .option(
      '--partial',
      'apply the valid rows and leave the invalid ones in staging (accepts an unchecked batch)'
    )
    .option('--json', 'JSON output');
  declareRisk(post, {
    risk: 'irreversible',
    agent: false,
    writes:
      'journal_entries + journal_entry_lines POSTEADOS (source_type=import_batch, source_id=fila) ' +
      'y el encabezado del lote (status, rows_invalid)',
  });
  post.addHelpText('after', EJEMPLOS.post);
  post.action((id: string, opts: CommonOpts & { partial?: boolean }) =>
    run(async () => {
      const ctx = await entityForWrite(opts);
      const { dryRun } = gateMutation(post, opts as unknown as Record<string, unknown>);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const p = deps.palette;
      const partial = opts.partial === true;
      const cx = contexto(ctx);

      const ensayar = (): Promise<ResultadoAplicacion> =>
        postBatch(cx, id, reviewer.userId, { partial, dryRun: true });

      /** Lo que va a pasar (o pasó), fila por fila y con el total enfrente. */
      const mostrar = (r: ResultadoAplicacion): void => {
        const out = process.stdout;
        out.write(
          `\n${p.bold(`LOTE ${r.batchId}`)} ${p.dim(
            `· ${r.posteadas.length} póliza(s) · Debe ${r.total_debe}` +
              (r.ya_posteadas > 0 ? ` · ${r.ya_posteadas} ya estaba(n)` : '')
          )}\n`
        );
        for (const fila of r.posteadas) {
          out.write(`    fila ${fila.row_number} → ${fila.entry_number}\n`);
        }
        if (r.invalidas.length > 0) {
          out.write(`\n  ${p.yellow(`${r.invalidas.length} fila(s) quedan en staging:`)}\n`);
          for (const h of r.invalidas) {
            out.write(
              `    ${p.red('✘')} fila ${h.row_number} ${p.dim(`[${h.categoria ?? 'otro'}]`)} — ` +
                `${h.errores.join('; ')}\n`
            );
          }
        }
      };

      let resultado: ResultadoAplicacion;
      let repetido = false;

      if (dryRun) {
        resultado = await ensayar();
      } else {
        // Sin -y se ensaya, se enseña y se pregunta sobre lo ensayado: lo que
        // el operador lee antes de decir que sí sale del MISMO código que va a
        // escribir. Con -y no hay ensayo: nadie va a leer la vista previa.
        if (opts.yes !== true) {
          const previo = await ensayar();
          if (legible(opts)) mostrar(previo);
          await exigirConfirmacion(
            `Vas a CONTABILIZAR ${previo.posteadas.length} póliza(s) del lote ${id} por ` +
              `${previo.total_debe} (Debe)` +
              (previo.invalidas.length > 0
                ? `, dejando ${previo.invalidas.length} fila(s) en staging`
                : '') +
              '. El mayor es inmutable: esto sólo se corrige por reversa. ¿Continuar?',
            'batch post'
          );
        }
        // `conLlave` exige una carga indexable (viaja como JSONB): se envuelve
        // en { v } y se desenvuelve aquí, igual que el `bajoLlave` de F05d.
        const acto = await conLlave(
          { tenantId: ctx.tenantId, entityId: ctx.entityId },
          {
            scope: 'batch post',
            clave: opts.idempotencyKey,
            // `--partial` entra en la carga: el mismo lote aplicado entero y
            // aplicado a medias son dos actos, y el segundo no puede
            // contestarse con el informe del primero.
            payloadHash: hashDeCarga(id, 'post', partial),
          },
          async () => ({ v: await postBatch(cx, id, reviewer.userId, { partial }) })
        );
        repetido = acto.repetido;
        resultado = acto.resultado.v;
        if (repetido) {
          avisarRepetido(opts.idempotencyKey, `${resultado.posteadas.length} póliza(s) del lote ${id}`);
        } else {
          // Tras el commit y sólo tras el commit: en ensayo el servicio ya
          // devuelve la lista vacía, y en un hit de idempotencia esta corrida
          // no posteó nada que atestar.
          for (const a of resultado.attestations) {
            attestEntryAsync(ctx.tenantId, a.entityId, a.entryId);
          }
        }
      }

      if (opts.json) {
        render(
          [
            {
              batch_id: resultado.batchId,
              status: resultado.status,
              posteadas: resultado.posteadas,
              ya_posteadas: resultado.ya_posteadas,
              invalidas: resultado.invalidas,
              total_debe: resultado.total_debe,
              dry_run: resultado.dryRun,
            },
          ],
          { json: true, idField: 'batch_id' }
        );
      } else {
        if (opts.yes === true || dryRun) mostrar(resultado);
        process.stdout.write(
          `${dryRun ? p.yellow('◑') : p.green('✔')} ${p.bold(`lote ${resultado.batchId}`)} ${p.dim(
            `→ '${resultado.status}' · ${resultado.posteadas.length} contabilizada(s) · ` +
              `${resultado.ya_posteadas} ya estaba(n) · ${resultado.invalidas.length} en staging · ` +
              `Debe ${resultado.total_debe}`
          )}\n`
        );
      }
      if (dryRun) {
        process.stderr.write(
          p.yellow(
            'Ensayo: se contabilizó de verdad y se deshizo; los folios mostrados no quedaron ' +
              'reservados.\n'
          )
        );
      }
      // 4 es «hay algo que mirar»: un --partial que dejó filas atrás no es un
      // éxito silencioso — el guion que lo corre tiene que enterarse.
      if (resultado.invalidas.length > 0) return ExitCode.VALIDATION;
    })
  );

  // ---- batch reverse -----------------------------------------------
  const reverse = batch
    .command('reverse')
    .alias('reversar')
    .argument('<id>', 'batch id')
    .description(
      'Mirror every entry the batch posted, as one unit in one transaction — import errors are ' +
        'batch-shaped, not entry-shaped'
    );
  withContext(reverse);
  reverse
    .option('--as-of <date>', 'date for every mirror entry (YYYY-MM-DD); defaults to today')
    .option('--json', 'JSON output');
  // declareRisk añade --reason por ser verbo de deshacer, y gateMutation la
  // exige salvo en ensayo.
  declareRisk(reverse, {
    risk: 'irreversible',
    agent: false,
    writes:
      'journal_entries espejo POSTEADOS (sin source_type, como toda reversa) + ' +
      'reversed_by_entry_id de cada póliza del lote',
  });
  reverse.addHelpText('after', EJEMPLOS.reverse);
  reverse.action((id: string, opts: CommonOpts & { asOf?: string }) =>
    run(async () => {
      const ctx = await entityForWrite(opts);
      const { dryRun, reason } = gateMutation(reverse, opts as unknown as Record<string, unknown>);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const p = deps.palette;
      const cx = contexto(ctx);
      // El servicio exige motivo SIEMPRE (una reversa sin motivo no deja
      // rastro utilizable); el núcleo permite ensayar sin --reason. El
      // marcador sólo puede llegar al camino del ensayo, que se revierte.
      const motivo = reason ?? '(ensayo sin --reason)';

      const ensayar = (): Promise<ResultadoReversa> =>
        reverseBatch(cx, id, reviewer.userId, {
          reason: motivo,
          asOf: opts.asOf,
          dryRun: true,
        });

      /** Las pólizas que se van a espejar, una por una. */
      const mostrar = (r: ResultadoReversa): void => {
        const out = process.stdout;
        out.write(
          `\n${p.bold(`LOTE ${r.batchId}`)} ${p.dim(
            `· ${r.espejos.length} espejo(s)` + (opts.asOf ? ` con fecha ${opts.asOf}` : '')
          )}\n`
        );
        for (const e of r.espejos) {
          out.write(`    ${e.original} → ${e.espejo}\n`);
        }
      };

      let resultado: ResultadoReversa;
      let repetido = false;

      if (dryRun) {
        resultado = await ensayar();
      } else {
        if (opts.yes !== true) {
          const previo = await ensayar();
          if (legible(opts)) mostrar(previo);
          await exigirConfirmacion(
            `Vas a REVERSAR el lote ${id}: ${previo.espejos.length} espejo(s) posteado(s), uno ` +
              'por póliza, en una sola transacción. Cada póliza admite UNA reversa (041). ' +
              '¿Continuar?',
            'batch reverse'
          );
        }
        const acto = await conLlave(
          { tenantId: ctx.tenantId, entityId: ctx.entityId },
          {
            scope: 'batch reverse',
            clave: opts.idempotencyKey,
            // La fecha entra en la carga (el mismo lote reversado a otra fecha
            // es otro acto); el texto del motivo no — reintentar con la
            // redacción corregida no debe acusar conflicto.
            payloadHash: hashDeCarga(id, 'reverse', opts.asOf),
          },
          async () => ({
            v: await reverseBatch(cx, id, reviewer.userId, {
              reason: reason as string,
              asOf: opts.asOf,
            }),
          })
        );
        repetido = acto.repetido;
        resultado = acto.resultado.v;
        if (repetido) {
          avisarRepetido(opts.idempotencyKey, `${resultado.espejos.length} espejo(s) del lote ${id}`);
        } else {
          for (const a of resultado.attestations) {
            attestEntryAsync(ctx.tenantId, a.entityId, a.entryId);
          }
        }
      }

      if (opts.json) {
        render(
          [
            {
              batch_id: resultado.batchId,
              status: resultado.status,
              espejos: resultado.espejos,
              dry_run: resultado.dryRun,
            },
          ],
          { json: true, idField: 'batch_id' }
        );
      } else {
        if (opts.yes === true || dryRun) mostrar(resultado);
        process.stdout.write(
          `${dryRun ? p.yellow('◑') : p.green('✔')} ${p.bold(`lote ${resultado.batchId}`)} ${p.dim(
            `· ${resultado.espejos.length} espejo(s) · el lote sigue '${resultado.status}': la ` +
              'verdad de la reversa vive en reversed_by_entry_id de cada póliza'
          )}\n`
        );
      }
      if (dryRun) {
        process.stderr.write(
          p.yellow('Ensayo: los espejos se crearon de verdad y se deshicieron; nada quedó escrito.\n')
        );
      }
    })
  );
}
