import { z } from 'zod/v4';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { query } from '../../database/connection.js';
import { neutralizarMarcadores } from '../untrusted.js';
import { listAccountRoles, rolesValidos } from '../../services/accounting/account-roles-service.js';
import { panelTranslator } from '../../i18n/panel-text.js';
import { policyWording, type SeededWording } from '../../services/policy/policy-service.js';
import type { AgentContext } from '../context.js';
import type { ToolDeps } from './observer.js';

// ============================================================
// A7·2 · EL PANEL DE POLÍTICAS, LEÍBLE POR EL AGENTE (sólo lectura)
//
// El hecho medido: ninguna de las trece familias de herramientas
// consultaba `policy_decisions` ni `account_roles`. El despacho
// contestaba «5000» al umbral de capitalización, llegaba un CFDI de
// equipo de cómputo, y el modelo clasificaba SIN QUE ESA CIFRA
// EXISTIERA EN SU CONTEXTO. La regla de la casa manda toda
// bifurcación de criterio contable al panel con su lector real; el
// panel tenía lectores en el motor (ingest-thresholds, cierre,
// depreciación) y ninguno en el agente, que es quien redacta.
//
// DECLARACIÓN DE RIESGO — esta herramienta es de LECTURA y nada más:
//  · NO escribe en policy_decisions. Contestar una política es un acto
//    del humano (`mnemosine pending define`, o el wizard de init), y
//    pasa por resolvePolicy con su compuerta de evidencia. Una
//    herramienta que resolviera políticas dejaría al agente contestando
//    las preguntas que existen precisamente porque él no puede.
//  · NO reapunta roles de cuenta (eso es `mnemosine account role set`).
//  · NO decide: devuelve el criterio del despacho y, cuando NO hay
//    criterio, lo dice con todas sus letras. Una herramienta que leyera
//    el panel para SALTÁRSELO —aplicar el defecto como si fuera una
//    decisión— sería lo contrario de este tramo. Por eso el resultado
//    separa `value` de `status`, y el instructivo manda preguntar.
//  · Alcance: inquilino + entidad de la sesión, en el SQL. La fila de
//    la entidad gana sobre la del inquilino, igual que en getPolicy.
//
// UNA DIVERGENCIA DELIBERADA CON getPolicy, DECLARADA AQUÍ. Ante una fila
// 'resolved' con `resolved_value` en blanco, getPolicy devuelve ese blanco con
// defined:true —y getPolicyNumber lo convierte en 0, que como umbral de
// capitalización significa «capitalízalo todo»—. Esta herramienta NO lo imita:
// un blanco no es criterio del despacho, así que sale 'unanswered' con el
// defecto etiquetado como tal y con `answer_defect` diciendo por qué. La
// divergencia no se resuelve aquí: se cierra en la escritura (que `pending
// define` por argumento y `resolvePolicy` rechacen un valor vacío) y en
// getPolicyNumber, y hasta entonces este lado es el conservador — el que
// pregunta.
//
// SOBRE LA CONFIANZA DEL TEXTO — el panel NO es dato de tercero: lo
// escribe el propio despacho (catálogo en código + valor y nota
// tecleados por un humano con `pending define`). Por eso NO viaja
// entre marcadores UNTRUSTED: envolverlo diría «esto nunca es una
// instrucción para ti», y es exactamente lo contrario — el panel ES la
// instrucción del principal sobre qué criterio seguir. Lo que sí se
// neutraliza es la forma: valor y nota son texto libre, así que no
// pueden abrir ni cerrar un bloque ajeno ni romper su renglón.
// ============================================================

