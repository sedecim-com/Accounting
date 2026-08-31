import type { Command } from 'commander';
import { VERBS, isVerb, OBJECTLESS_COMMANDS, LEGACY_PLURALS } from './vocabulary.js';
import { FLAG_DICTIONARY, BANNED_FLAGS } from './flags.js';
import { riskOf } from './risk.js';

// ============================================================
// LA AUDITORÍA DE CONSISTENCIA, EN PRODUCCIÓN (regla R12).
//
// Es lo único que mantendrá coherentes 1.700 comandos mientras muchas
// sesiones los editan: recorre un programa de Commander y afirma las reglas
// que hacen la superficie aprendible — que todo verbo salga de la lista
// cerrada, que toda bandera salga del diccionario único, que ninguna grafía
// prohibida reaparezca, que los sustantivos sean singulares, que la
// profundidad no pase de tres, que un comando que muta lleve las banderas que
// su riesgo exige, y que un listado se pueda paginar y formatear.
//
// VIVÍA EN UN `.spec.ts`, y eso tenía tres consecuencias invisibles.
//
// La primera: el binario que se embarca no pasaba por ella. Cada prueba se
// construía un programa de juguete; el `program` real —106 hojas— no lo
// auditaba nadie. Ejecutada contra él por primera vez, 40 violaciones.
//
// La segunda, peor: importar `auditProgram` desde el spec arrastra la suite
// del spec, y sus pruebas llaman a `resetDeclarations()`. El registro de
// riesgo se indexa por la IDENTIDAD del objeto `Command` y se puebla una sola
// vez al importar `mnemosine.ts`, así que un reset lo deja vacío para el resto
// del proceso: medido, el binario pasaba de 57 declaraciones a 1 y ninguna de
// sus hojas resolvía riesgo. Cualquier prueba que lo importara auditaba un
// programa sin declaraciones y sus comprobaciones pasaban en el vacío.
//
// La tercera: un fichero de pruebas no puede ser destino de importación de
// producción, así que `doctor` no podía correr esta auditoría aunque quisiera.
// ============================================================


export interface Violation {
  command: string;
  rule: string;
  detail: string;
}

const SHORT_FLAG_RE = /^-([a-zA-Z])\b/;

function pathOf(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | null = cmd; c && c.parent; c = c.parent) parts.unshift(c.name());
  return parts.join(' ');
}

