import * as readline from 'node:readline/promises';
import { confirmarConReintento, noEntendi } from './kernel/confirmacion.js';
import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import Decimal from 'decimal.js';
import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { resolvePeriod } from '../services/accounting/fiscal-calendar-service.js';
import { runMonthlyDepreciation } from '../services/assets/depreciation.js';
import {
  diferenciasContraPlan,
  leerPlanAprobado,
  planDeDepreciacion,
  type PlanDeDepreciacion,
} from '../services/assets/depreciation-plan.js';
import { exigirLibroDelPanel } from '../services/assets/asset-lookup.js';
import { conLlave, hashDeCarga } from '../services/idempotency/idempotency-store.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  abortedByUser,
  blockedByState,
  conflict,
  declareRisk,
  exitCodeFor,
  gateMutation,
  render,
  requireExplicitEntity,
  resolveActiveEntity,
  usageError,
  withContext,
  withOutput,
  withStrict,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine depreciation · depreciacion
//
// DOS HOJAS Y UNA FRONTERA ENTRE ELLAS: `run` calcula y NO ESCRIBE; `post`
// escribe. El catálogo las separa desde antes de que existieran y tiene razón
// —«falta partir el motor en dos», dice él mismo en la fila de `post`—, porque
// `runMonthlyDepreciation` calcula y postea de golpe: hasta hoy la única forma
// de saber qué iba a hacer era dejarla hacerlo, sobre un mayor que no admite
// UPDATE ni DELETE.
//
// SEIS DECISIONES QUE NO SON DE ESTILO.
//
// LA PRIMERA · `run` NO LLEVA `--dry-run`, Y ESO NO ES INCUMPLIR EL CATÁLOGO:
// es que la hoja ENTERA es el ensayo. No escribe una fila, no crea un asiento,
// no consume un folio. Una bandera que dijera «no hagas lo que de todos modos
// no haces» es la clase de promesa vacía que este repositorio ya cazó en `ap
// reconcile` —una bandera declarada que nadie lee—, y aquí además invitaría a
// creer que SIN ella sí escribe.
//
// LA SEGUNDA · `post` ES IRREVERSIBLE Y POR TANTO IA ✗. El catálogo escribe
// «escritura» en su columna de riesgo, pero la fila misma lista `--dry-run`,
// `--yes` y `--idempotency-key`, que en este núcleo son exactamente las tres
// banderas que sólo se inyectan a lo irreversible y a lo externo. Postea al
// mayor de la migración 041, donde un asiento no se edita ni se borra: se
// corrige por reversa. La columna IA del catálogo ya dice ✗ y así se queda —
// toda fila irreversible es IA ✗ sin excepción, y el par ✓/✗ no depende del
// valor de ninguna bandera, `--dry-run` incluida.
//
// LA TERCERA · EL PLAN QUE `post` ENSEÑA SALE DE LAS MISMAS PUERTAS QUE LA
// CORRIDA. `planDeDepreciacion` no deduce el periodo, ni relee las políticas,
// ni elige el método: entra por `periodoDeLaEntidad`, `criteriosDeLaCorrida`,
// `metodoDeLaBase` y `fechaDelAsiento`, que son las de `depreciation.ts`. Lo
// único que repite es la lista de motivos de omisión, y por eso `post`
// COMPARA después: si la corrida procesó otra cantidad de activos que la que
// el plan prometió, se dice en voz alta en vez de descubrirse en una balanza.
//
// LA CUARTA · SON N ASIENTOS, NO UNO. `runMonthlyDepreciation` llama a
// `createJournalEntry` DENTRO del bucle: cada activo tiene su póliza de dos
// líneas. El catálogo imagina una sola («reversa la póliza de una corrida»),
// y no es lo que el motor hace hoy. La vista previa lo dice con todas sus
// letras porque la diferencia importa el día que alguien quiera reversar: son
// N reversas, no una.
//
// LA QUINTA · LA TERCERA POLÍTICA DE F06a TIENE CONSUMIDOR AQUÍ.
// `depreciacion_faltante_al_cierre` gobierna la casilla del cierre, y esta
// familia le hace la misma pregunta un paso antes: con `bloquear`, `post` se
// niega a contabilizar mientras queden activos debiendo su renglón —los que se
// deprecian por unidades y no tienen producción capturada, los que no arman
// calendario—, y no postea nada. Con `avisar` los nombra y contabiliza. `run`
// dice de antemano qué va a pasar. `--strict` puede APRETAR (convertir el
// aviso en bloqueo) y nunca aflojar: encender y aflojar son del despacho.
//
// LA SEXTA · `--file` COMPARA PARES (ACTIVO, IMPORTE), NO UNA HUELLA. Una
// huella distinta sólo puede decir «algo cambió»; los pares dicen qué activo
// se movió y de cuánto a cuánto, que es lo único accionable a las diez de la
// noche de un cierre.
// ============================================================

