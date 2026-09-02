import type { Command } from 'commander';
import Decimal from 'decimal.js';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import {
  FUENTES_DE_TIPO,
  FUENTE_DE_LA_POLITICA,
  TIPOS_DE_TASA,
  exigirFuente,
  exigirPar,
  exigirTipoDeTasa,
  fijarTipo,
  listarTipos,
  verTipo,
  type FuenteDeTipo,
  type RenglonTipoDeCambio,
} from '../services/fx/rate-service.js';
import { getPolicy } from '../services/policy/policy-service.js';
import { translateDomainError } from './entry-command.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  blockedByState,
  declareRisk,
  exitCodeFor,
  gateMutation,
  notFound,
  render,
  resolveActiveEntity,
  usageError,
  withContext,
  withOutput,
  withSelection,
  type ExitCodeValue,
} from './kernel/index.js';

// ============================================================
// mnemosine fx rate · cambio tipo   (R4, fase 1 del subgrupo Multimoneda)
//
// Cuatro hojas del catálogo: list·listar, show·ver, set·fijar y
// download·descargar. `exchange_rates` es una tabla GLOBAL sin tenant_id ni
// entity_id, fuera de RLS y a propósito: el tipo que el DOF publicó es un
// hecho del mundo, no de un inquilino. Por eso aquí la entidad NO acota las
// lecturas; lo que se acota es la ESCRITURA — `set` y `download` declaran
// agente ✗ y exigen un usuario resuelto que queda como created_by.
//
// `show` resuelve con el fallback de la 001 (directo → inverso → cruzado por
// USD) y DICE EN VOZ ALTA cuando arrastra un tipo de una fecha anterior: el
// catálogo señala ese arrastre silencioso como el defecto de la función SQL,
// y la superficie no lo repite.
// ============================================================

