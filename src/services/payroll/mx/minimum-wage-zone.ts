import { query, withTransaction } from '../../../database/connection.js';
import { MINIMUM_WAGE_ZONES } from '../../../database/enums.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../utils/errors.js';
import { registrarAuditoria } from '../../audit/audit-log.js';

// ============================================================
// MX · THE MINIMUM-WAGE ZONE (#196 · MNE-001-377)
//
// LFT art. 486 caps the seniority premium with the minimum wage of the area
// of the place of work, and LFT arts. 90-92 tie each general minimum to its
// area: in 2026, 315.04 in the general area and 440.87 in the Zona Libre de la
// Frontera Norte (CONASAMI, DOF 09-12-2025). The zone is a datum of the entity
// (migration 336), and an employee who works in another zone may override it.
//
// Decision MNE-001-376 (#196, 18 Nov 2026): with no zone declared, the
// calculation uses the general minimum and declares that assumption. So the
// answer here always carries who declared the zone, or that nobody did.
// ============================================================

export type MinimumWageZone = (typeof MINIMUM_WAGE_ZONES)[number];

export interface ZoneOf {
  zone: MinimumWageZone;
  /** Who declared it; null = nobody, the zone is the migration's default. */
  declaredBy: 'employee' | 'entity' | null;
}

/** The `tax_parameters` key that holds each zone's daily minimum. */
const PARAMETER_OF: Record<MinimumWageZone, string> = {
  general: 'salario_minimo_general_diario',
  northern_border: 'salario_minimo_frontera_diario',
};

export function parseMinimumWageZone(value: string): MinimumWageZone {
  const zone = MINIMUM_WAGE_ZONES.find((z) => z === value.trim());
  if (!zone) {
    throw new ValidationError(
      `Unknown minimum wage zone '${value}': use one of ${MINIMUM_WAGE_ZONES.join(', ')}.`
    );
  }
  return zone;
}

/**
 * The daily minimum of the zone in the year's tax parameters, or undefined when
 * that figure is not loaded. A missing border figure is never replaced by the
 * general one: the finiquito then names what is missing (SIN CALCULAR).
 */
export function dailyMinimumWageFor(params: Record<string, unknown>, zone: MinimumWageZone): string | undefined {
  const raw = params[PARAMETER_OF[zone]];
  return typeof raw === 'number' || typeof raw === 'string' ? String(raw) : undefined;
}

/** The zone that applies to the entity, or to one of its employees. */
export async function minimumWageZoneOf(
  ctx: { tenantId: string; entityId?: string },
  employeeId?: string
): Promise<ZoneOf> {
  if (!ctx.entityId) return { zone: 'general', declaredBy: null };
  const r = await query<{ entity_zone: MinimumWageZone; entity_declared: boolean; employee_zone: MinimumWageZone | null }>(
    `SELECT le.minimum_wage_zone AS entity_zone,
            le.minimum_wage_zone_declared_at IS NOT NULL AS entity_declared,
            e.minimum_wage_zone AS employee_zone
       FROM legal_entities le
       LEFT JOIN employees e ON e.id = $3 AND e.entity_id = le.id AND e.tenant_id = le.tenant_id
      WHERE le.id = $1 AND le.tenant_id = $2`,
    [ctx.entityId, ctx.tenantId, employeeId ?? null]
  );
  const row = r.rows[0];
  if (!row) return { zone: 'general', declaredBy: null };
  if (row.employee_zone) return { zone: row.employee_zone, declaredBy: 'employee' };
  return { zone: row.entity_zone, declaredBy: row.entity_declared ? 'entity' : null };
}

/** Declares the entity's zone: validated first, scoped to the tenant, stamped and audited. */
export async function setEntityMinimumWageZone(
  entityId: string,
  tenantId: string,
  value: string,
  audit: { userId: string; tenantId: string; reason?: string }
): Promise<{ minimum_wage_zone: MinimumWageZone; minimum_wage_zone_declared_at: string }> {
  const zone = parseMinimumWageZone(value);
  return withTransaction(async (client) => {
    const before = await client.query<{ minimum_wage_zone: string; minimum_wage_zone_declared_at: string | null }>(
      `SELECT minimum_wage_zone, minimum_wage_zone_declared_at FROM legal_entities
        WHERE id = $1 AND tenant_id = $2 AND is_active = true FOR UPDATE`,
      [entityId, tenantId]
    );
    if (before.rows.length === 0) throw new NotFoundError('Active legal entity', entityId);
    const updated = await client.query<{ declared_at: string }>(
      `UPDATE legal_entities SET minimum_wage_zone = $3, minimum_wage_zone_declared_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND is_active = true
        RETURNING minimum_wage_zone_declared_at AS declared_at`,
      [entityId, tenantId, zone]
    );
    if (updated.rowCount !== 1) {
      throw new ConflictError(`Legal entity ${entityId} changed while its minimum wage zone was being set.`);
    }
    await registrarAuditoria(client, {
      tenantId: audit.tenantId,
      legalEntityId: entityId,
      userId: audit.userId,
      action: 'update',
      entityType: 'legal_entities',
      entityId,
      oldValues: { ...before.rows[0] },
      newValues: { minimum_wage_zone: zone },
      reason: audit.reason,
    });
    return { minimum_wage_zone: zone, minimum_wage_zone_declared_at: new Date(updated.rows[0].declared_at).toISOString() };
  });
}
