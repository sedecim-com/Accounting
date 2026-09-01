import Decimal from 'decimal.js';
import { query } from '../database/connection.js';
import { concordanciaSombra, type ConcordanciaSombra } from './shadow-verdicts.js';
import type { AgentContext } from './context.js';

// ============================================================
// AI STATS — calibración del agente sobre lo que ai_drafts ya guarda (A2)
//
// El clasificador reporta una confianza 0-1 por borrador y el despacho
// decide (aprueba, rechaza, deja que el umbral postee). Este servicio junta
// las dos series: aprobación por bucket de confianza y el DELTA entre lo
// que el modelo creyó y lo que el humano confirmó. Un delta positivo
// grande = exceso de confianza — la evidencia concreta con la que el panel
// decide ingest_auto_post, en vez del pálpito.
//
// El destino de un borrador NO es una columna: se reconstruye del rastro de
// atribución que los caminos de aprobación dejan a propósito —
//   · auto-posteo por umbral → review_notes 'auto-post by threshold …'
//     (ingest-service; el reviewer es el humano al que se atribuye, así que
//     reviewed_by NO distingue este camino: la nota sí)
//   · política pre-autorizada → reviewed_by 'policy:<id>' (draft-service)
//   · humano → lo aprobado que no es ninguno de los dos.
// El orden de los CASE respeta esa precedencia.
// ============================================================

export interface BucketCalibracion {
  bucket: string;
  borradores: number;
  aprobados_humano: number;
  aprobados_politica: number;
  auto_posteados: number;
  rechazados: number;
  pendientes: number;
  /** Confianza media de los DECIDIDOS del bucket (la calibración compara contra decisiones, no contra la cola). */
  confianza_media: string | null;
  /** aprobados / decididos, 3 decimales; null sin decisiones. */
  tasa_aprobacion: string | null;
  /** confianza_media − tasa_aprobacion: positivo = el modelo se cree más de lo que acierta. */
  delta: string | null;
}

export interface ResumenAgente {
  borradores_total: number;
  decididos: number;
  aprobados_humano: number;
  aprobados_politica: number;
  auto_posteados: number;
  rechazados: number;
  pendientes: number;
  /** (aprobados_humano + rechazados) / decididos: cuánto sigue pasando por un humano. */
  tasa_intervencion_humana: string | null;
  corridas_ingesta: number;
  borradores_de_ingesta: number;
  costo_ingesta_usd: string | null;
  costo_por_borrador_usd: string | null;
  llamadas_con_duracion: number;
  duracion_promedio_ms: number | null;
  duracion_p95_ms: number | null;
  eventos: { sospecha: number; nudge: number; failover: number };
}

export interface EstadisticasAgente {
  buckets: BucketCalibracion[];
  resumen: ResumenAgente;
  /** A4: el historial de sombra — la evidencia que resolvePolicy exige para 'on'. */
  sombra: ConcordanciaSombra;
}

interface BucketRow {
  bucket: string;
  borradores: number;
  rechazados: number;
  pendientes: number;
  auto_posteados: number;
  aprobados_politica: number;
  aprobados_humano: number;
  confianza_decididos: string | null;
}

const tres = (d: Decimal): string => d.toFixed(3);

