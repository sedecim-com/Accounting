import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { palette, type Palette } from '../palette.js';
import { CliError, ExitCode } from './exit.js';

// ============================================================
// OUTPUT CONTRACT
// Three audiences, one implementation.
//   humans   → an aligned table, colored only on a real TTY
//   pipes    → --quiet (bare identifiers) / --format csv|tsv|ndjson
//   machines → --format json, a versioned envelope
//
// Two rules here are correctness, not taste:
//
//   MONEY IS NEVER A JSON NUMBER. Postgres hands us numerics as
//   strings; we keep them as strings all the way out. A float
//   round-trip through JSON.parse is how a trial balance stops
//   balancing by a cent that nobody can find.
//
//   TRUNCATION IS ALWAYS REPORTED. A default --limit that silently
//   drops rows produces a wrong financial statement and a wrong
//   agent answer, invisibly. Every format says so: humans get a
//   stderr note, machines get `truncated` and `total` in the
//   envelope.
//
// Data goes to stdout; every note, warning and diagnostic goes to
// stderr, so one stray message never corrupts a pipeline.
//
//   UN DATO SALE POR UNA SOLA PUERTA, Y ESA PUERTA CONOCE `-o`.
//   `-o/--output` promete un archivo con la salida del comando, y
//   mentía de tres maneras: dos ramas de `render` volvían escribiendo
//   directo a stdout —`--fields` a secas y la tabla sin filas—, así que
//   el comando salía 0 y el archivo NO EXISTÍA; y como cada escritura
//   truncaba, un comando que rinde dos veces (`cfdi show`: cabecera y
//   conceptos) dejaba en el archivo sólo la ÚLTIMA tabla.
//   La regla que lo cierra: quien COMPONE el texto (`compose`) no
//   recibe ningún flujo y devuelve `Composed`, un tipo que bajo
//   `strict` obliga al compilador a rechazar cualquier rama futura
//   (`--summary`, `--count`) que se olvide de producir su texto. La
//   única escritura de datos vive en `emit`.
//
//   Y ESO NO ES UNA GARANTÍA ESTRUCTURAL, dicho para que nadie se
//   confíe: `process.stdout` es global, así que `compose` PODRÍA
//   escribir por ahí y devolver la cadena vacía, y ni el compilador ni
//   el tipo lo verían. Lo que sí lo ve es una prueba que espía los dos
//   flujos mientras compone cada formato y cada rama, y exige CERO
//   escrituras (tests/cli/kernel/salida-prometida.spec.ts). El tipo
//   ayuda; la prueba es la que cierra.
// ============================================================

export const FORMATS = ['table', 'json', 'ndjson', 'csv', 'tsv', 'md'] as const;
export type Format = (typeof FORMATS)[number];

/** Envelope version. Bump only on a breaking field change; it is an API. */
export const SCHEMA_VERSION = 1;

export type Row = Record<string, unknown>;

export interface RenderOptions {
  /** Parsed from --format; --json is a documented shorthand for json. */
  format?: string;
  json?: boolean;
  /** --fields a,b,c — or true (the bare flag), which lists the available names. */
  fields?: string | boolean;
  /** --quiet: identifiers only, one per line. */
  quiet?: boolean;
  /** -o/--output: write to a file instead of stdout. */
  output?: string;
  /** Total rows available upstream, when more exist than were fetched. */
  total?: number;
  /** Which column --quiet prints. Defaults to id, then code, then the first column. */
  idField?: string;
  /** Columns to right-align (numbers). Inferred when omitted. */
  numeric?: string[];
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export function resolveFormat(opts: RenderOptions): Format {
  if (opts.quiet) return 'table'; // quiet short-circuits before formatting
  const raw = opts.json ? 'json' : (opts.format ?? 'table');
  const normalized = String(raw).trim().toLowerCase();
  if (!(FORMATS as readonly string[]).includes(normalized)) {
    throw new CliError(
      `Unknown --format "${raw}". Use one of: ${FORMATS.join(', ')}.`,
      ExitCode.USAGE
    );
  }
  return normalized as Format;
}

/** Column names in first-seen order across every row (rows may be ragged). */
export function fieldNames(rows: Row[]): string[] {
  const seen: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!seen.includes(key)) seen.push(key);
  }
  return seen;
}

