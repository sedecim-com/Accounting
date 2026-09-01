import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection.js';
import type { AgentContext } from './context.js';

// ============================================================
// A4 · VEREDICTOS SOMBRA (047)
//
// El registro NO es inyectable a propósito: una sombra cuyos veredictos
// pudieran apagarse por dependencia dejaría de medir justo cuando más
// importa. Falla suave (la ingesta no se cae por no poder opinar), pero
// el fallo se DICE en el detail del resultado, nunca en silencio.
// ============================================================

export interface VeredictoSombra {
  draftId: string;
  wouldAutoPost: boolean;
  motivo: string;
  thresholds: Record<string, unknown>;
}

export async function registrarVeredictoSombra(
  ctx: AgentContext,
  v: VeredictoSombra
): Promise<void> {
  await query(
    `INSERT INTO ai_shadow_verdicts (id, tenant_id, entity_id, draft_id, would_auto_post, motivo, thresholds)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (draft_id) DO NOTHING`,
    [uuidv4(), ctx.tenantId, ctx.entityId, v.draftId, v.wouldAutoPost, v.motivo,
     JSON.stringify(v.thresholds)]
  );
}

export interface ConcordanciaSombra {
  veredictos: number;
  /** Veredictos cuyo borrador ya decidió un HUMANO (auto/política excluidos). */
  decididos: number;
  acuerdos: number;
  /** acuerdos / decididos, null sin decisiones. */
  tasa_acuerdo: string | null;
  dias_con_veredictos: number;
}

/**
 * El cruce sombra-vs-humano: acuerdo = (habría posteado y el humano aprobó)
 * o (no habría y el humano rechazó). Los aprobados por política o por
 * umbral se excluyen: la concordancia mide contra el juicio HUMANO.
 */
export async function concordanciaSombra(
  ctx: { tenantId: string; entityId?: string | null }
): Promise<ConcordanciaSombra> {
  const r = await query<{
    veredictos: number; decididos: number; acuerdos: number; dias: number;
  }>(
    `SELECT COUNT(*)::int AS veredictos,
            COUNT(*) FILTER (WHERE d.status IN ('approved','rejected')
              AND COALESCE(d.review_notes,'') NOT LIKE 'auto-post by threshold%'
              AND COALESCE(d.reviewed_by,'') NOT LIKE 'policy:%')::int AS decididos,
            COUNT(*) FILTER (WHERE
              (v.would_auto_post AND d.status = 'approved'
                AND COALESCE(d.review_notes,'') NOT LIKE 'auto-post by threshold%'
                AND COALESCE(d.reviewed_by,'') NOT LIKE 'policy:%')
              OR (NOT v.would_auto_post AND d.status = 'rejected'))::int AS acuerdos,
            COUNT(DISTINCT v.created_at::date)::int AS dias
       FROM ai_shadow_verdicts v
       JOIN ai_drafts d ON d.id = v.draft_id
      WHERE v.tenant_id = $1 AND ($2::uuid IS NULL OR v.entity_id = $2)`,
    [ctx.tenantId, ctx.entityId ?? null]
  );
  const fila = r.rows[0];
  return {
    veredictos: fila.veredictos,
    decididos: fila.decididos,
    acuerdos: fila.acuerdos,
    tasa_acuerdo: fila.decididos > 0 ? (fila.acuerdos / fila.decididos).toFixed(3) : null,
    dias_con_veredictos: fila.dias,
  };
}
