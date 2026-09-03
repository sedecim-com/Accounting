import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { apReconcile, type PartidaConciliatoria } from '../services/ap/ap-controls.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withContext,
  withOutput,
  withStrict,
  resolveActiveEntity,
  checkExitCode,
  exitCodeFor,
  usageError,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine ap · cxp
//
// El control de la deuda con proveedores. Hoy una sola hoja, `ap reconcile`,
// que responde la pregunta que un cierre de mes no puede saltarse: lo que el
// subdiario dice que se debe, ¿está en el mayor?
//
// Lectura pura y abierta al agente. Medir nunca es peligroso; lo peligroso es
// cerrar un mes sin haber medido.
//
// TRES DECISIONES QUE NO SON DE ESTILO.
//
// La primera, la RAMA DE SALIDA. `withOutput` declara `--format` con valor por
// defecto `'table'`, así que `opts.format` NUNCA es indefinido: la condición
// `if (opts.json || opts.output || opts.format)` que usan varias familias
// entra siempre y deja su rama humana muerta. Aquí se compara contra
// `'table'`, como hacen `bill show` y `entry show`.
//
// La segunda, el CÓDIGO DE SALIDA. Un descuadre con TODAS sus partidas
// nombradas no es lo mismo que un descuadre sin dueño: el primero es una lista
// de tareas —reversar un asiento, aprobar un gasto—, el segundo es un defecto
// que nadie sabe dónde buscar. Así que sólo el residuo sin explicar es
// bloqueante (4); las partidas nombradas son advertencia, y se vuelven
// bloqueantes con `--strict`, que es exactamente para lo que existe la
// bandera.
//
// La tercera, el IDIOMA. Las etiquetas de la interfaz van en inglés, como en
// el resto del CLI; el `detalle` de cada partida y las advertencias vienen del
// servicio en español, igual que los hallazgos de `ledger check`. La
// explicación contable es del dominio y se escribe una sola vez, donde se
// conoce el porqué.
// ============================================================

export interface ApCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  strict?: boolean;
  asOf?: string;
  explain?: boolean;
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Una bandera mal escrita es un error de USO (2), no una validación fallida
 * del dominio (4): confundirlos hace que un guion de CI trate un typo como si
 * los libros estuvieran mal. La comprobación de ida y vuelta rechaza los días
 * que no existen — JS acepta `2026-02-31` y lo desplaza al 3 de marzo.
 */
function exigirFecha(flag: string, valor: string): string {
  const d = new Date(`${valor}T00:00:00Z`);
  if (!FECHA_RE.test(valor) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) {
    throw usageError(`${flag} debe ser una fecha real en formato YYYY-MM-DD; llegó "${valor}".`);
  }
  return valor;
}

// ============================================================
// EJEMPLOS · invocaciones copiables
//
// `--as-of` corta LOS DOS lados de la conciliación a la misma fecha; sin ella
// es hoy. Prosa en inglés (idioma del nodo), datos mexicanos.
// ============================================================
const EJEMPLOS = `
Examples:
  # The vendor subledger against the cxp control account, as of today.
  mnemosine ap reconcile
  # At the close date, spelling out every reconciling item in prose.
  mnemosine ap reconcile --as-of 2026-07-31 --explain
  # Exit 4 on any delta, for CI.
  mnemosine ap reconcile --as-of 2026-07-31 --strict
`;

