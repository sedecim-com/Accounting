import { z } from 'zod/v4';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { query } from '../../database/connection.js';
import { neutralizarMarcadores } from '../untrusted.js';
import { listAccountRoles, rolesValidos } from '../../services/accounting/account-roles-service.js';
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
  options: Array<{ value: string; label: string }>;
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
  /** Presente sólo cuando hubo que recortar NOTAS para que el panel cupiera. */
  notes_trimmed?: string;
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

interface FilaPolitica {
  key: string;
  category: string;
  question: string;
  options: Array<{ value: string; label: string }> | null;
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
            key, category, question, options, default_value,
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
    return {
      key: fila.key,
      category: fila.category,
      question: fila.question,
      status: contestada ? 'answered' : 'unanswered',
      value: respuesta ?? fila.default_value ?? '',
      answered_value: respuesta,
      default_value: fila.default_value,
      scope: fila.entity_id === null ? 'tenant' : 'entity',
      options: fila.options ?? [],
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
// EL PANEL ENTERO CABE, Y LO QUE SE RECORTA SE DICE.
//
// Medido: 27 políticas (las que POLICY_CATALOG tiene en producción) con notas
// de unos 900 caracteres serializan por encima de MAX_TOOL_RESULT_CHARS, y
// withResultCap corta por el final. Dos consecuencias, no una: el instructivo
// desaparecía (arreglado por el ORDEN de las claves) y el propio panel se
// quedaba amputado a media lista SIN QUE EL AGENTE LO SUPIERA, que es peor —
// decidir creyendo haber visto los 27 criterios cuando se vieron 18.
//
// Lo que se recorta son las NOTAS, que son la justificación; jamás `key`,
// `status`, `value` ni `answered_value`, que son el criterio. Y se declara en
// `notes_trimmed`, porque un recorte silencioso es otra forma de la misma
// enfermedad.
// ============================================================

/** Bajo el tope de tools/index.ts (32000) con margen para el resto del turno. */
const TOPE_DEL_PANEL = 30000;

// El 60 no es un número redondo: es el peldaño que hace que las 46 políticas
// de hoy quepan CON su justificación (28 622 < 30 000). Sin él la escalera
// saltaba de 150 directa a 0, y a este tamaño 150 ya no cabía: el agente
// recibía las 46 reglas SIN una sola razón de por qué son así. Un panel que
// dice qué hacer y nunca por qué es el que se acaba ignorando.
const ESCALONES_DE_NOTA = [400, 150, 60, 0] as const;

/** El marcador cuenta DENTRO del tope, no encima. */
const MARCA_DE_RECORTE = ' […trimmed]';

function recortarNota(nota: string | null, tope: number): string | null {
  if (nota === null) return null;
  if (tope === 0) return null;
  if (nota.length <= tope) return nota;
  // El marcador se restaba del corte, no se sumaba al resultado: antes esto
  // devolvía `tope + 11` caracteres mientras `notes_trimmed` anunciaba `tope`,
  // así que el aviso mentía sobre su propio corte —y el presupuesto del panel
  // se pasaba en once caracteres por cada nota recortada, veintisiete veces—.
  // Un aviso que no describe lo que hizo es peor que no avisar.
  const util = Math.max(0, tope - MARCA_DE_RECORTE.length);
  return `${nota.slice(0, util)}${MARCA_DE_RECORTE}`;
}

/** Serializa el panel dentro del presupuesto, recortando SÓLO notas. */
function serializarPanel(panel: PanelDelDespacho, tope = TOPE_DEL_PANEL): string {
  const entero = JSON.stringify(panel);
  if (entero.length <= tope) return entero;

  let ultimo = entero;
  for (const escalon of ESCALONES_DE_NOTA) {
    const recortado: PanelDelDespacho = {
      ...panel,
      policies: panel.policies.map((p) => ({ ...p, notes: recortarNota(p.notes, escalon) })),
      notes_trimmed:
        escalon === 0
          ? 'The rationale notes were DROPPED so the whole panel would fit; every key, status and ' +
            'value below is complete. Ask a human for the rationale of a specific key if you need it.'
          : `The rationale notes were trimmed to ${escalon} characters so the whole panel would fit; ` +
            'every key, status and value below is complete.',
    };
    ultimo = JSON.stringify(recortado);
    if (ultimo.length <= tope) return ultimo;
  }
  // Panel patológico (valores libres enormes): el tope de la herramienta lo
  // cortará, y por eso el instructivo va PRIMERO — se pierde el final, nunca
  // la regla de uso.
  return ultimo;
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
      'Each policy comes back with status: "answered" is your firm\'s criterion and you follow ' +
      'it; "unanswered" means the value shown is only the system default — do NOT apply it as if ' +
      'it were a decision, ask with ask_user when the answer would change what you book.',
    inputSchema: z.object({
      keys: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'Policy keys to read (e.g. ["umbral_capitalizacion_mxn"]). Omit for the whole panel — ' +
            'it is small, and reading it whole is how you notice a criterion you did not know applied.'
        ),
    }),
    run: async (input) => {
      deps.observe?.('get_accounting_policies', input);
      const panel = await leerPanel(ctx, input.keys);
      if (panel.policies.length === 0) {
        return (
          'The policy panel has no rows for this entity' +
          (input.keys?.length ? ` matching ${input.keys.join(', ')}` : '') +
          '. That is NOT "no criteria apply": it means nobody has seeded or answered the panel ' +
          '(a human runs `mnemosine init --section politicas` or `mnemosine pending`). Treat every ' +
          'firm criterion as undefined and ask with ask_user before booking anything that depends ' +
          'on one.\n' +
          JSON.stringify({ entity: panel.entity, policies: [], unanswered: [],
            account_roles: panel.account_roles, unmapped_roles: panel.unmapped_roles })
        );
      }
      return serializarPanel(panel);
    },
  });

  return [panelTool];
}
