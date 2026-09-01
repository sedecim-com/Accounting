import { writeFileSync } from 'node:fs';
import { palette } from '../palette.js';
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

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
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

function toTable(rows: Row[], cols: string[], numeric: Set<string>, stream: NodeJS.WriteStream): string {
  const p = palette(stream);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => cell(r[c]).length), 0)
  );
  // Numbers right-align so digits stack; everything else left-aligns.
  const padded = (v: string, w: number, right: boolean) =>
    right ? v.padStart(w) : v.padEnd(w);
  const row = (values: string[]) =>
    values.map((v, i) => padded(v, widths[i], numeric.has(cols[i]))).join('  ').trimEnd();

  const header = cols.map((c, i) => padded(c, widths[i], false)).join('  ').trimEnd();
  const rule = widths.map((w) => '─'.repeat(w)).join('  ');
  const body = rows.map((r) => row(cols.map((c) => cell(r[c]))));
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
  // La diagonal invertida va PRIMERO: si sólo se escapara el pipe, una celda
  // que ya trae `\|` saldría como `\\|` — barra literal seguida de un pipe
  // SIN escapar, que parte la fila de la tabla.
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  return [
    `| ${cols.map(esc).join(' | ')} |`,
    `|${cols.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${cols.map((c) => esc(cell(r[c]))).join(' | ')} |`),
  ].join('\n');
}

/**
 * Renders a result set under the output contract. Returns nothing; writes
 * to stdout (or --output) and puts every note on stderr.
 */
export function render(rows: Row[], opts: RenderOptions = {}): void {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const p = palette(err);

  // Bare --fields: free schema discovery, for humans and for the agent.
  if (opts.fields === true) {
    out.write(fieldNames(rows).join('\n') + '\n');
    return;
  }

  const truncated = typeof opts.total === 'number' && opts.total > rows.length;

  if (opts.quiet) {
    const cols = fieldNames(rows);
    const id = opts.idField ?? (cols.includes('id') ? 'id' : cols.includes('code') ? 'code' : cols[0]);
    const text = rows.map((r) => cell(r[id])).join('\n');
    emit(text ? text + '\n' : '', opts, out);
    if (truncated) warnTruncation(err, p, rows.length, opts.total as number);
    return;
  }

  const format = resolveFormat(opts);
  const cols = selectFields(rows, opts.fields);
  let text: string;

  if (format === 'json') {
    // Envelope, not a bare array: truncation and counts must be visible to
    // a machine, and a versioned shape can evolve without breaking readers.
    text = JSON.stringify(
      {
        schema: SCHEMA_VERSION,
        count: rows.length,
        ...(typeof opts.total === 'number' ? { total: opts.total, truncated } : {}),
        rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))),
      },
      null,
      2
    ) + '\n';
  } else if (format === 'ndjson') {
    text = rows
      .map((r) => JSON.stringify(Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))))
      .join('\n') + (rows.length ? '\n' : '');
  } else if (format === 'csv' || format === 'tsv') {
    text = toDelimited(rows, cols, format === 'csv' ? ',' : '\t') + '\n';
  } else if (format === 'md') {
    text = toMarkdown(rows, cols) + '\n';
  } else {
    if (!rows.length) {
      err.write(p.dim('No rows.\n'));
      return;
    }
    const numeric = new Set(opts.numeric ?? [...inferNumeric(rows, cols)]);
    text = toTable(rows, cols, numeric, out) + '\n';
  }

  emit(text, opts, out);

  // Machine formats carry truncation in the payload; humans need to be told.
  if (truncated && format !== 'json') warnTruncation(err, p, rows.length, opts.total as number);
}

function warnTruncation(
  err: NodeJS.WriteStream,
  p: ReturnType<typeof palette>,
  shown: number,
  total: number
): void {
  err.write(
    p.yellow(
      `Showing ${shown} of ${total} rows. Raise --limit, page with --offset, or use --all to see the rest.\n`
    )
  );
}

function emit(text: string, opts: RenderOptions, out: NodeJS.WriteStream): void {
  if (opts.output) {
    writeFileSync(opts.output, text, 'utf8');
    return;
  }
  out.write(text);
}
