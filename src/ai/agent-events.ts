import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection.js';
import type { AgentContext } from './context.js';

// ============================================================
// AGENT EVENTS — sospecha / nudge / failover como filas (044)
//
// Los tres eventos que cuentan la salud del agente vivían en stderr y en
// memoria de proceso: la sospecha de inyección era un texto en el detail
// del resultado, el nudge de grounding un latch que muere con la sesión, y
// el failover una advertencia fugaz. «Medir antes de soltar» exige que el
// delito menor deje rastro ANTES de discutir el mayor: cuántos CFDI
// llegaron con texto que intenta dar órdenes, cuántas veces el modelo
// contestó de memoria, cuántas veces un proveedor se cayó — son la
// evidencia con la que el panel decide si el auto-posteo se enciende.
//
// Mismo contrato que el usage-ledger: el registro NUNCA bloquea ni tira el
// camino que lo emite — la variante EnSegundoPlano traga el error con una
// línea a stderr. Perder un evento es tolerable; perder una corrida de
// ingesta por no poder anotarla, no.
// ============================================================

export type AgentEventKind = 'sospecha' | 'nudge' | 'failover';

export interface AgentEvent {
  kind: AgentEventKind;
  /** Perfil de proveedor involucrado, cuando aplica (failover, sospecha en ingesta). */
  provider?: string;
  /** Contexto del evento: archivo, campos marcados, categoría del fallo… */
  detail?: Record<string, unknown>;
}

export async function registrarEventoAgente(ctx: AgentContext, evento: AgentEvent): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO ai_agent_events (id, tenant_id, entity_id, kind, provider, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, ctx.tenantId, ctx.entityId, evento.kind, evento.provider ?? null,
     JSON.stringify(evento.detail ?? {})]
  );
  return id;
}

/** Fire-and-forget: el evento jamás tira el turno ni la corrida que lo emite. */
export function registrarEventoEnSegundoPlano(ctx: AgentContext, evento: AgentEvent): void {
  void registrarEventoAgente(ctx, evento).catch((err) => {
    process.stderr.write(`  (aviso: evento '${evento.kind}' no registrado: ${(err as Error).message})\n`);
  });
}
