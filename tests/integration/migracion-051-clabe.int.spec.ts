import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';

/**
 * LA 051 NO SE LLEVA POR DELANTE UNA CLABE QUE YA ESTUVIERA GUARDADA.
 *
 * La 051 sustituye `bank_accounts.clabe` —texto en claro desde la 003— por
 * `clabe_encrypted` + `clabe_last4`, y para eso suelta la columna vieja. Su
 * primera versión lo justificaba diciendo que NADIE la escribe: ni un
 * servicio, ni una ruta, ni la siembra. Es cierto del código de HOY, y no
 * prueba nada sobre las bases ya desplegadas: la columna lleva viva desde la
 * 003 y una instalación pudo poblarla por SQL, por una versión anterior o por
 * una carga. El dato que se perdería es el más sensible del maestro bancario,
 * porque en México la CLABE ES el número de cuenta.
 *
 * Tampoco se puede migrar dentro del archivo: `clabe_encrypted` se cifra con
 * la llave de la APLICACIÓN, que vive en el proceso de Node. Una migración SQL
 * no tiene con qué, y una columna llamada `_encrypted` guardando texto plano
 * sería peor que el problema.
 *
 * Así que la 051 comprueba y se planta. Esta prueba fija las dos direcciones
 * sobre una base de verdad migrada hasta la 050:
 *
 *   1. Con una CLABE guardada, la 051 FALLA, el dato sobrevive y la columna
 *      sigue ahí. Sin esto, el hueco sólo se descubre cuando alguien busca
 *      una cuenta que ya no existe.
 *   2. Sin CLABEs, la 051 aplica igual que siempre: la guarda no le cobra
 *      peaje a la base de desarrollo, a la de CI ni a la instalación que
 *      nunca usó la columna.
 *
 * La guarda mira bajo el piso de RLS con el patrón sancionado (SET LOCAL
 * row_security = on más el GUC por inquilino). No es adorno: `migrate.ts`
 * corre con `row_security = off`, y sin el opt-in el conteo vería CERO filas
 * y daría el visto bueno EXACTAMENTE en la base que venía a proteger — el
 * mismo mecanismo que dejó a la 037, la 040 y la 043 sembrando en vacío.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;

const BASE = `mnem_051_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');

const TENANT = '11111111-1111-1111-1111-111111111111';
const ORG = '55555555-5555-5555-5555-555555555555';
const USER = '66666666-6666-6666-6666-666666666666';
const ENTIDAD = '22222222-2222-2222-2222-222222222222';
const CUENTA = '44444444-4444-4444-4444-444444444444';
const BANCARIA = '33333333-3333-3333-3333-333333333333';
/** CLABE con dígito verificador válido: es un dato, no un relleno. */
const CLABE = '012180001234567895';

function urlConBase(url: string, base: string): string {
  const u = new URL(url);
  u.pathname = `/${base}`;
  return u.toString();
}

/** Los archivos hasta `hasta` inclusive, en orden. */
function migracionesHasta(hasta: number): string[] {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => Number(f.slice(0, 3)) <= hasta)
    .sort();
}

function sqlDe(prefijo: string): string {
  const f = fs.readdirSync(DIR).find((x) => x.startsWith(prefijo) && x.endsWith('.sql'));
  if (!f) throw new Error(`no encuentro la migración ${prefijo}`);
  return fs.readFileSync(path.join(DIR, f), 'utf-8');
}

let admin: pg.Client;
let db: pg.Client;

beforeAll(async () => {
  if (!ADMIN) throw new Error('falta TEST_ADMIN_DATABASE_URL / DATABASE_URL');
  admin = new pg.Client({ connectionString: urlConBase(ADMIN, 'postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${BASE}`);

  db = new pg.Client({ connectionString: urlConBase(ADMIN, BASE) });
  await db.connect();

  // Una base PRE-051: exactamente lo que tiene una instalación que se
  // desplegó antes de este PR. Cada archivo en su transacción, como migrate.ts.
  for (const archivo of migracionesHasta(50)) {
    await db.query('BEGIN');
    await db.query(fs.readFileSync(path.join(DIR, archivo), 'utf-8'));
    await db.query('COMMIT');
  }
}, 300_000);

afterAll(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${BASE}`);
  await admin?.end();
});

describe('la 051 frente a una CLABE ya guardada', () => {
  it('la base pre-051 tiene la columna en claro, que es lo que hay que proteger', async () => {
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_name = 'bank_accounts' AND column_name = 'clabe'`
    );
    expect(r.rows[0].n, 'la 003 la creó y hasta aquí sigue viva').toBe('1');
  });

  it('con una CLABE guardada, la migración se planta y el dato sobrevive', async () => {
    await db.query(
      `INSERT INTO tenants (id, name, subdomain, schema_name) VALUES ($1,'D','d','t_d')`,
      [TENANT]
    );
    await db.query(
      `INSERT INTO organizations (id, tenant_id, name, type) VALUES ($1,$2,'Grupo','holding')`,
      [ORG, TENANT]
    );
    await db.query(
      `INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1,$2,'a@b.c','x')`,
      [USER, TENANT]
    );
    await db.query(
      `INSERT INTO legal_entities
         (id, organization_id, tenant_id, name, entity_type, tax_id, tax_id_type, incorporation_country)
       VALUES ($1,$2,$3,'Acme','corporation','AAA010101AAA','rfc','MX')`,
      [ENTIDAD, ORG, TENANT]
    );
    await db.query(
      `INSERT INTO accounts (id, entity_id, code, name, account_type, normal_balance, created_by)
       VALUES ($1,$2,'1110','Bancos','asset','debit',$3)`,
      [CUENTA, ENTIDAD, USER]
    );
    await db.query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, clabe)
       VALUES ($1,$2,'Cta','Banco',$3,$4)`,
      [BANCARIA, ENTIDAD, CUENTA, CLABE]
    );

    // Como migrate.ts: el archivo entero en una transacción, con el piso puesto.
    let fallo: Error | undefined;
    await db.query('BEGIN');
    await db.query('SET row_security = off');
    try {
      await db.query(sqlDe('051'));
      await db.query('COMMIT');
    } catch (e) {
      fallo = e as Error;
      await db.query('ROLLBACK');
    }

    expect(fallo, 'la 051 tiene que negarse a correr sobre una CLABE guardada').toBeDefined();
    // El mensaje es la mitad del arreglo: sin el número de cuentas afectadas
    // el operador no sabe si son dos o dos mil.
    expect(fallo!.message).toMatch(/051 se detiene/);
    expect(fallo!.message).toMatch(/1 cuenta\(s\) con CLABE/);

    const sobrevive = await db.query<{ clabe: string }>(
      `SELECT clabe FROM bank_accounts WHERE id = $1`,
      [BANCARIA]
    );
    expect(sobrevive.rows[0]?.clabe, 'el dato sigue ahí, entero').toBe(CLABE);

    const columna = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_name = 'bank_accounts' AND column_name = 'clabe'`
    );
    expect(columna.rows[0].n, 'y la columna tampoco se fue').toBe('1');
  }, 120_000);

  it('sin CLABEs guardadas, la 051 aplica como siempre', async () => {
    await db.query(`UPDATE bank_accounts SET clabe = NULL WHERE id = $1`, [BANCARIA]);

    await db.query('BEGIN');
    await db.query('SET row_security = off');
    await db.query(sqlDe('051'));
    await db.query('COMMIT');

    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'bank_accounts' AND column_name LIKE 'clabe%'
        ORDER BY column_name`
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(['clabe_encrypted', 'clabe_last4']);
  }, 120_000);
});
