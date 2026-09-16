import type { Command } from 'commander';
import type { TranslationKey } from '../../i18n/index.js';
import { ExitCode } from './exit.js';
import { CliError } from './cli-error.js';
import { optionByKey } from './help.js';

// ============================================================
// RISK DECLARATION — one central mechanism (rulebook R11)
//
// Every mutating command declares its risk class ONCE, here, and
// that declaration drives four things at once:
//   1. which safety flags the command is required to carry,
//   2. how strong the confirmation is,
//   3. what the audit record says,
//   4. whether the LLM agent may invoke it.
//
// The load-bearing rule is (4), and the reason it lives in code
// rather than in a review checklist:
//
//   THE AGENT'S PERMISSION MUST NEVER DEPEND ON THE VALUE OF A
//   FLAG.
//
// If `year close --generate` were allowed and `year close --seal`
// forbidden, then permission would be a property of how the
// command was invoked — unknowable at registration time and
// unenforceable anywhere. Such a command must be split into two
// commands with two declarations. `declareRisk` refuses the
// alternative: marking an irreversible or external command as
// agent-invocable throws at startup, so the mistake cannot ship.
// ============================================================

/**
 * The four risk classes, matching the catalog's vocabulary exactly
 * (docs/cli-command-catalog.md), so a row in the catalog and a
 * command in the code cannot drift apart.
 */
export type Risk =
  /** Reads only. No row anywhere changes. */
  | 'lectura'
  /** Writes something reversible: a draft, a master-data field, a config value. */
  | 'escritura'
  /** Posts to the ledger, deletes, or otherwise cannot be undone by re-running. */
  | 'irreversible'
  /** Has an effect outside this system: a PAC, the SAT, a bank, an email. */
  | 'externo';

export interface RiskDeclaration {
  risk: Risk;
  /**
   * True only when the LLM agent may invoke this command autonomously.
   * Permitted for `lectura` always, and for `escritura` only together
   * with `draftOnly`, because the single guarantee the agent's whole
   * design rests on is that it proposes and a human disposes.
   */
  agent?: boolean;
  /**
   * Required to pair with `agent` on an `escritura` command: asserts
   * that every write this command performs lands in a review queue
   * (ai_drafts / ai_questions / ai_external_ops), never in the ledger.
   */
  draftOnly?: boolean;
  /** Human-readable summary of what it writes, for the audit record. */
  writes?: string;
  /**
   * QUÉ HACE ESTA HOJA CON `--idempotency-key`.
   *
   * El núcleo inyecta la bandera en toda hoja irreversible o externa y su
   * ayuda PROMETE, con estas palabras, que «a retry with the same key and
   * payload returns the recorded result». Hasta hoy la promesa la hacía la
   * inyección y la cumplía —o no— cada manejador por su cuenta: 36 hojas la
   * aceptaban, 15 la honraban, y las 21 restantes duplicaban dinero en un
   * reintento sin que nada lo dijera.
   *
   * Por eso la declaración ahora TIENE QUE DECIDIRLO, y no hay opción por
   * omisión que sea silenciosa:
   *
   *   · `{ scope: 'receipt record' }` — la honra. El manejador entrega la
   *     llave a `conLlave` bajo ESE ámbito, que es su identidad en
   *     `idempotency_keys`; por eso R11 exige que dos hojas no lo compartan
   *     (compartirlo las deduplicaría ENTRE SÍ) y la prueba de
   *     tests/cli/kernel/llave-honrada.spec.ts exige que el ámbito aparezca
   *     de verdad en una llamada al almacén — un texto que ninguna inyección
   *     puede fabricar.
   *
   *   · `{ sinLlave: '<motivo>' }` — NO la honra. La bandera se sigue
   *     declarando (retirarla rompería guiones publicados) pero su ayuda dice
   *     la verdad y PASARLA FALLA con salida 2, en vez de aceptar la llave y
   *     escribir dos veces. R11 la acusa además con una violación por hoja,
   *     congelada en la línea base: la lista sólo puede encoger.
   */
  llave?: Llave;
}