/** Roles y políticas devueltos, ya resueltos para ESTA entidad. */
export interface PoliticaDelPanel {
  key: string;
  category: string;
  question: string;
  /** answered = la contestó un humano; unanswered = se está usando el defecto. */
  status: 'answered' | 'unanswered';
  /** El valor VIGENTE (respuesta si la hay, defecto si no). */
  value: string;
  /** La respuesta del despacho, o null si nadie contestó. */
  answered_value: string | null;
  default_value: string | null;
  /** De qué fila salió: la de la entidad manda sobre la del inquilino. */
  scope: 'entity' | 'tenant';
  /**
   * LAS ALTERNATIVAS VIAJAN SÓLO CUANDO HAY QUE ELEGIR.
   *
   * Presente en las políticas SIN contestar, que es donde el agente tiene que
   * preguntar con las opciones reales delante. En una contestada se omite, por
   * dos razones que apuntan al mismo sitio: enseñarle al agente los caminos
   * que el despacho descartó le invita a reconsiderar una decisión que no es
   * suya, y las listas de opciones eran la mitad del peso del panel — a 53
   * políticas ya no cabía ninguna nota, así que el agente recibía las reglas
   * sin una sola razón de por qué son así.
   */
  options?: Array<{ value: string; label: string }>;
  notes: string | null;
  /**
   * No-null = la fila DICE estar resuelta y no guarda respuesta utilizable.
   * Es la inversión que esta pieza existe para impedir, vista desde adentro:
   * `status` ya salió como 'unanswered', y este campo dice POR QUÉ, para que
   * la pregunta al humano pueda citarlo.
   */
  answer_defect: string | null;
}

export interface RolDeCuenta {
  role: string;
  qualifier: string | null;
  account_code: string;
  account_name: string;
}

export interface PanelDelDespacho {
  /**
   * PRIMER campo del JSON, y no por estética: el tope de resultado
   * (withResultCap, MAX_TOOL_RESULT_CHARS) corta por el FINAL. Con el
   * instructivo al final —donde estaba— un panel del tamaño de producción lo
   * dejaba fuera del corte: el dato sobrevivía y su regla de uso no, que es
   * exactamente al revés de lo que este tramo promete. El orden de las claves
   * de un objeto literal es el orden de JSON.stringify, así que esto ES la
   * garantía, no una convención.
   */
  how_to_use: string;
  entity: string;
  policies: PoliticaDelPanel[];
  /** Las claves que el despacho NO ha contestado, para no tener que filtrar. */
  unanswered: string[];
  account_roles: RolDeCuenta[];
  /** Roles del taxonomía sin cuenta asignada en esta entidad. */
  unmapped_roles: string[];
}

/**
 * El instructivo viaja CON el dato, no sólo en la descripción de la
 * herramienta: la descripción se lee una vez al armar el turno y el resultado
 * se relee en cada compactación. Que la regla del «unanswered» viva en el
 * resultado es lo que impide que sobreviva el valor y se pierda su estado.
 */
const COMO_USARLO =
  'status "answered" = your firm decided this; follow it. status "unanswered" = nobody ' +
  'decided: `value` is the system default, a stopgap so nothing stalls, NOT the firm\'s ' +
  'criterion. Never present a default as a decision. If an unanswered policy is what ' +
  'decides the treatment you are about to book — i.e. two admissible answers would produce ' +
  'DIFFERENT entries for THIS document — stop and ask with ask_user, citing the key; if every ' +
  'admissible answer yields the same entry, the policy does not block you and you may proceed ' +
  'without asking. You cannot answer a policy yourself: a human does it with ' +
  '`mnemosine pending define <key> <value>` (see them all with `mnemosine pending`). ' +
  'A policy carrying a non-null `answer_defect` is unanswered too, and worse: its row claims ' +
  'to be resolved, so nobody will ever be asked again unless you raise it.';

