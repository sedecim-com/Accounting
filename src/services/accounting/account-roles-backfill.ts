import { query, withTransaction } from '../../database/connection.js';
import { ensureEntityAccounting } from './entity-accounting.js';
import { registrarAuditoria } from '../audit/audit-log.js';
import { keepsMexicanBooks } from '../jurisdiction/jurisdiction.js';
import { rolesPara } from '../xml-ingestion/account-roles-seed.js';
import type { AccountRole } from '../xml-ingestion/cfdi-taxonomy.js';

// ============================================================
// RELLENO DE LA CAPA SEMÁNTICA EN BASES YA DESPLEGADAS.
//
// `ensureEntityAccounting` siembra catálogo y roles en el alta, pero sólo
// para las entidades que crea ÉL. Toda entidad dada de alta antes —o por
// SQL, o por el asistente, que todavía tiene su propio camino— no tiene una
// sola fila en `account_roles`.
//
// Eso no era grave mientras el sistema resolvía las cuentas por su código
// literal. Ahora no: la ingesta de CFDI, el posteo de AR/AP y el servicio de
// pagos resuelven POR ROL, y una entidad sin roles muere con
// MISSING_ROLE_ACCOUNT en la primera factura del día del despliegue. Es la
// dependencia que hay que pagar ANTES de que nada más sirva.
//
// El censo no escribe. La aplicación va entidad por entidad en su propia
// transacción: una que falle —le falta una cuenta padre, tiene el catálogo a
// medias— no debe impedir que las demás queden listas.
// ============================================================

export interface EntidadSinRoles {
  entity_id: string;
  entity_name: string;
  tenant_id: string;
  roles_actuales: number;
  cuentas_actuales: number;
}

/**
 * Entidades activas cuya capa semántica está vacía o incompleta.
 *
 * El criterio es «cero roles», no «faltan algunos»: una entidad con roles
 * parciales ya pasó por el sembrador, que es idempotente y habría mapeado
 * lo que pudiera. Lo que queda ahí son roles sin cuenta en el catálogo, y
 * eso lo reporta `mnemosine doctor`, no un relleno masivo.
 */
export async function censarEntidadesSinRoles(
  tenantId?: string | null
): Promise<EntidadSinRoles[]> {
  const r = await query<EntidadSinRoles>(
    `SELECT le.id        AS entity_id,
            le.name      AS entity_name,
            le.tenant_id,
            (SELECT count(*)::int FROM account_roles ar
              WHERE ar.entity_id = le.id)          AS roles_actuales,
            (SELECT count(*)::int FROM accounts a
              WHERE a.entity_id = le.id)           AS cuentas_actuales
       FROM legal_entities le
      WHERE le.is_active = true
        AND ($1::uuid IS NULL OR le.tenant_id = $1::uuid)
        AND NOT EXISTS (SELECT 1 FROM account_roles ar WHERE ar.entity_id = le.id)
      ORDER BY le.name`,
    [tenantId ?? null]
  );
  return r.rows;
}

export interface ResultadoRelleno {
  sembradas: number;
  cuentasCreadas: number;
  rolesMapeados: number;
  sinMapear: Array<{ entidad: string; role: string; code: string }>;
  fallos: string[];
}

/**
 * Siembra la capa semántica de cada entidad del censo.
 *
 * `seedAccountRoles` es idempotente y crea las cuentas que falten, así que
 * correr esto dos veces no duplica nada. El actor se resuelve por entidad
 * porque `accounts.created_by` es NOT NULL y tiene que ser un usuario real
 * del inquilino, no un identificador inventado.
 */
export async function rellenarRoles(
  entidades: EntidadSinRoles[],
  actorPorInquilino: Map<string, string>
): Promise<ResultadoRelleno> {
  const salida: ResultadoRelleno = {
    sembradas: 0, cuentasCreadas: 0, rolesMapeados: 0, sinMapear: [], fallos: [],
  };

  for (const e of entidades) {
    const actor = actorPorInquilino.get(e.tenant_id);
    if (!actor) {
      salida.fallos.push(
        `${e.entity_name}: el inquilino ${e.tenant_id} no tiene ningún usuario activo que pueda firmar el alta de cuentas.`
      );
      continue;
    }
    try {
      // ensureEntityAccounting, NO seedAccountRoles.
      //
      // seedAccountRoles sólo crea REQUIRED_ACCOUNTS: 17 códigos, ninguno de
      // los que todo posteo necesita. ROLE_MAP necesita once más —1110 banco,
      // 1120 clientes, 2110 proveedores, 4100 ingresos, 6100 gastos y otros
      // seis— que vienen del catálogo base. Llamando sólo al sembrador de
      // roles, una entidad heredada terminaba con 17 roles y SIN cxc, cxp,
      // banco, ingreso ni gasto: seguía muriendo con MISSING_ROLE_ACCOUNT en
      // la primera factura, que es literalmente el fallo que este relleno
      // existe para eliminar.
      //
      // ensureEntityAccounting corre ensureBaseChart primero, con estrategia
      // 'auto': catálogo completo si la entidad no tiene ninguno, y respeta
      // el suyo si llegó con uno propio.
      const r = await withTransaction((client) =>
        ensureEntityAccounting(e.entity_id, e.tenant_id, actor, {
          client,
          estrategia: 'auto',
        })
      );
      salida.sembradas += 1;
      salida.cuentasCreadas += r.cuentasBaseCreadas.length + r.accountsCreated.length;
      salida.rolesMapeados += r.rolesMapped;
      for (const u of r.unmapped) {
        salida.sinMapear.push({ entidad: e.entity_name, role: u.role, code: u.code });
      }
    } catch (err) {
      salida.fallos.push(`${e.entity_name}: ${(err as Error).message}`);
    }
  }
  return salida;
}