/**
 * Las tres únicas respuestas posibles a «¿qué haces con la llave?».
 *
 * Son tres y no dos porque hay tres situaciones REALES, y meter la tercera en
 * el saco de la segunda hacía que la ayuda publicara lo contrario de lo que el
 * código hacía: siete hojas —`review`, `ingest`, `outbox run`,
 * `subscription delivery sweep`, `bill approve`, `sat cred add` y
 * `sat cred revoke`— YA eran idempotentes por su dominio y lo explicaban por
 * escrito en un aviso propio, y declararlas `{ sinLlave }` les habría dicho a
 * sus operadores «un reintento vuelve a escribir» cuando su propio fuente dice
 * que no.
 */
export type Llave =
  /** La honra bajo este ámbito, que es su identidad en `idempotency_keys`. */
  | { scope: string }
  /**
   * NO LA NECESITA: el dominio ya deduplica por sí mismo —el estado de la
   * factura y su `journal_entry_id`, el UUID del CFDI, el `X-Webhook-ID` de
   * cada entrega, la ausencia de credencial activa tras revocar—. La bandera
   * SIGUE FUNCIONANDO (no rompe el guion que ya la pasa) y no miente: la ayuda
   * dice que no hace falta y por qué.
   */
  | { innecesaria: string }
  /**
   * NO LA HONRA y un reintento SÍ vuelve a escribir. La bandera se acepta
   * —retirarla rompería guiones publicados— pero pasarla FALLA, porque quien
   * la pasaba se creía protegido y no lo estaba.
   */
  | { sinLlave: string };

/** El ámbito bajo el que esta hoja consuma la llave, si la honra. */
export function ambitoDeLlave(cmd: Command): string | undefined {
  const llave = REGISTRY.get(cmd)?.llave;
  return llave && 'scope' in llave ? llave.scope : undefined;
}

/**
 * La ruta completa de la hoja, subiendo por sus padres.
 *
 * El mensaje de negativa decía `cmd.name()`, o sea el nombre suelto: «add»,
 * «apply», «run-due». Hay más de una hoja llamada `apply`, así que el error no
 * decía CUÁL se negó — y un error que no nombra su comando obliga a adivinar
 * justo cuando el operador ya está desconcertado.
 */
function rutaDeLaHoja(cmd: Command): string {
  const partes: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) {
    const nombre = c.name();
    if (nombre) partes.unshift(nombre);
  }
  return partes.join(' ');
}

export interface ResolvedRisk extends RiskDeclaration {
  /** Final, enforced answer to "may the agent call this?". */
  agentAllowed: boolean;
  /** Irreversible and external commands must be able to show their effect first. */
  requiresDryRun: boolean;
  /** External effects are opt-in: the default endpoint is the sandbox. */
  requiresLiveGate: boolean;
  /** Mutations at this level must carry a client dedupe key. */
  requiresIdempotencyKey: boolean;
}

const REGISTRY = new Map<Command, ResolvedRisk>();

/** Verbs whose whole point is undoing or overriding something: they must be justified. */
const REASON_VERBS = new Set([
  'reverse', 'void', 'reopen', 'unlock', 'cancel', 'reject', 'archive', 'revoke', 'delete',
]);

function lastToken(cmd: Command): string {
  const parts = cmd.name().trim().split(/\s+/);
  return parts[parts.length - 1] ?? '';
}

/**
 * Declares a command's risk and applies every flag that class requires.
 * Throws at registration time — i.e. at process startup, before any
 * user input exists — when a declaration is unsafe.
 */