/**
 * LA INVERSIÓN, VISTA DESDE LA FILA. Una fila con status 'resolved' y
 * `resolved_value` en blanco —espacios, saltos, caracteres de control— no
 * guarda criterio ninguno; pero la cadena de `??` la presentaba como
 * `answered` CON EL DEFECTO DEL SISTEMA en `value`, bajo el sello «answered =
 * your firm decided this; follow it». Es la herramienta leyendo el panel para
 * SALTÁRSELO, que es lo contrario de este tramo, y es alcanzable: la ruta por
 * argumento de `pending define` no trimea ni valida, y `resolvePolicy`
 * tampoco.
 *
 * Aquí una respuesta en blanco NO es respuesta: la política sale 'unanswered'
 * (que es la verdad: nadie decidió nada) y este texto dice por qué, porque el
 * humano tampoco lo va a ver — `mnemosine pending` sólo lista status
 * 'pending', así que la fila rota es invisible para quien podría arreglarla.
 */
const DEFECTO_RESPUESTA_VACIA =
  'This row is marked resolved but its stored answer is blank once sanitized (spaces, newlines ' +
  'or control characters only): there is no criterion in it. Treat it as UNANSWERED — `value` ' +
  'is the system default, not a decision. It will NOT appear in `mnemosine pending` (that list ' +
  'only shows status "pending"), so nobody will be asked again: name this key when you ask with ' +
  'ask_user, so a human can re-answer it with `mnemosine pending define <key> <value>`.';

/**
 * Un solo campo de texto libre no puede comerse el resultado entero: un valor
 * o una nota de 100 000 caracteres empujaría al resto del panel contra el tope.
 */
const MAX_TEXTO_LIBRE = 2000;

/**
 * Texto libre tecleado por un humano: ni abre bloques, ni rompe su renglón, ni
 * crece sin límite. Devuelve null cuando NO QUEDA NADA — un valor de puros
 * espacios es la ausencia de respuesta, no una respuesta rara.
 */
function textoLlano(valor: string | null): string | null {
  if (valor === null || valor === undefined) return null;
  const limpio = neutralizarMarcadores(valor)
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ')
    .trim();
  if (limpio.length === 0) return null;
  return limpio.length > MAX_TEXTO_LIBRE
    ? `${limpio.slice(0, MAX_TEXTO_LIBRE)} […trimmed]`
    : limpio;
}

/**
 * The seeded text columns (`question`, `impact`, `options`,
 * `default_rationale`) come from `SeededWording` and are selected for ONE
 * reader: `policyWording`, which only falls back to them for a key the catalog
 * no longer has. This file never reads them directly: a seeded tenant's copy is
 * the catalog as it was on seed day (`ON CONFLICT DO NOTHING` never refreshes
 * it), so for a live key what the agent receives is the catalog, and only a
 * retired key still shows that copy — through `policyWording`, not from here.
 */
interface FilaPolitica extends SeededWording {
  category: string;
  default_value: string | null;
  status: string;
  resolved_value: string | null;
  resolution_notes: string | null;
  entity_id: string | null;
}

/**
 * El panel vigente para la entidad de la sesión, más el mapa de roles.
 *
 * Una sola fila por clave: `DISTINCT ON (key)` con la fila de la entidad
 * primero. Es la MISMA precedencia que `getPolicy` —fila de entidad sobre
 * fila de inquilino, y `resolved` sobre defecto— aplicada de una vez a todo
 * el panel en vez de clave por clave: veintisiete `getPolicy` serían
 * veintisiete viajes a la base para armar un turno.
 */
