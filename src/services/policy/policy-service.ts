import type pg from 'pg';
import { query } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';
import { concordanciaSombra } from '../../ai/shadow-verdicts.js';
import { FLOOR_SOMBRA_DIAS, FLOOR_SOMBRA_ACUERDO, FLOOR_SOMBRA_VEREDICTOS } from '../../ai/floor.js';
import { POLICY_CATALOG, getPolicySpec } from './pending-catalog.js';
import type { JurisdictionCode } from '../jurisdiction/jurisdiction.js';

// ============================================================
// POLICY SERVICE
// Reads and resolves policy decisions. The important piece:
// `getPolicy` returns the resolved value or the declared default,
// so consuming code NEVER blocks — and `listPending` keeps what
// remains undefined visible.
// ============================================================

export interface PolicyRow {
  id: string;
  key: string;
  category: string;
  question: string;
  impact: string;
  options: Array<{ value: string; label: string }>;
  default_value: string | null;
  default_rationale: string | null;
  status: 'pending' | 'resolved' | 'dismissed';
  resolved_value: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_notes: string | null;
  priority: number;
  entity_id: string | null;
  /**
   * A qué jurisdicción aplica esta respuesta. NULL = universal (J0.2, 075).
   *
   * Todas las filas anteriores a la 075 son NULL, y no se les inventa un país:
   * se contestaron sin pensar en ninguno.
   */
  jurisdiction: string | null;
}

const COLUMNS = `id, key, category, question, impact, options, default_value, default_rationale,
  status, resolved_value, resolved_by, resolved_at, resolution_notes, priority, entity_id,
  jurisdiction`;

export interface PolicyContext {
  tenantId: string;
  entityId?: string;
  /**
   * LA JURISDICCIÓN DE LA PREGUNTA (J0.2). Opcional, y su ausencia significa
   * algo: «contéstame sólo con lo universal».
   *
   * Sale de `jurisdictionOf(entidad).fiscal` — es la autoridad la que hace que
   * la pregunta sea otra. Un despacho con una sociedad mexicana y otra de
   * Delaware contestaba UNA vez a «¿el resultado del ejercicio va directo a
   * acumulados?» y esa respuesta gobernaba a las dos, aunque una tenga
   * asamblea que esperar (LGSM 19-20) y la otra no.
   *
   * ESTE TRAMO SÓLO ABRE EL ESLABÓN. La cascada completa —`PolicySpec` con sus
   * jurisdicciones, la siembra filtrada, `pending --jurisdiction`— es J0.3; lo
   * que aquí se garantiza es que la columna que la 075 creó tiene lector y que
   * una respuesta marcada 'US' no puede gobernar a quien no preguntó por US.
   */
  jurisdiction?: JurisdictionCode;
}

/**
 * Seeds the catalog for a tenant. Idempotent: it does not touch existing
 * ones, so an already-resolved decision is not revived when new ones are
 * added to the catalog.
 */
export async function seedPolicies(ctx: PolicyContext): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const spec of POLICY_CATALOG) {
    const r = await query(
      `INSERT INTO policy_decisions (
         tenant_id, entity_id, key, category, question, impact, options,
         default_value, default_rationale, priority, source
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'seed')
       -- No target: uniqueness lives in three indexes —los dos parciales de
       -- la 017 (alcance de inquilino con entity_id NULL, y alcance de
       -- entidad) más el de la 075, que añade la jurisdicción con COALESCE—,
       -- y ON CONFLICT DO NOTHING los cubre a los tres sin nombrar ninguno.
       --
       -- OJO, Y ES DE J0.3: los dos índices de la 017 NO llevan la
       -- jurisdicción, así que hoy siguen impidiendo que un inquilino tenga
       -- una respuesta 'MX' y otra 'US' para la misma clave. La columna de la
       -- 075 tiene lector (getPolicy), pero la cascada no podrá sembrar dos
       -- jurisdicciones hasta que esos dos índices se reemplacen por sus
       -- equivalentes con jurisdicción. Está anotado también en la prueba de
       -- integración de este tramo, que lo deja fijado en vez de en la
       -- memoria de quien lo encontró.
       ON CONFLICT DO NOTHING`,
      [
        ctx.tenantId, ctx.entityId ?? null, spec.key, spec.category,
        spec.question, spec.impact, JSON.stringify(spec.options),
        spec.defaultValue, spec.defaultRationale, spec.priority,
      ]
    );
    inserted += r.rowCount ?? 0;
  }
  return { inserted };
}