/** Un usuario activo por inquilino, para firmar el alta de las cuentas. */
export async function actoresPorInquilino(
  inquilinos: string[]
): Promise<Map<string, string>> {
  if (inquilinos.length === 0) return new Map();
  const r = await query<{ tenant_id: string; id: string }>(
    `SELECT DISTINCT ON (tenant_id) tenant_id, id
       FROM users
      WHERE tenant_id = ANY($1::uuid[]) AND is_active = true
      ORDER BY tenant_id, created_at`,
    [inquilinos]
  );
  return new Map(r.rows.map((x) => [x.tenant_id, x.id]));
}

// ============================================================
// BAN-1 (#324): A ROLE ADDED TO THE SEED AFTER THE ENTITY WAS SEEDED.
//
// `efectivo` joined ROLE_MAP after most entities were seeded, and the census
// above only looks at entities with NO roles, so it would never reach them.
// This pass adds one named role's default mapping (qualifier NULL) where it is
// missing, pointing at the code the seed uses for that entity's books.
//
// It is one role at a time on purpose, not "every role the entity lacks": a
// missing mapping in a seeded entity can be an accountant's deliberate choice,
// and bringing it back is not a backfill's call. Idempotent: the census skips
// entities that already have the role, and the insert does nothing on
// conflict.
// ============================================================

export interface MissingRole {
  entityId: string;
  entityName: string;
  tenantId: string;
  role: AccountRole;
  accountId: string;
  code: string;
}

export interface MissingRoleCensus {
  missing: MissingRole[];
  /** Entities whose chart lacks the account the seed would use. */
  unmappable: Array<{ entityName: string; role: AccountRole; code: string }>;
}

/** Read-only: seeded entities with no default mapping for `role`. */
export async function censusMissingRole(
  role: AccountRole,
  tenantId?: string | null
): Promise<MissingRoleCensus> {
  const r = await query<{
    entity_id: string; entity_name: string; tenant_id: string;
    incorporation_country: string | null; accounting_standard: string | null;
  }>(
    `SELECT le.id AS entity_id, le.name AS entity_name, le.tenant_id,
            le.incorporation_country, le.accounting_standard
       FROM legal_entities le
      WHERE le.is_active = true
        AND ($1::uuid IS NULL OR le.tenant_id = $1::uuid)
        AND EXISTS (SELECT 1 FROM account_roles ar
                     WHERE ar.entity_id = le.id AND ar.tenant_id = le.tenant_id)
        AND NOT EXISTS (SELECT 1 FROM account_roles ar
                         WHERE ar.entity_id = le.id AND ar.tenant_id = le.tenant_id
                           AND ar.role = $2 AND ar.qualifier IS NULL)
      ORDER BY le.name`,
    [tenantId ?? null, role]
  );

  const census: MissingRoleCensus = { missing: [], unmappable: [] };
  for (const e of r.rows) {
    const mexican = keepsMexicanBooks(e.incorporation_country, e.accounting_standard);
    const code = rolesPara(mexican)[role];
    if (!code) continue;
    const account = await query<{ id: string }>(
      `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2 AND is_active`,
      [e.entity_id, code]
    );
    if (!account.rows[0]) {
      census.unmappable.push({ entityName: e.entity_name, role, code });
      continue;
    }
    census.missing.push({
      entityId: e.entity_id, entityName: e.entity_name, tenantId: e.tenant_id,
      role, accountId: account.rows[0].id, code,
    });
  }
  return census;
}

export interface AddRolesResult {
  added: number;
  failures: string[];
}

/** Adds each census row in its own transaction, with an audit row per mapping. */
export async function addMissingRoles(
  rows: MissingRole[],
  actorByTenant: Map<string, string>
): Promise<AddRolesResult> {
  const out: AddRolesResult = { added: 0, failures: [] };
  for (const row of rows) {
    const actor = actorByTenant.get(row.tenantId);
    if (!actor) {
      out.failures.push(`${row.entityName}: el inquilino ${row.tenantId} no tiene ningún usuario activo que firme el cambio.`);
      continue;
    }
    const added = await withTransaction(async (client) => {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO account_roles (tenant_id, entity_id, role, account_id)
         VALUES ($1, $2, $3, $4)
         -- No target: uniqueness lives in two partial indexes (018).
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [row.tenantId, row.entityId, row.role, row.accountId]
      );
      if (!ins.rows[0]) return false;
      await registrarAuditoria(client, {
        tenantId: row.tenantId,
        userId: actor,
        action: 'create',
        entityType: 'account_role',
        entityId: ins.rows[0].id,
        oldValues: null,
        newValues: { role: row.role, qualifier: null, account_id: row.accountId, code: row.code },
        reason: `BAN-1 (#324): el rol ${row.role} se añadió a la semilla después del alta`,
      });
      return true;
    });
    if (added) out.added += 1;
    else out.failures.push(`${row.entityName}: el rol ${row.role} ya estaba mapeado; no se tocó.`);
  }
  return out;
}