export async function estadisticasDelAgente(ctx: AgentContext): Promise<EstadisticasAgente> {
  const bucketsRes = await query<BucketRow>(
    `SELECT
       CASE
         WHEN ai_confidence < 0.5  THEN '0.00-0.49'
         WHEN ai_confidence < 0.7  THEN '0.50-0.69'
         WHEN ai_confidence < 0.8  THEN '0.70-0.79'
         WHEN ai_confidence < 0.9  THEN '0.80-0.89'
         WHEN ai_confidence < 0.95 THEN '0.90-0.94'
         ELSE '0.95-1.00'
       END AS bucket,
       COUNT(*)::int AS borradores,
       COUNT(*) FILTER (WHERE status = 'rejected')::int AS rechazados,
       COUNT(*) FILTER (WHERE status = 'pending_review')::int AS pendientes,
       COUNT(*) FILTER (WHERE status = 'approved'
         AND COALESCE(review_notes, '') LIKE 'auto-post by threshold%')::int AS auto_posteados,
       COUNT(*) FILTER (WHERE status = 'approved'
         AND COALESCE(review_notes, '') NOT LIKE 'auto-post by threshold%'
         AND COALESCE(reviewed_by, '') LIKE 'policy:%')::int AS aprobados_politica,
       COUNT(*) FILTER (WHERE status = 'approved'
         AND COALESCE(review_notes, '') NOT LIKE 'auto-post by threshold%'
         AND COALESCE(reviewed_by, '') NOT LIKE 'policy:%')::int AS aprobados_humano,
       AVG(ai_confidence) FILTER (WHERE status <> 'pending_review')::text AS confianza_decididos
     FROM ai_drafts
     WHERE entity_id = $1
     GROUP BY 1
     ORDER BY 1`,
    [ctx.entityId]
  );

  const buckets: BucketCalibracion[] = bucketsRes.rows.map((r) => {
    const decididos = r.borradores - r.pendientes;
    const aprobados = r.auto_posteados + r.aprobados_politica + r.aprobados_humano;
    const tasa = decididos > 0 ? new Decimal(aprobados).div(decididos) : null;
    const media = r.confianza_decididos === null ? null : new Decimal(r.confianza_decididos);
    return {
      bucket: r.bucket,
      borradores: r.borradores,
      aprobados_humano: r.aprobados_humano,
      aprobados_politica: r.aprobados_politica,
      auto_posteados: r.auto_posteados,
      rechazados: r.rechazados,
      pendientes: r.pendientes,
      confianza_media: media === null ? null : tres(media),
      tasa_aprobacion: tasa === null ? null : tres(tasa),
      delta: media !== null && tasa !== null ? tres(media.minus(tasa)) : null,
    };
  });

  const suma = (f: (b: BucketCalibracion) => number): number =>
    buckets.reduce((acc, b) => acc + f(b), 0);
  const borradoresTotal = suma((b) => b.borradores);
  const pendientes = suma((b) => b.pendientes);
  const rechazados = suma((b) => b.rechazados);
  const humano = suma((b) => b.aprobados_humano);
  const politica = suma((b) => b.aprobados_politica);
  const auto = suma((b) => b.auto_posteados);
  const decididos = borradoresTotal - pendientes;

  const corridas = await query<{
    corridas: number; borradores: number; costo_total: string | null; sospechas: number;
  }>(
    `SELECT COUNT(*)::int AS corridas,
            COALESCE(SUM(drafts_created), 0)::int AS borradores,
            SUM(estimated_cost_usd)::text AS costo_total,
            COALESCE(SUM(sospecha_count), 0)::int AS sospechas
       FROM ai_ingest_runs WHERE entity_id = $1`,
    [ctx.entityId]
  );
  const cr = corridas.rows[0];

  const duracion = await query<{ llamadas: number; promedio: string | null; p95: string | null }>(
    `SELECT COUNT(*)::int AS llamadas,
            ROUND(AVG(duration_ms))::text AS promedio,
            ROUND((percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::numeric)::text AS p95
       FROM ai_usage WHERE entity_id = $1 AND duration_ms IS NOT NULL`,
    [ctx.entityId]
  );
  const du = duracion.rows[0];

  const eventos = await query<{ kind: string; n: number }>(
    `SELECT kind, COUNT(*)::int AS n
       FROM ai_agent_events WHERE entity_id = $1 GROUP BY kind`,
    [ctx.entityId]
  );
  const porKind: Record<string, number> = {};
  for (const e of eventos.rows) porKind[e.kind] = e.n;

  const costoTotal = cr.costo_total === null ? null : new Decimal(cr.costo_total);
  const sombra = await concordanciaSombra(ctx);
  return {
    buckets,
    sombra,
    resumen: {
      borradores_total: borradoresTotal,
      decididos,
      aprobados_humano: humano,
      aprobados_politica: politica,
      auto_posteados: auto,
      rechazados,
      pendientes,
      tasa_intervencion_humana:
        decididos > 0 ? tres(new Decimal(humano + rechazados).div(decididos)) : null,
      corridas_ingesta: cr.corridas,
      borradores_de_ingesta: cr.borradores,
      costo_ingesta_usd: costoTotal === null ? null : costoTotal.toFixed(6),
      costo_por_borrador_usd:
        costoTotal !== null && cr.borradores > 0
          ? costoTotal.div(cr.borradores).toFixed(6)
          : null,
      llamadas_con_duracion: du.llamadas,
      duracion_promedio_ms: du.promedio === null ? null : Number(du.promedio),
      duracion_p95_ms: du.p95 === null ? null : Number(du.p95),
      eventos: {
        // Solo de ai_agent_events: el sospecha_count de ai_ingest_runs es el
        // MISMO hecho agregado por corrida — sumarlos lo contaría doble.
        sospecha: porKind.sospecha ?? 0,
        nudge: porKind.nudge ?? 0,
        failover: porKind.failover ?? 0,
      },
    },
  };
}
