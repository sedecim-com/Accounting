// ============================================================
// CSV (RFC 4180)
//
// Shared by the report endpoints that offer ?format=csv. Deliberately small:
// no streaming, no schema inference, no dependency. Rows are already in memory
// by the time a handler calls this, and a report's row count is bounded by the
// chart of accounts, not by the ledger.
// ============================================================

/**
 * Leading characters a spreadsheet reads as the start of a formula when the
 * file is opened: OWASP's CSV-injection set, `=` `+` `-` `@` plus TAB and CR.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * A plain decimal literal, optional sign, optional exponent.
 *
 * This is the exemption that makes the guard below usable in an accounting
 * export. Half the dangerous set is also how numbers legitimately begin:
 * `-21000.0000` comes out of Decimal.toFixed(4) on every credit-balance
 * account. A guard that fired on the leading character alone would turn every
 * negative amount into text and break the columns the report exists for.
 */
const NUMERIC_LITERAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Quote one field per RFC 4180 §2: wrap in double quotes when the value
 * contains a comma, a double quote, CR or LF, doubling any embedded quote.
 * Everything else goes out bare.
 *
 * null and undefined become the EMPTY field, not the strings 'null' and
 * 'undefined'. That is not cosmetic here: TrialBalanceRow declares
 * beginning_balance, which the trial-balance query does not select, so any
 * column that turns out to be absent must read as blank rather than as a word.
 *
 * A non-numeric field opening on a formula character is additionally prefixed
 * with an apostrophe and quoted. Account names are user input and these files
 * are opened in Excel, so an account called `=IMPORTXML(...)` would otherwise
 * execute on the reader's machine, not describe itself. The apostrophe is
 * OWASP's recommended prefix; the cost is that some spreadsheet apps show it
 * literally on import, which is a fair price for a value that was already
 * pretending to be a formula. Anything that parses as a number is exempt --
 * see NUMERIC_LITERAL -- so the debit, credit and balance columns are
 * untouched.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);

  if (FORMULA_LEAD.test(text) && !NUMERIC_LITERAL.test(text)) {
    return `"'${text.replace(/"/g, '""')}"`;
  }

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serialize `rows` to CSV, emitting `columns` in the given order as both the
 * header and the projection. Passing the columns explicitly (rather than
 * reading Object.keys off the first row) keeps the header stable when a row
 * happens to be missing a key, and keeps the column order a decision of the
 * caller instead of an accident of insertion order.
 *
 * CRLF terminators, including a trailing one, per RFC 4180 §2.
 */
export function toCsv<T>(
  columns: readonly (keyof T & string)[],
  rows: readonly T[]
): string {
  const lines = [columns.map(csvField).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvField(row[column])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Build a Content-Disposition value for a CSV download.
 *
 * `stem` reaches us from the request (entity_id is a query parameter, and
 * requireEntityAccess never checks its shape), so everything outside a
 * conservative alphabet is dropped before it lands in a response header. A
 * value carrying a quote or a CRLF would otherwise let a caller write headers
 * of their own choosing.
 */
export function csvAttachment(stem: string): string {
  const safe = stem.replace(/[^A-Za-z0-9._-]/g, '') || 'export';
  return `attachment; filename="${safe}.csv"`;
}
