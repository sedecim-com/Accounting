import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection.js';
import type { AgentContext } from './context.js';
import type { IngestStatus } from './ingest-service.js';

// ============================================================
// INGEST RUNS — los counts que solo se imprimían, persistidos (044)
//
// `mnemosine ingest` terminaba con un Summary en consola y el reporte se
// evaporaba: imposible responder «¿cuántos CFDI clasificó el agente este
// mes, cuántos bloqueó, cuánto costó cada borrador?» sin releer terminales.
// Una fila por corrida: counts por estatus, borradores creados, sospechas,
// y el consumo (tokens, costo estimado, duración) acumulado de los
// callbacks de uso — así «costo por borrador» es una división auditable.
//
// A7·3 — LA FILA SE ABRE ANTES DEL BUCLE, NO DESPUÉS.
//
// Aquella fila era UN SOLO INSERT con los contadores ya finales, y el
// llamador lo ejecutaba cuando `ingestCfdiFiles` ya había vuelto. Una
// corrida de 2 000 CFDI que muere en el archivo 1 500 dejaba mil quinientos
// documentos registrados, sus asientos en el mayor, y CERO filas de corrida.
// El registro se parte en dos actos, como ai_external_ops lleva haciendo
// desde su primer día:
//
//   abrirCorridaIngesta  → antes del primer archivo, con lo único que se
//                          sabe entonces (proveedor, modelo, cuántos
//                          archivos, umbral de auto-posteo, quién).
//   cerrarCorridaIngesta → después, con los contadores y el consumo; o con
//                          la razón de la muerte, y entonces cierra en
//                          'failed'.
//
// Y el registro sigue siendo BEST-EFFORT a propósito: los resultados de la
// ingesta son verdad aunque la anotación falle. Lo que cambia es que un
// registro fallido ya no se traga: `conCorridaRegistrada` lo entrega como
// aviso al llamador, para que lo enseñe donde el humano mira.
// ============================================================

/** Lo que se sabe ANTES del primer archivo. Con esto basta para abrir la fila. */
export interface AperturaCorridaIngesta {
  provider: string;
  model: string;
  filesTotal: number;
  autoPostEnabled: boolean;
  createdBy: string;
}

/** Lo que sólo se sabe DESPUÉS — y a medias, si la corrida murió. */
export interface CierreCorridaIngesta {
  /**
   * Los contadores por estatus. AUSENTES cuando la corrida reventó: entonces
   * las columnas conservan su DEFAULT 0, que junto a status='failed' se lee
   * «no se llegó a contar». Escribir ceros como si fueran finales sería
   * inventar una corrida vacía que nunca existió.
   */
  counts?: Record<IngestStatus, number>;
  sospechaCount: number;
  draftsCreated: number;
  inputTokens: number;
  outputTokens: number;
  /** NULL = ningún modelo con precio conocido participó (semántica de ai_usage). */
  estimatedCostUsd: number | null;
  durationMs: number;
  /** Presente sólo si murió: la fila cierra en 'failed' con esta razón. */
  error?: string | null;
}

/** Corrida completa: lo de la apertura y lo del cierre a la vez. */
export type CorridaIngesta = AperturaCorridaIngesta &
  CierreCorridaIngesta & { counts: Record<IngestStatus, number> };

/**
 * Un stack de megabytes no cabe en una fila de bitácora ni le sirve a nadie:
 * la razón se recorta aquí, no en la columna, para que el recorte sea visible
 * en el código que lo decide.
 */
const MAX_ERROR_CHARS = 2000;

function recortarError(mensaje: string): string {
  return mensaje.length > MAX_ERROR_CHARS
    ? `${mensaje.slice(0, MAX_ERROR_CHARS)}… [recortado]`
    : mensaje;
}

/**
 * Abre la fila ANTES del bucle. Devuelve el id con el que se cerrará.
 *
 * Todo lo que no se sabe todavía se queda en su DEFAULT: los contadores en 0
 * y duration_ms / estimated_cost_usd en NULL. status nace en 'running', que
 * es lo que distingue esos ceros de los de una corrida que sí terminó vacía.
 */