export interface DepreciationCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Costura de prueba: responde la confirmación de `depreciation post`. */
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

export const DIMENSIONES = ['asset', 'class', 'account', 'method'] as const;
export type Dimension = (typeof DIMENSIONES)[number];

export function exigirDimension(valor: string): Dimension {
  const d = valor.trim().toLowerCase();
  if (!(DIMENSIONES as readonly string[]).includes(d)) {
    throw usageError(
      `--by "${valor}" no existe. Las cuatro dimensiones son: ${DIMENSIONES.join(', ')} ` +
        '(asset es el detalle activo por activo; class y account son el resumen por clase y por ' +
        'destino del gasto que pide el catálogo).'
    );
  }
  return d as Dimension;
}

function exigirPeriodo(periodo: string | undefined): string {
  if (!periodo) {
    throw usageError(
      'Falta --period. La depreciación es de un mes concreto y no se adivina del reloj: correr ' +
        '«el periodo actual» un día 1 a las 00:05 depreciaría el mes que acaba de empezar.'
    );
  }
  return periodo;
}

/** Un renglón del plan, activo por activo, entren o no. */
export function filasPorActivo(plan: PlanDeDepreciacion): Row[] {
  const entran: Row[] = plan.renglones.map((r) => ({
    asset_id: r.asset_id,
    asset_number: r.asset_number,
    asset_name: r.asset_name,
    categoria: r.categoria,
    estado: 'entra',
    motivo: '',
    metodo: r.metodo,
    indice: r.indice,
    depreciacion: r.depreciacion,
    acumulada: r.acumulada,
    valor_en_libros: r.valor_en_libros,
    cuenta_gasto: r.cuenta_gasto,
  }));
  const omitidos: Row[] = plan.omitidos.map((o) => ({
    asset_id: o.asset_id,
    asset_number: o.asset_number,
    asset_name: o.asset_name,
    categoria: o.categoria,
    estado: 'omitido',
    motivo: o.motivo,
    metodo: '',
    indice: '',
    depreciacion: '',
    acumulada: '',
    valor_en_libros: '',
    cuenta_gasto: '',
  }));
  // Los omitidos NO se esconden en stderr: en `--json` se perderían, y «qué se
  // saltó y por qué» es la mitad del valor de una corrida. Van en la misma
  // tabla, con su columna de estado, para que ningún formato los pierda.
  return [...entran, ...omitidos];
}

/** El resumen por clase, por cuenta de destino o por método. */
export function filasAgrupadas(plan: PlanDeDepreciacion, por: Exclude<Dimension, 'asset'>): Row[] {
  const clave = (r: { categoria: string; cuenta_gasto: string; metodo: string }): string =>
    por === 'class' ? r.categoria || '(sin clase)' : por === 'account' ? r.cuenta_gasto : r.metodo;

  const grupos = new Map<string, { activos: number; suma: Decimal }>();
  for (const r of plan.renglones) {
    const k = clave(r);
    const g = grupos.get(k) ?? { activos: 0, suma: new Decimal(0) };
    g.activos += 1;
    g.suma = g.suma.plus(r.depreciacion);
    grupos.set(k, g);
  }

  // Los omitidos sólo se pueden agrupar por CLASE: no tienen método elegido ni
  // cuenta de destino resuelta, y rellenarlos con un guion los mezclaría en un
  // grupo inventado. En las otras dos dimensiones se cuentan aparte, en la
  // nota de stderr.
  const omitidosPorClase = new Map<string, number>();
  if (por === 'class') {
    for (const o of plan.omitidos) {
      const k = o.categoria || '(sin clase)';
      omitidosPorClase.set(k, (omitidosPorClase.get(k) ?? 0) + 1);
      if (!grupos.has(k)) grupos.set(k, { activos: 0, suma: new Decimal(0) });
    }
  }

  return [...grupos.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, g]) => ({
      grupo: k,
      activos: g.activos,
      depreciacion: g.suma.toFixed(4),
      ...(por === 'class' ? { omitidos: omitidosPorClase.get(k) ?? 0 } : {}),
    }));
}