export async function leerPanel(
  ctx: AgentContext,
  keys?: string[]
): Promise<PanelDelDespacho> {
  const filtro = keys && keys.length > 0 ? keys : null;
  const r = await query<FilaPolitica>(
    `SELECT DISTINCT ON (key)
            key, category, question, impact, options, default_value, default_rationale,
            status, resolved_value, resolution_notes, entity_id
       FROM policy_decisions
      WHERE tenant_id = $1
        AND (entity_id IS NULL OR entity_id = $2::uuid)
        AND ($3::text[] IS NULL OR key = ANY($3::text[]))
      ORDER BY key, entity_id IS NULL ASC`,
    [ctx.tenantId, ctx.entityId, filtro]
  );

  const policies: PoliticaDelPanel[] = r.rows.map((fila) => {
    // Misma condición que getPolicy: sólo 'resolved' CON valor cuenta como
    // contestada. Una 'dismissed' vuelve al defecto, y por tanto no es
    // criterio del despacho para nada.
    const marcadaResuelta = fila.status === 'resolved' && fila.resolved_value !== null;
    // …y CON valor quiere decir con valor DE VERDAD: lo que decide es el texto
    // que sobrevive a neutralizar, no el hecho de que la columna no sea NULL.
    const respuesta = marcadaResuelta ? textoLlano(fila.resolved_value) : null;
    const contestada = respuesta !== null;
    // Wording is the system's text (the catalog, or the seed-time copy of it
    // for a retired key), so it is not run through `textoLlano`. The answer
    // columns are: `resolved_value` is typed by a person, and
    // `resolution_notes` mixes a person's note with system annotations such as
    // `[value outside the catalog]` or `Defined during setup`.
    const wording = policyWording(fila, panelTranslator());
    return {
      key: fila.key,
      category: fila.category,
      question: wording.question,
      status: contestada ? 'answered' : 'unanswered',
      value: respuesta ?? fila.default_value ?? '',
      answered_value: respuesta,
      default_value: fila.default_value,
      scope: fila.entity_id === null ? 'tenant' : 'entity',
      ...(contestada ? {} : { options: wording.options }),
      notes: textoLlano(fila.resolution_notes),
      answer_defect: marcadaResuelta && !contestada ? DEFECTO_RESPUESTA_VACIA : null,
    };
  });

  const roles = await listAccountRoles(ctx.entityId);
  const asignados = new Set(roles.map((x) => x.role));

  return {
    // El instructivo ABRE el objeto: ver PanelDelDespacho.how_to_use.
    how_to_use: COMO_USARLO,
    entity: ctx.entityName,
    policies,
    unanswered: policies.filter((p) => p.status === 'unanswered').map((p) => p.key),
    account_roles: roles.map((x) => ({
      role: x.role,
      qualifier: x.qualifier,
      account_code: x.account_code,
      account_name: x.account_name,
    })),
    unmapped_roles: rolesValidos().filter((rol) => !asignados.has(rol)),
  };
}

// ============================================================
// TWO FIXED SHAPES, CHOSEN BY `keys` AND NEVER BY SIZE (#747).
//
// The panel used to travel whole in one result, and it outgrew the result cap
// four times. A fixed ladder of note lengths broke at 46 keys and again at 49;
// a bisection over the note length replaced it and, at 88 keys, left no room
// for any note: the agent received every rule without one reason. Measured on
// the same day, a firm that had answered nothing received 50,771 characters
// cut at 32,000: 59 of 86 policies, and no role map. Each fix trimmed harder
// inside one shape; none changed what grows with the catalog.
//
//  · Without `keys`: a compact list. One row per key with its status and
//    value, the counts, and the role map. A row weighs about 97 characters,
//    so the list holds well over 200 keys.
//  · With `keys`: those policies in full. Nothing is trimmed: a policy either
//    arrives whole or is named in `not_included`.
//
// Whatever is left out is named in the result, next to how to obtain it.
// ============================================================

/** Under the cap of tools/index.ts (32000), with room for the rest of the turn. */
export const TOPE_DEL_PANEL = 30000;

/**
 * A free-text value cannot make a compact row unpredictable in size. Catalog
 * values average 10 characters; only a typed answer reaches this.
 */
const COMPACT_VALUE_CHARS = 120;

const COMPACT_SUFFIX =
  ' This list is compact: every key with status and value. Before you rely on a key or ask ' +
  "about one, call again with `keys` to read its question, its options and the firm's full " +
  'note. `has_notes` marks a key whose note you have not read yet; `value_trimmed` marks a ' +
  `value cut to ${COMPACT_VALUE_CHARS} characters here.`;

