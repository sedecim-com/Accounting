import { InvalidArgumentError, type Command } from 'commander';
import { FORMATS } from './output.js';

// ============================================================
// FLAG VOCABULARY — the single dictionary (rulebook R6)
//
// One concept, one spelling, one meaning, everywhere. Commands do
// not declare these flags by hand; they apply the group they need.
// That is what makes the R12 consistency test possible: a flag can
// only exist in the CLI if it exists here first.
//
// Short flags are scarce and are assigned once:
//   -e entity  -t tenant  -u user  -p provider  -m model
//   -n limit   -l list    -s status  -a all     -y yes
//   -o output  -q quiet   -v verbose -c set     -z null
//   -M -Q -Y interval
// `-f` is deliberately never assigned: it reads as both --file and
// --force, and the day those two are confused someone overrides a
// period lock while meaning to pass a filename.
//
// Deliberately banned spellings, rejected here so they cannot creep
// back: --dryrun, --out, --fmt, --outfmt, --from/--to, --noinput,
// --silent, --pretty, and -f for force.
// ============================================================

/** Spellings a command may never declare. Enforced by the consistency test. */
export const BANNED_FLAGS = [
  '--dryrun', '--out', '--fmt', '--outfmt', '--from', '--to',
  '--noinput', '--silent', '--pretty', '--confirm', '--validate-only', '--plan',
  '--against', '--sandbox', '--test',
] as const;

