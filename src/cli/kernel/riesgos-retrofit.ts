import type { Command } from 'commander';
import { declareRisk, riskOf, type RiskDeclaration } from './risk.js';

// ============================================================
// LAS DECLARACIONES QUE FALTABAN, EN UN SOLO SITIO.
//
// 49 de las 106 hojas del binario no declaraban riesgo. Entre ellas estaban
// las que postean al mayor (`review`, `ingest --auto-post`, `onboard --post`),
// la que ejecuta contra el sistema externo del cliente con su credencial
// (`outbox`) y la que registra la e.firma. A lo que no se declara no se le
// aplica ninguna compuerta, y la regla R11 del auditor —la única sustantiva—
// producía CERO violaciones: no porque el CLI estuviera bien, sino porque
// `riskOf` devolvía `undefined` y no tenía sobre qué correr.
//
// POR QUÉ UNA TABLA Y NO 49 EDICIONES EN DIEZ ARCHIVOS
//
// El estilo de la casa declara junto al comando, y es el correcto para uno
// nuevo. Pero un retrofit de este tamaño repartido por diez archivos es un
// diff que nadie revisa de verdad. Aquí el inventario entero se lee de un
// vistazo y se puede discutir riesgo por riesgo, que es lo que importa: cada
// línea es una afirmación sobre lo que ese comando puede hacer.
//
// Un comando NUEVO declara junto a su registro. El criterio de cierre exige
// que toda hoja declare, así que uno que se olvide rompe — y el sitio natural
// para arreglarlo es su propio archivo, no esta tabla.
//
// EL CRITERIO DE CLASIFICACIÓN: EL MÁXIMO QUE ALCANZA CUALQUIER CAMINO
//
// Siete comandos hacen cosas distintas según una bandera: `close --check` lee
// y `close --hard` es irreversible; `outbox -l` lista y sin la bandera
// EJECUTA. La regla del núcleo prohíbe que el permiso dependa del valor de
// una bandera, y la lectura conservadora de esa regla no es dejarlos sin
// declarar —que es lo que había— sino declararlos al riesgo MÁS ALTO que
// alcanza cualquiera de sus caminos. Eso no hace depender el permiso de nada:
// aplica el más estricto a todos.
//
// Partirlos en dos comandos es mejor superficie y sigue siendo lo correcto,
// pero es un cambio de interfaz con alias de deprecación — otro trabajo. Lo
// que no puede esperar es que `outbox` ejecute contra un tercero sin ninguna
// compuerta.
// ============================================================

