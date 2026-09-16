import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';

/**
 * LA 085 SOBRE UN DESPACHO YA INSTALADO Y ENDURECIDO (F08 · #113).
 *
 * Misma forma que tests/integration/migracion-075-embargo-bajo-rls.int.spec.ts,
 * y por la misma razón medida allí: `garnishments` está en `rls-policies.sql`,
 * `migrate.ts` abre la sesión con `SET row_security = off`, y esa combinación
 * NO desactiva RLS — PostgreSQL LANZA 42501 en cuanto una sentencia sería
 * afectada por una política. La 075 murió así antes de instalar nada.
 *
 * La 085 hace DOS cosas que la 075 no hacía, y ninguna de las dos se puede
 * dar por buena leyendo:
 *
 *   · un `ALTER COLUMN … SET NOT NULL`, que recorre la tabla entera;
 *   · tres `ADD CONSTRAINT … CHECK`, que también.
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
 *
 * ── LO QUE «NO LO AFECTA LA POLÍTICA» SIGNIFICA, Y CÓMO SE SEPARA ───────
 *
 * Su primera redacción decía que aquí quedaba zanjado, y las aserciones que
 * traía no podían zanjarlo: con UN solo inquilino sembrado, el conjunto que ve
 * la política y el montón entero son el MISMO conjunto, así que un recorrido
 * filtrado y uno sin filtrar dan idéntico resultado. «No lanzó 42501» es
 * evidencia —con `row_security = off` una sentencia AFECTADA por una política
 * lanza, no filtra en silencio— pero no excluye la hipótesis de que el
 * recorrido mirase sólo lo visible.
 *
 * Lo que la separa es la SONDA del último describe: con la 085 ya aplicada y
 * el corredor SIN contexto de inquilino —donde la política no le enseñaría ni
 * una fila— se añade un CHECK que sólo una fila invisible viola. Tres
 * desenlaces y cada uno dice una cosa distinta: 42501 = el recorrido sí está
 * sujeto a la política; ÉXITO = está filtrado y validó contra un conjunto
 * vacío (el desenlace que de verdad da miedo en una instalación multi-
 * inquilino: restricciones «validadas» contra las filas de uno solo); 23514 =
 * el recorrido ve el montón entero, que es lo que esta prueba afirma.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;

const BASE = `mnem_085_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const FILE_085 = '085_the_order_that_nobody_could_file.sql';
const MIGRADOR = `it_mig085_${randomBytes(4).toString('hex')}`;

const TENANT = randomUUID();
const EMPLOYEE = randomUUID();
const MEXICAN = randomUUID();
const ORDER_ID = randomUUID();
const TWIN_A = randomUUID();
const TWIN_B = randomUUID();
const CASE = '2026-DF-004417';

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

/** Aplica la 085 como la aplicaría el corredor: en su transacción y con el opt-out puesto. */
async function apply085(): Promise<void> {
  await db.query('SET row_security = off');
  await db.query('BEGIN');
  try {
    await db.query(sqlOf(FILE_085));
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [FILE_085]);
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
  // Y una trabajadora MEXICANA, porque la 085 distingue por el país del
  // empleado lo que un CHECK no puede ver.
  await db.query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name, hire_date, country_code, rfc)
     VALUES ($1,$2,$3,'E-F08-MX','Sor','Juana','2020-01-01','MX','LOAA800101AAA')`,
    [MEXICAN, TENANT, entity]
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
  // UNA PENSIÓN ALIMENTICIA MEXICANA SIN LAS DOS RESPUESTAS DE LA CCPA, que
  // es el despacho que la primera redacción de la 085 dejaba sin poder
  // migrar: la cascada no corre para esta empleada (la compuerta de país), así
  // que esas dos respuestas no son hechos de su orden y exigirlas habría sido
  // pedir que se inventaran. Con `metadata` en NULL, además, para que la
  // normalización tenga que alcanzarla — si no, muere en el `SET NOT NULL`.
  await db.query(
    `INSERT INTO garnishments (employee_id, garnishment_type, priority, amount_type, amount_value, start_date, is_active, metadata)
     VALUES ($1,'pension_alimenticia',1,'percent_disposable',25,'2020-01-01',true,NULL)`,
    [MEXICAN]
  );
  // DOS ÓRDENES VIVAS CON EL MISMO EXPEDIENTE: el estado que el índice único
  // viene a prohibir, y que sin censo mataría la migración con un mensaje
  // crudo de Postgres que nombra un par por intento.
  await db.query(
    `INSERT INTO garnishments (id, employee_id, garnishment_type, priority, amount_type, amount_value, case_number, start_date, is_active, metadata)
     VALUES ($1,$3,'creditor',1,'percent_disposable',10,$4,'2020-01-01',true,'{}'::jsonb),
            ($2,$3,'creditor',1,'percent_disposable',10,$4,'2020-01-01',true,'{}'::jsonb)`,
    [TWIN_A, TWIN_B, EMPLOYEE, CASE]
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

describe('la 085 no restringe sobre datos que no cumplen: para y nombra', () => {
  it('aborta nombrando la orden que hoy retiene el cheque entero', async () => {
    // El id de la orden ofensora tiene que salir EN EL MENSAJE: la doctrina
    // de la 075 es parar y NOMBRAR, porque las filas que el censo lista son
    // exactamente las que hoy están reteniendo de más.
    await expect(apply085()).rejects.toThrow(new RegExp(ORDER_ID));
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

describe('el censo del expediente duplicado también para, y nombra el par', () => {
  it('aborta nombrando (empleado, expediente) y no un solo par crudo de Postgres', async () => {
    // La reparación la hace quien puede mirarlo todo: el corredor sigue con
    // `row_security = off` y sin contexto de inquilino, así que su propia
    // escritura lanzaría 42501 — que es el defecto, no el efecto.
    await verifier.query(`UPDATE garnishments SET metadata = '{"exempt_amount": "462.50"}'::jsonb WHERE id = $1`, [
      ORDER_ID,
    ]);

    // Ahora el censo de metadatos pasa y el que tiene que morder es el del
    // índice. Sin él, el `CREATE UNIQUE INDEX` moriría con «Key
    // (employee_id, case_number)=(…) is duplicated» DESPUÉS de que los dos
    // bloques anteriores ya corrieron, y el operador se enteraría de un par
    // por intento — lo contrario de la doctrina de este archivo.
    await expect(apply085()).rejects.toThrow(new RegExp(`${EMPLOYEE}/${CASE}`));
    await expect(apply085()).rejects.toThrow(/withheld twice per period/);
  });

  it('y el índice no quedó a medio crear', async () => {
    const { rows } = await verifier.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'garnishments' AND indexname = 'ux_garnishments_case_active'`
    );
    expect(rows).toEqual([]);
  });
});