export function declareRisk(cmd: Command, decl: RiskDeclaration): Command {
  const { risk, agent = false, draftOnly = false } = decl;

  if (agent && (risk === 'irreversible' || risk === 'externo')) {
    throw new Error(
      `Command "${cmd.name()}" declares risk "${risk}" and agent access at the same time. ` +
        'The agent may never post to the ledger, move money, stamp, cancel, file with an ' +
        'authority, delete, or reach a third party with a client credential. If part of this ' +
        'command is genuinely safe, split it into two commands with two declarations — ' +
        'permission must never depend on the value of a flag.'
    );
  }
  if (agent && risk === 'escritura' && !draftOnly) {
    throw new Error(
      `Command "${cmd.name()}" grants the agent a write without asserting draftOnly. ` +
        'An agent-invocable write must land in a review queue, not in the ledger. ' +
        'Set draftOnly: true if that is true of every path through this command; otherwise agent: false.'
    );
  }

  const resolved: ResolvedRisk = {
    ...decl,
    agent,
    draftOnly,
    agentAllowed: agent,
    requiresDryRun: risk === 'irreversible' || risk === 'externo',
    requiresLiveGate: risk === 'externo',
    requiresIdempotencyKey: risk === 'irreversible' || risk === 'externo',
  };

  // La inyección es IDEMPOTENTE: un comando que ya definió su propia
  // `--dry-run` —`onboard` la tiene desde antes de que existiera el núcleo—
  // no debe chocar al declararse. Sin esta guarda, retrofitar las
  // declaraciones que faltaban rompía el arranque en el primer comando que ya
  // llevara la bandera, y el fallo aparecía como un error de Commander sin
  // relación aparente con la declaración.
  const yaTiene = (largo: string): boolean =>
    cmd.options.some((o) => o.long === largo);
  // I7 · La bandera se declara con su GRAFÍA y una CLAVE. La grafía es contrato
  // de máquina y no se traduce; la frase que la explica sale del catálogo, y en
  // el objeto de Commander queda su inglés (`optionByKey` → `englishOf`), que es
  // lo que sigue leyendo el censo de `scripts/ux-status.ts`.
  const anadir = (flags: string, key: TranslationKey): void => {
    const largo = flags.split(/[ ,]/).find((t) => t.startsWith('--'));
    if (largo && yaTiene(largo)) return;
    optionByKey(cmd, flags, key);
  };

  /**
   * LA BANDERA QUE MIENTE SE NIEGA A FUNCIONAR.
   *
   * Una hoja declarada `{ sinLlave }` sigue ACEPTANDO `--idempotency-key`
   * —retirarla de 21 comandos publicados rompería guiones que ya la pasan—
   * pero deja de fingir: la ayuda dice que no la honra y el parser de
   * Commander, que corre ANTES de la acción y por tanto antes de cualquier
   * escritura, aborta con el contrato de USAGE. Fallar es estrictamente
   * mejor que aceptar la llave y escribir dos veces: quien la pasaba creía
   * estar protegido y no lo estaba.
   */
  const anadirLlaveQueMiente = (): void => {
    // La ayuda va SIN EL MOTIVO, y eso no cambió en I7: el motivo es distinto
    // en cada hoja `{ sinLlave }` y viaja en el error de `gateMutation`, que es
    // quien lo tiene delante. Lo que sí cambió es el idioma: la frase se guarda
    // en inglés en el objeto de Commander —lo que sigue leyendo el censo de
    // `scripts/ux-status.ts`, que cuenta como defecto toda prosa de ayuda fuera
    // del inglés— y se rinde traducida al imprimir la ayuda.
    //
    // EL RECHAZO NO VIVE AQUÍ. Estuvo en el `parseArg` de esta opción, que
    // corre mientras Commander aún no ha terminado de leer la línea: allí no se
    // sabe si además vino `--dry-run`, así que reventaba también el ENSAYO —y
    // un ensayo no escribe nada, de modo que negárselo al operador cuyo guion
    // ya trae la llave escrita es coste sin beneficio—. Vive en `gateMutation`,
    // que ve las opciones ya resueltas, sigue corriendo antes de cualquier
    // escritura, y es el sitio donde este repo falla cerrado.
    anadir('--idempotency-key <key>', 'cli.flag.idempotency_key_unhonored');
  };

  /** La bandera funciona, y la ayuda dice por qué no hace falta. */
  const anadirLlaveInnecesaria = (): void => {
    anadir('--idempotency-key <key>', 'cli.flag.idempotency_key_unneeded');
  };

  if (resolved.requiresDryRun) {
    anadir('--dry-run', 'cli.flag.dry_run');
    anadir('-y, --yes', 'cli.flag.yes');
    if (decl.llave && 'sinLlave' in decl.llave) {
      anadirLlaveQueMiente();
    } else if (decl.llave && 'innecesaria' in decl.llave) {
      anadirLlaveInnecesaria();
    } else {
      anadir('--idempotency-key <key>', 'cli.flag.idempotency_key');
    }
  }
  if (resolved.requiresLiveGate) {
    anadir('--live', 'cli.flag.live');
  }
  if (REASON_VERBS.has(lastToken(cmd))) {
    anadir('--reason <text>', 'cli.flag.reason');
  }

  REGISTRY.set(cmd, resolved);
  return cmd;
}