function selectFields(rows: Row[], fields: string | boolean | undefined): string[] {
  const available = fieldNames(rows);
  if (typeof fields !== 'string' || !fields.trim()) return available;
  const wanted = fields.split(',').map((f) => f.trim()).filter(Boolean);
  // An empty result set has no columns to check against. Validating here
  // turned every "nothing matched" into "Unknown field(s): …  Available: ."
  // — a usage error for a query that was perfectly well formed.
  if (rows.length === 0) return wanted;
  const unknown = wanted.filter((f) => !available.includes(f));
  if (unknown.length) {
    throw new CliError(
      `Unknown field(s): ${unknown.join(', ')}. Available: ${available.join(', ')}.`,
      ExitCode.USAGE
    );
  }
  return wanted;
}

/**
 * La fecha LOCAL como yyyy-mm-dd. Un Date que llega al renderizador es una
 * fecha CONTABLE (node-postgres entrega las columnas DATE como Date a
 * medianoche local), no un instante: `toISOString()` la movía un día al
 * oeste de Greenwich — una póliza del 31 de enero a las 20:00 en CDMX se
 * leía como del 1 de febrero, en el corte de periodo. Los getters locales
 * son los que coinciden con lo que la base guardó.
 *
 * Los instantes de verdad (timestamps de bitácora: posted_date, reversed_at,
 * last_used_at…) no pasan por aquí como Date: los comandos los serializan
 * ellos mismos con toISOString() ANTES de armar la fila, y eso queda así.
 */
export function dateOnly(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const s = String(value);
  // Una cadena ISO con hora ya trae la fecha resuelta: se recorta, no se reinterpreta.
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return dateOnly(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Valor de celda rumbo a JSON: mismas reglas de fecha que cell(), tipos intactos. */
function jsonCell(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return dateOnly(value);
  return value;
}

// ============================================================
// DINERO EN LA TABLA — presentación, no almacenamiento.
// Un contador lee 12,458,930.55; el 12458930.5500 de cuatro
// decimales es el formato de ALMACENAMIENTO y sólo es contrato en
// los formatos de máquina (json/ndjson/csv/tsv/md), que no cambian
// ni un byte. La detección se apoya en la misma convención que ya
// alinea estas columnas a la derecha: *_amount, *_total, debit,
// credit, balance, importe…
// ============================================================

const MONEY_COL_RE =
  /(^|_)(amount|amounts|total|totals|subtotal|debit|debits|credit|credits|balance|balances|importe|price)(_|$)/;

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** ¿La columna es de dinero por convención de nombre? */
function isMoneyColumn(col: string): boolean {
  return MONEY_COL_RE.test(col.toLowerCase());
}

/**
 * es-MX de presentación: separador de miles y DOS decimales, a partir de la
 * cadena decimal de almacenamiento. Todo por cadena y BigInt: pasar por
 * float es exactamente el redondeo que este sistema prohíbe, y aunque aquí
 * sólo se imprime, un importe de más de 2^53 centésimos saldría ya mentido.
 * El tercer decimal redondea hacia arriba en valor absoluto cuando es ≥ 5
 * (half-up sobre la magnitud, como redondea la calculadora del despacho).
 */
export function formatMoneyMx(value: string): string {
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value);
  if (!m) return value;
  const sign = m[1];
  let intDigits = m[2];
  const fracRaw = m[3] ?? '';
  let frac = (fracRaw + '00').slice(0, 2);
  if (fracRaw.length > 2 && fracRaw.charCodeAt(2) >= 0x35 /* '5' */) {
    const bumped = (BigInt(intDigits + frac) + 1n)
      .toString()
      .padStart(intDigits.length + 2, '0');
    intDigits = bumped.slice(0, -2);
    frac = bumped.slice(-2);
  }
  const grouped = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const out = `${grouped}.${frac}`;
  return sign && out !== '0.00' ? `-${out}` : out;
}

/** A column is numeric when every non-empty value parses as a number. */
function inferNumeric(rows: Row[], cols: string[]): Set<string> {
  const numeric = new Set<string>();
  for (const col of cols) {
    const values = rows.map((r) => cell(r[col])).filter((v) => v !== '');
    if (values.length && values.every((v) => /^-?[\d,]+(\.\d+)?$/.test(v))) numeric.add(col);
  }
  return numeric;
}

function toTable(rows: Row[], cols: string[], numeric: Set<string>, p: Palette): string {
  // SOLO aquí (la rama para humanos) el dinero se viste de presentación;
  // los formatos de máquina reciben la cadena de almacenamiento intacta.
  const display = (col: string, value: unknown): string => {
    const raw = cell(value);
    return isMoneyColumn(col) && DECIMAL_RE.test(raw) ? formatMoneyMx(raw) : raw;
  };
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => display(c, r[c]).length), 0)
  );
  // Numbers right-align so digits stack; everything else left-aligns.
  const padded = (v: string, w: number, right: boolean) =>
    right ? v.padStart(w) : v.padEnd(w);
  const row = (values: string[]) =>
    values.map((v, i) => padded(v, widths[i], numeric.has(cols[i]))).join('  ').trimEnd();

  const header = cols.map((c, i) => padded(c, widths[i], false)).join('  ').trimEnd();
  const rule = widths.map((w) => '─'.repeat(w)).join('  ');
  const body = rows.map((r) => row(cols.map((c) => display(c, r[c]))));
  return [p.bold(header), p.dim(rule), ...body].join('\n');
}

