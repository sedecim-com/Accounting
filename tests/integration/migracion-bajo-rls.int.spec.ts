import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * UNA MIGRACIÓN DE DATOS QUE OLVIDE LA RLS TRUENA, NO CALLA.
 *
 * La 025 sembró cero filas y lo confesó la 026; la 043 volvió a sembrar cero
 * y se supo por una colisión de folio; entre ambas, la 037 dejó rellenos sin
 * hacer y la 040 dejó 15 blobs con el secreto que decía purgar. Mismo
 * mecanismo las cuatro veces: el corredor conecta como mnemosine_owner, que
 * bajo FORCE ROW LEVEL SECURITY está SUJETO a las políticas, y sin GUC de
 * inquilino el predicado es falso para toda fila — el INSERT...SELECT
 * «termina bien» habiendo leído nada.
 *
 * Esta suite corre como superusuario a propósito, y un superusuario ignora
 * RLS: por eso jamás cazó el no-op. Lo que SÍ puede fijar es la semántica
 * de la que ahora cuelga migrate.ts, reproduciéndola con un rol de utilería
 * NOBYPASSRLS. Tres verdades y una coda:
 *
 *   1. La trampa: bajo FORCE y sin GUC, el dueño lee 0 filas sin error.
 *   2. El piso: con row_security=off, la misma consulta LANZA 42501
 *      («query would be affected by row-level security policy») en vez de
 *      filtrar — es el default de pg_dump por esta misma razón.
 *   3. El opt-in: dentro de una transacción, SET LOCAL row_security = on
 *      más el GUC por inquilino (el patrón de la 026/043/046) vuelve a leer
 *      las filas del inquilino.
 *   4. La coda: al COMMIT, el SET LOCAL muere y el piso vuelve solo — una
 *      migración no puede dejarle la puerta abierta a la siguiente.
 *
 * El criterio E0.2 del tablero vigila que migrate.ts ponga el piso y que
 * toda siembra por inquilino declare el opt-in; aquí se fija que el piso y
 * el opt-in significan lo que migrate.ts cree que significan.
 */

// Rol de clúster, no de base: sufijo aleatorio para no chocar con otra
// corrida concurrente de la suite sobre el mismo Postgres.
const ROL = `scratch_migrador_${randomBytes(4).toString('hex')}`;
const TABLA = 'scratch_siembra_bajo_rls';

const tenantA = randomUUID();
const tenantB = randomUUID();

let db: pg.Client;

beforeAll(async () => {
  // Cliente dedicado: SET ROLE y los GUC son estado de SESIÓN, y el pool de
  // la app reparte sesiones — aquí la sesión ES el sujeto de la prueba.
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query(`CREATE ROLE ${ROL} NOLOGIN NOBYPASSRLS`);
  await db.query(`CREATE TABLE ${TABLA} (id int, tenant_id uuid NOT NULL)`);
  await db.query(`INSERT INTO ${TABLA} VALUES (1, $1), (2, $2)`, [tenantA, tenantB]);
  // La misma geometría que las tablas reales: dueño no-superusuario, RLS
  // forzada (el dueño también queda sujeto) y el predicado canónico.
  await db.query(`ALTER TABLE ${TABLA} OWNER TO ${ROL}`);
  await db.query(`ALTER TABLE ${TABLA} ENABLE ROW LEVEL SECURITY`);
  await db.query(`ALTER TABLE ${TABLA} FORCE ROW LEVEL SECURITY`);
  await db.query(
    `CREATE POLICY aislamiento ON ${TABLA} FOR ALL USING (tenant_id = public.app_current_tenant())`
  );
  await db.query(`SET ROLE ${ROL}`);
});

afterAll(async () => {
  await db.query('RESET ROLE');
  await db.query(`DROP TABLE IF EXISTS ${TABLA}`);
  await db.query(`DROP ROLE IF EXISTS ${ROL}`);
  await db.end();
});

describe('la siembra bajo FORCE RLS', () => {
  it('la trampa: sin GUC de inquilino, el dueño lee cero filas y ningún error', async () => {
    const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLA}`);
    expect(r.rows[0].n).toBe(0); // dos filas existen; la política las tapa callando
  });

  it('el piso: con row_security=off la misma consulta lanza 42501 en vez de filtrar', async () => {
    await db.query('SET row_security = off');
    await expect(db.query(`SELECT count(*) FROM ${TABLA}`)).rejects.toMatchObject({
      code: '42501',
      message: expect.stringContaining('row-level security'),
    });
  });

  it('el opt-in: SET LOCAL + GUC por inquilino lee exactamente las filas de ese inquilino', async () => {
    // La sesión sigue con el piso puesto — como la deja migrate.ts.
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL row_security = on');
      await db.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantA]);
      const r = await db.query<{ n: number; id: number }>(`SELECT count(*)::int AS n, min(id) AS id FROM ${TABLA}`);
      expect(r.rows[0].n).toBe(1);
      expect(r.rows[0].id).toBe(1);
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  });

  it('la coda: al COMMIT el opt-in muere y el piso vuelve a morder', async () => {
    await expect(db.query(`SELECT count(*) FROM ${TABLA}`)).rejects.toMatchObject({
      code: '42501',
    });
  });
});