export async function listPolicies(
  ctx: PolicyContext,
  status?: PolicyRow['status']
): Promise<PolicyRow[]> {
  const conditions = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (status) {
    conditions.push(`status = $${params.length + 1}`);
    params.push(status);
  }
  const r = await query<PolicyRow>(
    `SELECT ${COLUMNS} FROM policy_decisions
     WHERE ${conditions.join(' AND ')}
     ORDER BY status = 'pending' DESC, priority ASC, key ASC`,
    params
  );
  return r.rows;
}

export const listPending = (ctx: PolicyContext) => listPolicies(ctx, 'pending');

export interface EffectivePolicy {
  key: string;
  value: string;
  /** true = the user defined it; false = the default is being used. */
  defined: boolean;
  question: string;
  rationale: string | null;
  /**
   * De qué jurisdicción era la fila que contestó; NULL = universal, y también
   * cuando contestó el catálogo porque no había fila.
   *
   * Se propaga y no se calla porque el llamador tiene que poder distinguir
   * «me contestó la respuesta de MI jurisdicción» de «me contestó la
   * universal»: son la misma cifra con distinta autoridad detrás, y es lo que
   * `pending explain` (J0.3) va a imprimir.
   */
  jurisdiction: string | null;
}

/**
 * Effective value of a policy. Priority:
 *   resolved value > DB default > catalog default.
 * Never throws for lack of definition: the system keeps operating and
 * the decision remains visible in `/pendientes`.
 */
export async function getPolicy(
  ctx: PolicyContext,
  key: string,
  /**
   * Cliente del llamador, para leer DENTRO de su transacción.
   *
   * Sin esto, `query` toma una segunda conexión del pool, y el primer lector
   * de una política resultó ser la siembra de una entidad —que ya tiene una
   * conexión abierta y en transacción—. Dos conexiones simultáneas por alta no
   * es un detalle de estilo: con el pool pequeño, la segunda espera a que la
   * primera termine, y la primera espera a la segunda.
   */
  client?: pg.PoolClient
): Promise<EffectivePolicy> {
  const ejecutar = client
    ? <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => client.query<T>(sql, params)
    : query;
  const r = await ejecutar<PolicyRow>(
    // El alcance por entidad se ACOTA, no sólo se ordena.
    //
    // Antes era `WHERE tenant_id AND key ORDER BY entity_id IS NULL ASC`, y
    // ese orden hace ganar a cualquier fila con entity_id no nulo — sea de la
    // entidad que sea. Con dos entidades del mismo inquilino, una de ellas
    // recibía la política de la otra. No se notaba porque hasta hoy todo se
    // sembraba a nivel de inquilino (entity_id NULL) y ninguna política tenía
    // lector; al aparecer el primero, el defecto deja de ser teórico.
    //
    // La fila de la entidad gana sobre la del inquilino, que es lo que el
    // orden pretendía decir.
    //
    // ── ── ──
    //
    // J0.2 · LA JURISDICCIÓN SE ACOTA IGUAL QUE LA ENTIDAD, Y SE ORDENA
    // DESPUÉS DE ELLA.
    //
    // El WHERE deja pasar la fila universal (jurisdiction NULL) y la de la
    // jurisdicción preguntada, nada más. Sin jurisdicción en el contexto, $4
    // es NULL y `jurisdiction = NULL` no es cierto en SQL: quedan sólo las
    // universales, que es exactamente lo que hoy hay en la tabla —la 075 deja
    // la columna en NULL para toda fila anterior—. Por eso este añadido no
    // mueve ninguna respuesta existente.
    //
    // Y el ORDER BY mantiene la precedencia que ya funcionaba: la ENTIDAD
    // gana primero, y sólo dentro del mismo alcance decide la jurisdicción.
    // Al revés, una respuesta de inquilino marcada 'MX' le ganaría a la
    // respuesta específica de la entidad, que es la regresión que este tramo
    // tiene prohibido introducir.
    `SELECT ${COLUMNS} FROM policy_decisions
     WHERE tenant_id = $1 AND key = $2
       AND (entity_id IS NULL OR entity_id = $3::uuid)
       AND (jurisdiction IS NULL OR jurisdiction = $4)
     ORDER BY entity_id IS NULL ASC, jurisdiction IS NULL ASC
     LIMIT 1`,
    [ctx.tenantId, key, ctx.entityId ?? null, ctx.jurisdiction ?? null]
  );
  const row = r.rows[0];
  const spec = getPolicySpec(key);

  if (row?.status === 'resolved' && row.resolved_value !== null) {
    return {
      key, value: row.resolved_value, defined: true,
      question: row.question,
      rationale: row.resolution_notes,
      jurisdiction: row.jurisdiction,
    };
  }
  const fallback = row?.default_value ?? spec?.defaultValue;
  if (fallback === undefined || fallback === null) {
    throw new Error(`Policy "${key}" does not exist in the catalog or in the database`);
  }
  return {
    key, value: fallback, defined: false,
    question: row?.question ?? spec?.question ?? key,
    rationale: row?.default_rationale ?? spec?.defaultRationale ?? null,
    // Sin fila, contestó el catálogo, y el catálogo todavía no sabe de
    // jurisdicciones: `PolicySpec.jurisdicciones` es de J0.3. Universal, que
    // es lo que de verdad es.
    jurisdiction: row?.jurisdiction ?? null,
  };
}