/**
 * Las líneas del asiento que la corrida va a crear, activo por activo.
 *
 * Es la vista previa que el catálogo promete y que el mayor inmutable exige:
 * un asiento posteado no se edita, así que la única oportunidad de mirarlo es
 * antes. Cada activo produce SU póliza de dos líneas —cargo al gasto, abono a
 * la acumulada—, y la columna `asiento` lo numera para que se vea que son N y
 * no una.
 */
export function filasDelAsiento(plan: PlanDeDepreciacion): Row[] {
  const filas: Row[] = [];
  plan.renglones.forEach((r, i) => {
    const asiento = `${i + 1}/${plan.renglones.length}`;
    filas.push({
      asiento,
      fecha: plan.fecha_del_asiento,
      asset_number: r.asset_number,
      cuenta: r.cuenta_gasto,
      descripcion: `Depreciation - ${r.asset_name}`,
      debe: r.depreciacion,
      haber: '',
    });
    filas.push({
      asiento,
      fecha: plan.fecha_del_asiento,
      asset_number: r.asset_number,
      cuenta: r.cuenta_acumulada,
      descripcion: `Accumulated Depreciation - ${r.asset_name}`,
      debe: '',
      haber: r.depreciacion,
    });
  });
  return filas;
}

// ============================================================
// EJEMPLOS · invocaciones copiables, con datos mexicanos
//
// `--period` NO se adivina del reloj y por eso va en todos: correr «el periodo
// actual» un día 1 a las 00:05 depreciaría el mes que acaba de empezar. Se
// admite 2026-08 o un trozo inequívoco del nombre que el calendario acuñó.
//
// `--book` DECLARA, no elige: cuál de las dos depreciaciones llega al mayor es
// la política `base_depreciacion` del panel, y la bandera sólo sirve para que
// el comando pueda contradecir a quien creía estar corriendo la otra. Los
// ejemplos escriben `--book book`, que es lo que rige con el defecto declarado
// (vida útil NIF C-6); un despacho que contestó `tasa_lisr` escribe `tax`.
//
// El plan de `--file` sale de la corrida POR ACTIVO —la de por omisión—,
// porque lo que se compara son pares (activo, importe): un resumen por clase
// no trae `asset_id` y no aprueba nada.
//
// Prosa en inglés (idioma del nodo); los datos son mexicanos.
// ============================================================
const EJEMPLOS = {
  run: `
Examples:
  # August, asset by asset: what each one charges this month, and which ones are
  # left out and why. This leaf writes nothing and posts nothing — the whole leaf
  # is the rehearsal, which is why it carries no --dry-run.
  mnemosine depreciation run --period 2026-08
  # The same month as JSON. THIS is the approved plan that depreciation post
  # --file compares against, so it is left per asset (the default --by).
  mnemosine depreciation run --period 2026-08 --format json -o plan-depreciacion-2026-08.json
  # Summarised by asset class, and with the missing-asset warning turned into a
  # blocker: --strict can only tighten, never loosen.
  mnemosine depreciation run --period 2026-08 --by class --strict
`,
  post: `
Examples:
  # What would land in the ledger: ONE journal entry per asset (DR 6140 expense /
  # CR 1290 accumulated), with the total in front. Run this first — a month
  # posted twice cannot be edited away, only reversed, entry by entry.
  mnemosine depreciation post --period 2026-08 --dry-run
  # Post it, declaring the book you believe you are on. --book has to agree with
  # \`base_depreciacion\` on the panel; it does not override it.
  mnemosine depreciation post --period 2026-08 --book book
  # Unattended and against the plan that was approved: if an asset moved since
  # then, it refuses and names the asset and both amounts. The same key replayed
  # returns the recorded result instead of posting again.
  mnemosine depreciation post --period 2026-08 --file plan-depreciacion-2026-08.json --yes --idempotency-key depreciacion-2026-08
`,
} as const;

