import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';

/**
 * LA 071 SE PRUEBA EN EL ESTADO QUE LA ROMPÍA: LA ACTUALIZACIÓN.
 *
 * La 071 recrea dos vistas materializadas leyendo `accounts`. Contra el piso
 * `SET row_security = off` que pone `migrate.ts`, un rol sujeto a
 * `FORCE ROW LEVEL SECURITY` no lee filtrado: Postgres LANZA
 * `42501 · query would be affected by row-level security policy for table
 * "accounts"`. Es decir, la versión anterior de este archivo BLOQUEABA la
 * actualización de todo despacho ya instalado.
 *
 * Y no se veía por ningún lado:
 *   · en una INSTALACIÓN NUEVA no pasa, porque `rls-policies.sql` corre en el
 *     `finally` de la corrida, DESPUÉS de las migraciones: cuando la 071 se
 *     ejecuta todavía no hay políticas;
 *   · la suite de integración corre como SUPERUSUARIO, y un superusuario
 *     ignora la RLS;
 *   · y la primera prueba de este tramo aplicaba 001–071 ANTES de las
 *     políticas, así que tampoco la ejercía endurecida (WIT-03).
 *
 * Esta suite monta las tres cosas que hacen falta para que el defecto exista:
 * un rol de migración NOBYPASSRLS que es DUEÑO de las tablas, las políticas
 * aplicadas con su FORCE, y el piso `row_security = off`. Sin las tres, la
 * prueba pasa por vacuidad.
 *
 * Lo que fija, y en este orden: que la 071 APLICA en ese estado; que las
 * vistas quedan pobladas con las filas de LOS DOS despachos —una vista
 * materializada tiene por contrato que ver el clúster entero—; que los
 * permisos que el DROP se llevó vuelven; que la migración se ANOTA en la
 * misma transacción (lo que exige haber devuelto el rol antes); y que la
 * sesión no queda contaminada con el traje puesto.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;

const BASE = `mnem_071_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const ARCHIVO_071 = '071_las_vistas_que_perdian_la_archivada.sql';
/** El rol que hace de `mnemosine_owner`: no superusuario, sujeto a FORCE RLS. */
const MIGRADOR = `it_migrador_${randomBytes(4).toString('hex')}`;
/** Hace de `mnemosine_app`: el que LEE las vistas y cuyo permiso el DROP se lleva. */
const LECTOR = `it_lector_${randomBytes(4).toString('hex')}`;

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

function urlConBase(url: string, base: string): string {
  const u = new URL(url);
  u.pathname = `/${base}`;
  return u.toString();
}

function migracionesHasta(hasta: number): string[] {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => Number(f.slice(0, 3)) <= hasta)
    .sort();
}

function sqlDe(archivo: string): string {
  return fs.readFileSync(path.join(DIR, archivo), 'utf-8');
}

/** Un despacho con una cuenta, un periodo y una póliza posteada. */
async function sembrarDespacho(
  db: pg.Client,
  tenant: string,
  sufijo: string
): Promise<void> {
  const org = randomUUID();
  const user = randomUUID();
  const entidad = randomUUID();
  const cuenta = randomUUID();
  const banco = randomUUID();
  const ejercicio = randomUUID();
  const periodo = randomUUID();
  const poliza = randomUUID();

  await db.query(`INSERT INTO tenants (id, name, subdomain, schema_name) VALUES ($1,$2,$3,$4)`, [
    tenant, `Despacho ${sufijo}`, `d${sufijo}`, `t_${sufijo}`,
  ]);
  await db.query(`INSERT INTO organizations (id, tenant_id, name, type) VALUES ($1,$2,'Grupo','holding')`, [org, tenant]);
  await db.query(`INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1,$2,$3,'x')`, [user, tenant, `${sufijo}@b.c`]);
  await db.query(
    `INSERT INTO legal_entities (id, organization_id, tenant_id, name, entity_type, tax_id, tax_id_type, incorporation_country)
     VALUES ($1,$2,$3,$4,'corporation',$5,'rfc','MX')`,
    [entidad, org, tenant, `Acme ${sufijo}`, `AA${sufijo}010101AA${sufijo}`.slice(0, 13)]
  );
  // ARCHIVADA A PROPÓSITO: es la cuenta que la 071 vino a rescatar. Si la
  // vista volviera a filtrar por `is_active`, esta fila desaparecería.
  await db.query(
    `INSERT INTO accounts (id, entity_id, code, name, account_type, normal_balance, created_by, is_active)
     VALUES ($1,$2,'4100','Ventas','revenue','credit',$3,false)`,
    [cuenta, entidad, user]
  );
  await db.query(
    `INSERT INTO accounts (id, entity_id, code, name, account_type, normal_balance, created_by)
     VALUES ($1,$2,'1110','Bancos','asset','debit',$3)`,
    [banco, entidad, user]
  );
  await db.query(
    `INSERT INTO fiscal_years (id, entity_id, year_number, start_date, end_date)
     VALUES ($1,$2,2026,'2026-01-01','2026-12-31')`,
    [ejercicio, entidad]
  );
  await db.query(
    `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name, start_date, end_date, status)
     VALUES ($1,$2,$3,1,'2026-01','2026-01-01','2026-01-31','open')`,
    [periodo, ejercicio, entidad]
  );
  await db.query(
    `INSERT INTO journal_entries
       (id, entity_id, entry_number, entry_type, entry_date, fiscal_period_id, status,
        created_by, description, total_debits, total_credits, posted_date)
     VALUES ($1,$2,$3,'standard','2026-01-15',$4,'draft',$5,'venta',0,0,NULL)`,
    [poliza, entidad, `JE-2026-${sufijo}`, periodo, user]
  );
  await db.query(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit_amount, line_number)
     VALUES (gen_random_uuid(), $1, $2, 10000, 1)`,
    [poliza, banco]
  );
  await db.query(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, credit_amount, line_number)
     VALUES (gen_random_uuid(), $1, $2, 10000, 2)`,
    [poliza, cuenta]
  );
  // Se postea AL FINAL: el mayor es inviolable desde la 041, y añadirle una
  // línea a un asiento ya posteado lo prohíbe un disparador (NIF B-1).
  await db.query(
    `UPDATE journal_entries
        SET status = 'posted', total_debits = 10000, total_credits = 10000, posted_date = '2026-01-15'
      WHERE id = $1`,
    [poliza]
  );
}