export async function abrirCorridaIngesta(
  ctx: AgentContext,
  apertura: AperturaCorridaIngesta
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO ai_ingest_runs (
      id, tenant_id, entity_id, provider, model, files_total,
      auto_post_enabled, created_by, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running')`,
    [
      id, ctx.tenantId, ctx.entityId, apertura.provider, apertura.model,
      apertura.filesTotal, apertura.autoPostEnabled, apertura.createdBy,
    ]
  );
  return id;
}

/**
 * Cierra la fila que abrió `abrirCorridaIngesta`.
 *
 * El estado lo decide UN sitio: hay `error` → 'failed'; no lo hay →
 * 'completed'. La guarda del WHERE es la de recoverExecutingOp: id + entidad
 * + status='running'. Cerrar dos veces, o cerrar una fila de otra entidad, no
 * escribe nada y LANZA — un cierre que no encontró su fila es un dato que se
 * perdió, y decirlo es lo que lo convierte en aviso en vez de en silencio.
 */
export async function cerrarCorridaIngesta(
  ctx: AgentContext,
  corridaId: string,
  cierre: CierreCorridaIngesta
): Promise<void> {
  const c = cierre.counts ?? null;
  const result = await query(
    `UPDATE ai_ingest_runs SET
       status = $1,
       closed_at = NOW(),
       error = $2,
       rules_count = COALESCE($3::int, rules_count),
       auto_post_count = COALESCE($4::int, auto_post_count),
       draft_count = COALESCE($5::int, draft_count),
       blocked_count = COALESCE($6::int, blocked_count),
       duplicate_count = COALESCE($7::int, duplicate_count),
       invalid_count = COALESCE($8::int, invalid_count),
       error_count = COALESCE($9::int, error_count),
       sospecha_count = $10,
       drafts_created = $11,
       input_tokens = $12,
       output_tokens = $13,
       estimated_cost_usd = $14,
       duration_ms = $15
     WHERE id = $16 AND entity_id = $17 AND status = 'running'`,
    [
      cierre.error ? 'failed' : 'completed',
      cierre.error ? recortarError(cierre.error) : null,
      c ? c.rules : null,
      c ? c.auto_post : null,
      c ? c.draft : null,
      c ? c.blocked : null,
      c ? c.duplicate : null,
      c ? c.invalid : null,
      c ? c.error : null,
      cierre.sospechaCount,
      cierre.draftsCreated,
      cierre.inputTokens,
      cierre.outputTokens,
      cierre.estimatedCostUsd === null ? null : cierre.estimatedCostUsd.toFixed(6),
      cierre.durationMs,
      corridaId,
      ctx.entityId,
    ]
  );
  if (result.rowCount !== 1) {
    throw new Error(
      `no hay corrida ABIERTA con id ${corridaId} en esta entidad (ya cerrada, o de otra entidad): el cierre no se escribió`
    );
  }
}

/**
 * Corrida COMPLETA en un solo INSERT: la fila nace ya cerrada.
 *
 * Éste era EL camino, y hoy es el de RESCATE: cuando la apertura falló no hay
 * id que cerrar, y sin esto una corrida entera se quedaría sin rastro sólo
 * porque la base tosió en el segundo cero. Tarde es peor que a tiempo, pero
 * infinitamente mejor que nunca.
 */
export async function registrarCorridaIngesta(
  ctx: AgentContext,
  corrida: CorridaIngesta
): Promise<string> {
  const id = uuidv4();
  const c = corrida.counts;
  await query(
    `INSERT INTO ai_ingest_runs (
      id, tenant_id, entity_id, provider, model, files_total,
      rules_count, auto_post_count, draft_count, blocked_count,
      duplicate_count, invalid_count, error_count,
      sospecha_count, drafts_created, input_tokens, output_tokens,
      estimated_cost_usd, duration_ms, auto_post_enabled, created_by,
      status, closed_at, error
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
              $14, $15, $16, $17, $18, $19, $20, $21,
              $22, NOW(), $23)`,
    [
      id, ctx.tenantId, ctx.entityId, corrida.provider, corrida.model, corrida.filesTotal,
      c.rules, c.auto_post, c.draft, c.blocked, c.duplicate, c.invalid, c.error,
      corrida.sospechaCount, corrida.draftsCreated,
      corrida.inputTokens, corrida.outputTokens,
      corrida.estimatedCostUsd === null ? null : corrida.estimatedCostUsd.toFixed(6),
      corrida.durationMs, corrida.autoPostEnabled, corrida.createdBy,
      corrida.error ? 'failed' : 'completed',
      corrida.error ? recortarError(corrida.error) : null,
    ]
  );
  return id;
}