export function registerDepreciationCommand(
  program: Command,
  deps: DepreciationCommandDeps
): void {
  const depreciation = program
    .command('depreciation')
    .alias('depreciacion')
    .description('The monthly depreciation run: compute it, look at it, then post it');

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

  const entityForWrite = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    return requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
  };

  const ask = async (question: string): Promise<boolean> => {
    if (deps.confirm) return deps.confirm(question);
    if (!stdin.isTTY) return false;
    const rl = readline.createInterface({ input: stdin, output: stdout });
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

  /** Cede la ficha escrita a mano en cuanto el usuario pide otra forma. */
  const legible = (opts: CommonOpts): boolean =>
    !opts.json &&
    (opts.format ?? 'table') === 'table' &&
    !opts.quiet &&
    opts.output === undefined &&
    opts.fields === undefined;

  /**
   * La cabecera del plan: con qué criterios se calculó y de dónde salieron.
   *
   * Va a stderr y no a stdout porque stdout es la tabla, y una línea de prosa
   * delante de un `--format csv` rompe el archivo. Que la base y la convención
   * vengan del DEFECTO y no de una respuesta del despacho se dice siempre:
   * postear meses con un criterio que nadie eligió es exactamente lo que la
   * conciliación fiscal de fin de año descubre demasiado tarde.
   */
  const cabecera = (plan: PlanDeDepreciacion): void => {
    const err = process.stderr;
    const p = deps.palette;
    err.write(
      p.dim(
        `${plan.periodo} (${plan.inicio}..${plan.fin}) · libro ${plan.tipo_calendario} · ` +
          `asientos con fecha ${plan.fecha_del_asiento} · huella ${plan.huella.slice(0, 12)}\n`
      )
    );
    err.write(
      p.dim(
        `base ${plan.base}${plan.base_definida ? '' : ' (defecto)'} · ` +
          `convención ${plan.convencion}${plan.convencion_definida ? '' : ' (defecto)'} · ` +
          `${plan.renglones.length} activo(s) entran, ${plan.omitidos.length} se omiten, ` +
          `total ${plan.total}\n`
      )
    );
    if (!plan.base_definida || !plan.convencion_definida) {
      err.write(
        p.yellow(
          '  ⚠ Rige al menos un defecto declarado y no una elección del despacho. Se contesta con ' +
            '`mnemosine pending resolve base_depreciacion` / `convencion_primer_mes`.\n'
        )
      );
    }
  };

  /** Los omitidos, uno por uno, en la salida legible. */
  const detalleDeOmitidos = (plan: PlanDeDepreciacion, opts: CommonOpts): void => {
    if (!legible(opts) || plan.omitidos.length === 0) return;
    const err = process.stderr;
    err.write(deps.palette.dim(`\nOmitidos (${plan.omitidos.length}):\n`));
    for (const o of plan.omitidos) {
      const linea = `  · ${o.asset_number} ${o.asset_name}: ${o.motivo} — ${o.detalle}\n`;
      err.write(o.pendiente ? deps.palette.yellow(linea) : deps.palette.dim(linea));
    }
  };

  /**
   * Qué dice el panel sobre los activos que se quedan debiendo su renglón.
   *
   * Devuelve `true` cuando la corrida no debe darse por buena. `--strict` sólo
   * puede apretar: convierte el aviso en bloqueo y nunca al revés.
   */
  const bloqueaElFaltante = (plan: PlanDeDepreciacion, strict: boolean | undefined): boolean =>
    plan.pendientes > 0 && (plan.faltante_al_cierre.politica === 'bloquear' || strict === true);

  const avisoDeFaltante = (plan: PlanDeDepreciacion): void => {
    if (plan.pendientes === 0) return;
    process.stderr.write(
      deps.palette.yellow(
        `  ⚠ ${plan.pendientes} activo(s) se quedan sin renglón de ${plan.periodo} y el mes ` +
          `debería reconocerlo. La política \`depreciacion_faltante_al_cierre\` vale ` +
          `"${plan.faltante_al_cierre.politica}"` +
          `${plan.faltante_al_cierre.definida ? '' : ' (defecto declarado)'}.\n`
      )
    );
  };

  // ---- depreciation run ----------------------------------------------
  const correr = depreciation
    .command('run')
    .alias('ejecutar')
    .description(
      'Compute the period run and show it asset by asset — writes nothing, posts nothing'
    );
  withContext(correr);
  withOutput(correr);
  withStrict(correr);
  correr
    .option('--period <expr>', 'period to compute: 2026-08, or any unambiguous part of its name')
    .option('--book <book|tax>', 'the depreciation book you believe you are running; checked against the panel')
    .option(
      '--by <dimension>',
      `detail or summary: ${DIMENSIONES.join(', ')} (asset is the per-asset detail)`,
      'asset'
    );
  // LECTURA. El catálogo escribe «escritura» en su columna de riesgo porque
  // imaginaba una hoja que dejara el asiento como borrador; el motor no
  // produce borradores y esta hoja no escribe ni una fila. Declararla
  // escritura sería declarar de más, y una declaración que no corresponde al
  // código es justo lo que hace inútil al registro de riesgo.
  declareRisk(correr, { risk: 'lectura', agent: true });
  correr.addHelpText('after', EJEMPLOS.run);
  correr.action((opts: CommonOpts & { period?: string; book?: string; by: string; strict?: boolean }) =>
    run(async () => {
      const por = exigirDimension(opts.by);
      const ctx = await entityOf(opts);
      const periodo = await resolvePeriod(ctx.entityId, exigirPeriodo(opts.period));
      const plan = await planDeDepreciacion(ctx.entityId, periodo.id);

      // El libro sale del panel; la bandera sólo puede coincidir con él.
      exigirLibroDelPanel(opts.book, {
        libro: plan.tipo_calendario,
        base: plan.base,
        definida: plan.base_definida,
      });

      cabecera(plan);

      const filas = por === 'asset' ? filasPorActivo(plan) : filasAgrupadas(plan, por);
      // `--fields` lo aplica `render`, así que se honra también en la tabla por
      // omisión y no sólo en --json.
      render(filas, {
        ...opts,
        idField: por === 'asset' ? 'asset_number' : 'grupo',
        numeric: ['depreciacion', 'acumulada', 'valor_en_libros', 'activos', 'omitidos', 'indice'],
      });

      detalleDeOmitidos(plan, opts);
      avisoDeFaltante(plan);

      if (bloqueaElFaltante(plan, opts.strict)) {
        throw blockedByState(
          `${plan.pendientes} activo(s) sin renglón de ${plan.periodo}. ` +
            (opts.strict === true
              ? '--strict convierte el aviso en bloqueo.'
              : 'La política `depreciacion_faltante_al_cierre` está en "bloquear".') +
            ' `depreciation post` se negará a contabilizar hasta que se resuelvan.'
        );
      }
      if (plan.renglones.length === 0) {
        process.stderr.write(
          deps.palette.dim('Nada que contabilizar en este periodo con este libro.\n')
        );
      }
      return ExitCode.OK;
    })
  );

  // ---- depreciation post ----------------------------------------------
  const contabilizar = depreciation
    .command('post')
    .alias('contabilizar')
    .description('Post the period run to the ledger — one journal entry per asset, irreversible');
  withContext(contabilizar);
  withOutput(contabilizar);
  contabilizar
    .option('--period <expr>', 'period to post: 2026-08, or any unambiguous part of its name')
    .option('--book <book|tax>', 'the depreciation book you believe you are posting; checked against the panel')
    .option(
      '--file <path>',
      'the approved plan (JSON from `depreciation run --format json`); refuses if the numbers moved'
    );
  // IRREVERSIBLE: postea al mayor inmutable de la 041, donde un asiento no se
  // edita ni se borra. El núcleo inyecta --dry-run, --yes y --idempotency-key,
  // y `declareRisk` REHÚSA arrancar si alguien intenta darle acceso al agente.
  declareRisk(contabilizar, {
    risk: 'irreversible',
    agent: false,
    writes: 'journal_entries + journal_entry_lines (una póliza por activo), depreciation_schedules, fixed_assets',
  });
  contabilizar.addHelpText('after', EJEMPLOS.post);
  contabilizar.action((
    opts: CommonOpts & {
      period?: string;
      book?: string;
      file?: string;
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
      const plan = await planDeDepreciacion(ctx.entityId, periodo.id);

      exigirLibroDelPanel(opts.book, {
        libro: plan.tipo_calendario,
        base: plan.base,
        definida: plan.base_definida,
      });

      // EL PLAN APROBADO, ANTES DE NADA. Si los datos se movieron desde que
      // alguien firmó el archivo, no se postea y se dice QUÉ se movió.
      if (opts.file !== undefined) {
        const aprobado = leerPlanAprobado(readFileSync(opts.file, 'utf-8'), opts.file);
        const diferencias = diferenciasContraPlan(aprobado, plan);
        if (diferencias.length > 0) {
          throw conflict(
            `El plan aprobado en ${opts.file} ya no corresponde a lo que la corrida haría hoy, ` +
              `así que no se contabiliza nada: ${diferencias.join('; ')}. Vuelve a correr ` +
              '`depreciation run`, revisa el plan nuevo y contabiliza contra ése.'
          );
        }
      }

      // LA CASILLA DEL PANEL. Con `bloquear` no se postea NADA: un mes medio
      // depreciado es peor que uno sin depreciar, porque el siguiente arranca
      // de un valor en libros que ya no es reconstruible de un vistazo.
      if (bloqueaElFaltante(plan, false)) {
        avisoDeFaltante(plan);
        throw blockedByState(
          `No se contabiliza: ${plan.pendientes} activo(s) se quedan sin renglón de ` +
            `${plan.periodo} y la política \`depreciacion_faltante_al_cierre\` está en ` +
            '"bloquear". Resuélvelos (captura la producción del periodo, corrige la ficha) o ' +
            'cambia la política con `mnemosine pending resolve depreciacion_faltante_al_cierre`.'
        );
      }

      if (plan.renglones.length === 0) {
        cabecera(plan);
        detalleDeOmitidos(plan, opts);
        process.stderr.write(
          deps.palette.dim(`Nada que contabilizar en ${plan.periodo}: el mayor no se tocó.\n`)
        );
        return ExitCode.OK;
      }

      cabecera(plan);
      // EL ASIENTO, ANTES DE CREARLO. En dry-run es toda la salida; en el
      // camino real es lo que se enseña antes de preguntar.
      render(filasDelAsiento(plan), {
        ...opts,
        idField: 'asset_number',
        numeric: ['debe', 'haber'],
      });
      if (legible(opts)) {
        process.stderr.write(
          deps.palette.dim(
            `${plan.renglones.length} póliza(s) de dos líneas, una por activo — no una sola de ` +
              `la corrida. Reversar esta corrida son ${plan.renglones.length} reversas.\n`
          )
        );
      }
      avisoDeFaltante(plan);

      if (dryRun) {
        process.stderr.write(
          deps.palette.dim('Ensayo: el mayor no se tocó y no se escribió ningún renglón.\n')
        );
        return ExitCode.OK;
      }

      if (opts.yes !== true) {
        const ok = await ask(
          `¿Contabilizar ${plan.total} en ${plan.renglones.length} póliza(s) del libro ` +
            `${plan.tipo_calendario} de ${plan.periodo}? El mayor no admite deshacer.`
        );
        if (!ok) {
          throw abortedByUser(
            stdin.isTTY
              ? 'Sin cambios: el mayor no se tocó.'
              : 'Sin cambios: no hay terminal donde confirmar. Añade -y para contabilizar sin ' +
                'preguntar, o --dry-run para ver el asiento completo sin escribir nada.'
          );
        }
      }

      // `--idempotency-key`, HONRADA Y NO ANUNCIADA. La misma llave con la
      // misma carga devuelve el resultado GRABADO sin volver a correr; con
      // otra carga, `conLlave` acusa el reuso. La carga incluye la huella del
      // plan: reintentar la misma orden sobre otros importes no es un
      // reintento, es otra corrida.
      const { repetido, resultado } = await conLlave(
        { tenantId: ctx.tenantId, entityId: ctx.entityId },
        {
          scope: 'depreciation post',
          clave: opts.idempotencyKey,
          payloadHash: hashDeCarga(ctx.entityId, plan.fiscal_period_id, plan.tipo_calendario, plan.huella),
        },
        async () => runMonthlyDepreciation(ctx.entityId, plan.fiscal_period_id, reviewer.userId)
      );

      const err = process.stderr;
      if (repetido) {
        err.write(
          deps.palette.dim(
            'Llave de idempotencia ya consumada: se devuelve el resultado grabado y no se ' +
              'volvió a contabilizar.\n'
          )
        );
      }

      // LA COMPARACIÓN CONTRA LO QUE DE VERDAD PASÓ. El plan y la corrida
      // comparten criterios pero no el bucle, y ésta es la red que impide que
      // se separen en silencio.
      if (resultado.processed !== plan.renglones.length) {
        err.write(
          deps.palette.yellow(
            `  ⚠ El plan enseñaba ${plan.renglones.length} póliza(s) y la corrida hizo ` +
              `${resultado.processed}. El plan y el motor no coincidieron: revisa los errores ` +
              'antes de dar el mes por cerrado.\n'
          )
        );
      }
      for (const e of resultado.errors) err.write(deps.palette.yellow(`  ⚠ ${e}\n`));
      err.write(
        deps.palette.green(
          `✔ ${resultado.processed} póliza(s) contabilizada(s) en ${plan.periodo} (libro ` +
            `${plan.tipo_calendario}).\n`
        )
      );

      return resultado.errors.length > 0 ? ExitCode.VALIDATION : ExitCode.OK;
    })
  );
}