/** Every long flag the dictionary defines, with its short form when it has one. */
export const FLAG_DICTIONARY: Record<string, string | null> = {
  '--entity': '-e', '--tenant': '-t', '--user': '-u',
  '--profile': null, '--config': null, '--set': '-c',
  '--period': null, '--since': null, '--until': null, '--as-of': null,
  '--date-basis': null, '--interval': null,
  '--account': null, '--status': '-s', '--limit': '-n', '--offset': null,
  '--cursor': null, '--all': '-a',
  '--format': null, '--json': null, '--output': '-o', '--fields': null,
  '--jq': null, '--quiet': '-q', '--verbose': '-v', '--null': '-z',
  '--no-color': null, '--no-pager': null,
  '--dry-run': null, '--diff': null, '--yes': '-y', '--force': null,
  '--reason': null, '--note': null, '--idempotency-key': null, '--live': null,
  '--strict': null, '--no-input': null, '--watch': null,
  '--provider': '-p', '--model': '-m',
  // S3: el destino de un respaldo (directorio) o de una restauración (base).
  // Lo nombra el catálogo en las filas de `backup` desde antes de existir.
  '--target': null,
  // S3: `backup verify` comprueba hash y manifiesto sin restaurar (lo que el
  // catálogo promete); con --restore ENSAYA la restauración de verdad, que es
  // lo único que demuestra que un respaldo sirve.
  '--restore': null,
  // F04 · la bandeja de CFDI (`bill inbox list|run`). El catálogo las nombra
  // desde antes de que existieran. Entran aquí para congelar la grafía: sin
  // esto `--query` reaparece como --filter o --where en la próxima sesión, y
  // `--vendor` —que `bill list` y `bill create` ya declaraban a mano— podría
  // ganar una forma corta en un comando y no en otro.
  '--vendor': null,
  '--processing-mode': null,
  '--requires-approval': null,
  '--bulk': null,
  '--query': null,
  '--action': null,
  // El lote programado al que `--action set-batch` engancha el pre-registro.
  '--batch': null,
  // F04 · la autorización explícita de alta de proveedor desde un CFDI. Es
  // control interno, no criterio contable: no se pregunta al panel de
  // políticas, se escribe en la orden o no ocurre.
  '--allow-new-vendor': null,
  // F04 · el desglose en prosa de un resultado que la tabla sólo enumera: el
  // porqué de cada partida, no sólo su importe. El catálogo la promete en
  // `ap reconcile` y la reclamarán las demás conciliaciones; entra al
  // diccionario para que las tres se escriban igual. `explain` ya existía como
  // VERBO (`cfdi explain`): son cosas distintas y conviven sin estorbarse,
  // igual que `--diff` convive con el verbo `diff`.
  '--explain': null,

  // ── F05a · la familia `bank` ──────────────────────────────────────────
  //
  // Ninguna de estas lleva forma corta, así que estrictamente el auditor no
  // las exigía aquí. Entran igual porque el diccionario existe para que una
  // grafía se decida UNA vez: `bank account edit --clabe` y el
  // `payment dispatch --clabe` de F05b tienen que ser la misma bandera, y el
  // día que alguien le ponga `-c` a una de las dos el auditor lo dirá en vez
  // de dejarlo pasar. Cuatro de ellas —`--type`, `--currency`, `--name`,
  // `--check`— las hablan ya cuatro familias cada una (account, entry,
  // credit-note, cfdi; ledger, ar, close) sin que nadie las hubiera
  // congelado; se congelan ahora, con la forma que ya tenían.
  '--name': null,
  '--type': null,
  '--currency': null,
  '--check': null,
  '--bank': null,
  '--branch': null,
  '--gl-account': null,
  // Los tres identificadores por los que sale el dinero. Su edición exige
  // --reason y nunca se devuelven en claro (051 · cifrado de la CLABE).
  '--clabe': null,
  '--account-number': null,
  '--routing-ach': null,
  '--routing-wire': null,
  '--swift': null,
  '--iban': null,
  '--sat-bank-code': null,
  // `bank account show --redacted`: oculta hasta los últimos 4, para la
  // pantalla que se comparte. No es lo mismo que enmascarar, que es siempre.
  '--redacted': null,
  // Lecturas de despacho: la misma pregunta sobre todas las entidades del
  // inquilino. Sólo lecturas — un alta necesita saber en cuál entidad ocurre.
  '--all-entities': null,
  // `bank statement import --dir`: el directorio del que se toman los
  // archivos, complementario a los posicionales.
  '--dir': null,
  // El saldo final que el operador AFIRMA, cuando el archivo no lo trae (un
  // CSV no tiene saldos). Si el archivo sí lo trae y no coinciden, se rechaza.
  '--closing-balance': null,
  // `bank statement show --lines`: trae las líneas, no sólo la cabecera.
  '--lines': null,

  // ── F05b · los dos lados y el cotejo ──────────────────────────────────
  //
  // Ninguna lleva forma corta. Las que más importa congelar son las tres
  // últimas del bloque de compuertas: `--min-confidence`, `--max-amount` y
  // `--rules-only` las hablan `bank match preview` y `bank match run`, que son
  // deliberadamente DOS hojas —una ✓ y otra ✗— porque el permiso del agente no
  // puede depender del valor de una bandera. Dos hojas que hacen la misma
  // pregunta tienen que hacerla con las mismas palabras, o la mitad de lectura
  // deja de predecir lo que hará la de escritura, que es lo único que la hace
  // valer para algo.
  //
  // `--unmatched`: el estado de cotejo de un movimiento. Es un atajo de
  // `-s unmatched` y no un filtro paralelo; el catálogo lo nombra así.
  '--unmatched': null,
  // Hacia dónde fue el dinero. Es el SIGNO del importe, no `transaction_type`,
  // que dice de qué clase es el movimiento (comisión, interés) y no su sentido.
  '--direction': null,
  // `bank transaction show --raw`: el `raw_data` como lo publicó el banco.
  // Se pide, no se imprime siempre: suele traer nombre y cuenta de la
  // contraparte, y una ficha que lo enseña por omisión es una fuga por
  // pantalla compartida.
  '--raw': null,
  // `bank book-item list --over-days`: antigüedad mínima. Es la bandera que
  // convierte una lista en un hallazgo —el cheque que lleva ochenta días
  // expedido y que el banco nunca mostró—.
  '--over-days': null,
  // `bank match preview --top`: cuántos MOVIMIENTOS previsualizar. No es
  // `--limit` porque no lista filas de una tabla: recorre movimientos y por
  // cada uno consulta candidatos, así que su costo es el del motor y no el de
  // un SELECT. El catálogo lo escribe así en la fila 1224.
  '--top': null,
  '--min-confidence': null,
  '--max-amount': null,
  '--rules-only': null,
  // La sesión de conciliación a la que se liga el cotejo. Sus dos escritores
  // anteriores la dejaban en NULL mientras su único lector filtraba por ella.
  '--session': null,
  // `bank match apply --stdin`: los ids llegan por tubería, que es lo que hace
  // que `bank match preview -q | mnemosine bank match apply --stdin` exista.
  '--stdin': null,
  // Los dos lados de un grupo de cotejo explícito. El catálogo los escribe
  // `--bank` y `--book`; aquí se llaman por el sustantivo de su hoja
  // (`bank transaction list`, `bank book-item list`) porque `--bank` YA
  // significa otra cosa en esta misma familia —la institución, en
  // `bank account create`— y una grafía con dos significados es exactamente lo
  // que este diccionario existe para impedir.
  '--transaction': null,
  '--book-item': null,
  // Un ajuste declarado del grupo: comisión, diferencia cambiaria. Repetible.
  '--adjust': null,
  // Qué se hace con lo que sobra, y contra qué cuenta si se cancela. Los dos
  // van juntos por CHECK en la 052.
  '--residual': null,
  '--write-off-account': null,

  // ── F05c · la sesión de conciliación ──────────────────────────────────
  //
  // Ninguna lleva forma corta. Se congelan aquí por lo mismo que las de F05a y
  // F05b: para que la grafía se decida UNA vez. Tres de ellas ya existían
  // sueltas en otras familias con esta misma escritura (`--file` en `entry
  // create`, `--amount` en `payment`/`ap`, `--resume` en `chat`), así que lo
  // que hace esta entrada es impedir que la próxima sesión les invente una
  // forma corta o una variante.
  '--file': null,
  '--amount': null,
  // El extracto concreto al que se ata la sesión, cuando el periodo tiene más
  // de uno. Es un documento, no un formato: `bank statement` es su familia.
  '--statement': null,
  // La MAGNITUD del residual que un cierre puede absorber. El criterio de si
  // se admite residual vive en el panel (`conciliacion_tolerancia`) y esta
  // bandera NO lo afloja: con `cero_exacto` se rechaza en voz alta. Existe
  // porque el panel fija el criterio y no el número.
  '--tolerance': null,
  // Hasta qué paso llega el pase guiado. Nunca más allá de `estado`: `approve`
  // y `post` no son pasos de un pase automático.
  '--stop-at': null,
  // Continuar donde se detuvo, en vez de abrir otra sesión que explicaría el
  // mismo movimiento dos veces. Convive con el VERBO `resume`·`reanudar`, como
  // `--explain` convive con el verbo `explain`.
  '--resume': null,
  // La partida conciliatoria que un ajuste explica. Se llama por el objeto que
  // nombra —`bank reconciling-item`— y no `--reconciling-item`, que sería la
  // bandera más larga del binario.
  '--item': null,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parsePositiveInt(name: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new InvalidArgumentError(`${name} must be a non-negative whole number; got "${value}".`);
    }
    return n;
  };
}