function escapeDelimited(value: string, delimiter: string): string {
  const needsQuotes = value.includes(delimiter) || value.includes('"') || /[\r\n]/.test(value);
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}

function toDelimited(rows: Row[], cols: string[], delimiter: string): string {
  const head = cols.map((c) => escapeDelimited(c, delimiter)).join(delimiter);
  const body = rows.map((r) => cols.map((c) => escapeDelimited(cell(r[c]), delimiter)).join(delimiter));
  return [head, ...body].join('\n');
}

function toMarkdown(rows: Row[], cols: string[]): string {
  // Escapa lo que puede FORJAR la tabla, no sólo lo que la afea, y en este
  // orden: primero la barra invertida —si fuera al final escaparía las que
  // añaden los otros pasos—, luego el pipe, que abre una columna, y al final
  // los saltos de línea, que abren una FILA entera. Un valor con \n convertía
  // una celda en dos renglones y desplazaba la tabla completa: el nombre de un
  // proveedor con salto de línea bastaba para que las cifras dejaran de
  // corresponder a su columna.
  const esc = (s: string) => s
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
  return [
    `| ${cols.map(esc).join(' | ')} |`,
    `|${cols.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${cols.map((c) => esc(cell(r[c]))).join(' | ')} |`),
  ].join('\n');
}

/**
 * Una nota: SIEMPRE va por stderr, nunca al archivo de `-o`.
 *
 * Lleva su tono en vez de venir ya coloreada porque quien la compone no
 * conoce el destino —esa es justamente la propiedad que hace imposible que
 * una rama nueva escriba por su cuenta—, y el color depende de si stderr es
 * una terminal.
 */
interface Note {
  tone: 'dim' | 'yellow';
  text: string;
}

/**
 * Lo que un renderizado PRODUCE, antes de saber a dónde va.
 *
 * `data` son los bytes que el usuario pidió: los que salen por stdout, o los
 * que `-o` prometió en un archivo. `notes` son los avisos, que van a stderr
 * siempre. La separación es el contrato. `compose` no recibe ningún flujo, lo
 * que lo hace difícil de saltarse por accidente — pero no imposible a
 * propósito, porque `process.stdout` es global: quien vigila eso de verdad es
 * la prueba que espía los dos flujos mientras compone.
 */
interface Composed {
  data: string;
  notes: Note[];
}

/**
 * Un destino que NO es una terminal.
 *
 * Con `-o` el dato va a un archivo, así que el color se decide contra el
 * ARCHIVO y no contra el stdout de quien invoca: desde una terminal, la tabla
 * entraba al archivo con los códigos ANSI dentro (`\x1b[1m` eran sus primeros
 * bytes) y ningún `diff` ni ningún `awk` sobrevivía a eso.
 */
const NO_ES_TERMINAL = { isTTY: false } as unknown as NodeJS.WriteStream;

