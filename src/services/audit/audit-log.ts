import { v4 as uuidv4 } from 'uuid';
import type pg from 'pg';
import { currentTenant } from '../../database/connection.js';

// ============================================================
// RASTRO DE AUDITORÍA — un solo punto de escritura.
//
// Hasta ahora la misma sentencia INSERT estaba copiada en cuatro
// servicios de dominio, y el motor de posteo —el único lugar por el que
// pasa TODO asiento— no escribía ninguna. Un asiento creado desde la CLI
// o por el agente no dejaba rastro: quedaba el asiento, no quién lo hizo
// ni por qué.
//
// Dos diferencias con las copias que reemplaza:
//
//  1. Recibe el CLIENTE de la transacción, no usa query(). query() saca
//     otra conexión del pool, así que el rastro se confirmaba en una
//     transacción distinta de la del hecho auditado: si el asiento se
//     revertía, el renglón de auditoría se quedaba. Aquí el rastro se
//     confirma con el hecho o no se confirma.
//  2. La acción es un tipo, no una cadena. El vocabulario lo fija un
//     CHECK en la tabla (migración 001) y un valor fuera de él revienta
//     en tiempo de ejecución; así revienta en tiempo de compilación.
// ============================================================

/** Vocabulario del CHECK de audit_log.action. */
export type AccionAuditada =
  | 'create' | 'update' | 'delete' | 'post'
  | 'void' | 'approve' | 'close' | 'reopen';

export interface EntradaAuditoria {
  tenantId: string;
  /** Quién. Es NOT NULL en la tabla: un hecho sin autor no se registra. */
  userId: string;
  action: AccionAuditada;
  /** Tabla o agregado afectado: 'journal_entries', 'customers'… */
  entityType: string;
  entityId: string;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  reason?: string | null;
}

/**
 * El inquilino para un renglón de auditoría: el del contexto RLS si lo hay,
 * o el de la entidad. Lanza si no resuelve — un hecho sin inquilino no se
 * registra, y registrarlo con uno inventado sería peor. (R1: compartido para
 * que los ciclos de vida de invoice/bill/payment no dupliquen la lógica.)
 */
export async function tenantDe(client: pg.PoolClient, entityId: string): Promise<string> {
  const delContexto = currentTenant();
  if (delContexto) return delContexto;
  const r = await client.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM legal_entities WHERE id = $1',
    [entityId]
  );
  const tenantId = r.rows[0]?.tenant_id;
  if (!tenantId) {
    throw new Error(
      `No se pudo determinar el inquilino de la entidad ${entityId}: el hecho no se registra sin rastro.`
    );
  }
  return tenantId;
}

export async function registrarAuditoria(
  client: pg.PoolClient,
  entrada: EntradaAuditoria
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (
       id, user_id, tenant_id, action, entity_type, entity_id,
       old_values, new_values, reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      uuidv4(),
      entrada.userId,
      entrada.tenantId,
      entrada.action,
      entrada.entityType,
      entrada.entityId,
      entrada.oldValues ? JSON.stringify(entrada.oldValues) : null,
      entrada.newValues ? JSON.stringify(entrada.newValues) : null,
      entrada.reason ?? null,
    ]
  );
}
