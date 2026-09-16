import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';

/**
 * LA 084 SOBRE UN DESPACHO YA INSTALADO Y ENDURECIDO (F08 · #113).
 *
 * Misma forma que tests/integration/migracion-075-embargo-bajo-rls.int.spec.ts,
 * y por la misma razón medida allí: `garnishments` está en `rls-policies.sql`,
 * `migrate.ts` abre la sesión con `SET row_security = off`, y esa combinación
 * NO desactiva RLS — PostgreSQL LANZA 42501 en cuanto una sentencia sería
 * afectada por una política. La 075 murió así antes de instalar nada.
 *
 * La 084 hace DOS cosas que la 075 no hacía, y ninguna de las dos se puede
 * dar por buena leyendo:
 *
 *   · un `ALTER COLUMN … SET NOT NULL`, que recorre la tabla entera;
 *   · dos `ADD CONSTRAINT … CHECK`, que también.
 *
 * Que esos recorridos de DDL no los afecte la política es exactamente lo que
 * nadie puede afirmar desde el fuente. Esta prueba lo ejecuta contra un banco
 * que NO es superusuario, que es dueño de las tablas (sin eso `FORCE ROW LEVEL
 * SECURITY` no lo sujeta) y que tiene las políticas puestas — el estado en que
 * `migrate.ts` deja toda instalación.
 *
 * Y comprueba ANTES su propio banco. Sin esas tres afirmaciones la prueba
 * pasaría siempre y no probaría nada, que es el modo exacto en que un banco de
 * pruebas miente.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;

const BASE = `mnem_084_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const FILE_084 = '084_the_order_that_nobody_could_file.sql';
const MIGRADOR = `it_mig084_${randomBytes(4).toString('hex')}`;

const TENANT = randomUUID();
const EMPLOYEE = randomUUID();
const ORDER_ID = randomUUID();

const urlWithDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

const migrationsUpTo = (upTo: number): string[] =>
  fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => Number(f.slice(0, 3)) <= upTo)
    .sort();

const sqlOf = (file: string): string => fs.readFileSync(path.join(DIR, file), 'utf-8');

let admin: pg.Client;
let db: pg.Client;
/**
 * El rol que puede mirarlo todo, conectado A ESTA BASE.
 *
 * `admin` vive en `postgres` —sólo sirve para CREATE/DROP DATABASE— así que
 * cualquier verificación suya sobre `garnishments` diría «la relación no
 * existe». Y el corredor no puede verificar lo suyo: sigue con
 * `row_security = off` y sin contexto de inquilino, de modo que su propia
 * lectura lanzaría 42501, que es el defecto y no el efecto.
 */
let verifier: pg.Client;

