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
// Varios comandos hacen cosas distintas según una bandera. La regla del
// núcleo prohíbe que el PERMISO dependa del valor de una bandera, y la
// lectura conservadora es declararlos al riesgo MÁS ALTO que alcanza
// cualquiera de sus caminos: aplica el más estricto a todos.
//
// S0.6 sacó de esta tabla a los ocho graves: `review`, `ingest`, `onboard`,
// `close`, `outbox`, `jobs run-due` y las dos de `sat cred` declaran hoy
// junto a su registro Y honran sus banderas (gateMutation, --dry-run real,
// --live para lo externo, llave de idempotencia guardada). Los modos de
// bandera que eran clases de riesgo distintas se partieron donde el catálogo
// lo comete (`outbox list`/`outbox run`, `question list`/`question answer`,
// con el comando viejo como shim de deprecación); `close`, `review`,
// `ingest` y `onboard` se quedan de una hoja porque el REGISTRY así lo
// dictamina (§5 #6: `close --check` se queda), declarados al máximo.
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

  // Los graves (irreversible/externo) ya no viven aquí: S0.6 los migró a
  // declarar junto a su registro, con sus manejadores cableados a la
  // compuerta. Una fila grave nueva en esta tabla sería un retroceso — el
  // criterio del plan lo vigila.
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
/**
 * Los comandos que declaró ESTA tabla, por identidad de objeto.
 *
 * Sin esto, una segunda llamada no puede distinguir «esta ruta declara junto
 * a su registro» —la fila de la tabla sobra— de «esta ruta la declaré yo en
 * la llamada anterior» —la fila es la declaración vigente—. El primer censo
 * ingenuo reportaba las 49 como sombreadas al segundo paso, que es cómo se
 * descubrió la diferencia.
 */
const declaradasPorTabla = new WeakSet<Command>();

export function declararPendientes(program: Command): {
  aplicadas: number;
  sinTabla: string[];
  /** Rutas de la tabla que el comando ya declaraba junto a su registro. */
  sombreadas: string[];
} {
  let aplicadas = 0;
  const sinTabla: string[] = [];
  const sombreadas: string[] = [];
  const rutasVistas = new Set<string>();
  for (const { ruta, cmd } of hojasDe(program)) {
    rutasVistas.add(ruta);
    if (riskOf(cmd)) {
      // Si además está en la tabla Y no fue esta tabla quien lo declaró, la
      // entrada es letra muerta: el comando migró a declarar junto a su
      // registro —el destino deseado— y su fila ya no describe nada. Se
      // reporta para que la prueba obligue a borrarla, igual que la línea
      // base del auditor obliga a borrar la violación arreglada.
      if (RIESGOS_RETROFIT[ruta] && !declaradasPorTabla.has(cmd)) sombreadas.push(ruta);
      continue;
    }
    const decl = RIESGOS_RETROFIT[ruta];
    if (!decl) {
      sinTabla.push(ruta);
      continue;
    }
    declareRisk(cmd, decl);
    declaradasPorTabla.add(cmd);
    aplicadas += 1;

    // LAS BANDERAS QUE LA DECLARACIÓN INYECTA NO LAS HONRA (todavía) EL
    // MANEJADOR. `declareRisk` añade --dry-run/--live a las clases graves, y
    // los 57 comandos que declaran junto a su registro las consumen vía
    // gateMutation — pero estos 49 retrofitados no: su manejador se escribió
    // antes de que declararan. Una `--dry-run` aceptada que ESCRIBE de todos
    // modos es peor que no ofrecerla: promete «write nothing» y ejecuta.
    //
    // Hasta que cada manejador se cablee (CLI-F2), usarlas explícitamente
    // FALLA EN VOZ ALTA en vez de fingir. El que teclea --dry-run recibe la
    // verdad — «este comando aún no la honra» — y no una escritura real
    // disfrazada de simulacro.
    const resolved = riskOf(cmd)!;
    if (resolved.requiresDryRun || resolved.requiresLiveGate) {
      cmd.hook('preAction', (_this, action) => {
        const o = action.opts() as { dryRun?: boolean; live?: boolean };
        const pedidas = [o.dryRun ? '--dry-run' : null, o.live ? '--live' : null].filter(Boolean);
        if (pedidas.length > 0) {
          throw new Error(
            `"${ruta}" acepta ${pedidas.join(' y ')} pero su manejador todavía no las honra: ` +
              'ejecutaría de verdad mientras la bandera promete lo contrario. Se rechaza en vez ' +
              'de fingir. (La bandera existe porque la clase de riesgo la exige; el cableado del ' +
              'manejador es trabajo de CLI-F2.)'
          );
        }
      });
    }
  }
  // Y las entradas de la tabla para rutas que el binario ya no tiene.
  for (const ruta of Object.keys(RIESGOS_RETROFIT)) {
    if (!rutasVistas.has(ruta)) sombreadas.push(ruta);
  }
  return { aplicadas, sinTabla, sombreadas };
}