describe('capturada la exención, la 085 aplica sobre ese despacho endurecido', () => {
  it('no aborta, y normaliza el NULL que no significaba nada', async () => {
    // Archivada la duplicada, queda un solo expediente vivo por trabajador.
    await verifier.query(`UPDATE garnishments SET is_active = false WHERE id = $1`, [TWIN_B]);

    await expect(apply085()).resolves.toBeUndefined();

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

  it('deja puestas las TRES restricciones y el índice único del expediente', async () => {
    const { rows } = await verifier.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'garnishments'::regclass AND contype = 'c'
          AND conname LIKE 'ck_garnishments_%caps'
           OR conname = 'ck_garnishments_levy_exemption'
        ORDER BY conname`
    );
    expect(rows.map((r) => r.conname)).toEqual([
      'ck_garnishments_levy_exemption',
      'ck_garnishments_maintenance_caps',
      'ck_garnishments_support_caps',
    ]);

    const idx = await verifier.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'garnishments' AND indexname = 'ux_garnishments_case_active'`
    );
    expect(idx.rows).toHaveLength(1);
  });

  it('y la orden mexicana sigue ahí, con su `{}` y sin dos respuestas inventadas', async () => {
    const { rows } = await verifier.query<{ metadata: unknown }>(
      `SELECT metadata FROM garnishments WHERE employee_id = $1`,
      [MEXICAN]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({});
  });

  it('y desde aquí la orden sin exención ya no se puede guardar ni con el rol que puede todo', async () => {
    for (const metadata of ['{"exempt_amount": null}', '{"exempt_amount": "0"}', '{"exempt_amount": ""}']) {
      await expect(
        verifier.query(
          `INSERT INTO garnishments (employee_id, garnishment_type, priority, amount_type, amount_value, start_date, is_active, metadata)
           VALUES ($1,'tax_levy_state',1,'fixed',0,'2020-01-01',true,$2::jsonb)`,
          [EMPLOYEE, metadata]
        )
      ).rejects.toMatchObject({ code: '23514' });
    }
  });
});

describe('y el recorrido de DDL ve el montón entero, no lo que la política enseña', () => {
  it('un CHECK que sólo viola una fila INVISIBLE para el corredor se rechaza igual', async () => {
    // LA SONDA QUE SEPARA LAS DOS HIPÓTESIS. El corredor va con
    // `row_security = off` y SIN contexto de inquilino, de modo que la
    // política no le enseñaría ni una fila: si el recorrido de validación
    // estuviera sujeto a ella, este CHECK se crearía tan feliz sobre un
    // conjunto vacío. Tres desenlaces posibles y cada uno dice algo
    // distinto —42501: sujeto a la política; éxito: filtrado, o sea
    // restricciones «validadas» contra las filas de un inquilino; 23514: ve
    // el montón entero—, y sólo el tercero sostiene lo que la 085 necesita
    // para que su `SET NOT NULL` y sus CHECK signifiquen algo en una
    // instalación con varios despachos.
    await verifier.query(
      `UPDATE garnishments SET amount_value = 12345.6789 WHERE id = $1`,
      [ORDER_ID]
    );
    await db.query('SET row_security = off');
    // LA PREMISA, COMPROBADA Y NO SUPUESTA: en esta sesión una lectura normal
    // de la tabla ni siquiera llega a devolver filas — la política la
    // rechaza—, así que la fila de abajo es invisible por todos los caminos
    // que la política gobierna.
    await expect(db.query('SELECT amount_value FROM garnishments')).rejects.toMatchObject({
      code: '42501',
    });

    await expect(
      db.query(`ALTER TABLE garnishments ADD CONSTRAINT tmp_scan_probe CHECK (amount_value <> 12345.6789)`)
    ).rejects.toMatchObject({ code: '23514' });

    const left = await verifier.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'garnishments'::regclass AND conname = 'tmp_scan_probe'`
    );
    expect(left.rows, 'la sonda no puede dejar nada puesto').toEqual([]);
  });
});