let admin: pg.Client;
let db: pg.Client;

beforeAll(async () => {
  if (!ADMIN) throw new Error('falta TEST_ADMIN_DATABASE_URL / MIGRATION_DATABASE_URL / DATABASE_URL');
  admin = new pg.Client({ connectionString: urlConBase(ADMIN, 'postgres') });
  await admin.connect();

  // EL ROL QUE HACE DE CORREDOR. NOBYPASSRLS es la mitad del escenario; la
  // otra es que sea DUEÑO de las tablas, para que `FORCE ROW LEVEL SECURITY`
  // también lo sujete a él. `mnemosine_refresher` lo crea el global-setup de
  // esta suite, y la 071 exige que el corredor sea MIEMBRO suyo.
  await admin.query(`CREATE ROLE ${MIGRADOR} NOLOGIN NOBYPASSRLS`);
  await admin.query(`CREATE ROLE ${LECTOR} NOLOGIN NOBYPASSRLS`);
  await admin.query(`GRANT ${MIGRADOR} TO CURRENT_USER`);
  await admin.query(`GRANT mnemosine_refresher TO ${MIGRADOR}`);
  await admin.query(`CREATE DATABASE ${BASE} OWNER ${MIGRADOR}`);

  db = new pg.Client({ connectionString: urlConBase(ADMIN, BASE) });
  await db.connect();
  // Todo lo que sigue lo hace el corredor, no el superusuario: si esto se
  // quitara, la prueba pasaría siempre y no probaría nada.
  await db.query(`SET ROLE ${MIGRADOR}`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS public.migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Una instalación al día en la 070: el despacho que hoy no puede actualizar.
  await db.query('SET row_security = off');
  for (const archivo of migracionesHasta(70)) {
    await db.query('BEGIN');
    await db.query(sqlDe(archivo));
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [archivo]);
    await db.query('COMMIT');
  }

  await sembrarDespacho(db, TENANT_A, 'a');
  await sembrarDespacho(db, TENANT_B, 'b');

  // Y EL ENDURECIMIENTO, que es lo que distingue una actualización de una
  // instalación nueva: `migrate.ts` lo aplica en el `finally` de CADA corrida,
  // así que toda base ya instalada lo tiene puesto cuando llega la siguiente.
  await db.query(fs.readFileSync(path.join(DIR, '..', 'rls-policies.sql'), 'utf-8'));

  // EL PERMISO QUE EL `DROP` SE VA A LLEVAR. En una instalación real la
  // aplicación LEE estas vistas, y `rls-policies.sql` no puede devolvérselo:
  // su bucle de privilegios sólo recorre `relkind IN ('r','p','S')`, así que
  // una materializada queda fuera. Sin sembrarlo aquí, la prueba comprobaría
  // la devolución de una ACL vacía, que es no comprobar nada.
  await db.query(`GRANT SELECT ON mv_trial_balance, mv_account_balance_summary TO ${LECTOR}`);
}, 900_000);