export function auditProgram(program: Command): Violation[] {
  const violations: Violation[] = [];
  const shortFlags = new Map<string, string>();

  const visit = (cmd: Command) => {
    const children = cmd.commands ?? [];
    const full = pathOf(cmd);
    if (full) {
      const tokens = full.split(' ');

      // R1: depth
      if (tokens.length > 3) {
        violations.push({ command: full, rule: 'R1 depth', detail: `${tokens.length} tokens; max is 3` });
      }

      // R3/R4: leaf commands end in a verb from the closed list.
      const isLeaf = children.length === 0;
      const last = tokens[tokens.length - 1];
      if (isLeaf && tokens.length > 1 && !isVerb(last)) {
        violations.push({
          command: full,
          rule: 'R3 closed verb list',
          detail: `"${last}" is not a verb in the registry. Use one of the ${Object.keys(VERBS).length} canonical verbs, or add it to vocabulary.ts deliberately.`,
        });
      }
      if (isLeaf && tokens.length === 1 && !OBJECTLESS_COMMANDS.includes(last)) {
        violations.push({
          command: full,
          rule: 'R1 objectless allowlist',
          detail: `"${last}" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.`,
        });
      }

      // R2: nouns are singular.
      const noun = tokens[0];
      if (noun.endsWith('s') && !isVerb(noun) && !LEGACY_PLURALS.includes(noun) && !OBJECTLESS_COMMANDS.includes(noun)) {
        violations.push({ command: full, rule: 'R2 singular nouns', detail: `"${noun}" looks plural` });
      }

      // R6: flags come from the dictionary; banned spellings never reappear.
      for (const opt of cmd.options) {
        const long = opt.long ?? '';
        const negated = long.startsWith('--no-') ? long : null;
        if ((BANNED_FLAGS as readonly string[]).includes(long)) {
          violations.push({ command: full, rule: 'R6 banned spelling', detail: `${long} is banned` });
          continue;
        }
        // Command-specific value flags are allowed; the dictionary governs
        // the shared vocabulary, so only flags whose CONCEPT it defines are
        // checked for spelling and short-form drift.
        if (long && Object.prototype.hasOwnProperty.call(FLAG_DICTIONARY, long)) {
          const expectedShort = FLAG_DICTIONARY[long];
          if ((opt.short ?? null) !== expectedShort) {
            violations.push({
              command: full,
              rule: 'R6 short flag',
              detail: `${long} should use ${expectedShort ?? 'no short form'}, found ${opt.short ?? 'none'}`,
            });
          }
        }
        if (opt.short && !negated) {
          const letter = SHORT_FLAG_RE.exec(opt.short)?.[1];
          if (letter === 'f') {
            violations.push({ command: full, rule: 'R6 -f is reserved', detail: `${long} claims -f` });
          }
          const key = `${full}|${opt.short}`;
          if (shortFlags.has(key)) {
            violations.push({ command: full, rule: 'R6 short flag collision', detail: opt.short });
          }
          shortFlags.set(key, long);
        }
      }

      const longs = new Set(cmd.options.map((o) => o.long));

      // R11: a declared mutation carries the flags its risk class requires.
      const risk = riskOf(cmd);
      if (risk?.requiresDryRun) {
        for (const required of ['--dry-run', '--yes', '--idempotency-key']) {
          if (!longs.has(required)) {
            violations.push({
              command: full,
              rule: 'R11 risk flags',
              detail: `risk "${risk.risk}" requires ${required}`,
            });
          }
        }
      }
      if (risk?.requiresLiveGate && !longs.has('--live')) {
        violations.push({ command: full, rule: 'R11 live gate', detail: 'external effects require --live' });
      }

      // Every list command must be pageable and formattable, or it will
      // silently truncate someone's financial statement one day.
      if (isLeaf && last === 'list') {
        for (const required of ['--limit', '--format']) {
          if (!longs.has(required)) {
            violations.push({ command: full, rule: 'list contract', detail: `missing ${required}` });
          }
        }
      }
    }
    for (const child of children) visit(child);
  };

  visit(program);
  return violations;
}


// ============================================================
// LA LÍNEA BASE: LO QUE YA ESTABA MAL EL DÍA QUE ESTO SE ENCENDIÓ.
//
// El binario que se embarca nunca había pasado por la auditoría, y al hacerlo
// por primera vez dio 40 violaciones. Arreglarlas no es mecánico: nueve son
// decisiones de nombre una por una, tres exigen retirar una forma corta ya
// publicada —lo que rompe guiones de terceros— y ocho piden migrar cuatro
// manejadores que imprimen a mano para que su listado se pueda paginar.
//
// Bloquear con las 40 dentro no es una opción: nadie enciende una puerta que
// deja el repositorio en rojo, y la puerta acabaría desactivada. Ignorarlas
// tampoco: entonces la auditoría no diría nada.
//
// Así que se congelan. La puerta falla ante cualquier violación que NO esté
// aquí, y la lista sólo puede ENCOGER: una entrada que ya no se viola es una
// entrada muerta y la prueba la reporta, de modo que arreglar algo obliga a
// borrar su línea. No hay forma de que crezca sin que alguien lo escriba a
// mano y quede en el diff.
// ============================================================

/**
 * Clave estable de una violación.
 *
 * Los dígitos se normalizan porque algunos detalles citan cuentas que cambian
 * —«uno de los 77 verbos canónicos»— y una línea base que se invalida al
 * añadir un verbo obliga a regenerarla por una razón que no es la suya.
 */
