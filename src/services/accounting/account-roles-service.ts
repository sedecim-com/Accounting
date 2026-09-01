import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../database/connection.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
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

export async function setAccountRole(
  entityId: string,
  tenantId: string,
  role: string,
  accountId: string,
  opts: { qualifier?: string | null; notes?: string | null } = {}
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
    const upd = await client.query(
      `UPDATE account_roles
          SET account_id = $1, notes = COALESCE($2, notes)
        WHERE entity_id = $3 AND role = $4 AND qualifier IS NOT DISTINCT FROM $5`,
      [accountId, opts.notes ?? null, entityId, role, qualifier]
    );
    if (upd.rowCount === 0) {
      await client.query(
        `INSERT INTO account_roles (id, tenant_id, entity_id, role, account_id, qualifier, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [uuidv4(), tenantId, entityId, role, accountId, qualifier, opts.notes ?? null]
      );
    }
    return {
      role,
      qualifier,
      account_code: cuenta.rows[0].code,
      accion: upd.rowCount === 0 ? 'creado' : 'reapuntado',
    };
  });
}
