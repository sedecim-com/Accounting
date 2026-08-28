import { query, withTransaction } from '../../database/connection.js';
import { seedAccountRoles } from '../xml-ingestion/account-roles-seed.js';

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
      // Una transacción por entidad: un catálogo a medias no debe impedir
      // que las demás queden listas.
      const r = await withTransaction((client) =>
        seedAccountRoles(e.entity_id, e.tenant_id, actor, { client })
      );
      salida.sembradas += 1;
      salida.cuentasCreadas += r.accountsCreated.length;
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
