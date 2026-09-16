// ESTE ARCHIVO NO IMPORTA NADA, Y NO ES ESTILO: ES UNA INVARIANTE MEDIDA.
//
// El arnés de evaluación importa `exit.ts` ANTES del global-setup, así que
// cualquier dependencia suya se carga antes de que exista la base efímera y
// puede armar el pool con la DATABASE_URL equivocada. Lo vigila
// `tests/ai/eval/arnes-cableado.spec.ts` («los dos `src` que el arnés importa
// arriba son módulos HOJA»), y cuenta CUALQUIER `import` —también los de sólo
// tipo—, porque el remedio no es que el tipo se borre al compilar sino que el
// archivo no tenga a quién cargar.
//
// I7 lo rompió al hacer que `CliError` se rindiera por clave: metió i18n aquí
// dentro. La forma del mensaje se declara ABAJO, sin importar nada; quien lo
// RINDE es `render-keyed.ts`, que sí puede depender del catálogo porque nadie
// lo carga temprano.

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

// ============================================================
// UN ERROR QUE LLEVA SU CLAVE, NO SU PROSA (I7 · issue #149)
//
// `CliError` nació con un `message: string`, y esa firma es lo que ataba cada
// fallo del kernel a un idioma: la frase se escribía en el sitio del `throw`, y
// para cuando `reportError` la veía ya era texto —no quedaba nada que traducir—.
// El arreglo NO retira la firma vieja: cientos de sitios de llamada pasan una
// cadena y siguen valiendo. Lo que se añade es la ALTERNATIVA, y las hojas se
// mudan a ella tramo a tramo.
//
// LA MAQUETACIÓN NO ENTRA EN EL CATÁLOGO. Los errores de este núcleo llevan a
// menudo un remedio debajo («  → mnemosine doctor») y una nota final; esas
// sangrías y esas flechas se escriben AQUÍ, en `lines`, y el catálogo guarda
// sólo la frase. Meter el «  → » en la cadena traducida obligaría a traducir el
// margen de cada sitio de llamada, que es exactamente lo que `src/i18n/en.ts`
// dice por escrito que no se hace.
//
// DOS RENDIDOS Y NO UNO, Y LA DIFERENCIA ES DELIBERADA:
//   · `message` —lo que hereda de `Error`— se fija en INGLÉS al construir. Es
//     lo que acaba en un log, en un `stack` y en cualquier lector de máquina, y
//     un log que cambia de idioma según quién corrió el binario no se puede
//     buscar.
//   · `localized()` rinde en el idioma ACTIVO, y es lo que `reportError`
//     imprime. Se rinde al imprimir, no al lanzar.
// ============================================================

/** Un renglón que cuelga debajo del mensaje: un remedio, una nota. */
export interface KeyedLine {
  // `string` y no `TranslationKey`: traer ese tipo sería un import, y este
  // archivo no puede tenerlos. El estrechamiento a una clave real ocurre en
  // `render-keyed.ts`, que comprueba en tiempo de render que la clave existe.
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
  /** Lo que va delante del renglón. La sangría vive aquí, no en el catálogo. */
  readonly prefix?: string;
}

/** Un mensaje de error escrito como clave del catálogo y sus huecos. */
export interface KeyedMessage {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly lines?: readonly KeyedLine[];
}

/**
 * An error that carries the exit code the process should end with.
 * Command handlers throw these; one top-level handler maps them to
 * `process.exitCode` and a single stderr line, so no command calls
 * process.exit() on its own.
 */
export function batchExitCode(codes: readonly ExitCodeValue[]): ExitCodeValue {
  if (codes.length === 0) return ExitCode.OK;
  if (codes.includes(ExitCode.EXTERNAL_FAILED)) return ExitCode.EXTERNAL_FAILED;
  if (codes.every((c) => c === ExitCode.EXTERNAL_REJECTED)) return ExitCode.EXTERNAL_REJECTED;
  return ExitCode.FAILURE;
}


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