/** Numeric shortcut for policies that are amounts or quantities. */
export async function getPolicyNumber(ctx: PolicyContext, key: string): Promise<number> {
  const p = await getPolicy(ctx, key);
  // `Number('')`, `Number('  ')` y `Number(null)` valen 0, y `Number.isFinite(0)`
  // es true: sin este recorte, un valor en blanco se leía como CERO en vez de
  // caer al default declarado. La escritura ya no admite blancos, pero una
  // fila anterior a esa guarda sigue en la base, así que el cinturón se queda.
  const crudo = (p.value ?? '').trim();
  const n = crudo === '' ? Number.NaN : Number(crudo);
  if (!Number.isFinite(n)) {
    const spec = getPolicySpec(key);
    return Number(spec?.defaultValue ?? 0);
  }
  return n;
}

// ASIMETRÍA DECLARADA, Y ES TRABAJO DE J0.3 (no un olvido de J0.2).
//
// `getPolicy` ya sabe que la jurisdicción forma parte de la identidad de una
// decisión: la selecciona, la acota y la propaga. Las funciones que ESCRIBEN
// esas mismas filas —`resolvePolicy`, `listPolicies`, `listPending`— todavía
// no: acotan por inquilino y, como mucho, por entidad.
//
// Hoy no hace daño y por eso no se cierra aquí: NINGUNA fila lleva
// jurisdicción, porque nada la escribe —la siembra filtrada por país es J0.3—,
// así que leer con jurisdicción y escribir sin ella resuelve exactamente la
// misma fila que antes. El día que J0.3 siembre respuestas por país, esta
// asimetría deja de ser latente: `getPolicy` leería la respuesta mexicana y
// `resolvePolicy` escribiría sobre la universal.
//
// Se escribe aquí, junto al escritor, en vez de en una tarjeta: quien venga a
// hacer J0.3 abre este archivo, no la issue. Lo encontró el verificador
// adversario del tramo; el implementador no lo había reportado.
export async function resolvePolicy(
  ctx: PolicyContext,
  key: string,
  value: string,
  resolvedBy: string,
  notes?: string
): Promise<void> {
  const spec = getPolicySpec(key);

  // UNA RESPUESTA EN BLANCO NO ES UNA RESPUESTA, y hasta hoy sí lo era.
  //
  // La ruta interactiva de `pending define` recorta y cancela con vacío; la
  // ruta por ARGUMENTO (`pending define <key> "   "`) no hacía ninguna de las
  // dos, y aquí tampoco se miraba. La fila entraba como `resolved` con
  // resolved_value en blanco, y a partir de ahí el sistema la presentaba al
  // agente bajo el sello «tu despacho decidió esto, síguelo».
  //
  // El daño no era cosmético: `getPolicyNumber` hacía Number('   \n  ') === 0
  // y Number.isFinite(0) es true, así que el respaldo al default declarado
  // NUNCA se disparaba y el umbral de capitalización del motor quedaba en
  // CERO — «capitalízalo todo», en silencio, sobre cada compra del cliente.
  // Se corta en el sitio donde entra, que es el único que cubre a los dos
  // llamadores (pending define y el asistente del alta).
  if (value.trim() === '') {
    throw new ValidationError(
      `Una política no se contesta en blanco: "${key}" quedaría marcada como decidida por el despacho ` +
        'con un valor vacío, y el motor lo leería como cero. Da un valor, o déjala pendiente.',
      'value'
    );
  }

  // A4 · LA COMPUERTA DE LA EVIDENCIA: encender el auto-posteo exige el
  // historial de sombra que el piso manda (días, acuerdo y veredictos
  // decididos por un humano). Va AQUÍ y no en el CLI porque resolvePolicy
  // tiene dos llamadores (pending define y el wizard de init): un guard solo
  // en uno dejaría al otro como puerta trasera. reopen→resolve vuelve a
  // pasar por aquí, así que el ciclo shadow→on también queda cubierto.
  if (key === 'ingest_auto_post' && value === 'on') {
    const c = await concordanciaSombra({ tenantId: ctx.tenantId, entityId: ctx.entityId ?? null });
    const acuerdo = c.tasa_acuerdo === null ? 0 : Number(c.tasa_acuerdo);
    if (
      c.dias_con_veredictos < FLOOR_SOMBRA_DIAS ||
      c.decididos < FLOOR_SOMBRA_VEREDICTOS ||
      acuerdo < FLOOR_SOMBRA_ACUERDO
    ) {
      throw new ValidationError(
        `Encender el auto-posteo exige evidencia de sombra: ${FLOOR_SOMBRA_DIAS} día(s) con veredictos ` +
          `(hay ${c.dias_con_veredictos}), ${FLOOR_SOMBRA_VEREDICTOS} veredicto(s) decididos por un humano ` +
          `(hay ${c.decididos}) y acuerdo ≥ ${FLOOR_SOMBRA_ACUERDO} (va ${c.tasa_acuerdo ?? '—'}). ` +
          `Contesta 'shadow', deja que la sombra opine unos días, y vuelve: el encendido será una decisión con historial.`
      );
    }
  }

  // A free-form value is accepted (catalogs don't cover everything), but a
  // note is added when it is not among the options so it doesn't go unnoticed.
  const known = spec?.options.some((o) => o.value === value) ?? true;
  const finalNotes = known ? notes ?? null : `${notes ?? ''} [value outside the catalog]`.trim();

  // A7 · LA DECISIÓN SE ESCRIBE EN EL MISMO ALCANCE QUE SE MIDIÓ.
  //
  // El UPDATE no acotaba por entidad: resolvía CUALQUIER fila pendiente del
  // inquilino con esa clave. Con la compuerta de evidencia justo encima
  // —que sí mide por entidad— eso producía el defecto que el plan nombra en
  // su pilar 6: siete días de sombra en UNA entidad encendían el auto-posteo
  // de todas las demás, porque la fila que acababa en 'resolved' podía ser la
  // del inquilino (entity_id NULL, que gobierna a todos) o la de otra
  // entidad. La evidencia y la decisión tienen que ser el mismo alcance, o la
  // evidencia no autoriza lo que se enciende.
  //
  // IS NOT DISTINCT FROM: `entity_id = NULL` nunca casa en SQL, y el alcance
  // de inquilino es exactamente entity_id NULL.
  const r = await query(
    `UPDATE policy_decisions
     SET status = 'resolved', resolved_value = $1, resolved_by = $2,
         resolved_at = NOW(), resolution_notes = $3, updated_at = NOW()
     WHERE tenant_id = $4 AND key = $5 AND status = 'pending'
       AND entity_id IS NOT DISTINCT FROM $6::uuid`,
    [value, resolvedBy, finalNotes, ctx.tenantId, key, ctx.entityId ?? null]
  );
  if (r.rowCount === 0) {
    throw new Error(
      `There is no pending decision with key "${key}" in this ` +
        (ctx.entityId ? `entity (${ctx.entityId})` : 'tenant scope (entity_id NULL)') +
        '. A decision is resolved in the SAME scope its evidence was measured.'
    );
  }
}

