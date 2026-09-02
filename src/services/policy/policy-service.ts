import type pg from 'pg';
import { query } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';
import { concordanciaSombra } from '../../ai/shadow-verdicts.js';
import { FLOOR_SOMBRA_DIAS, FLOOR_SOMBRA_ACUERDO, FLOOR_SOMBRA_VEREDICTOS } from '../../ai/floor.js';
import { POLICY_CATALOG, getPolicySpec } from './pending-catalog.js';

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
}

const COLUMNS = `id, key, category, question, impact, options, default_value, default_rationale,
  status, resolved_value, resolved_by, resolved_at, resolution_notes, priority, entity_id`;

export interface PolicyContext {
  tenantId: string;
  entityId?: string;
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
       -- No target: uniqueness lives in two partial indexes (one for
       -- tenant scope with entity_id NULL, another for entity scope), and
       -- ON CONFLICT DO NOTHING covers both without naming them.
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
    `SELECT ${COLUMNS} FROM policy_decisions
     WHERE tenant_id = $1 AND key = $2
       AND (entity_id IS NULL OR entity_id = $3::uuid)
     ORDER BY entity_id IS NULL ASC
     LIMIT 1`,
    [ctx.tenantId, key, ctx.entityId ?? null]
  );
  const row = r.rows[0];
  const spec = getPolicySpec(key);

  if (row?.status === 'resolved' && row.resolved_value !== null) {
    return {
      key, value: row.resolved_value, defined: true,
      question: row.question,
      rationale: row.resolution_notes,
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
  };
}

/** Numeric shortcut for policies that are amounts or quantities. */
export async function getPolicyNumber(ctx: PolicyContext, key: string): Promise<number> {
  const p = await getPolicy(ctx, key);
  const n = Number(p.value);
  if (!Number.isFinite(n)) {
    const spec = getPolicySpec(key);
    return Number(spec?.defaultValue ?? 0);
  }
  return n;
}

export async function resolvePolicy(
  ctx: PolicyContext,
  key: string,
  value: string,
  resolvedBy: string,
  notes?: string
): Promise<void> {
  const spec = getPolicySpec(key);

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