/**
 * EL ENVOLTORIO QUE EL LLAMADOR USA. Abre, corre, cierra — pase lo que pase.
 *
 * Tres promesas, y las tres importan:
 *
 *  1. La apertura NO puede tumbar la corrida. Si falla, `cuerpo` corre igual
 *     (con corridaId null) y el fallo sale por `onAviso`. El registro es
 *     best-effort a propósito: los CFDI clasificados son verdad aunque la
 *     anotación no se escriba.
 *  2. Pero un registro que falla DEJA RASTRO. Nada se traga en silencio: cada
 *     tropiezo —apertura, cierre o rescate— produce su aviso, y el llamador
 *     lo enseña donde el humano mira, no en un stderr que nadie lee.
 *  3. El camino de excepción también cierra. Si `cuerpo` revienta, la fila se
 *     cierra en 'failed' con la razón ANTES de relanzar el error original: la
 *     corrida que murió a media lista deja fila, y la fila dice que murió.
 */
export async function conCorridaRegistrada<T>(opts: {
  ctx: AgentContext;
  apertura: AperturaCorridaIngesta;
  /** El trabajo. Recibe el id de la fila, o null si la apertura falló. */
  cuerpo: (corridaId: string | null) => Promise<T>;
  /**
   * Arma el cierre con lo que se sepa. `resultado` es null cuando el cuerpo
   * reventó: ahí se entrega lo que el proceso sí midió (consumo, borradores
   * capturados) y se OMITEN los counts, que nadie llegó a contar.
   */
  cierre: (resultado: T | null) => CierreCorridaIngesta;
  /** Rastro de un registro que falló. Nunca tumba la corrida, pero se ve. */
  onAviso: (mensaje: string) => void;
}): Promise<T> {
  const { ctx, apertura, cuerpo, cierre, onAviso } = opts;

  let corridaId: string | null = null;
  try {
    corridaId = await abrirCorridaIngesta(ctx, apertura);
  } catch (err) {
    onAviso(
      `la corrida no quedó ABIERTA en ai_ingest_runs (${(err as Error).message}). ` +
        'Si el proceso muere ahora no habrá rastro de ella: se intentará registrarla entera al terminar.'
    );
  }

  const anotar = async (parcial: T | null, error?: string): Promise<void> => {
    // `cierre()` va DENTRO del try a propósito: es código del llamador, y si
    // revienta (un contador que no existe, un filter sobre undefined) no puede
    // tumbar una corrida que ya terminó ni tapar el error original de una que
    // murió. Nada de este bloque escapa: todo sale por onAviso.
    try {
      const datos = { ...cierre(parcial), error: error ?? null };
      if (corridaId !== null) {
        await cerrarCorridaIngesta(ctx, corridaId, datos);
      } else {
        // Rescate: sin apertura no hay id, pero los counts de una corrida que
        // SÍ terminó caben en un INSERT completo. Si tampoco terminó, no hay
        // counts que escribir y la fila nace ya en 'failed'.
        await registrarCorridaIngesta(ctx, {
          ...apertura,
          ...datos,
          counts: datos.counts ?? {
            rules: 0, auto_post: 0, draft: 0, blocked: 0, duplicate: 0, invalid: 0, error: 0,
          },
        });
      }
    } catch (err) {
      onAviso(`la corrida no quedó registrada en ai_ingest_runs: ${(err as Error).message}`);
    }
  };

  let resultado: T;
  try {
    resultado = await cuerpo(corridaId);
  } catch (err) {
    await anotar(null, (err as Error).message ?? String(err));
    throw err;
  }
  await anotar(resultado);
  return resultado;
}