export async function dismissPolicy(
  ctx: PolicyContext,
  key: string,
  dismissedBy: string,
  notes?: string
): Promise<void> {
  const r = await query(
    `UPDATE policy_decisions
     SET status = 'dismissed', resolved_by = $1, resolved_at = NOW(),
         resolution_notes = $2, updated_at = NOW()
     WHERE tenant_id = $3 AND key = $4 AND status = 'pending'`,
    [dismissedBy, notes ?? null, ctx.tenantId, key]
  );
  if (r.rowCount === 0) {
    throw new Error(`There is no pending decision with key "${key}" in this tenant`);
  }
}

/** Reopens an already-resolved decision (the policy changed). */
export async function reopenPolicy(ctx: PolicyContext, key: string): Promise<void> {
  const r = await query(
    `UPDATE policy_decisions
     SET status = 'pending', resolved_value = NULL, resolved_by = NULL,
         resolved_at = NULL, updated_at = NOW()
     WHERE tenant_id = $1 AND key = $2 AND status != 'pending'`,
    [ctx.tenantId, key]
  );
  if (r.rowCount === 0) {
    throw new Error(`Decision "${key}" is already pending or does not exist`);
  }
}

export { POLICY_CATALOG, getPolicySpec } from './pending-catalog.js';
export type { PolicySpec } from './pending-catalog.js';