const KEYED_SUFFIX =
  ' This is the full detail of the keys you asked for; the account role map comes only from a ' +
  'call without `keys`. `not_included` names requested keys left out so that no note or value ' +
  'here would be cut: call again with those keys. `unknown_keys` have no row in this ' +
  "entity's panel: check them against the list from a call without `keys`.";

/** One row of the compact list. The optional fields appear only when they apply. */
export interface CompactPolicy {
  key: string;
  status: 'answered' | 'unanswered';
  value: string;
  scope: 'entity' | 'tenant';
  /** The firm wrote a note for this key; the keyed call carries it whole. */
  has_notes?: true;
  /** `value` is cut to COMPACT_VALUE_CHARS here; the keyed call carries it whole. */
  value_trimmed?: true;
  /** A short code for a non-null `answer_defect`; the keyed call explains it. */
  answer_defect?: 'resolved_but_blank';
}

/** The result of a call without `keys`. */
export interface CompactPanel {
  /** First, for the reason given at PanelDelDespacho.how_to_use. */
  how_to_use: string;
  /** Second, and present only past the design limit: see `not_listed`. */
  list_incomplete?: string;
  entity: string;
  /** Both counts describe the whole panel, `not_listed` keys included. */
  answered_count: number;
  unanswered_count: number;
  policies: CompactPolicy[];
  /** Keys whose row did not fit the budget: named, never cut. */
  not_listed?: string[];
  account_roles: RolDeCuenta[];
  unmapped_roles: string[];
}

/** The result of a call with `keys`. */
export interface PolicyDetail {
  how_to_use: string;
  entity: string;
  /** In the order requested, each one whole. */
  policies: PoliticaDelPanel[];
  /** Requested keys that did not fit this result. */
  not_included?: string[];
  /** Requested keys with no row in this entity's panel. */
  unknown_keys?: string[];
}

function compactRow(p: PoliticaDelPanel): CompactPolicy {
  const long = p.value.length > COMPACT_VALUE_CHARS;
  return {
    key: p.key,
    status: p.status,
    value: long ? p.value.slice(0, COMPACT_VALUE_CHARS) : p.value,
    scope: p.scope,
    ...(p.notes !== null ? { has_notes: true as const } : {}),
    ...(long ? { value_trimmed: true as const } : {}),
    ...(p.answer_defect !== null ? { answer_defect: 'resolved_but_blank' as const } : {}),
  };
}

/** The largest n in [0, max] whose result fits; `sizeOf` grows with n. */
function largestThatFits(max: number, budget: number, sizeOf: (n: number) => number): number {
  if (sizeOf(max) <= budget) return max;
  let low = 0;
  let high = max;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (sizeOf(mid) <= budget) low = mid;
    else high = mid;
  }
  return low;
}

/**
 * The compact list. Past the design limit it keeps whole rows and names the
 * remaining keys bare; the notice sits right after the instructions, where a
 * cut by the result cap cannot reach it.
 */
function serializeCompact(panel: PanelDelDespacho, budget = TOPE_DEL_PANEL): string {
  const rows = panel.policies.map(compactRow);
  const build = (n: number): string =>
    JSON.stringify({
      how_to_use: COMO_USARLO + COMPACT_SUFFIX,
      ...(n < rows.length
        ? {
            list_incomplete:
              `The panel has ${rows.length} keys; ${n} are listed with status and value, and the ` +
              `other ${rows.length - n} appear in \`not_listed\` by key only: read those with ` +
              '`keys` before you rely on any of them.',
          }
        : {}),
      entity: panel.entity,
      answered_count: rows.length - panel.unanswered.length,
      unanswered_count: panel.unanswered.length,
      policies: rows.slice(0, n),
      ...(n < rows.length ? { not_listed: rows.slice(n).map((r) => r.key) } : {}),
      account_roles: panel.account_roles,
      unmapped_roles: panel.unmapped_roles,
    } satisfies CompactPanel);
  return build(largestThatFits(rows.length, budget, (n) => build(n).length));
}

