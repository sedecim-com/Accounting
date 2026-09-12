import { ExitCode, type ExitCodeValue, type KeyedMessage } from './exit.js';
import { renderKeyed } from './render-keyed.js';
import type { Language, MessageParams } from '../../i18n/index.js';

// ============================================================
// EL ERROR QUE LLEVA SU CÓDIGO DE SALIDA — y por qué NO vive en `exit.ts`
//
// `exit.ts` lo importa el arnés de evaluación ANTES del global-setup, así que
// cualquier dependencia suya se carga antes de que exista la base efímera y
// puede armar el pool con la DATABASE_URL equivocada. Lo vigila
// `tests/ai/eval/arnes-cableado.spec.ts`, que cuenta CUALQUIER `import` de ese
// archivo —también los de sólo tipo—, porque lo que protege no es el tipo sino
// que el módulo no tenga a quién cargar.
//
// I7 rompió esa invariante al hacer que `CliError` se rindiera por clave:
// `renderKeyed` metió el catálogo dentro de `exit.ts`. La partición es la
// natural y no un rodeo para pasar la prueba: `exit.ts` se queda con la TABLA
// de códigos y la FORMA del mensaje —datos, cero imports—, y la clase que
// necesita el catálogo vive aquí. Reexportar desde `exit.ts` habría pasado la
// prueba y NO habría arreglado nada: un `export … from` carga el módulo igual.
// ============================================================

export class CliError extends Error {
  readonly exitCode: ExitCodeValue;
  /** Machine-readable detail carried into --json output. */
  readonly detail?: unknown;
  /**
   * La clave del catálogo, cuando este error nació de una.
   *
   * `string` y no `TranslationKey`: la forma del mensaje vive en `exit.ts`,
   * que no puede importar el catálogo (ver la cabecera), así que el
   * estrechamiento no ocurre en el tipo sino al RENDIR — `render-keyed.ts`
   * comprueba que la clave exista y falla con su nombre si no. Se paga un
   * chequeo de compilador por una invariante de arranque, y queda dicho.
   */
  readonly key?: string;
  /** Los huecos de esa clave. Vacío cuando el error nació de una cadena. */
  readonly params: MessageParams;
  private readonly keyed?: KeyedMessage;

  constructor(
    message: string | KeyedMessage,
    exitCode: ExitCodeValue = ExitCode.FAILURE,
    detail?: unknown
  ) {
    const keyed = typeof message === 'string' ? undefined : message;
    super(keyed ? renderKeyed(keyed, 'en') : (message as string));
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.detail = detail;
    this.keyed = keyed;
    this.key = keyed?.key;
    this.params = keyed?.params ?? {};
  }

  /**
   * El mensaje en el idioma activo, rendido AHORA.
   *
   * Un error que nació de una cadena devuelve esa cadena tal cual: no hay clave
   * que rendir y fingir lo contrario sería peor que devolver inglés — y `language`
   * tampoco lo cambia, por lo mismo.
   *
   * `language` es para quien necesita un idioma CONCRETO sin mover el idioma
   * activo del proceso: hoy, las pruebas. Omitido, manda el activo, que es lo
   * que hace `reportError` (src/cli/mnemosine.ts).
   */
  localized(language?: Language): string {
    return this.keyed ? renderKeyed(this.keyed, language) : this.message;
  }
}

export const notFound = (what: string | KeyedMessage, detail?: unknown) =>
  new CliError(what, ExitCode.NOT_FOUND, detail);

export const usageError = (message: string | KeyedMessage) => new CliError(message, ExitCode.USAGE);

export const validationFailed = (message: string | KeyedMessage, detail?: unknown) =>
  new CliError(message, ExitCode.VALIDATION, detail);

export const blockedByState = (message: string | KeyedMessage, detail?: unknown) =>
  new CliError(message, ExitCode.BLOCKED, detail);

export const conflict = (message: string | KeyedMessage, detail?: unknown) =>
  new CliError(message, ExitCode.CONFLICT, detail);

export const permissionDenied = (message: string | KeyedMessage, detail?: unknown) =>
  new CliError(message, ExitCode.PERMISSION, detail);

/** Retryable: the service was reachable-ish but did not answer usefully. */
export const externalFailed = (message: string | KeyedMessage, detail?: unknown) =>
  new CliError(message, ExitCode.EXTERNAL_FAILED, detail);

/**
 * NOT retryable: the service answered and said no. SAT error 5002
 * ("same period requested twice") is permanent — retrying burns the
 * request budget for that period forever.
 */
export const externalRejected = (message: string | KeyedMessage, detail?: unknown) =>
  new CliError(message, ExitCode.EXTERNAL_REJECTED, detail);

/**
 * The verdict of a batch that kept going after each failure — `outbox run`
 * with explicit ids is the one that matters, because it is the leaf a cron
 * calls. Such a loop cannot throw (it must attempt every id), so its exit
 * code has to be COMPOSED from what it collected, and for years it was
 * composed as `failed > 0 ? 1 : 0` — a ternary that the ratchet hunting
 * hardcoded exit codes never matched, and that threw away the one
 * distinction the contract sells.
 *
 * A retryable failure DOMINATES. If even one operation may yet succeed the
 * batch is worth re-running, and re-running the ones already refused is
 * harmless: they are no longer `pending`, so their status refuses them
 * again without a second call. Only when EVERY failure was a definitive
 * refusal is the batch itself hopeless — that is the 9, and it is what
 * stops a cron from hammering a rejection forever.
 */

/**
 * El aborto que el usuario pidió. Sin argumento sale del catálogo; con uno, la
 * hoja que quiere decir algo más concreto sigue pudiendo.
 */
export const abortedByUser = (message?: string | KeyedMessage) =>
  new CliError(message ?? { key: 'cli.exit.aborted' }, ExitCode.ABORTED);

export const needsHuman = (message: string | KeyedMessage, detail?: unknown) =>
  new CliError(message, ExitCode.NEEDS_HUMAN, detail);