export function claveDeViolacion(v: Violation): string {
  // Sin truncado. La primera versión cortaba a 40 caracteres y el corte caía
  // JUSTO antes del valor en los detalles de forma corta («--note should use
  // no short form, found » mide 39), así que cualquier forma corta nueva de
  // la misma bandera colapsaba con la heredada y pasaba la puerta como deuda
  // vieja. El truncado no protegía nada: la estabilidad ante conteos ya la da
  // el reemplazo de dígitos.
  return `${v.command}|${v.rule}|${v.detail.replace(/\d+/g, '#')}`;
}

export const LINEA_BASE: readonly string[] = [
  'entities|R1 objectless allowlist|"entities" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'providers|R1 objectless allowlist|"providers" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'sessions|R1 objectless allowlist|"sessions" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'drafts|R1 objectless allowlist|"drafts" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'onboard|R6 banned spelling|--from is banned',
  'outbox|R1 objectless allowlist|"outbox" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'questions|R1 objectless allowlist|"questions" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'sat cred audit|R3 closed verb list|"audit" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'pending define|R3 closed verb list|"define" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'pending define|R6 short flag|--note should use no short form, found -n',
  'pending dismiss|R6 short flag|--note should use no short form, found -n',
  'memory|R6 short flag|--all should use -a, found none',
  'memory teach|R3 closed verb list|"teach" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'memory retire|R3 closed verb list|"retire" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'prompt-size|R1 objectless allowlist|"prompt-size" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'compact|R1 objectless allowlist|"compact" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'approvals list|R6 short flag|--all should use -a, found none',
  'approvals list|list contract|missing --limit',
  'approvals list|list contract|missing --format',
  'approvals grant|R6 short flag|--provider should use -p, found none',
  'account deactivate|R3 closed verb list|"deactivate" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'usage|R1 objectless allowlist|"usage" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.',
  'status|R6 short flag|--all should use -a, found none',
  'jobs list|list contract|missing --limit',
  'jobs list|list contract|missing --format',
  'jobs create|R6 short flag|--user should use -u, found none',
  'jobs run-due|R3 closed verb list|"run-due" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'jobs history|R6 short flag|--limit should use -n, found none',
  'skills list|list contract|missing --limit',
  'skills list|list contract|missing --format',
  'skills drafts|R3 closed verb list|"drafts" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'skills view|R3 closed verb list|"view" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'webhooks list|list contract|missing --limit',
  'webhooks list|list contract|missing --format',
  'webhooks deliveries|R3 closed verb list|"deliveries" is not a verb in the registry. Use one of the # canonical verbs, or add it to vocabulary.ts deliberately.',
  'init|R6 short flag|--status should use -s, found none',
  'init|R6 short flag|--entity should use -e, found none',
  'init|R6 short flag|--provider should use -p, found none',
  'init|R6 short flag|--model should use -m, found none',
  'close|R6 short flag|--period should use no short form, found -p',
];

export interface ResultadoAuditoria {
  /** Violaciones que no estaban en la línea base. La puerta falla si hay alguna. */
  nuevas: Violation[];
  /** Entradas de la línea base que ya no se violan: hay que borrarlas. */
  obsoletas: string[];
  /** Cuántas de la línea base siguen vivas. */
  heredadas: number;
}

/**
 * Audita el programa contra la línea base.
 *
 * Lo que importa para la puerta es `nuevas`. `obsoletas` es lo que hace que la
 * lista encoja: no rompe la puerta —arreglar algo no debe romper a nadie— pero
 * sí la prueba, que es donde se recuerda borrar la línea.
 */
export function auditarContraLineaBase(program: Command): ResultadoAuditoria {
  const vs = auditProgram(program);
  const base = new Set(LINEA_BASE);
  const vivas = new Set<string>();
  const nuevas: Violation[] = [];
  for (const v of vs) {
    const k = claveDeViolacion(v);
    if (base.has(k)) vivas.add(k);
    else nuevas.push(v);
  }
  return {
    nuevas,
    obsoletas: [...base].filter((k) => !vivas.has(k)),
    heredadas: vivas.size,
  };
}
