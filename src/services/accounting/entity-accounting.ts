import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { ensureBaseChart } from './chart-seed.js';
import { seedAccountRoles, type SeedResult } from '../xml-ingestion/account-roles-seed.js';

/**
 * Deja una entidad lista para contabilizar: catálogo de cuentas base y la
 * capa semántica de account_roles que traduce «cxc» o «iva_acreditable» a un
 * código concreto.
 *
 * Existe porque `mnemosine init` creaba la entidad sin catálogo y sin roles,
 * de modo que postInvoiceEntry/postBillEntry/postCustomerPaymentEntry/
 * postVendorPaymentEntry fallaban con MISSING_ROLE_ACCOUNT en la primera
 * factura, sin más salida que insertar filas a mano.
 *
 * Estrategia del catálogo (decisión configurable, ver `estrategia`):
 * - 'auto' (por defecto): crea el catálogo base SOLO si la entidad no tiene
 *   ninguna cuenta. Una entidad nacida en mnemosine recibe el plan completo;
 *   una que llegó por onboarding desde otro sistema conserva el suyo y solo
 *   se le mapean los roles que puedan resolverse.
 * - 'siempre': crea las cuentas base que falten aunque ya haya catálogo.
 * - 'nunca': no toca el catálogo; solo mapea roles.
 *
 * Idempotente en las tres variantes. No abre transacción propia si recibe
 * `client`: el alta de entidad siembra todo en un solo acto.
 */
export type EstrategiaCatalogo = 'auto' | 'siempre' | 'nunca';

export interface ResultadoContabilidad extends SeedResult {
  /** Códigos del catálogo base creados en esta pasada. */
  cuentasBaseCreadas: string[];
  estrategiaAplicada: EstrategiaCatalogo;
  /** true si la entidad ya tenía cuentas antes de esta pasada. */
  teniaCatalogo: boolean;
}

export async function ensureEntityAccounting(
  entityId: string,
  tenantId: string,
  createdBy: string,
  options: { client?: pg.PoolClient; estrategia?: EstrategiaCatalogo } = {}
): Promise<ResultadoContabilidad> {
  const estrategia = options.estrategia ?? 'auto';

  const run = async (client: pg.PoolClient): Promise<ResultadoContabilidad> => {
    const { rows } = await client.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM accounts WHERE entity_id = $1',
      [entityId]
    );
    const teniaCatalogo = Number(rows[0]?.n ?? '0') > 0;

    const crearBase =
      estrategia === 'siempre' || (estrategia === 'auto' && !teniaCatalogo);

    const cuentasBaseCreadas = crearBase
      ? await ensureBaseChart(client, entityId, createdBy)
      : [];

    // Los roles se siembran SIEMPRE: es lo que traduce semántica a códigos, y
    // sobre un catálogo ajeno al menos mapea lo que sí exista y reporta el resto.
    const roles = await seedAccountRoles(entityId, tenantId, createdBy, { client });

    return { ...roles, cuentasBaseCreadas, estrategiaAplicada: estrategia, teniaCatalogo };
  };

  return options.client ? run(options.client) : withTransaction(run);
}

/**
 * Diagnóstico: roles que ningún código del catálogo puede satisfacer. Es lo
 * que `mnemosine doctor` reporta y lo que distingue «la entidad no está
 * sembrada» de «el catálogo del cliente no tiene esa cuenta».
 */
export async function rolesSinMapear(
  entityId: string
): Promise<Array<{ role: string; code: string }>> {
  const { REQUIRED_ACCOUNTS, ROLE_MAP } = await import('../xml-ingestion/account-roles-seed.js');
  void REQUIRED_ACCOUNTS;
  const { query } = await import('../../database/connection.js');

  const mapeados = await query<{ role: string }>(
    'SELECT role FROM account_roles WHERE entity_id = $1 AND qualifier IS NULL',
    [entityId]
  );
  const yaEstan = new Set(mapeados.rows.map((r) => r.role));
  return Object.entries(ROLE_MAP)
    .filter(([role]) => !yaEstan.has(role))
    .map(([role, code]) => ({ role, code: String(code) }));
}