export const RIESGOS_RETROFIT: Record<string, RiskDeclaration> = {
  // ── Sólo leen ──
  entities: { risk: 'lectura', agent: true },
  providers: { risk: 'lectura', agent: true },
  sessions: { risk: 'lectura', agent: true },
  drafts: { risk: 'lectura', agent: true },
  whoami: { risk: 'lectura', agent: true },
  doctor: { risk: 'lectura', agent: true },
  'prompt-size': { risk: 'lectura', agent: true },
  compact: { risk: 'lectura', agent: true },
  usage: { risk: 'lectura', agent: true },
  status: { risk: 'lectura', agent: true },
  'sat cred status': { risk: 'lectura', agent: true },
  'sat cred audit': { risk: 'lectura', agent: true },
  'approvals list': { risk: 'lectura', agent: true },
  'jobs list': { risk: 'lectura', agent: true },
  'jobs history': { risk: 'lectura', agent: true },
  'skills list': { risk: 'lectura', agent: true },
  'skills view': { risk: 'lectura', agent: true },
  'webhooks list': { risk: 'lectura', agent: true },
  'webhooks deliveries': { risk: 'lectura', agent: true },

  // ── Escriben algo reversible ──
  //
  // `chat` y `ask` van aquí y no en `externo`, aunque llamen a un proveedor de
  // modelos. `externo` es para un efecto que cambia estado FUERA —un timbre,
  // una declaración, una transferencia, un correo— y una consulta a un modelo
  // no cambia nada de eso: gasta presupuesto, que es lo que vigila el libro de
  // consumo. Declararlos externo les atornillaría `--dry-run`, `--live` y una
  // llave de idempotencia al comando principal de la interfaz, que es absurdo
  // y no protegería de nada. Lo que sí escriben —la sesión, los mensajes y los
  // borradores que dejan sus herramientas— queda dicho.
  chat: {
    risk: 'escritura',
    agent: false,
    writes: 'ai_sessions, ai_messages; y por sus herramientas: ai_drafts, ai_questions, ai_external_ops',
  },
  ask: {
    risk: 'escritura',
    agent: false,
    writes: 'ai_sessions, ai_messages; y por sus herramientas: ai_drafts, ai_questions, ai_external_ops',
  },
  lang: { risk: 'escritura', agent: false, writes: 'mnemosine.config.json (idioma del agente)' },
  login: { risk: 'escritura', agent: false, writes: 'credencial local del proveedor de identidad' },
  logout: { risk: 'escritura', agent: false, writes: 'credencial local (la borra)' },
  init: {
    risk: 'escritura',
    agent: false,
    writes: 'tenants, legal_entities, users, accounts, account_roles, policy_decisions, mnemosine.config.json',
  },
  questions: { risk: 'escritura', agent: false, writes: 'ai_questions y los precedentes que su respuesta siembra' },
  'pending define': { risk: 'escritura', agent: false, writes: 'policy_decisions' },
  'pending dismiss': { risk: 'escritura', agent: false, writes: 'policy_decisions' },
  'pending reopen': { risk: 'escritura', agent: false, writes: 'policy_decisions' },
  'memory teach': { risk: 'escritura', agent: false, writes: 'precedentes del despacho' },
  'memory correct': { risk: 'escritura', agent: false, writes: 'precedentes (el anterior queda en el historial)' },
  'memory retire': { risk: 'escritura', agent: false, writes: 'precedentes (los desactiva)' },
  'memory restore': { risk: 'escritura', agent: false, writes: 'precedentes (los reactiva)' },
  'jobs create': { risk: 'escritura', agent: false, writes: 'scheduled_jobs' },
  'jobs enable': { risk: 'escritura', agent: false, writes: 'scheduled_jobs' },
  'jobs disable': { risk: 'escritura', agent: false, writes: 'scheduled_jobs' },
  'skills drafts': { risk: 'escritura', agent: false, writes: 'skills y sus borradores (aprueba o rechaza cambios)' },
  'webhooks create': { risk: 'escritura', agent: false, writes: 'webhook_tokens (muestra el token en claro UNA vez)' },
  'webhooks disable': { risk: 'escritura', agent: false, writes: 'webhook_tokens' },
  'approvals grant': {
    risk: 'escritura',
    agent: false,
    writes: 'approval_policies — concede una autorización permanente por patrón',
  },
  'approvals revoke': { risk: 'escritura', agent: false, writes: 'approval_policies' },

  // ── Postean al mayor o no se deshacen re-ejecutando ──
  //
  // Los tres primeros son de los que hacen cosas distintas según una bandera,
  // y se declaran por su camino más grave.
  review: {
    risk: 'irreversible',
    agent: false,
    writes: 'journal_entries + journal_entry_lines POSTEADOS al aprobar un borrador',
  },
  ingest: {
    risk: 'irreversible',
    agent: false,
    writes: 'xml_documents, pre_registrations, bills; y con --auto-post, asientos POSTEADOS',
  },
  onboard: {
    risk: 'irreversible',
    agent: false,
    writes: 'accounts, saldos iniciales; y con --post, el asiento de apertura POSTEADO',
  },
  close: {
    risk: 'irreversible',
    agent: false,
    writes: 'fiscal_periods; con --hard el cierre no se deshace re-ejecutando',
  },
  'sat cred revoke': {
    risk: 'irreversible',
    agent: false,
    writes: 'fiscal_credentials + destrucción del material en la bóveda',
  },

  // ── Tienen efecto fuera de este sistema ──
  outbox: {
    risk: 'externo',
    agent: false,
    writes:
      'ai_external_ops; y EJECUTA cada operación contra el sistema contable del cliente con su credencial',
  },
  'jobs run-due': {
    risk: 'externo',
    agent: false,
    writes: 'job_runs; y ejecuta el trabajo de cada job vencido, que puede salir del sistema',
  },
  'sat cred add': {
    risk: 'externo',
    agent: false,
    writes: 'fiscal_credentials + el material en la bóveda; valida el certificado contra el SAT',
  },
};

/** Toda hoja del árbol, como `familia sub verbo`. */
export function hojasDe(cmd: Command, prefijo: string[] = []): Array<{ ruta: string; cmd: Command }> {
  const hijos = (cmd.commands ?? []) as Command[];
  const nombre = cmd.name();
  const ruta = prefijo.length === 0 && nombre === 'mnemosine' ? [] : [...prefijo, nombre];
  if (hijos.length === 0) return ruta.length > 0 ? [{ ruta: ruta.join(' '), cmd }] : [];
  return hijos.flatMap((h) => hojasDe(h, ruta));
}

/**
 * Aplica las declaraciones que faltaban al programa ya montado.
 *
 * No pisa nada: una hoja que ya declaró junto a su registro se respeta. Se
 * llama una vez, al final del ensamblado del programa.
 */
export function declararPendientes(program: Command): { aplicadas: number; sinTabla: string[] } {
  let aplicadas = 0;
  const sinTabla: string[] = [];
  for (const { ruta, cmd } of hojasDe(program)) {
    if (riskOf(cmd)) continue;
    const decl = RIESGOS_RETROFIT[ruta];
    if (!decl) {
      sinTabla.push(ruta);
      continue;
    }
    declareRisk(cmd, decl);
    aplicadas += 1;
  }
  return { aplicadas, sinTabla };
}
