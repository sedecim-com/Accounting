import { query, enterTenant, currentTenant } from '../database/connection.js';

// ============================================================
// AGENT CONTEXT
// Resolves which legal entity the CLI session operates on and
// carries the identifiers every tool needs for scoping.
// ============================================================

export interface AgentContext {
  entityId: string;
  entityName: string;
  tenantId: string;
  currency: string;
  country: string;
  accountingStandard: string;
  taxId: string;
}

interface EntityRow {
  id: string;
  name: string;
  tenant_id: string;
  functional_currency: string;
  incorporation_country: string;
  accounting_standard: string;
  tax_id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENTITY_COLUMNS = `id, name, tenant_id, functional_currency, incorporation_country, accounting_standard, tax_id`;

function toContext(row: EntityRow): AgentContext {
  // El contexto de inquilino NO se reemplaza si ya hay uno.
  //
  // El razonamiento anterior —«si ya existía es el mismo, porque RLS no
  // habría dejado leer una entidad de otro inquilino»— sólo se sostiene con
  // RLS ACTIVA, y RLS es inerte para un rol dueño o superusuario. En el
  // servidor eso era una fuga: la petición abre su contexto con withTenant a
  // partir del token, y aquí `enterWith` lo SUSTITUÍA por el inquilino de la
  // fila que designa la cabecera x-entity-id. A partir de ese punto el
  // inquilino efectivo lo elegía quien enviaba la cabecera, no el token.
  //
  // Es la forma que este repositorio prohíbe por escrito en
  // api/rest/middleware/tenant-context.ts. Ahora:
  //  · sin contexto (la terminal, que es de un proceso y un inquilino) se
  //    entra, que es para lo que enterTenant existe;
  //  · con contexto abierto se COMPRUEBA la pertenencia y se rechaza si no
  //    coincide, en vez de acomodarse al inquilino de la fila.
  const abierto = currentTenant();
  if (!abierto) {
    enterTenant(row.tenant_id);
  } else if (abierto !== row.tenant_id) {
    throw new Error(
      `La entidad ${row.name} pertenece al inquilino ${row.tenant_id} y el contexto activo es ` +
        `${abierto}. Si lo fijaste con --tenant o MNEMOSINE_TENANT, corrígelo o quítalo; ` +
        `en el servidor, el inquilino lo fija el token y no la cabecera x-entity-id.`
    );
  }
  return {
    entityId: row.id,
    entityName: row.name,
    tenantId: row.tenant_id,
    currency: row.functional_currency,
    country: row.incorporation_country,
    accountingStandard: row.accounting_standard,
    taxId: row.tax_id,
  };
}

/**
 * Sets the tenant before any query, so that entity resolution itself is
 * scoped by RLS. Without this, listEntities() would see the entities of
 * every tenant — which is the leak this closes.
 *
 * Precedence order: --tenant > MNEMOSINE_TENANT > whatever the already
 * resolved entity carries.
 */
/**
 * Under RLS, "not found" and "out of scope" are indistinguishable from the
 * query's point of view. The message has to say what is missing, or it sends
 * the user debugging in the wrong direction.
 */
function alcanceHint(): string {
  return currentTenant()
    ? ''
    : ' If the database enforces tenant isolation, specify one: --tenant <uuid> or MNEMOSINE_TENANT.';
}

export function bootstrapTenant(tenantFlag?: string): void {
  const tenantId = tenantFlag || process.env.MNEMOSINE_TENANT;
  if (tenantId) enterTenant(tenantId);
}

export async function listEntities(): Promise<EntityRow[]> {
  const result = await query<EntityRow>(
    `SELECT ${ENTITY_COLUMNS} FROM legal_entities WHERE is_active = true ORDER BY name`
  );
  return result.rows;
}

/**
 * Resolve an entity by UUID, exact tax id, or name fragment.
 * With no argument: succeeds only when exactly one active entity exists.
 */
export async function resolveEntity(idOrName?: string): Promise<AgentContext> {
  if (idOrName) {
    const trimmed = idOrName.trim();
    if (UUID_RE.test(trimmed)) {
      const byId = await query<EntityRow>(
        `SELECT ${ENTITY_COLUMNS} FROM legal_entities WHERE id = $1 AND is_active = true`,
        [trimmed]
      );
      if (byId.rows.length === 1) return toContext(byId.rows[0]);
      throw new Error(`No active entity exists with id ${trimmed}.${alcanceHint()}`);
    }

    const byName = await query<EntityRow>(
      `SELECT ${ENTITY_COLUMNS} FROM legal_entities
       WHERE is_active = true AND (name ILIKE $1 OR tax_id = $2)
       ORDER BY name`,
      [`%${trimmed}%`, trimmed.toUpperCase()]
    );
    if (byName.rows.length === 1) return toContext(byName.rows[0]);
    if (byName.rows.length === 0) {
      throw new Error(`No active entity matches "${trimmed}".${alcanceHint()}`);
    }
    throw new Error(
      `"${trimmed}" is ambiguous. Matches:\n` +
        byName.rows.map((r) => `  - ${r.name} (${r.tax_id}) → ${r.id}`).join('\n')
    );
  }

  const all = await listEntities();
  if (all.length === 1) return toContext(all[0]);
  if (all.length === 0) {
    // Readable fail-closed: without tenant context RLS returns zero rows, and
    // "no entities" would sound like an empty database when the problem is scope.
    if (!currentTenant()) {
      throw new Error(
        'No entities are visible. If the database enforces tenant isolation, specify one: ' +
          '--tenant <uuid> or MNEMOSINE_TENANT.'
      );
    }
    throw new Error('There are no active legal entities in this tenant. Create one first (POST /v1/entities or seed).');
  }
  throw new Error(
    'There are multiple active entities; specify one with --entity <id|name>:\n' +
      all.map((r) => `  - ${r.name} (${r.tax_id}) → ${r.id}`).join('\n')
  );
}
