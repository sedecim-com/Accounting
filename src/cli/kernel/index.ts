// ============================================================
// CLI KERNEL
// The shared machinery every command is built from: the flag
// vocabulary, the output contract, the exit-code contract, the
// risk declaration that drives safety and agent permission, the
// active-entity context, and the closed verb list.
//
// Commands import from here and nowhere else for these concerns.
// That is what makes the consistency test (tests/cli/kernel/
// consistency.spec.ts) able to hold the surface together while
// many hands edit it.
// ============================================================

export {
  ExitCode,
  CliError,
  checkExitCode,
  notFound,
  usageError,
  validationFailed,
  blockedByState,
  conflict,
  permissionDenied,
  externalFailed,
  externalRejected,
  abortedByUser,
  needsHuman,
  type ExitCodeValue,
} from './exit.js';

export {
  render,
  resolveFormat,
  fieldNames,
  dateOnly,
  formatMoneyMx,
  FORMATS,
  SCHEMA_VERSION,
  type Format,
  type Row,
  type RenderOptions,
} from './output.js';

export {
  withContext,
  withOutput,
  withSelection,
  withTime,
  withStrict,
  withForce,
  withNote,
  withReadFlags,
  globalsOf,
  FLAG_DICTIONARY,
  BANNED_FLAGS,
} from './flags.js';

export {
  declareRisk,
  gateMutation,
  riskOf,
  allDeclarations,
  resetDeclarations,
  type Risk,
  type RiskDeclaration,
  type ResolvedRisk,
} from './risk.js';

export {
  resolveActiveEntity,
  requireExplicitEntity,
  useEntity,
  currentEntity,
  readState,
  writeState,
  clearActiveEntity,
  statePath,
  type EntityResolution,
} from './entity-context.js';

export { VERBS, isVerb, spanishVerb, OBJECTLESS_COMMANDS, LEGACY_PLURALS } from './vocabulary.js';

import { CliError, ExitCode, type ExitCodeValue } from './exit.js';

/**
 * HTTP status → exit code, for the domain errors the service layer throws
 * (`AppError` and its subclasses in utils/errors.ts carry a `statusCode`).
 * The services were written for the REST surface and speak in status codes;
 * the CLI has its own contract, and this is the one place the two meet.
 * Duck-typed on `statusCode` so the kernel keeps no dependency on the
 * error hierarchy — and so any future error carrying one maps too.
 */
const STATUS_TO_EXIT: Record<number, ExitCodeValue> = {
  400: ExitCode.USAGE,
  401: ExitCode.PERMISSION,
  403: ExitCode.PERMISSION,
  404: ExitCode.NOT_FOUND,
  409: ExitCode.CONFLICT,
  422: ExitCode.VALIDATION,
  423: ExitCode.BLOCKED,
  502: ExitCode.EXTERNAL_FAILED,
  503: ExitCode.EXTERNAL_FAILED,
  504: ExitCode.EXTERNAL_FAILED,
};

/**
 * The exit code an error should produce. A CliError carries its own; a domain
 * error is mapped from its status; anything else is an unmapped failure and
 * gets the generic code. Kept here so no command has to remember the mapping.
 */
export function exitCodeFor(err: unknown): ExitCodeValue {
  if (err instanceof CliError) return err.exitCode;
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && STATUS_TO_EXIT[status]) return STATUS_TO_EXIT[status];
  return ExitCode.FAILURE;
}
