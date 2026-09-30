// ============================================================
// ONE GRAMMAR FOR --line (#327, MNE-001-100)
//
// entry, bill and invoice each grew their own --line syntax: entry was
// positional with colons, bill was key=value with commas, invoice was
// key=value with semicolons. The owner's decision (2026-09-26, #327) is a
// fixed kernel rule, not a policy key:
//
//   - canonical form: key=value pairs separated by ";" in all three;
//   - cargo/abono are permanent synonyms of debit/credit, as a side and as a
//     key (never single letters: "c" is credit in English and cargo in Spanish);
//   - "-" and "_" are the same in key names (tax_rate is tax-rate);
//   - what people already type keeps working: entry's positional form as a
//     documented shortcut, and bill's commas plus the bare tax= key with a
//     stderr warning and a retirement version (catalog rule R9).
//
// The separator is ";" because a description with a comma in it is normal
// and one with a semicolon in it is not.
// ============================================================

import { usageError } from './cli-error.js';

export const LINE_PAIR_SEPARATOR = ';';

/**
 * The version in which the legacy spellings stop being accepted. R9: a
 * deprecated form is never removed in a minor, so it is the next major.
 */
export const LEGACY_LINE_FORMS_RETIRE_IN = '2.0.0';

const SIDE_SYNONYMS: Readonly<Record<string, 'debit' | 'credit'>> = { cargo: 'debit', abono: 'credit' };

/** Lower case, `_` read as `-`, and cargo/abono folded into debit/credit. */
export function normalizeLineKey(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/_/g, '-');
  return SIDE_SYNONYMS[key] ?? key;
}

export interface ParsedLineSpec {
  fields: Record<string, string>;
  /** True when the pairs were separated by commas (bill's legacy form). */
  legacyComma: boolean;
}

function splitPair(part: string, spec: string): [string, string] {
  const eq = part.indexOf('=');
  if (eq < 1) {
    throw usageError(
      `Cannot read the line "${spec}". Each part is key=value, separated by ";": ` +
        '--line "account=5100;qty=2;price=350.00;description=Text".'
    );
  }
  return [part.slice(0, eq), part.slice(eq + 1).trim()];
}

/**
 * True when every comma-separated part is itself a pair and there is no ";"
 * at all: only then is a comma a separator. `description=Consulting, July`
 * alone stays one pair.
 */
function looksLikeLegacyCommaForm(spec: string): boolean {
  if (spec.includes(LINE_PAIR_SEPARATOR)) return false;
  const parts = spec.split(',');
  return parts.length > 1 && parts.every((p) => p.indexOf('=') > 0);
}

/**
 * Parses one `key=value;key=value` spec. With `allowLegacyComma`, a spec
 * written the old bill way (commas) is read too and flagged, so the caller
 * can warn once.
 */
export function parseKeyValueLine(
  spec: string,
  options: { allowLegacyComma?: boolean } = {}
): ParsedLineSpec {
  const legacyComma = options.allowLegacyComma === true && looksLikeLegacyCommaForm(spec);
  const parts = spec.split(legacyComma ? ',' : LINE_PAIR_SEPARATOR);
  const pairs: Array<[string, string]> = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    pairs.push(splitPair(part.trim(), spec));
  }
  return { fields: normalizePairs(pairs, spec), legacyComma };
}

/**
 * The same key normalization for a line that arrives as a JSON object
 * (`--from-file`). Two spellings of one key (`debit` and `cargo`, `tax_rate`
 * and `tax-rate`) in one line are an error: silently keeping one of two
 * amounts is how a ledger goes wrong.
 */
export function normalizeLineRecord(record: Record<string, unknown>): Record<string, string> {
  return normalizePairs(Object.entries(record), JSON.stringify(record));
}

function normalizePairs(pairs: Array<[string, unknown]>, label: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [raw, value] of pairs) {
    if (value === null || value === undefined) continue;
    const key = normalizeLineKey(raw);
    if (key in out) throw usageError(`The line "${label}" gives "${key}" twice.`);
    out[key] = (typeof value === 'string' ? value : JSON.stringify(value)).trim();
  }
  return out;
}

/** Rejects any key outside `known`, naming the full list. */
export function rejectUnknownLineKeys(fields: Record<string, string>, known: readonly string[]): void {
  const unknown = Object.keys(fields).filter((k) => !known.includes(k));
  if (unknown.length) {
    throw usageError(`Unknown key(s) in --line: ${unknown.join(', ')}. Known keys: ${known.join(', ')}.`);
  }
}

/** True when the spec starts with `key=`, i.e. it is not entry's positional shortcut. */
export function isKeyValueLine(spec: string): boolean {
  return /^\s*[A-Za-z][A-Za-z_-]*\s*=/.test(spec);
}

/** One stderr line, once per invocation, when a line used bill's commas. */
export const LEGACY_COMMA_WARNING =
  `--line pairs separated by "," are deprecated; separate them with ";" ` +
  `(account=5100;qty=1;price=1000;tax-amount=160). Commas stop working in ${LEGACY_LINE_FORMS_RETIRE_IN}.`;

/** The help block that lists the keys of one command's --line. */
export function lineKeysHelp(rows: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(...rows.map(([k]) => k.length)) + 2;
  return (
    `\nKeys accepted in --line (key=value pairs separated by ";"; "_" and "-" are the same):\n` +
    rows.map(([k, text]) => `  ${k.padEnd(width)} ${text}`).join('\n') +
    '\n'
  );
}