export function registerApCommand(program: Command, deps: ApCommandDeps): void {
  const ap = program
    .command('ap')
    .alias('cxp')
    .description('Payables controls: reconcile the vendor subledger against the control account');

  /**
   * El manejador DEVUELVE su código y `run` lo cierra una sola vez.
   *
   * La forma heredada —`await deps.shutdown(4)` dentro del manejador y otro
   * `shutdown(0)` al volver— sólo funciona porque el `shutdown` real llama a
   * `process.exit` y nunca regresa. Contra cualquier doble (una prueba, un
   * arnés) el segundo se ejecuta y el código de salida observado es 0: el
   * comando informa un descuadre y el guion que lo vigila lo lee como limpio.
   */
  const run = async (fn: () => Promise<number | void>): Promise<void> => {
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

  // ---- ap reconcile ------------------------------------------------
  const reconcile = ap
    .command('reconcile')
    .alias('conciliar')
    .description(
      'Vendor subledger (open bills) vs the cxp control account, naming the reconciling items'
    );
  withStrict(withOutput(withContext(reconcile)));
  reconcile
    // `--as-of` se declara suelta y no con `withTime()`: el grupo entero
    // arrastra `--period`, `--since`, `--until` y `--date-basis`, y un cuadre
    // no tiene rango ni base de fecha que elegir — tiene un corte. Declarar
    // cuatro banderas para rechazar tres es peor superficie que declarar una.
    // El diccionario gobierna la grafía y la forma corta (ninguna), no el grupo.
    .option('--as-of <date>', 'cut-off for both sides of the reconciliation (YYYY-MM-DD; defaults to today)')
    .option('--explain', 'spell out every reconciling item in prose, not just the table');
  declareRisk(reconcile, { risk: 'lectura', agent: true });
  reconcile.addHelpText('after', EJEMPLOS);
  reconcile.action((opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const asOf = opts.asOf ? exigirFecha('--as-of', opts.asOf) : undefined;
      const r = await apReconcile(ctx.entityId, { asOf, explain: opts.explain === true });
      const p = deps.palette;
      const err = process.stderr;

      const nombradas = r.partidas.filter((x) => x.tipo !== 'residuo');
      // Lo bloqueante se pregunta por la PARTIDA de residuo, nunca recalculando
      // el umbral sobre `sinExplicar`.
      //
      // `sinExplicar` sale del servicio ya redondeado a dos decimales, y el
      // servicio decidió con el importe EXACTO. Medio centavo sin dueño no
      // llega a partida (0.005 < 0.01) pero se imprime como «-0.01», así que
      // comparar aquí contra 0.01 lo declaraba bloqueante: el comando escribía
      // «✔ Balanced.», no listaba una sola partida, y salía 4. Un guion de
      // cierre veía roja una conciliación que el propio comando llamaba limpia,
      // sin nada que perseguir. Dos copias del mismo umbral divergen en el
      // primer redondeo; ésta es la copia que sobraba.
      const bloqueantes = r.partidas.some((x) => x.tipo === 'residuo') ? 1 : 0;

      const format = opts.json ? 'json' : (opts.format ?? 'table');
      if (format !== 'table' || opts.quiet || opts.output) {
        // Una fila con el cuadre entero, `partidas` anidadas dentro: es el
        // mismo objeto que devuelve el servicio, para que la respuesta de la
        // máquina y la del agente no diverjan de la del humano.
        render([r as unknown as Row], {
          ...opts,
          idField: 'diferencia',
          numeric: ['subdiario', 'mayor', 'diferencia', 'explicado', 'sinExplicar'],
        });
      } else {
        const out = process.stdout;
        out.write(
          `\n${p.bold('AP reconciliation')} ` +
            `${p.dim(`· control ${r.cuentaControl.code} ${r.cuentaControl.name} · as of ${r.asOf}`)}\n\n`
        );
        const linea = (etiqueta: string, valor: string) =>
          out.write(`  ${p.dim(etiqueta.padEnd(28))}${valor.padStart(16)}\n`);
        linea('Subledger (open bills)', r.subdiario);
        linea('Control account (ledger)', r.mayor);
        linea('Difference', r.diferencia);
        linea('Explained by items', r.explicado);
        linea('Unexplained', r.sinExplicar);

        out.write(
          r.cuadra
            ? `\n${p.green('✔')} Balanced.\n`
            : `\n${p.red('✘')} Difference ${p.bold(r.diferencia)} — ` +
              (bloqueantes
                ? `${r.explicado} named, ${p.bold(r.sinExplicar)} with no owner.\n`
                : 'every peso of it is named below.\n')
        );

        if (r.partidas.length) {
          out.write(
            `\n${p.bold('Reconciling items')} ${p.dim(`(${r.partidas.length})`)}\n`
          );
          render(r.partidas as unknown as Row[], {
            format: 'table',
            idField: 'referencia',
            numeric: ['importe'],
            // Sin `--explain` la prosa larga rompería la tabla; el detalle
            // corto ya cabe en una celda. Pero lo que el USUARIO pida con
            // `--fields` manda sobre las dos: la bandera estaba declarada y
            // sólo se leía en json/csv, así que en la salida por omisión
            // —la que teclea una persona— se ignoraba en silencio. Una
            // bandera aceptada y no leída es una promesa incumplida.
            fields: opts.fields ?? (opts.explain ? 'tipo,referencia,fecha,importe' : undefined),
          });
          out.write(
            p.dim(
              '  importe = what this item adds to (subledger − ledger); the named ones sum to Explained, ' +
                'and with the residual row to Difference.\n' +
                // Cada importe se redondea POR SEPARADO y Explained se redondea
                // una sola vez sobre la suma exacta, así que la columna puede
                // no cuadrar al centavo con Explained. Decirlo aquí es más
                // honesto que forzar el cuadre: forzarlo rompería
                // Explained + Unexplained = Difference, y Explained cubre
                // también las filas que el tope no llegó a enumerar.

                '  Amounts are rounded per item; the column may differ from Explained by cents.\n'
            )
          );
        }

        if (opts.explain && r.partidas.length) {
          out.write(`\n${p.bold('Why each item is there')}\n\n`);
          for (const partida of r.partidas) escribirProsa(out, p, partida);
        }

        if (!r.partidas.length && r.cuadra) {
          out.write(p.dim('\n  No manual entries on the control account either.\n'));
        }
      }

      // Las advertencias van a stderr SIEMPRE, también en formato máquina: un
      // cuadre retroactivo sesgado que se cuela en un guion sin decir nada es
      // justo el error que la ficha del aged payables lleva documentado.
      if (r.advertenciaAsOf) err.write(p.yellow(`\n${r.advertenciaAsOf}\n`));
      if (r.omitidas > 0) {
        err.write(
          p.yellow(
            `\n${r.omitidas} partida(s) más existen y no se enumeraron: el listado tiene tope por sonda. ` +
              'Los totales (explicado, sin explicar) sí las incluyen.\n'
          )
        );
      }

      return checkExitCode(
        { blocking: bloqueantes, warning: nombradas.length },
        { strict: opts.strict === true }
      );
    })
  );
}

/** Un párrafo por partida, envuelto para que un terminal de 80 columnas lo lea. */
function escribirProsa(
  out: NodeJS.WriteStream,
  p: Palette,
  partida: PartidaConciliatoria
): void {
  const cabecera = `${partida.tipo} · ${partida.referencia}` + (partida.fecha ? ` · ${partida.fecha}` : '');
  out.write(`  ${p.bold(cabecera)} ${p.dim(partida.importe)}\n`);
  for (const linea of envolver(partida.detalle, 76)) out.write(`    ${linea}\n`);
  out.write('\n');
}

function envolver(texto: string, ancho: number): string[] {
  const lineas: string[] = [];
  let actual = '';
  for (const palabra of texto.split(/\s+/)) {
    if (actual && actual.length + 1 + palabra.length > ancho) {
      lineas.push(actual);
      actual = palabra;
    } else {
      actual = actual ? `${actual} ${palabra}` : palabra;
    }
  }
  if (actual) lineas.push(actual);
  return lineas;
}