/**
 * TODO EL TEXTO DE DATOS DE UN RENDERIZADO, EN UNA FUNCIÓN QUE NO PUEDE
 * ESCRIBIR.
 *
 * No recibe `NodeJS.WriteStream` a propósito: ésa es la garantía. Una rama
 * nueva —`--summary`, `--count`— se escribe aquí porque aquí se deciden los
 * formatos, y aquí no hay a dónde escribir; lo único que puede hacer es
 * devolver su texto, que sale por la única puerta. Y como el tipo de retorno
 * es `Composed` y el proyecto compila en `strict`, una rama que se olvide de
 * devolverlo no es un defecto silencioso: es un error de `tsc`.
 */
function compose(rows: Row[], opts: RenderOptions, p: Palette): Composed {
  // Bare --fields: free schema discovery, for humans and for the agent.
  // Es DATO —una lista de columnas que un guion consume—, así que sale por la
  // puerta como cualquier otra: antes volvía escribiendo a stdout y `-o` se
  // quedaba sin crear el archivo que había prometido.
  if (opts.fields === true) {
    return { data: fieldNames(rows).join('\n') + '\n', notes: [] };
  }

  const truncated = typeof opts.total === 'number' && opts.total > rows.length;
  const aviso: Note[] = truncated
    ? [
        {
          tone: 'yellow',
          text:
            `Showing ${rows.length} of ${opts.total as number} rows. ` +
            'Raise --limit, page with --offset, or use --all to see the rest.\n',
        },
      ]
    : [];

  if (opts.quiet) {
    const cols = fieldNames(rows);
    const id = opts.idField ?? (cols.includes('id') ? 'id' : cols.includes('code') ? 'code' : cols[0]);
    const text = rows.map((r) => cell(r[id])).join('\n');
    return { data: text ? text + '\n' : '', notes: aviso };
  }

  const format = resolveFormat(opts);
  const cols = selectFields(rows, opts.fields);

  if (format === 'json') {
    // Envelope, not a bare array: truncation and counts must be visible to
    // a machine, and a versioned shape can evolve without breaking readers.
    // Machine formats carry truncation in the payload; humans need to be told.
    return {
      data:
        JSON.stringify(
          {
            schema: SCHEMA_VERSION,
            count: rows.length,
            ...(typeof opts.total === 'number' ? { total: opts.total, truncated } : {}),
            rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c, jsonCell(r[c])]))),
          },
          null,
          2
        ) + '\n',
      notes: [],
    };
  }

  if (format === 'ndjson') {
    return {
      data:
        rows
          .map((r) => JSON.stringify(Object.fromEntries(cols.map((c) => [c, jsonCell(r[c])]))))
          .join('\n') + (rows.length ? '\n' : ''),
      notes: aviso,
    };
  }

  if (format === 'csv' || format === 'tsv') {
    return { data: toDelimited(rows, cols, format === 'csv' ? ',' : '\t') + '\n', notes: aviso };
  }

  if (format === 'md') {
    return { data: toMarkdown(rows, cols) + '\n', notes: aviso };
  }

  if (!rows.length) {
    // Cero filas es un RESULTADO, no una ausencia de salida: el humano lee la
    // nota por stderr y `-o` recibe su archivo, vacío. Vacío y no truncado:
    // `emit` sabe si esta invocación ya escribió ahí (`cfdi show` rinde dos
    // veces), y en ese caso añade nada en vez de borrar lo anterior.
    return { data: '', notes: [{ tone: 'dim', text: 'No rows.\n' }, ...aviso] };
  }

  const numeric = new Set(opts.numeric ?? [...inferNumeric(rows, cols)]);
  return { data: toTable(rows, cols, numeric, p) + '\n', notes: aviso };
}

/**
 * Renders a result set under the output contract. Returns nothing; writes
 * the DATA to stdout (or to `-o`) through `emit`, and every note to stderr.
 */
export function render(rows: Row[], opts: RenderOptions = {}): void {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  // El estilo del dato lo decide su DESTINO, no el stdout de quien invoca.
  const { data, notes } = compose(rows, opts, palette(opts.output ? NO_ES_TERMINAL : out));
  emit(data, opts, out);
  const p = palette(err);
  for (const n of notes) err.write(n.tone === 'yellow' ? p.yellow(n.text) : p.dim(n.text));
}

