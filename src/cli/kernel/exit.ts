// ============================================================
// EXIT CODE CONTRACT
// One table for the whole CLI. Published once here and cited
// everywhere else; no command invents its own scheme.
//
// The two codes that carry weight beyond "it failed":
//   4  a `check` that FOUND something. Findings are also in the
//      payload — the code is what lets a check drop into CI or a
//      job runner unchanged (git diff --exit-code's trick).
//   11 needs human: a question was raised or a draft awaits
//      review. This is the code that makes an agent-driven
//      workflow safe — the work did not fail, it is waiting.
//
// A check that could NOT RUN (no connection, bad selector) exits
// 1/2/3/8 as appropriate — never 4. Conflating "I found problems"
// with "I could not look" is how a green pipeline lies.
// ============================================================

export const ExitCode = {
  /** Success — including a clean check, and an idempotency hit with an identical result. */
  OK: 0,
  /** Generic failure. Last resort: prefer a specific code. */
  FAILURE: 1,
  /** Usage error — bad flag, missing argument, unknown subcommand. */
  USAGE: 2,
  /** Not found — entity, entry, account, period or document does not exist. */
  NOT_FOUND: 3,
  /** Validation failed — unbalanced entry, NIF/GAAP rule violated, schema invalid; also a check with blocking findings. */
  VALIDATION: 4,
  /** Blocked by state — period closed or locked, lock date, entry already posted, credential expired. */
  BLOCKED: 5,
  /** Conflict — same idempotency key, different payload. */
  CONFLICT: 6,
  /** Permission denied — RLS, role, entity access, approval policy. */
  PERMISSION: 7,
  /** External service failed (PAC, SAT, bank, Contalink timed out or errored). Retryable. */
  EXTERNAL_FAILED: 8,
  /** External service rejected (SAT 5002, CFDI rejected). NOT retryable — never blind-retry. */
  EXTERNAL_REJECTED: 9,
  /** Aborted by user — declined a confirmation. */
  ABORTED: 10,
  /** Needs human — a question was raised or a draft awaits review. */
  NEEDS_HUMAN: 11,
  /** Interrupted (SIGINT). */
  INTERRUPTED: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * An error that carries the exit code the process should end with.
 * Command handlers throw these; one top-level handler maps them to
 * `process.exitCode` and a single stderr line, so no command calls
 * process.exit() on its own.
 */
export class CliError extends Error {
  readonly exitCode: ExitCodeValue;
  /** Machine-readable detail carried into --json output. */
  readonly detail?: unknown;

  constructor(message: string, exitCode: ExitCodeValue = ExitCode.FAILURE, detail?: unknown) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

export const notFound = (what: string, detail?: unknown) =>
  new CliError(what, ExitCode.NOT_FOUND, detail);

export const usageError = (message: string) => new CliError(message, ExitCode.USAGE);

export const validationFailed = (message: string, detail?: unknown) =>
  new CliError(message, ExitCode.VALIDATION, detail);

export const blockedByState = (message: string, detail?: unknown) =>
  new CliError(message, ExitCode.BLOCKED, detail);

export const conflict = (message: string, detail?: unknown) =>
  new CliError(message, ExitCode.CONFLICT, detail);

export const permissionDenied = (message: string, detail?: unknown) =>
  new CliError(message, ExitCode.PERMISSION, detail);

/** Retryable: the service was reachable-ish but did not answer usefully. */
export const externalFailed = (message: string, detail?: unknown) =>
  new CliError(message, ExitCode.EXTERNAL_FAILED, detail);

/**
 * NOT retryable: the service answered and said no. SAT error 5002
 * ("same period requested twice") is permanent — retrying burns the
 * request budget for that period forever.
 */
export const externalRejected = (message: string, detail?: unknown) =>
  new CliError(message, ExitCode.EXTERNAL_REJECTED, detail);

export const abortedByUser = (message = 'Aborted.') => new CliError(message, ExitCode.ABORTED);

export const needsHuman = (message: string, detail?: unknown) =>
  new CliError(message, ExitCode.NEEDS_HUMAN, detail);

/**
 * Exit code for a `check`-style command, per the one diagnostic
 * convention: clean → 0; blocking findings → 4; warning-only → 0
 * unless --strict makes them 4.
 */
export function checkExitCode(
  findings: { blocking: number; warning: number },
  opts: { strict?: boolean } = {}
): ExitCodeValue {
  if (findings.blocking > 0) return ExitCode.VALIDATION;
  if (findings.warning > 0 && opts.strict) return ExitCode.VALIDATION;
  return ExitCode.OK;
}