/**
 * The requested policies in full, in request order. A policy that does not fit
 * is named in `not_included` whole rather than trimmed: the note is the firm's
 * reason, and half a reason reads like a different one.
 */
function serializeDetail(
  panel: PanelDelDespacho,
  requested: string[],
  budget = TOPE_DEL_PANEL
): string {
  const byKey = new Map(panel.policies.map((p) => [p.key, p]));
  const asked = [...new Set(requested)];
  const found = asked.filter((k) => byKey.has(k));
  const unknown = asked.filter((k) => !byKey.has(k));
  const build = (n: number): string =>
    JSON.stringify({
      how_to_use: COMO_USARLO + KEYED_SUFFIX,
      entity: panel.entity,
      policies: found.slice(0, n).flatMap((k) => byKey.get(k) ?? []),
      ...(n < found.length ? { not_included: found.slice(n) } : {}),
      ...(unknown.length > 0 ? { unknown_keys: unknown } : {}),
    } satisfies PolicyDetail);
  return build(largestThatFits(found.length, budget, (n) => build(n).length));
}

export function buildPolicyTools(ctx: AgentContext, deps: ToolDeps) {
  const panelTool = betaZodTool({
    name: 'get_accounting_policies',
    description:
      "Reads your firm's ACCOUNTING POLICY PANEL (the decisions the system cannot make on its " +
      'own: capitalization threshold, restaurant meals, inventories, FX rate source, REP ' +
      'tolerances…) together with the ACCOUNT ROLE MAP (which concrete account plays cxc, cxp, ' +
      'banco, activo_fijo, iva_acreditable…). Call it BEFORE deciding an accounting treatment ' +
      'that depends on a firm criterion rather than on a standard — asset vs expense, deductible ' +
      'split, inventory vs direct expense — and before choosing an account a role already names. ' +
      'Read-only: it neither answers policies nor repoints roles, both of which are human acts. ' +
      'Without `keys` it returns a compact list: every key with its status and value, plus the ' +
      'role map. With `keys` it returns those policies in full: question, options and the ' +
      "firm's note. " +
      'Each policy comes back with status: "answered" is your firm\'s criterion and you follow ' +
      'it; "unanswered" means the value shown is only the system default — do NOT apply it as if ' +
      'it were a decision, ask with ask_user when the answer would change what you book.',
    inputSchema: z.object({
      keys: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'Policy keys to read in full (e.g. ["umbral_capitalizacion_mxn"]): the question, the ' +
            "options when nobody has answered, and the firm's whole note. Omit for the compact " +
            'list of every key with its status and value, plus the account role map — read that ' +
            'list first: it is how you notice a criterion you did not know applied.'
        ),
    }),
    run: async (input) => {
      deps.observe?.('get_accounting_policies', input);
      const keys = input.keys?.length ? input.keys : undefined;
      const panel = await leerPanel(ctx, keys);
      if (keys) return serializeDetail(panel, keys);
      if (panel.policies.length === 0) {
        return (
          'The policy panel has no rows for this entity. That is NOT "no criteria apply": it ' +
          'means nobody has seeded or answered the panel ' +
          '(a human runs `mnemosine init --section politicas` or `mnemosine pending`). Treat every ' +
          'firm criterion as undefined and ask with ask_user before booking anything that depends ' +
          'on one.\n' +
          JSON.stringify({ entity: panel.entity, policies: [], unanswered: [],
            account_roles: panel.account_roles, unmapped_roles: panel.unmapped_roles })
        );
      }
      return serializeCompact(panel);
    },
  });

  return [panelTool];
}
