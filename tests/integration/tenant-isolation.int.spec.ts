import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

/**
 * AISLAMIENTO ENTRE INQUILINOS, DE VERDAD.
 *
 * Cubre, sin necesidad de un clúster provisionado, la parte de
 * scripts/verify-isolation.sh que se puede afirmar sobre una base recién
 * migrada: las fronteras de RLS y la cobertura de políticas. Lo que queda
 * en el guion —propiedad de las vistas y permisos de mnemosine_app— habla
 * del entorno provisionado, no del esquema, y sigue siendo trabajo suyo.
 *
 * El truco para probar RLS sin dar de alta un rol con login ni tocar
 * pg_hba: SET LOCAL ROLE a un rol NOLOGIN con NOBYPASSRLS. Postgres
 * decide el bypass por el rol ACTUAL, así que la conexión de superusuario
 * deja de serlo dentro de la transacción y las políticas empiezan a
 * filtrar. Al hacer ROLLBACK vuelve a ser quien era.
 *
 * Lo que se demuestra:
 *  1. Con contexto, un inquilino solo ve lo suyo.
 *  2. SIN contexto no se ven todas las filas: se ven CERO. Cierre en falso.
 *  3. No se puede escribir en otro inquilino, ni actualizando ni insertando.
 *  4. Un rol dueño o superusuario ignora las políticas — que es justo por
 *     lo que la API tiene que conectarse como mnemosine_app.
 */

const SONDA = 'mnemosine_rls_probe';

let admin: pg.Client;
let a: Fixture;
let b: Fixture;

beforeAll(async () => {
  a = await crearInquilino('Inquilino A');
  b = await crearInquilino('Inquilino B');

  admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SONDA}') THEN
      CREATE ROLE ${SONDA} NOLOGIN NOBYPASSRLS;
    END IF;
  END $$;`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${SONDA}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${SONDA}`);
  await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${SONDA}`);
});

afterAll(async () => {
  if (admin) {
    // El rol es de nivel clúster y sobrevive a la base efímera: hay que
    // soltarlo a mano o la siguiente corrida lo hereda.
    await admin.query(`DROP OWNED BY ${SONDA}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${SONDA}`).catch(() => undefined);
    await admin.end();
  }
  await closeDatabase();
});

/** Ejecuta `sql` como la sonda, con el contexto de inquilino indicado. */
async function comoInquilino<T extends pg.QueryResultRow = Record<string, unknown>>(
  tenantId: string | null,
  sql: string,
  params: unknown[] = []
): Promise<pg.QueryResult<T>> {
  await admin.query('BEGIN');
  try {
    if (tenantId !== null) {
      await admin.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
    }
    await admin.query(`SET LOCAL ROLE ${SONDA}`);
    return await admin.query<T>(sql, params);
  } finally {
    await admin.query('ROLLBACK');
  }
}

describe('aislamiento por inquilino con RLS', () => {
  it('el montaje dejó dos inquilinos distintos', () => {
    expect(a.tenantId).not.toBe(b.tenantId);
  });

  it('con contexto, cada inquilino solo ve sus entidades', async () => {
    const vistoPorA = await comoInquilino<{ tenant_id: string }>(
      a.tenantId, 'SELECT tenant_id FROM legal_entities'
    );
    expect(vistoPorA.rowCount).toBeGreaterThan(0);
    expect(new Set(vistoPorA.rows.map((r) => r.tenant_id))).toEqual(new Set([a.tenantId]));

    const vistoPorB = await comoInquilino<{ tenant_id: string }>(
      b.tenantId, 'SELECT tenant_id FROM legal_entities'
    );
    expect(new Set(vistoPorB.rows.map((r) => r.tenant_id))).toEqual(new Set([b.tenantId]));
  });

  it('el aislamiento alcanza a las tablas que solo tienen entity_id', async () => {
    // Su política resuelve el inquilino a través de legal_entities.
    const r = await comoInquilino<{ n: string }>(
      a.tenantId,
      `SELECT count(*) AS n FROM accounts WHERE entity_id = $1`,
      [b.entityId]
    );
    expect(Number(r.rows[0].n)).toBe(0);
  });

  it('SIN contexto no se ve todo: se ven cero filas', async () => {
    const r = await comoInquilino(null, 'SELECT id FROM legal_entities');
    expect(r.rowCount).toBe(0);
  });

  it('un contexto con basura tampoco abre la puerta', async () => {
    // app_current_tenant() atrapa el error de casteo y devuelve NULL:
    // ausencia de contexto, nunca "todas las filas".
    const r = await comoInquilino('no-es-un-uuid', 'SELECT id FROM legal_entities');
    expect(r.rowCount).toBe(0);
  });

  it('no se puede actualizar la entidad de otro inquilino', async () => {
    const r = await comoInquilino(
      a.tenantId,
      `UPDATE legal_entities SET name = 'secuestrada' WHERE id = $1`,
      [b.entityId]
    );
    expect(r.rowCount).toBe(0);
  });

  it('no se puede insertar una fila a nombre de otro inquilino', async () => {
    // FOR ALL con USING y sin WITH CHECK: Postgres reutiliza USING para
    // validar la fila nueva, así que el INSERT es rechazado, no ignorado.
    await expect(
      comoInquilino(
        a.tenantId,
        `INSERT INTO organizations (tenant_id, name, type) VALUES ($1, 'infiltrada', 'operating')`,
        [b.tenantId]
      )
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('ninguna tabla con alcance quedó sin política', async () => {
    // Una migración que cree una tabla con tenant_id o entity_id y no
    // reciba política es una fuga silenciosa. Pasó de verdad con
    // ai_external_ops, creada nueve minutos después del endurecimiento.
    // rls-policies.sql se reaplica tras cada migración justo por esto;
    // esta prueba comprueba que el mecanismo funcionó.
    const r = await admin.query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
        AND a.attname IN ('tenant_id','entity_id')
        AND c.relname <> ALL (ARRAY['users','sessions','tenants','migrations'])
        AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
             OR NOT EXISTS (SELECT 1 FROM pg_policy p
                            WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'))
      GROUP BY c.relname ORDER BY c.relname`);
    const desprotegidas = r.rows.map((x) => x.relname);
    expect(
      desprotegidas,
      `Tablas con alcance de inquilino y sin política de aislamiento:\n  ${desprotegidas.join('\n  ')}`
    ).toEqual([]);
  });

  it('un rol dueño ignora las políticas: por eso la API no se conecta así', async () => {
    // Sin SET ROLE, la misma consulta ve los dos inquilinos. No es un
    // defecto: es la razón por la que mnemosine_app existe y por la que
    // el middleware de contexto no puede ser la única defensa.
    const r = await admin.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM legal_entities');
    const vistos = new Set(r.rows.map((x) => x.tenant_id));
    expect(vistos.has(a.tenantId)).toBe(true);
    expect(vistos.has(b.tenantId)).toBe(true);
  });
});