function parseDate(name: string) {
  return (value: string): string => {
    if (!DATE_RE.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
      throw new InvalidArgumentError(`${name} must be a date as YYYY-MM-DD; got "${value}".`);
    }
    return value;
  };
}

/** Which company to operate on, and as whom. */
export function withContext(cmd: Command): Command {
  return cmd
    .option('-e, --entity <idOrName>', 'legal entity to operate on (defaults to the active one)')
    .option('-t, --tenant <id>', 'tenant (firm) whose data to scope to')
    .option('-u, --user <email>', 'acting user, for attribution and permissions');
}

/**
 * Options merged with those declared on the root program.
 *
 * READ THIS BEFORE USING opts.tenant. The root declares a global
 * `-T, --tenant`, and Commander gives a repeated option to the PARENT: a
 * subcommand that also declares `--tenant` sees `undefined` when the user
 * typed it, and the value silently lands on the program instead.
 *
 * It has been benign so far only because `bootstrapTenant(undefined)` falls
 * back to MNEMOSINE_TENANT — so scoping still happened while the VALUE was
 * lost. Any command that needs the tenant as data (creating an entity,
 * attributing a write, naming the firm in output) must read it from here.
 *
 * The command is the last argument Commander passes to an action:
 *   cmd.action((arg, opts, command) => { const all = globalsOf<Opts>(command); })
 */
export function globalsOf<T>(cmd: Command): T {
  return cmd.optsWithGlobals() as T;
}

/**
 * How results are shaped. `--json` stays as the documented shorthand for
 * `--format json` because it is already typed everywhere; it does not get
 * to mean anything else.
 */
export function withOutput(cmd: Command): Command {
  return cmd
    .option(`--format <${FORMATS.join('|')}>`, 'output format', 'table')
    .option('--json', 'shorthand for --format json')
    .option('-o, --output <path>', 'write to a file instead of stdout')
    .option('--fields [names]', 'comma-separated columns; with no value, lists the available ones')
    .option('-q, --quiet', 'identifiers only, one per line, for piping');
}

/** Which rows to return. Every list command carries these. */
export function withSelection(cmd: Command): Command {
  return cmd
    .option('-n, --limit <n>', 'maximum rows to return', parsePositiveInt('--limit'))
    .option('--offset <n>', 'skip this many rows', parsePositiveInt('--offset'))
    .option('-s, --status <state...>', 'filter by lifecycle state (repeatable)')
    .option('-a, --all', 'no default limit; include archived and closed');
}

/**
 * Which dates the filters mean. `--date-basis` exists because document
 * date, posting date and value date are three different things, and one
 * `--date` flag silently answering for all three is a whole class of
 * wrong answers: accrual cutoff, FX rate selection and tax period
 * assignment each key off a different one.
 */
export function withTime(cmd: Command): Command {
  return cmd
    .option('--period <expr>', 'period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06')
    .option('--since <date>', 'inclusive lower bound (YYYY-MM-DD)', parseDate('--since'))
    .option('--until <date>', 'inclusive upper bound (YYYY-MM-DD)', parseDate('--until'))
    .option('--as-of <date>', 'valuation/balance date (YYYY-MM-DD)', parseDate('--as-of'))
    .option(
      '--date-basis <document|posting|value>',
      'which date the filters apply to',
      'posting'
    );
}

/** For `check`-style diagnostics: warnings become failures on demand. */
export function withStrict(cmd: Command): Command {
  return cmd.option('--strict', 'treat warnings as blocking (exit 4)');
}

/** Overriding a hard validation is separate from skipping a prompt. */
export function withForce(cmd: Command): Command {
  return cmd.option(
    '--force',
    'override a blocking validation (closed period, lock date, duplicate); requires --reason'
  );
}

/** A free annotation. Never a justification — that is --reason. */
export function withNote(cmd: Command): Command {
  return cmd.option('--note <text>', 'free annotation stored with the record');
}

/** Convenience for the common read command: context + time + selection + output. */
export function withReadFlags(cmd: Command): Command {
  return withOutput(withSelection(withTime(withContext(cmd))));
}