/**
 * Rutas que ESTE proceso ya abrió por `-o`.
 *
 * `-o` es una redirección, no un volcado: promete que el archivo contiene lo
 * que el comando habría impreso. `cfdi show` imprime dos tablas —la cabecera
 * del CFDI y sus conceptos— y con `writeFileSync` en cada render la segunda
 * BORRABA a la primera: el archivo salía con los conceptos y sin el
 * comprobante, en silencio y con código 0.
 *
 * De ahí las dos mitades de la regla, y por qué son dos:
 *
 *   · DENTRO de una invocación se ACUMULA. La primera escritura crea o trunca
 *     y las siguientes añaden, de modo que el archivo tenga la salida
 *     COMPLETA del comando. Fallar en vez de acumular —tratar el segundo
 *     render como un error del programador— era la otra salida posible y se
 *     descarta: convertiría `cfdi show -o` en un error de uso para quien no
 *     hizo nada mal, cambiando una pérdida silenciosa por una negativa a
 *     obedecer una combinación de banderas documentada.
 *   · ENTRE invocaciones NO se acumula. Este conjunto nace vacío con el
 *     proceso, así que correr el mismo comando dos veces sobre el mismo
 *     archivo lo deja con UNA salida, como haría `>`. Acumular entre
 *     corridas sería el defecto siguiente: un guion en cron duplicando su
 *     extracto cada noche.
 */
const abiertos = new Set<string>();

/**
 * LA ÚNICA PUERTA POR DONDE SALE UN DATO. La conoce `-o`, y por eso nada que
 * sea dato puede escribirse fuera de aquí.
 *
 * Se exporta porque hay una salida que no pasa por `render` y sí es dato: los
 * bytes exactos del XML en `cfdi show --format xml`, que no se re-serializan
 * jamás. Con `-o` iban íntegros a stdout y el archivo tampoco existía.
 */
export function emit(text: string, opts: RenderOptions, out?: NodeJS.WriteStream): void {
  if (opts.output) {
    // Por ruta RESUELTA: `./x.csv` y `x.csv` son el mismo archivo, y la
    // segunda tabla de un comando no puede truncar a la primera por haberse
    // escrito con otra forma del mismo nombre.
    const destino = resolvePath(opts.output);
    if (abiertos.has(destino)) {
      appendFileSync(destino, text, 'utf8');
    } else {
      writeFileSync(destino, text, 'utf8');
      abiertos.add(destino);
    }
    return;
  }
  (out ?? opts.stdout ?? process.stdout).write(text);
}

/**
 * ¿El usuario sigue queriendo la FICHA ESCRITA A MANO, o ya pidió otra forma?
 *
 * Diez hojas llevaban esta misma predicado copiado —`ap reconcile`, `closing
 * preview`, `diot`, `bank`, `batch`…— y la undécima, `entry show`, lo tenía
 * escrito a mano y le faltaba una cláusula: no consultaba `-o`. El efecto era
 * el defecto de este tramo con otra cara: con `-o`, la cabecera de la póliza
 * (número, fecha, estatus, totales) se iba por la terminal y al archivo
 * llegaban sólo los renglones. El archivo existía, así que la mentira era por
 * omisión y no se veía.
 *
 * Vive aquí, junto a la puerta, porque es una decisión del CONTRATO DE SALIDA
 * y no de ninguna hoja: pedir un archivo es pedir otra forma. Las diez copias
 * se quedan donde están —una de ellas con una excepción documentada, la de
 * `e-accounting generate`, donde `-o` nombra el XML y no la salida—; lo que
 * esta función da es un lugar canónico al que converger.
 */
export function legible(opts: RenderOptions): boolean {
  return (
    !opts.json &&
    (opts.format ?? 'table') === 'table' &&
    !opts.quiet &&
    opts.output === undefined &&
    opts.fields === undefined
  );
}

/**
 * SOLO PRUEBAS: olvida qué rutas abrió `-o`, que es como nace un proceso.
 *
 * Existe porque la mitad «entre invocaciones NO se acumula» sólo se puede
 * afirmar desde otro proceso, y una prueba que no puede expresar el fallo que
 * vigila no es una prueba. La otra mitad se comprueba de verdad, lanzando el
 * binario dos veces.
 */
export function resetOutputTargets(): void {
  abiertos.clear();
}
