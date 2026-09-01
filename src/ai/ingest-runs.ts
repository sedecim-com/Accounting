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
// ============================================================

export interface CorridaIngesta {
  provider: string;
  model: string;
  filesTotal: number;
  counts: Record<IngestStatus, number>;
  sospechaCount: number;
  draftsCreated: number;
  inputTokens: number;
  outputTokens: number;
  /** NULL = ningún modelo con precio conocido participó (semántica de ai_usage). */
  estimatedCostUsd: number | null;
  durationMs: number;
  autoPostEnabled: boolean;
  createdBy: string;
}

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
      estimated_cost_usd, duration_ms, auto_post_enabled, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
              $14, $15, $16, $17, $18, $19, $20, $21)`,
    [
      id, ctx.tenantId, ctx.entityId, corrida.provider, corrida.model, corrida.filesTotal,
      c.rules, c.auto_post, c.draft, c.blocked, c.duplicate, c.invalid, c.error,
      corrida.sospechaCount, corrida.draftsCreated,
      corrida.inputTokens, corrida.outputTokens,
      corrida.estimatedCostUsd === null ? null : corrida.estimatedCostUsd.toFixed(6),
      corrida.durationMs, corrida.autoPostEnabled, corrida.createdBy,
    ]
  );
  return id;
}
