import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';

/**
 * LA 075 SOBRE UN DESPACHO YA INSTALADO Y ENDURECIDO (WIT-01 de #200).
 *
 * Witness bloqueó este PR con un hallazgo que NO reprodujo —lo dice en su
 * propio dictamen: «no hay URL administrativa ni servicio de Postgres dedicado
 * a este checkout»— y lo confirmó estáticamente. Esto lo mide.
 *
 * La acusación: `garnishments` está en `rls-policies.sql`, el corredor abre con
 * `SET row_security = off` (migrate.ts:90), y bajo esa combinación PostgreSQL
 * NO desactiva RLS: LANZA 42501 en cuanto la consulta sería afectada por una
 * política. Los dos `UPDATE` de la 075 abortarían la migración entera antes de
 * normalizar nada y antes de instalar los CHECK.
 *
 * El escenario tiene que ser el de una ACTUALIZACIÓN, no el de una instalación
 * nueva, y por eso se monta a mano: un rol NOBYPASSRLS que además es DUEÑO de
 * las tablas —sin lo segundo, FORCE ROW LEVEL SECURITY no lo sujeta—, la base
 * al día en la 074, una orden de embargo ya guardada con el vocabulario viejo,
 * y `rls-policies.sql` aplicado, que es lo que `migrate.ts` deja puesto en el
 * `finally` de cada corrida anterior.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;

const BASE = `mnem_075_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const ARCHIVO_075 = '075_el_embargo_que_no_retenia.sql';
const MIGRADOR = `it_mig075_${randomBytes(4).toString('hex')}`;

const TENANT = randomUUID();
const EMPLEADO = randomUUID();

const urlConBase = (url: string, base: string): string => {
  const u = new URL(url);
  u.pathname = `/${base}`;
  return u.toString();
};

const migracionesHasta = (hasta: number): string[] =>
  fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => Number(f.slice(0, 3)) <= hasta)
    .sort();

const sqlDe = (archivo: string): string => fs.readFileSync(path.join(DIR, archivo), 'utf-8');

let admin: pg.Client;
let db: pg.Client;

beforeAll(async () => {
  if (!ADMIN) throw new Error('falta TEST_ADMIN_DATABASE_URL / MIGRATION_DATABASE_URL / DATABASE_URL');
  admin = new pg.Client({ connectionString: urlConBase(ADMIN, 'postgres') });
  await admin.connect();
  await admin.query(`CREATE ROLE ${MIGRADOR} NOLOGIN NOBYPASSRLS`);
  await admin.query(`GRANT ${MIGRADOR} TO CURRENT_USER`);
  await admin.query(`CREATE DATABASE ${BASE} OWNER ${MIGRADOR}`);

  db = new pg.Client({ connectionString: urlConBase(ADMIN, BASE) });
  await db.connect();
  // Todo lo que sigue lo hace el corredor, no el superusuario: sin esto la
  // prueba pasaría siempre y no probaría nada.
  await db.query(`SET ROLE ${MIGRADOR}`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query('SET row_security = off');
  for (const archivo of migracionesHasta(74)) {
    await db.query('BEGIN');
    await db.query(sqlDe(archivo));
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [archivo]);
    await db.query('COMMIT');
  }

  // Un despacho con UNA orden de embargo guardada con el vocabulario viejo,
  // que es lo que la 075 viene a normalizar. Sin una sola fila el UPDATE no
  // toca nada y el defecto no se puede ver.
  const org = randomUUID();
  const entidad = randomUUID();
  await db.query(
    `INSERT INTO tenants (id, name, subdomain, schema_name) VALUES ($1,'W','w-${BASE}','s_${BASE}')`,
    [TENANT]
  );
  await db.query(`INSERT INTO organizations (id, tenant_id, name, type) VALUES ($1,$2,'G','holding')`, [org, TENANT]);
  await db.query(
    `INSERT INTO legal_entities (id, organization_id, tenant_id, name, entity_type, tax_id, tax_id_type, incorporation_country)
     VALUES ($1,$2,$3,'Acme','corporation','AA010101AAA','ein','US')`,
    [entidad, org, TENANT]
  );
  await db.query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name, hire_date, country_code, ssn_encrypted)
     VALUES ($1,$2,$3,'E-W','Ada','Lovelace','2020-01-01','US','x')`,
    [EMPLEADO, TENANT, entidad]
  );
  await db.query(
    `INSERT INTO garnishments (employee_id, garnishment_type, priority, amount_type, amount_value, start_date, is_active)
     VALUES ($1,'tax_levy',1,'percentage',25,'2020-01-01',true)`,
    [EMPLEADO]
  );

  // EL ENDURECIMIENTO, que es lo que distingue una actualización de una
  // instalación nueva: `migrate.ts` lo aplica en el `finally` de CADA corrida.
  await db.query(fs.readFileSync(path.join(DIR, '..', 'rls-policies.sql'), 'utf-8'));

  // Y EL TRAJE, OTRA VEZ. La 071 termina con `RESET ROLE` (:263) —a propósito,
  // para poder anotarse en public.migrations—, y eso devuelve la sesión al rol
  // de CONEXIÓN, que aquí es superusuario. Sin volver a ponérselo, todo lo que
  // sigue correría con RLS inerte y esta prueba pasaría siempre: es el modo
  // exacto en que un banco de pruebas miente, y ya pasó una vez con la 071.
  await db.query(`SET ROLE ${MIGRADOR}`);
}, 900_000);

afterAll(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${BASE}`);
  await admin?.query(`DROP ROLE IF EXISTS ${MIGRADOR}`);
  await admin?.end();
});

describe('el banco es el que rompía, y se comprueba antes de juzgar', () => {
  it('el corredor no es superusuario, es dueño, y no puede saltarse RLS', async () => {
    const { rows } = await db.query<{ usuario: string; sup: boolean; bypass: boolean }>(
      `SELECT current_user AS usuario,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS sup,
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

describe('la 075 aplica sobre ese despacho', () => {
  it('no aborta, y normaliza la orden que había', async () => {
    await db.query('SET row_security = off');
    await db.query('BEGIN');
    await db.query(sqlDe(ARCHIVO_075));
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [ARCHIVO_075]);
    await db.query('COMMIT');

    // La verificación se lee con el cliente ADMINISTRADOR a propósito: el
    // corredor sigue con `row_security = off` y sin contexto de inquilino, así
    // que su propia lectura lanzaría 42501 — que es el defecto, no el efecto.
    // Aquí se comprueba lo que la migración DEJÓ, y para eso hace falta un rol
    // que pueda mirarlo todo.
    const verificador = new pg.Client({ connectionString: urlConBase(ADMIN as string, BASE) });
    await verificador.connect();
    const { rows } = await verificador.query<{ amount_type: string; garnishment_type: string }>(
      `SELECT amount_type, garnishment_type FROM garnishments WHERE employee_id = $1`,
      [EMPLEADO]
    );
    await verificador.end();
    expect(rows[0].amount_type).toBe('percent_disposable');
    expect(rows[0].garnishment_type).toBe('tax_levy_federal');
  });

  it('y deja puestos los dos CHECK, que es lo que impide que vuelva a pasar', async () => {
    const { rows } = await db.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'garnishments'::regclass AND contype = 'c'
          AND conname IN ('ck_garnishments_amount_type', 'ck_garnishments_type')
        ORDER BY conname`
    );
    expect(rows.map((r) => r.conname)).toEqual([
      'ck_garnishments_amount_type',
      'ck_garnishments_type',
    ]);
  });
});