export function riskOf(cmd: Command): ResolvedRisk | undefined {
  return REGISTRY.get(cmd);
}

/** Every declaration made in this process, for the consistency test and the agent bridge. */
export function allDeclarations(): Array<{ command: Command; risk: ResolvedRisk }> {
  return [...REGISTRY.entries()].map(([command, risk]) => ({ command, risk }));
}

/** Test seam: drop every declaration so a suite can register a fresh program. */
export function resetDeclarations(): void {
  REGISTRY.clear();
}

/**
 * Enforces at call time what the declaration promised: a `--force` or an
 * undo verb needs a reason, and an external effect without `--live` stays
 * in the sandbox. Returns the effective mode so the handler can branch once.
 */
export function gateMutation(
  cmd: Command,
  opts: Record<string, unknown>
): { dryRun: boolean; live: boolean; reason?: string } {
  const resolved = riskOf(cmd);

  // FALLA CERRADO.
  //
  // Antes la única comprobación de esta función iba guardada por
  // `if (resolved && …)`, así que una hoja sin declaración no exigía nada:
  // atravesaba la compuerta entera sin que nada la mirase. Como además 49 de
  // las 106 hojas no declaraban, la compuerta era un no-op para casi la mitad
  // del binario — y peor, la costura de pruebas `resetDeclarations()` vaciaba
  // el registro, de modo que dentro de una suite TODO el binario quedaba sin
  // compuerta y las pruebas pasaban en ese estado.
  //
  // Un comando que llama a `gateMutation` está diciendo que muta. Si no
  // declaró su riesgo, lo correcto no es dejarlo pasar sino romper: el fallo
  // aparece en el primer uso, no en la primera auditoría.
  // LA LLAVE QUE MIENTE SE NIEGA AQUÍ, con las opciones ya resueltas.
  //
  // Una hoja `{ sinLlave }` acepta la bandera —retirarla de comandos publicados
  // rompería guiones que ya la pasan— pero pasarla FALLA, porque quien la
  // pasaba se creía protegido y no lo estaba. Fallar es estrictamente mejor que
  // fingir.
  //
  // Y NO SE NIEGA EL ENSAYO. `--dry-run` no escribe, así que negárselo al
  // operador cuyo guion ya trae la llave escrita es coste sin beneficio: le
  // impediría incluso mirar qué haría el comando. Ésta es la razón de que el
  // rechazo viva aquí y no en el `parseArg` de la opción, donde Commander
  // todavía no sabe si vino `--dry-run`. Sigue corriendo antes de cualquier
  // escritura.
  const llaveDeclarada = REGISTRY.get(cmd)?.llave;
  const clavePasada = typeof opts.idempotencyKey === 'string' ? opts.idempotencyKey.trim() : '';
  if (llaveDeclarada && 'sinLlave' in llaveDeclarada && clavePasada !== '' && opts.dryRun !== true) {
    throw new CliError(
      {
        key: 'cli.risk.key_not_honored',
        params: {
          command: rutaDeLaHoja(cmd),
          reason: llaveDeclarada.sinLlave,
          key: clavePasada,
        },
      },
      ExitCode.USAGE
    );
  }

  if (!resolved) {
    throw new CliError(
      { key: 'cli.risk.undeclared', params: { command: cmd.name() } },
      ExitCode.USAGE
    );
  }

  const dryRun = opts.dryRun === true;
  const live = opts.live === true;
  const reason = typeof opts.reason === 'string' ? opts.reason : undefined;

  if (opts.force === true && !reason) {
    throw new CliError({ key: 'cli.risk.force_needs_reason' }, ExitCode.USAGE);
  }
  if (REASON_VERBS.has(lastToken(cmd)) && !reason && !dryRun) {
    throw new CliError(
      { key: 'cli.risk.undo_needs_reason', params: { command: cmd.name() } },
      ExitCode.USAGE
    );
  }
  return { dryRun, live, reason };
}