/** Aplica la 084 como la aplicaría el corredor: en su transacción y con el opt-out puesto. */
async function apply084(): Promise<void> {
  await db.query('SET row_security = off');
  await db.query('BEGIN');
  try {
    await db.query(sqlOf(FILE_084));
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [FILE_084]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

beforeAll(async () => {
  if (!ADMIN) throw new Error('falta TEST_ADMIN_DATABASE_URL / MIGRATION_DATABASE_URL / DATABASE_URL');
  admin = new pg.Client({ connectionString: urlWithDatabase(ADMIN, 'postgres') });
  await admin.connect();
  await admin.query(`CREATE ROLE ${MIGRADOR} NOLOGIN NOBYPASSRLS`);
  await admin.query(`GRANT ${MIGRADOR} TO CURRENT_USER`);
  await admin.query(`CREATE DATABASE ${BASE} OWNER ${MIGRADOR}`);

  db = new pg.Client({ connectionString: urlWithDatabase(ADMIN, BASE) });
  await db.connect();
  verifier = new pg.Client({ connectionString: urlWithDatabase(ADMIN, BASE) });
  await verifier.connect();
  await db.query(`SET ROLE ${MIGRADOR}`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query('SET row_security = off');
  for (const file of migrationsUpTo(83)) {
    await db.query('BEGIN');
    await db.query(sqlOf(file));
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }

  // Un despacho con UNA orden de embargo fiscal SIN su exención — es decir,
  // una orden que hoy retiene el cien por ciento del ingreso disponible. Sin
  // una fila así el censo no tiene a quién nombrar y el defecto no se ve.
  const org = randomUUID();
  const entity = randomUUID();
  await db.query(
    `INSERT INTO tenants (id, name, subdomain, schema_name) VALUES ($1,'F08','f08-${BASE}','s_${BASE}')`,
    [TENANT]
  );
  await db.query(`INSERT INTO organizations (id, tenant_id, name, type) VALUES ($1,$2,'G','holding')`, [org, TENANT]);
  await db.query(
    `INSERT INTO legal_entities (id, organization_id, tenant_id, name, entity_type, tax_id, tax_id_type, incorporation_country)
     VALUES ($1,$2,$3,'Acme','corporation','AA010101AAA','ein','US')`,
    [entity, org, TENANT]
  );
  await db.query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name, hire_date, country_code, ssn_encrypted)
     VALUES ($1,$2,$3,'E-F08','Ada','Lovelace','2020-01-01','US','x')`,
    [EMPLOYEE, TENANT, entity]
  );
  await db.query(
    `INSERT INTO garnishments (id, employee_id, garnishment_type, priority, amount_type, amount_value, start_date, is_active, metadata)
     VALUES ($1,$2,'tax_levy_federal',1,'fixed',0,'2020-01-01',true,'{}'::jsonb)`,
    [ORDER_ID, EMPLOYEE]
  );
  // Y una de acreedor con `metadata` en NULL: ésta NO se nombra, se normaliza,
  // porque para todo lector del árbol NULL y '{}' son la misma cosa.
  await db.query(
    `INSERT INTO garnishments (employee_id, garnishment_type, priority, amount_type, amount_value, start_date, is_active, metadata)
     VALUES ($1,'creditor',1,'percent_disposable',10,'2020-01-01',true,NULL)`,
    [EMPLOYEE]
  );

  // EL ENDURECIMIENTO, que es lo que distingue una actualización de una
  // instalación nueva: `migrate.ts` lo aplica en el `finally` de CADA corrida.
  await db.query(fs.readFileSync(path.join(DIR, '..', 'rls-policies.sql'), 'utf-8'));
  // Y EL TRAJE OTRA VEZ: alguna migración termina con `RESET ROLE`, y eso
  // devuelve la sesión al rol de CONEXIÓN, que aquí es superusuario.
  await db.query(`SET ROLE ${MIGRADOR}`);
}, 900_000);

afterAll(async () => {
  await verifier?.end();
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${BASE}`);
  await admin?.query(`DROP ROLE IF EXISTS ${MIGRADOR}`);
  await admin?.end();
});

describe('el banco es el que rompía, y se comprueba antes de juzgar', () => {
  it('el corredor no es superusuario, es dueño, y no puede saltarse RLS', async () => {
    const { rows } = await db.query<{ sup: boolean; bypass: boolean }>(
      `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS sup,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`
    );
    expect(rows[0].sup, 'como superusuario RLS es inerte y la prueba no probaría nada').toBe(false);
    expect(rows[0].bypass).toBe(false);
  });

  it('`garnishments` tiene RLS forzada, que es la mitad del escenario', async () => {
    const { rows } = await db.query<{ enabled: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class WHERE relname = 'garnishments'`
    );
    expect(rows[0].enabled).toBe(true);
    expect(rows[0].forced).toBe(true);
  });

  it('y con row_security=off una lectura suya LANZA, no devuelve cero filas', async () => {
    await db.query('SET row_security = off');
    await expect(db.query('SELECT count(*) FROM garnishments')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('la 084 no restringe sobre datos que no cumplen: para y nombra', () => {
  it('aborta nombrando la orden que hoy retiene el cheque entero', async () => {
    // El id de la orden ofensora tiene que salir EN EL MENSAJE: la doctrina
    // de la 075 es parar y NOMBRAR, porque las filas que el censo lista son
    // exactamente las que hoy están reteniendo de más.
    await expect(apply084()).rejects.toThrow(new RegExp(ORDER_ID));
  });

  it('y no dejó media migración puesta: ninguna restricción nueva existe todavía', async () => {
    const { rows } = await verifier.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'garnishments'::regclass
          AND conname IN ('ck_garnishments_levy_exemption', 'ck_garnishments_support_caps')`
    );
    expect(rows).toEqual([]);
  });
});

describe('capturada la exención, la 084 aplica sobre ese despacho endurecido', () => {
  it('no aborta, y normaliza el NULL que no significaba nada', async () => {
    // La reparación la hace quien puede mirarlo todo: el corredor sigue con
    // `row_security = off` y sin contexto de inquilino, así que su propia
    // escritura lanzaría 42501 — que es el defecto, no el efecto.
    await verifier.query(`UPDATE garnishments SET metadata = '{"exempt_amount": "462.50"}'::jsonb WHERE id = $1`, [
      ORDER_ID,
    ]);

    await expect(apply084()).resolves.toBeUndefined();

    const { rows } = await verifier.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM garnishments WHERE metadata IS NULL`
    );
    expect(rows[0].n, 'el NULL de la orden de acreedor tenía que haberse colapsado a {}').toBe('0');
  });

  it('deja `metadata` en NOT NULL, que es lo que el CHECK necesita para poder morder', async () => {
    const { rows } = await verifier.query<{ notnull: boolean }>(
      `SELECT attnotnull AS notnull FROM pg_attribute
        WHERE attrelid = 'garnishments'::regclass AND attname = 'metadata'`
    );
    expect(rows[0].notnull).toBe(true);
  });

  it('deja puestas las dos restricciones y el índice único del expediente', async () => {
    const { rows } = await verifier.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'garnishments'::regclass AND contype = 'c'
          AND conname IN ('ck_garnishments_levy_exemption', 'ck_garnishments_support_caps')
        ORDER BY conname`
    );
    expect(rows.map((r) => r.conname)).toEqual([
      'ck_garnishments_levy_exemption',
      'ck_garnishments_support_caps',
    ]);

    const idx = await verifier.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'garnishments' AND indexname = 'ux_garnishments_case_active'`
    );
    expect(idx.rows).toHaveLength(1);
  });

  it('y desde aquí la orden sin exención ya no se puede guardar ni con el rol que puede todo', async () => {
    await expect(
      verifier.query(
        `INSERT INTO garnishments (employee_id, garnishment_type, priority, amount_type, amount_value, start_date, is_active, metadata)
         VALUES ($1,'tax_levy_state',1,'fixed',0,'2020-01-01',true,'{"exempt_amount": null}'::jsonb)`,
        [EMPLOYEE]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });
});