export interface FxCommandDeps {
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
  limit?: number;
  offset?: number;
  status?: string[];
  all?: boolean;
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function exigirFecha(nombre: string, valor: string): string {
  if (!FECHA_RE.test(valor) || Number.isNaN(new Date(`${valor}T00:00:00Z`).getTime())) {
    throw usageError(`${nombre} must be a date as YYYY-MM-DD; got "${valor}".`);
  }
  return valor;
}

/**
 * DECIMAL(19,10) enseñado con sus DIEZ decimales, siempre. `rate::text` ya
 * los trae, pero `get_exchange_rate()` puede devolver un derivado con otra
 * escala; normalizar aquí hace que la superficie nunca recorte en silencio
 * la precisión que la columna promete.
 */
function aDiezDecimales(valor: string): string {
  return new Decimal(valor).toFixed(10);
}

/** Columnas de `fx rate list`, en el orden fijo que `--fields` documenta. */
const COLUMNAS_TIPO = ['pair', 'date', 'rate', 'rate_type', 'source', 'policy', 'until', 'id'];

function renglonASalida(r: RenglonTipoDeCambio, fuenteDeLaPolitica?: FuenteDeTipo): Record<string, unknown> {
  return {
    pair: `${r.from_currency}/${r.to_currency}`,
    date: r.effective_date,
    rate: r.rate,
    rate_type: r.rate_type,
    source: r.source,
    // La marca de la política: cuál de las fuentes que conviven por fecha es
    // la que ESTE despacho usa para convertir (`fuente_tipo_cambio`).
    policy: fuenteDeLaPolitica !== undefined && r.source === fuenteDeLaPolitica ? '✓' : '',
    until: r.effective_until ?? '',
    id: r.id,
  };
}

/** Cede la salida escrita a mano en cuanto el usuario pide otra forma. */
function legible(opts: CommonOpts): boolean {
  return (
    !opts.json &&
    (opts.format ?? 'table') === 'table' &&
    !opts.quiet &&
    opts.output === undefined &&
    opts.fields === undefined
  );
}

function makeRunner(deps: FxCommandDeps) {
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
 * Lo que `fx rate download` puede nombrar como fuente, tal cual la celda del
 * catálogo (`--source <dof|banxico-fix|fed|ecb>`), y a qué fuente del esquema
 * corresponde cada una.
 */
const FUENTES_DE_DESCARGA: Record<string, { fuente: FuenteDeTipo; editor: string }> = {
  dof: {
    fuente: 'dof',
    editor: 'Diario Oficial de la Federación (el fiscal del art. 20 CFF; para una operación rige el publicado el día hábil anterior)',
  },
  'banxico-fix': {
    fuente: 'banco_mexico',
    editor: 'Banxico FIX vía SIE (requiere token del API SIE)',
  },
  fed: { fuente: 'fed', editor: 'Federal Reserve H.10' },
  ecb: { fuente: 'ecb', editor: 'Banco Central Europeo, tipos de referencia' },
};

export function registerFxCommand(program: Command, deps: FxCommandDeps): void {
  const fx = program
    .command('fx')
    .alias('cambio')
    .description('Exchange rates: the origin every foreign-currency amount converts from');

  const rate = fx
    .command('rate')
    .alias('tipo')
    .description('Published exchange rates by pair, date, type and source');

  const run = makeRunner(deps);

  // ---- fx rate list · cambio tipo listar ---------------------------
  const list = rate
    .command('list')
    .alias('listar')
    .description('List stored exchange rates by pair, date, type and source');
  withOutput(withSelection(withContext(list)));
  list
    .option('--pair <pair>', 'currency pair, e.g. USD/MXN')
    .option('--since <date>', 'inclusive lower bound (YYYY-MM-DD)')
    .option('--until <date>', 'inclusive upper bound (YYYY-MM-DD)')
    .option(`--rate-type <${TIPOS_DE_TASA.join('|')}>`, 'only rates of this type')
    .option(`--source <${FUENTES_DE_TIPO.join('|')}>`, 'only rates from this source');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action(
    (opts: CommonOpts & { pair?: string; since?: string; until?: string; rateType?: string; source?: string }) =>
      run(async () => {
        // `-s` viene del grupo de selección y aquí no significa nada: un tipo
        // de cambio publicado no tiene ciclo de vida. Rechazarlo en voz alta
        // es más honesto que una bandera declarada que se ignora.
        if (opts.status !== undefined) {
          throw usageError(
            '--status does not apply here: a published exchange rate has no lifecycle state. ' +
              'Filter with --pair, --source, --rate-type, --since or --until.'
          );
        }
        // Lectura global: el tenant se arranca para la conexión, pero ninguna
        // entidad acota qué tipos se ven — ver la cabecera del módulo.
        bootstrapTenant(opts.tenant);
        const renglones = await listarTipos({
          par: opts.pair ? exigirPar(opts.pair) : undefined,
          desde: opts.since ? exigirFecha('--since', opts.since) : undefined,
          hasta: opts.until ? exigirFecha('--until', opts.until) : undefined,
          rateType: opts.rateType ? exigirTipoDeTasa(opts.rateType) : undefined,
          fuente: opts.source ? exigirFuente(opts.source) : undefined,
        });

        // ¿Cuál de las fuentes que conviven usa ESTE despacho? La política es
        // por inquilino/entidad, así que se resuelve la entidad activa; si no
        // hay una (lectura global sin contexto), la lista sale igual y la
        // marca simplemente no se pinta — se avisa por stderr, nunca se calla.
        let fuentePolitica: FuenteDeTipo | undefined;
        try {
          const { ctx } = await resolveActiveEntity(
            { entity: opts.entity },
            { home: deps.home, warn: () => undefined }
          );
          const politica = await getPolicy(
            { tenantId: ctx.tenantId, entityId: ctx.entityId },
            'fuente_tipo_cambio'
          );
          fuentePolitica = FUENTE_DE_LA_POLITICA[politica.value];
          process.stderr.write(
            deps.palette.dim(
              `La política fuente_tipo_cambio de este despacho es "${politica.value}"` +
                (fuentePolitica ? ` → source '${fuentePolitica}' (columna policy: ✓).` : ', que este lector no mapea a ninguna fuente.') +
                '\n'
            )
          );
        } catch {
          process.stderr.write(
            deps.palette.dim(
              'Sin entidad activa resoluble: no se pudo señalar la fuente que la política del despacho usa.\n'
            )
          );
        }

        // El servicio no pagina: la tabla es global y pequeña, así que traer
        // todo y recortar aquí da un --limit/--offset que NO miente — el total
        // es exacto y `render` anuncia el truncado con él.
        const offset = opts.offset ?? 0;
        const tope = opts.all ? undefined : (opts.limit ?? 50);
        const visibles = renglones.slice(offset, tope === undefined ? undefined : offset + tope);

        render(visibles.map((r) => renglonASalida(r, fuentePolitica)), {
          ...opts,
          total: renglones.length,
          idField: 'id',
          fields: opts.fields ?? (visibles.length ? COLUMNAS_TIPO.join(',') : undefined),
        });
      })
  );

  // ---- fx rate show · cambio tipo ver ------------------------------
  const show = rate
    .command('show')
    .alias('ver')
    .argument('<pair>', 'currency pair, e.g. USD/MXN')
    .argument('<date>', 'date the rate applies to (YYYY-MM-DD)')
    .description('Resolve the applicable rate: direct, then inverse, then crossed through USD');
  withOutput(withContext(show));
  show.option(`--rate-type <${TIPOS_DE_TASA.join('|')}>`, 'rate type to resolve', 'spot');
  declareRisk(show, { risk: 'lectura', agent: true });
  show.action((pairArg: string, dateArg: string, opts: CommonOpts & { rateType: string }) =>
    run(async () => {
      bootstrapTenant(opts.tenant);
      const par = exigirPar(pairArg);
      const fecha = exigirFecha('<date>', dateArg);
      const tipo = exigirTipoDeTasa(opts.rateType);
      const resuelto = await verTipo(par, fecha, tipo);

      if (resuelto.rate === null) {
        throw notFound(
          `No hay tipo ${par.de}/${par.a} (${tipo}) resoluble para ${fecha}: ni directo, ni ` +
            'inverso, ni cruzado por USD. Captúralo con fx rate set.'
        );
      }

      // Los DIEZ decimales de DECIMAL(19,10), siempre — y el inverso: cuando
      // hay fila directa se enseña el `inverse_rate` GUARDADO (es parte del
      // hecho publicado), y cuando el tipo salió derivado se calcula 1/tasa
      // redondeado a la misma escala, dicho como derivado.
      const tasa = aDiezDecimales(resuelto.rate);
      const inverso = resuelto.renglon
        ? aDiezDecimales(resuelto.renglon.inverse_rate)
        : new Decimal(1).div(new Decimal(resuelto.rate)).toFixed(10);

      const salida = {
        pair: `${par.de}/${par.a}`,
        date: fecha,
        rate: tasa,
        inverse_pair: `${par.a}/${par.de}`,
        inverse_rate: inverso,
        rate_type: tipo,
        source: resuelto.renglon?.source ?? 'derived',
        carried_from: resuelto.arrastradoDe ?? '',
      };

      if (!legible(opts)) {
        render([salida], { ...opts, idField: 'pair' });
        return;
      }

      const p = deps.palette;
      process.stdout.write(
        `\n${p.bold(`${par.de}/${par.a}`)} ${fecha} = ${p.bold(tasa)} ` +
          p.dim(`(${tipo}${resuelto.renglon ? `, ${resuelto.renglon.source}` : ', derivado del inverso o cruzado'})`) +
          '\n'
      );
      process.stdout.write(
        `  ${p.dim(`inverso ${par.a}/${par.de} = ${inverso}${resuelto.renglon ? '' : ' (derivado)'}`)}\n`
      );
      if (resuelto.arrastradoDe) {
        // El arrastre que get_exchange_rate() hace en silencio, dicho fuerte.
        process.stdout.write(
          p.yellow(
            `  ⚠ arrastrado de ${resuelto.arrastradoDe}: no hay tipo del día pedido. ` +
              'Si necesitas el del día, captúralo con fx rate set.\n'
          )
        );
      }
      process.stdout.write('\n');
    })
  );

  // ---- fx rate set · cambio tipo fijar -----------------------------
  const set = rate
    .command('set')
    .alias('fijar')
    .argument('<pair>', 'currency pair, e.g. USD/MXN')
    .argument('<date>', 'effective date (YYYY-MM-DD)')
    .argument('<rate>', 'the rate, up to 10 decimals')
    .description('Record an exchange rate, naming its source');
  withContext(set);
  set
    .option(`--source <${FUENTES_DE_TIPO.join('|')}>`, 'who published the rate (required)')
    .option(`--rate-type <${TIPOS_DE_TASA.join('|')}>`, 'rate type', 'spot')
    .option('--until <date>', 'last date the rate remains effective (YYYY-MM-DD)')
    .option('--dry-run', 'show what would be recorded without writing');
  declareRisk(set, { risk: 'escritura', agent: false, writes: 'exchange_rates' });
  set.action(
    (
      pairArg: string,
      dateArg: string,
      rateArg: string,
      opts: CommonOpts & { source?: string; rateType: string; until?: string; dryRun?: boolean }
    ) =>
      run(async () => {
        bootstrapTenant(opts.tenant);
        const par = exigirPar(pairArg);
        const fecha = exigirFecha('<date>', dateArg);
        const tipo = exigirTipoDeTasa(opts.rateType);
        // Fijar exige la FUENTE explícita: desde la 057 DOF y FIX del mismo
        // día conviven como filas distintas, y un tipo sin fuente declarada
        // sería justo la ambigüedad que la migración existe para impedir.
        if (!opts.source) {
          throw usageError(
            `--source is required: say who published the rate (${FUENTES_DE_TIPO.join(', ')}). ` +
              'DOF and FIX for the same day are different numbers and coexist since migration 057.'
          );
        }
        const fuente = exigirFuente(opts.source);
        const hasta = opts.until ? exigirFecha('--until', opts.until) : undefined;
        const { dryRun } = gateMutation(set, opts as unknown as Record<string, unknown>);

        if (dryRun) {
          process.stdout.write(
            `\n${deps.palette.bold(`Would set ${par.de}/${par.a} ${fecha} = ${rateArg}`)} ` +
              `${deps.palette.dim(`(${fuente}, ${tipo}${hasta ? `, until ${hasta}` : ''})`)}\n\n`
          );
          return;
        }

        // La tabla es global: la entidad activa NO acota la fila, pero el
        // inquilino sí dice QUIÉN escribe — created_by es NOT NULL y es la
        // cota real de esta escritura compartida.
        const { ctx } = await resolveActiveEntity(
          { entity: opts.entity },
          { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
        );
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        // La confirmación ANTES de escribir: par, fecha, fuente y tipo, tal y
        // como se entendieron ("usd-mxn" ya normalizado a USD/MXN). Si la
        // escritura falla, esta línea es exactamente lo que se intentó.
        process.stdout.write(
          `${deps.palette.bold(`${par.de}/${par.a} ${fecha} = ${rateArg}`)} ` +
            `${deps.palette.dim(`(${fuente}, ${tipo}${hasta ? `, until ${hasta}` : ''})`)}\n`
        );
        const renglon = await fijarTipo({
          par,
          fecha,
          tasa: rateArg,
          fuente,
          rateType: tipo,
          hasta,
          creadoPor: reviewer.userId,
        });
        process.stdout.write(
          `${deps.palette.green('✔')} fijado como ${deps.palette.bold(aDiezDecimales(renglon.rate))} ` +
            `${deps.palette.dim(`· ${renglon.id}`)}\n`
        );
      })
  );

  // ---- fx rate download · cambio tipo descargar --------------------
  //
  // HONESTIDAD ANTES QUE CAPACIDAD. La celda del catálogo describe la
  // descarga del DOF o del FIX, pero también reconoce «la falta de cliente»:
  // en este proyecto no existe conector HTTP a terceros sin credencial
  // gobernada (el FIX exige token del SIE de Banxico, y el DOF no tiene API
  // oficial estable), y la regla de la casa —el cerrojo antisimulación de los
  // PAC— prohíbe fabricar el hecho externo que no se pudo obtener. Así que la
  // hoja existe con su superficie completa del catálogo, --dry-run enseña el
  // plan, y ejecutar FALLA CERRADO nombrando exactamente lo que falta y los
  // caminos honestos de hoy: fx rate set con el valor publicado, o el
  // fx rate import de fase 2.
  const download = rate
    .command('download')
    .alias('descargar')
    .description('Download the DOF or Banxico FIX rate, stored per source (they differ on the same day)');
  withContext(download);
  download
    .option('--source <dof|banxico-fix|fed|ecb>', 'which publisher to download from (required)')
    .option('--as-of <date>', 'single date to download (YYYY-MM-DD)')
    .option('--since <date>', 'inclusive lower bound (YYYY-MM-DD)')
    .option('--until <date>', 'inclusive upper bound (YYYY-MM-DD)');
  // externo: el núcleo añade --dry-run, --yes, --idempotency-key y --live.
  // El riesgo declarado es el de la clase de efecto de esta hoja —hablar con
  // un tercero y escribir la tabla global—, que es también el de su fila del
  // catálogo; y `writes` dice la VERDAD de hoy: sin conector, ejecutar falla
  // cerrado y no escribe nada. Declararla más abajo (lectura/escritura) haría
  // que el día que el conector exista cambiara el permiso del agente y las
  // compuertas de la MISMA hoja, que es justo lo que una declaración fija.
  declareRisk(download, {
    risk: 'externo',
    agent: false,
    writes: 'exchange_rates — hoy nada: falla cerrado por falta de conector',
  });
  download.action(
    (opts: CommonOpts & { source?: string; asOf?: string; since?: string; until?: string; dryRun?: boolean; live?: boolean }) =>
      run(async () => {
        bootstrapTenant(opts.tenant);
        if (!opts.source) {
          throw usageError(
            `--source is required: ${Object.keys(FUENTES_DE_DESCARGA).join(', ')}.`
          );
        }
        const elegida = FUENTES_DE_DESCARGA[opts.source];
        if (!elegida) {
          throw usageError(
            `Unknown --source "${opts.source}". Use one of: ${Object.keys(FUENTES_DE_DESCARGA).join(', ')}.`
          );
        }
        if (opts.asOf && (opts.since || opts.until)) {
          throw usageError('--as-of and --since/--until are two ways of saying the range; use one.');
        }
        const desde = opts.asOf ? exigirFecha('--as-of', opts.asOf) : opts.since ? exigirFecha('--since', opts.since) : undefined;
        const hasta = opts.asOf ? desde : opts.until ? exigirFecha('--until', opts.until) : desde;
        const { dryRun } = gateMutation(download, opts as unknown as Record<string, unknown>);

        const loQueFalta =
          `No existe todavía el conector de descarga: este proyecto no habla HTTP con terceros ` +
          `sin una credencial gobernada, y ${opts.source === 'banxico-fix' ? 'el SIE de Banxico exige un token que ningún almacén de credenciales del sistema gobierna aún' : 'no hay cliente declarado para esa fuente'}. ` +
          `Fabricar el tipo sería el mismo pecado que el cerrojo antisimulación de los PAC impide. ` +
          `Hoy los caminos honestos son: fx rate set <par> <fecha> <tasa> --source ${elegida.fuente} ` +
          `con el valor publicado, o fx rate import (fase 2) desde un archivo.`;

        if (dryRun) {
          const p = deps.palette;
          process.stdout.write(
            `\n${p.bold(`Would download from ${elegida.editor}`)}\n` +
              `  ${p.dim(`fechas: ${desde ?? '(hoy)'}${hasta && hasta !== desde ? ` → ${hasta}` : ''}`)}\n` +
              `  ${p.dim(`destino: exchange_rates con source='${elegida.fuente}' (la 057 deja convivir DOF y FIX del mismo día)`)}\n` +
              `  ${p.yellow(`⚠ ejecutar fallará: ${loQueFalta}`)}\n\n`
          );
          return;
        }

        throw blockedByState(loQueFalta, { fuente: elegida.fuente, editor: elegida.editor });
      })
  );
}
