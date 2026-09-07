import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../database/connection.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { registrarAuditoria } from '../audit/audit-log.js';
import { ROLE_MAP } from '../xml-ingestion/account-roles-seed.js';
import type { AccountRole } from '../xml-ingestion/cfdi-taxonomy.js';

// ============================================================
// F01 · ACCOUNT ROLES — el CRUD que la capa semántica no tenía
//
// account_roles traduce «cxc», «iva_pendiente_acreditar» o «banco» a
// una cuenta concreta, y TODO el posteo automático (AR/AP, REP,
// nómina) lee por rol. La tabla y la siembra existen desde la 015;
// lo que no existía era la manera de REAPUNTAR un rol sin SQL a mano.
//
// seedAccountRoles nunca sobreescribe una elección manual (sembrar es
// completar lo que falta); `role set` SÍ sobreescribe — son actos
// distintos y esa diferencia es la razón de este módulo.
//
// La unicidad real son DOS índices parciales (018): (entity, role)
// con qualifier NULL y (entity, role, qualifier) con qualifier no
// nulo. El upsert va por UPDATE-luego-INSERT dentro de transacción en
// vez de ON CONFLICT: apuntar el conflicto al índice parcial correcto
// según la nulidad del qualifier es exactamente la clase de sutileza
// que un refactor rompe sin que ningún test lo note.
// ============================================================

export interface AccountRoleRow {
  role: string;
  qualifier: string | null;
  account_id: string;
  account_code: string;
  account_name: string;
  notes: string | null;
}

export function rolesValidos(): string[] {
  return Object.keys(ROLE_MAP).sort();
}

export function assertRolConocido(role: string): asserts role is AccountRole {
  if (!(role in ROLE_MAP)) {
    throw new ValidationError(
      `Rol contable desconocido "${role}". Válidos: ${rolesValidos().join(', ')}.`
    );
  }
}

export async function listAccountRoles(
  entityId: string,
  filtros: { role?: string; qualifier?: string } = {}
): Promise<AccountRoleRow[]> {
  const cond: string[] = ['ar.entity_id = $1'];
  const params: unknown[] = [entityId];
  let i = 2;
  if (filtros.role) {
    cond.push(`ar.role = $${i++}`);
    params.push(filtros.role);
  }
  if (filtros.qualifier) {
    cond.push(`ar.qualifier = $${i++}`);
    params.push(filtros.qualifier);
  }
  const result = await query<AccountRoleRow>(
    `SELECT ar.role, ar.qualifier, ar.account_id, a.code AS account_code,
            a.name AS account_name, ar.notes
       FROM account_roles ar
       JOIN accounts a ON a.id = ar.account_id
      WHERE ${cond.join(' AND ')}
      ORDER BY ar.role, ar.qualifier NULLS FIRST`,
    params
  );
  return result.rows;
}

export interface SetRoleResult {
  role: string;
  qualifier: string | null;
  account_code: string;
  /** 'reapuntado' si ya existía y cambió de cuenta; 'creado' si es variante nueva. */
  accion: 'reapuntado' | 'creado';
}

export interface SetRoleOptions {
  qualifier?: string | null;
  notes?: string | null;
  /**
   * G3 · QUIÉN REAPUNTÓ EL ROL. Obligatorio, y no por simetría con el resto
   * del sistema: reapuntar `cxc` o `iva_pendiente_acreditar` redirige a dónde
   * van los asientos de MEDIA CONTABILIDAD —AR/AP, REP y nómina postean por
   * rol, nunca por código de cuenta—, y hasta hoy ese acto no dejaba una sola
   * fila. `audit_log.user_id` es NOT NULL (001:456): un hecho sin autor no se
   * registra, y registrarlo con un usuario inventado sería peor que no
   * registrarlo.
   */
  userId: string;
  /** Por qué se reapunta. Va tal cual a `audit_log.reason`. */
  reason?: string | null;
}

export async function setAccountRole(
  entityId: string,
  tenantId: string,
  role: string,
  accountId: string,
  opts: SetRoleOptions
): Promise<SetRoleResult> {
  assertRolConocido(role);
  const qualifier = opts.qualifier ?? null;

  // La cuenta destino debe ser de ESTA entidad: la frontera vive en el SQL.
  const cuenta = await query<{ code: string; is_active: boolean }>(
    `SELECT code, is_active FROM accounts WHERE id = $1 AND entity_id = $2`,
    [accountId, entityId]
  );
  if (cuenta.rows.length === 0) throw new NotFoundError('Account', accountId);
  if (!cuenta.rows[0].is_active) {
    throw new ValidationError(
      `La cuenta ${cuenta.rows[0].code} está archivada: un rol que apunta a una cuenta retirada rompe el posteo automático.`
    );
  }

  return withTransaction(async (client) => {
    // El ESTADO ANTERIOR se lee con FOR UPDATE antes de tocarlo, y no se
    // deduce del `rowCount` del UPDATE. Son dos cosas distintas: el rowCount
    // dice si HABÍA fila, y el rastro tiene que decir A QUÉ CUENTA apuntaba
    // —que es justo el dato que hace investigable un reapunte—. Además el
    // candado cierra la carrera entre dos reapuntes simultáneos del mismo
    // rol, que sin él terminan con la fila de uno y el rastro del otro.
    const antes = await client.query<{ id: string; account_id: string; notes: string | null }>(
      `SELECT id, account_id, notes FROM account_roles
        WHERE entity_id = $1 AND role = $2 AND qualifier IS NOT DISTINCT FROM $3
        FOR UPDATE`,
      [entityId, role, qualifier]
    );
    const previo = antes.rows[0] ?? null;

    let filaId: string;
    if (previo) {
      await client.query(
        `UPDATE account_roles
            SET account_id = $1, notes = COALESCE($2, notes)
          WHERE id = $3`,
        [accountId, opts.notes ?? null, previo.id]
      );
      filaId = previo.id;
    } else {
      filaId = uuidv4();
      await client.query(
        `INSERT INTO account_roles (id, tenant_id, entity_id, role, account_id, qualifier, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [filaId, tenantId, entityId, role, accountId, qualifier, opts.notes ?? null]
      );
    }

    // `entity_id` es la fila de `account_roles`, no la cuenta ni la entidad:
    // el objeto que cambió es el MAPEO. Rol y calificador viajan en los
    // valores porque el id de la fila, solo, no dice qué se reapuntó.
    await registrarAuditoria(client, {
      tenantId,
      userId: opts.userId,
      action: previo ? 'update' : 'create',
      entityType: 'account_role',
      entityId: filaId,
      oldValues: previo
        ? { role, qualifier, account_id: previo.account_id, notes: previo.notes }
        : null,
      newValues: { role, qualifier, account_id: accountId, notes: opts.notes ?? previo?.notes ?? null },
      reason: opts.reason ?? null,
    });

    return {
      role,
      qualifier,
      account_code: cuenta.rows[0].code,
      accion: previo ? 'reapuntado' : 'creado',
    };
  });
}