afterAll(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${BASE}`);
  await admin?.query(`DROP ROLE IF EXISTS ${MIGRADOR}`);
  await admin?.query(`DROP ROLE IF EXISTS ${LECTOR}`);
  await admin?.end();
});

describe('la 071 sobre un despacho ya instalado', () => {
  it('el escenario es el que rompía: rol no superusuario, dueño, y las políticas puestas', async () => {
    const quien = await db.query<{ usuario: string; super: boolean; bypass: boolean }>(
      `SELECT current_user AS usuario,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`
    );
    expect(quien.rows[0].usuario, 'corre el corredor, no el superusuario de la suite').toBe(MIGRADOR);
    expect(quien.rows[0].super, 'un superusuario ignoraría la RLS y la prueba pasaría por vacuidad').toBe(false);
    expect(quien.rows[0].bypass).toBe(false);

    const forzadas = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_class
        WHERE relrowsecurity AND relforcerowsecurity AND relname IN ('accounts','fiscal_periods','journal_entries','journal_entry_lines')`
    );
    expect(Number(forzadas.rows[0].n), 'las cuatro tablas que la vista lee, con FORCE').toBe(4);

    // Y la prueba de que el defecto existiría: bajo el piso, leer `accounts`
    // desde este rol LANZA en vez de filtrar.
    await db.query('BEGIN');
    await db.query('SET LOCAL row_security = off');
    await expect(db.query('SELECT count(*) FROM accounts')).rejects.toMatchObject({ code: '42501' });
    await db.query('ROLLBACK');
  });

  it('aplica, y la migración queda anotada en la MISMA transacción', async () => {
    // Como `migrate.ts`: piso de sesión, y el archivo con su apunte en una
    // sola transacción. El apunte lo escribe el corredor, que es quien tiene
    // INSERT sobre `migrations`: si la 071 no devolviera el traje antes de
    // llegar aquí, esto moriría con «permission denied for table migrations».
    await db.query('SET row_security = off');
    await db.query('BEGIN');
    await db.query(sqlDe(ARCHIVO_071));
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [ARCHIVO_071]);
    await db.query('COMMIT');

    const anotada = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM public.migrations WHERE filename = $1',
      [ARCHIVO_071]
    );
    expect(Number(anotada.rows[0].n)).toBe(1);
  });

  it('las vistas quedan pobladas y ven a LOS DOS despachos, no al de la sesión', async () => {
    const pobladas = await db.query<{ relname: string; poblada: boolean }>(
      `SELECT relname, relispopulated AS poblada FROM pg_class
        WHERE relkind = 'm' AND relname IN ('mv_trial_balance','mv_account_balance_summary')
        ORDER BY relname`
    );
    expect(pobladas.rows.map((r) => r.poblada), 'crear una materializada la puebla en el acto').toEqual([true, true]);

    // EL CONTRATO DE UNA MATERIALIZADA: el clúster entero. Si se hubiera
    // creado con `row_security = on` en vez de con el traje del refrescador,
    // la orden NO habría fallado: habría dejado la vista VACÍA o con un solo
    // inquilino, que es el modo de fallo silencioso que esta aserción caza.
    const entidades = await db.query<{ n: string }>(
      `SELECT count(DISTINCT entity_id)::text AS n FROM mv_account_balance_summary`
    );
    expect(Number(entidades.rows[0].n), 'las dos entidades, una por despacho').toBe(2);

    // Y la cuenta ARCHIVADA con movimiento sigue dentro: es lo que T13 vino a
    // rescatar y lo que la 071 no puede perder al recrear.
    const archivada = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM mv_trial_balance WHERE account_code = '4100'`
    );
    expect(Number(archivada.rows[0].n), 'la archivada con movimiento, en las dos entidades').toBe(2);
  });

  it('los permisos que el DROP se llevó vuelven, y la sesión no se queda con el traje puesto', async () => {
    // El `DROP` de una materializada se lleva su ACL y NADA la repone: el
    // bucle de privilegios de `rls-policies.sql` sólo recorre tablas,
    // particiones y secuencias, así que las vistas (relkind 'm') quedan fuera.
    const acl = await db.query<{ relname: string; acl: string | null }>(
      `SELECT relname, array_to_string(relacl, ',') AS acl FROM pg_class
        WHERE relkind = 'm' AND relname IN ('mv_trial_balance','mv_account_balance_summary')
        ORDER BY relname`
    );
    for (const v of acl.rows) {
      expect(v.acl ?? '', `${v.relname} conserva la lectura de la aplicación`).toMatch(new RegExp(`${LECTOR}=[a-z]*r`));
    }

    // Y EL TRAJE SE DEVUELVE. `RESET ROLE` vuelve al rol de SESIÓN: en
    // producción ése es el corredor (`migrate.ts` conecta como él), y aquí es
    // el superusuario de la suite, porque el corredor se asumió con `SET
    // ROLE`. Lo que importa en las dos es lo mismo: al salir, nadie sigue
    // vestido de refrescador.
    //
    // La prueba FUERTE de que el traje se devolvió es el caso anterior: el
    // apunte en `public.migrations` va en la MISMA transacción y el
    // refrescador no tiene INSERT sobre esa tabla, así que sin `RESET ROLE`
    // habría muerto con «permission denied for table migrations».
    const quien = await db.query<{ usuario: string }>('SELECT current_user AS usuario');
    expect(quien.rows[0].usuario, 'nadie se queda vestido de refrescador').not.toBe('mnemosine_refresher');
  });
});
