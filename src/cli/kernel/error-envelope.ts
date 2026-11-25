import { t, type MessageParams } from '../../i18n/index.js';
import { CliError } from './cli-error.js';
import { ERROR_SCHEMA_NAME, ERROR_SCHEMA_VERSION } from './output.js';

// ============================================================
// THE MACHINE ERROR (MNE-001-698 · #952 stage 1 · PRD-003 RF-36)
//
// A leaf asked for JSON promises JSON, and that promise covers its failure
// too: a gateway that runs the binary for a remote caller has to answer with
// what went wrong, and prose on stderr is not something it can read. So when
// the invocation asked for JSON, `reportError` writes ONE line of JSON on
// stderr instead of the prose:
//
//   {"schema":"mnemosine.error/1","exit_code":7,"key":"…","params":{…},
//    "message":"…","remedy":null}
//
//   · exit_code  the code the process exits with (the same as without --json).
//   · key/params the catalogue key and its holes, in English: stable, the same
//                in every language. null and {} when the error was written as
//                prose and has no key.
//   · message    what the person would read, in the active language.
//   · remedy     the lines the prose marks with «→», and the remedy
//                reportError adds; null when there is none.
//
// IT IS THE LAST LINE OF STDERR, not all of it: warnings and notes printed
// before the failure (the RLS notice, the `--user` notice) still go first. A
// leaf that carries on after an error writes one line per error.
//
// WHAT AN INTERNAL ERROR SAYS. A failure of the driver or of the system (a pg
// error, ECONNREFUSED) carries text written for the operator of the machine:
// SQL, a constraint, a host and port, a path. A machine error may travel to a
// remote caller, so it says `cli.error.internal` and a fixed sentence, never
// the raw text; the person reads it by running without --json. It is the
// choice the REST error handler makes for an unhandled error. Any other
// exception, written by this code, keeps its message: it was written for a
// person. Never a stack, never `detail` or `details`.
//
// Without --json NOTHING here runs: the prose is the one of before, byte for
// byte, and `tests/cli/json-error-envelope.spec.ts` pins it.
// ============================================================

/** One failure, as a machine reads it. */
export interface ErrorEnvelope {
  readonly schema: string;
  readonly exit_code: number;
  readonly key: string | null;
  readonly params: MessageParams;
  readonly message: string;
  readonly remedy: string | null;
}

/** What the caller already words itself: the provider branches of reportError, and its remedy redactor. */
export interface ToldError {
  readonly message?: string;
  readonly remedy?: string | null;
}

/**
 * The formats whose reader parses JSON. `--format json` is the same flag as
 * `--json` (`resolveFormat`); ndjson is JSON too, one value per line, so its
 * reader is the one that cannot parse prose either. csv, tsv, md, the table
 * and --quiet keep the prose.
 */
const MACHINE_FORMATS: ReadonlySet<string> = new Set(['json', 'ndjson']);

let machine = false;

/**
 * Records whether THIS invocation asked for JSON. Called first thing by the
 * root `preAction` hook (src/cli/mnemosine.ts), so a failure of the hook itself
 * is covered too. Process-wide on purpose: one process runs one leaf.
 */
export function setErrorOutput(opts: { readonly json?: unknown; readonly format?: unknown }): void {
  machine =
    opts.json === true ||
    (typeof opts.format === 'string' && MACHINE_FORMATS.has(opts.format.trim().toLowerCase()));
}

export function machineErrorOutput(): boolean {
  return machine;
}

/** TESTS ONLY: back to prose, which is how a process is born. */
export function resetErrorOutput(): void {
  machine = false;
}

/** The domain error of the service layer, duck-typed so the kernel keeps no dependency on its hierarchy. */
interface ServiceError {
  readonly statusCode: number;
  readonly messageKey?: { readonly key: string; readonly params?: MessageParams };
  localized(): string;
}

function isServiceError(err: unknown): err is ServiceError {
  const e = err as Partial<ServiceError> | null;
  return typeof e?.statusCode === 'number' && typeof e.localized === 'function';
}

/** A failure of the database driver or of the system, not of this code. */
function isInternal(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, severity, syscall } = err as { code?: unknown; severity?: unknown; syscall?: unknown };
  // pg's DatabaseError: a severity and a five-character SQLSTATE.
  if (typeof severity === 'string' && typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return true;
  // Node's system errors (ECONNREFUSED, ENOENT…), and the AggregateError a dual-stack connect throws.
  return typeof syscall === 'string' || (typeof code === 'string' && /^E[A-Z0-9_]+$/.test(code));
}

/** The head of a rendered message, and the lines it marks with «→». */
function split(text: string): { head: string; remedies: string[] } {
  const head: string[] = [];
  const remedies: string[] = [];
  for (const line of text.split('\n')) {
    const arrow = /^\s*→\s?(.*)$/.exec(line);
    if (arrow) remedies.push(arrow[1].trim());
    else head.push(line);
  }
  return { head: head.join('\n').trim(), remedies };
}

/** The envelope of one failure. Pure: it writes nothing. */
export function errorEnvelope(err: unknown, exitCode: number, told: ToldError = {}): ErrorEnvelope {
  let key: string | null = null;
  let params: MessageParams = {};
  let text: string;
  let internal = false;
  if (told.message !== undefined) {
    text = told.message;
  } else if (err instanceof CliError) {
    key = err.key ?? null;
    params = err.params;
    text = err.localized();
  } else if (isServiceError(err)) {
    key = err.messageKey?.key ?? null;
    params = { ...(err.messageKey?.params ?? {}) };
    text = err.localized();
  } else if (isInternal(err)) {
    key = 'cli.error.internal';
    text = t('cli.error.internal');
    internal = true;
  } else {
    text = err instanceof Error ? err.message : String(err);
  }
  const { head, remedies } = split(text);
  if (told.remedy) remedies.push(told.remedy);
  else if (internal) remedies.push(t('cli.error.internal_remedy'));
  return {
    schema: `${ERROR_SCHEMA_NAME}/${ERROR_SCHEMA_VERSION}`,
    exit_code: exitCode,
    key,
    params,
    message: head,
    remedy: remedies.length > 0 ? remedies.join('\n') : null,
  };
}

/** The envelope as one line on stderr: the only write of this module. */
export function writeErrorEnvelope(
  err: unknown,
  exitCode: number,
  told: ToldError = {},
  out: Pick<NodeJS.WritableStream, 'write'> = process.stderr
): void {
  out.write(`${JSON.stringify(errorEnvelope(err, exitCode, told))}\n`);
}