/**
 * LA POLÍTICA DE UNA TABLA HIJA TIENE QUE DEJAR ESCRIBIR, NO SÓLO FILTRAR.
 *
 * `reconciliation_matches` colgaba de `reconciliation_session_id`, y esa
 * columna sus dos únicos escritores la insertan SIEMPRE en NULL. La política
 * de hijos es `FOR ALL USING (...)` sin `WITH CHECK`, y en Postgres eso
 * significa que el USING hace también de comprobación del INSERT: con la clave
 * ajena nula, el EXISTS es falso y **ningún cotejo se podía insertar** bajo un
 * rol sin BYPASSRLS.
 *
 * No lo cazó nadie porque toda la suite de integración corre como
 * superusuario, donde la política es inerte, y la prueba de cobertura sólo
 * pregunta si la tabla TIENE política — no si esa política deja trabajar. Una
 * política que filtra bien y no deja escribir pasa las dos comprobaciones que
 * había.
 *
 * Estas dos afirman lo que faltaba: que el camino legítimo escribe, y que el
 * ajeno no. Valen para cualquier tabla hija; se ejercen sobre la que se rompió.
 */
describe('la política de hijos deja escribir por el camino legítimo', () => {
  async function movimientoDe(f: Fixture): Promise<string> {
    const cuenta = (await admin.query<{ id: string }>(
      `INSERT INTO bank_accounts (entity_id, account_name, bank_name, gl_account_id, currency_code)
       VALUES ($1, 'Operativa RLS', 'Banco', $2, 'MXN') RETURNING id`,
      [f.entityId, Object.values(f.cuentas)[0]]
    )).rows[0].id;
    return (await admin.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_account_id, transaction_date, amount, transaction_type, description)
       VALUES ($1, '2026-08-15', 1160.00, 'credit', 'Depósito RLS') RETURNING id`,
      [cuenta]
    )).rows[0].id;
  }

  it('un cotejo SIN sesión se inserta: la sesión es opcional por diseño', async () => {
    const tx = await movimientoDe(a);
    // Se cotea antes de abrir la sesión —ése es el orden normal del mes—, así
    // que exigir sesión para poder escribir el cotejo invertía el flujo.
    const r = await comoInquilino(
      a.tenantId,
      `INSERT INTO reconciliation_matches
         (bank_transaction_id, match_type, matched_entity_type, matched_entity_id, matched_amount)
       VALUES ($1, 'manual', 'invoice', gen_random_uuid(), 1160.00) RETURNING id`,
      [tx]
    );
    expect(r.rowCount, 'la política tiene que dejar pasar el INSERT legítimo').toBe(1);
  });

  it('y el del inquilino ajeno no', async () => {
    const txDeB = await movimientoDe(b);
    await expect(
      comoInquilino(
        a.tenantId,
        `INSERT INTO reconciliation_matches
           (bank_transaction_id, match_type, matched_entity_type, matched_entity_id, matched_amount)
         VALUES ($1, 'manual', 'invoice', gen_random_uuid(), 1160.00)`,
        [txDeB]
      )
    ).rejects.toThrow();
  });
});
