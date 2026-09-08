import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';

/**
 * EL REMEDIO DE LA 051 SE PRUEBA SOBRE UNA BASE QUE LA TRAE TORCIDA.
 *
 * T1 (#136) reparó tres defectos EDITANDO EN SU SITIO la 051, que ya estaba
 * distribuida. `migrate.ts` omite por NOMBRE de archivo y `public.migrations`
 * no guarda checksum: donde la 051 vieja quedó registrada, la reparada no
 * corre jamás. Ese es el hallazgo crítico WIT-01 del Testigo, y la 072 es su
 * remedio.
 *
 * ── LA POBLACIÓN, QUE NO ES LA QUE PARECE ───────────────────────────────
 *
 * Reproducido con el `migrate.ts` VIEJO de verdad, como `mnemosine_owner`
 * (NOBYPASSRLS, sujeto a FORCE RLS) y con las políticas aplicadas:
 *   · con filas en `bank_transactions`, la 051 vieja ABORTA con 23502 y no se
 *     registra, así que la reparada corre sola en la siguiente actualización:
 *     esa instalación se cura sola;
 *   · con la tabla VACÍA, REGISTRA — y ahí es donde queda el daño.
 * La 060, editada en el mismo commit, no necesita remedio: aborta con 42501
 * en cuanto hay políticas, así que nunca registra dejando basura.
 *
 * ── CÓMO SE MONTA AQUÍ EL ESTADO VIEJO, Y POR QUÉ ES FIEL ───────────────
 *
 * La prueba no lee el archivo histórico de git —una suite no debe depender de
 * la historia—: aplica las migraciones de hoy y luego DESHACE las tres cosas
 * que T1 cambió, que son exactamente las tres que el archivo viejo dejaba.
 * El estado reconstruido se comparó, objeto por objeto, contra un banco
 * montado con la 051 PRE-T1 sacada de `git show 0d4494f^`: índice ÚNICO
 * `uq_bank_tx_contenido`, disparador sin `content_hash` en su `UPDATE OF`, y
 * el sello de la 058 en `tgenabled = 'A'` sobre ese disparador ciego — que es
 * lo que hace la garantía FALSA en vez de ausente.
 *
 * Esta suite corre como superusuario, así que la RLS no filtra aquí. No hace
 * falta: los tres defectos son de catálogo y de datos, no de política.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;

const BASE = `mnem_072_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const ARCHIVO_072 = '072_la_huella_que_se_podia_forjar.sql';

const TENANT = randomUUID();
const ORG = randomUUID();
const USER = randomUUID();
const ENTIDAD = randomUUID();
const CUENTA = randomUUID();
const BANCARIA = randomUUID();

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

function sql072(): string {
  return fs.readFileSync(path.join(DIR, ARCHIVO_072), 'utf-8');
}

interface Aviso {
  severity: string;
  message: string;
}

let admin: pg.Client;
let db: pg.Client;
let avisos: Aviso[] = [];

/** Como `migrate.ts`: el archivo y su apunte en `migrations`, una transacción. */
async function correrLa072(anotar = true): Promise<Error | undefined> {
  avisos = [];
  await db.query('BEGIN');
  try {
    await db.query(sql072());
    if (anotar) {
      await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [ARCHIVO_072]);
    }
    await db.query('COMMIT');
    return undefined;
  } catch (e) {
    await db.query('ROLLBACK');
    return e as Error;
  }
}

/** El índice de contenido que hay AHORA, con su unicidad. */
async function indiceDeContenido(): Promise<{ nombre: string; unico: boolean } | null> {
  const r = await db.query<{ nombre: string; unico: boolean }>(
    `SELECT c.relname AS nombre, i.indisunique AS unico
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'bank_transactions'::regclass
        AND c.relname LIKE '%bank_tx_contenido'`
  );
  return r.rows[0] ?? null;
}

/** ¿El disparador vigila `content_hash`, y sigue sellado? */
async function disparador(): Promise<{ vigila: boolean; sello: string; comentario: string | null }> {
  const r = await db.query<{ vigila: boolean; sello: string; comentario: string | null }>(
    `SELECT EXISTS (
              SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = t.tgrelid AND a.attname = 'content_hash'
                 AND a.attnum = ANY (t.tgattr::smallint[])
            ) AS vigila,
            t.tgenabled::text AS sello,
            obj_description(t.oid, 'pg_trigger') AS comentario
       FROM pg_trigger t
      WHERE t.tgrelid = 'bank_transactions'::regclass
        AND t.tgname = 'bank_transactions_content_hash'`
  );
  return r.rows[0];
}

/** Intenta meter dos movimientos legítimamente idénticos por la vía de la app. */
async function dosComisionesIdenticas(fecha: string): Promise<number> {
  const r = await db.query(
    `INSERT INTO bank_transactions
       (id, bank_account_id, transaction_date, amount, transaction_type, description)
     VALUES (gen_random_uuid(), $1, $2, -50.00, 'fee', 'COMISION MANEJO'),
            (gen_random_uuid(), $1, $2, -50.00, 'fee', 'COMISION MANEJO')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [BANCARIA, fecha]
  );
  return r.rowCount ?? 0;
}

beforeAll(async () => {
  if (!ADMIN) throw new Error('falta TEST_ADMIN_DATABASE_URL / MIGRATION_DATABASE_URL / DATABASE_URL');
  admin = new pg.Client({ connectionString: urlConBase(ADMIN, 'postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${BASE}`);

  db = new pg.Client({ connectionString: urlConBase(ADMIN, BASE) });
  await db.connect();
  const escucha = db as unknown as {
    on(evento: 'notice', cb: (n: { severity?: string; message?: string }) => void): void;
  };
  escucha.on('notice', (n) => {
    avisos.push({ severity: n.severity ?? '', message: n.message ?? '' });
  });

  await db.query(`
    CREATE TABLE IF NOT EXISTS public.migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  for (const archivo of migracionesHasta(71)) {
    await db.query('BEGIN');
    await db.query(fs.readFileSync(path.join(DIR, archivo), 'utf-8'));
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [archivo]);
    await db.query('COMMIT');
  }

  // ── EL ESTADO VIEJO, DESHECHO A MANO ────────────────────────────────
  // Las tres cosas que T1 cambió en la 051, devueltas a como estaban. Es el
  // estado que deja el archivo PRE-T1, comparado objeto por objeto contra un
  // banco montado con ese archivo real.
  await db.query('DROP INDEX IF EXISTS idx_bank_tx_contenido');
  await db.query('CREATE UNIQUE INDEX uq_bank_tx_contenido ON bank_transactions(bank_account_id, content_hash)');
  await db.query('DROP TRIGGER bank_transactions_content_hash ON bank_transactions');
  await db.query(`
    CREATE TRIGGER bank_transactions_content_hash
      BEFORE INSERT OR UPDATE OF bank_account_id, transaction_date, amount, description
      ON bank_transactions
      FOR EACH ROW EXECUTE FUNCTION bank_tx_content_hash()
  `);
  // El sello de la 058 SÍ se aplicó sobre el disparador ciego: la garantía
  // quedó sellada y falsa, que es peor que no estar.
  await db.query('ALTER TABLE bank_transactions ENABLE ALWAYS TRIGGER bank_transactions_content_hash');
  await db.query(`
    COMMENT ON TRIGGER bank_transactions_content_hash ON bank_transactions IS
      'garantia-sellada: el hash de contenido lo calcula la base ignorando lo que mande el llamador; es lo que hace imposible forjar la deduplicación.'
  `);
  await db.query(`
    COMMENT ON COLUMN bank_transactions.content_hash IS
      'sha256 de (cuenta|fecha|importe|descripción), calculado por disparador y NUNCA por el llamador. El dedupe REAL: bank_transaction_id es nullable y un UNIQUE sobre NULL no impide nada, que es por lo que reimportar un CSV duplicaba el extracto.'
  `);

  // Un despacho con su cuenta bancaria.
  await db.query(`INSERT INTO tenants (id, name, subdomain, schema_name) VALUES ($1,'Despacho','d','t_d')`, [TENANT]);
  await db.query(`INSERT INTO organizations (id, tenant_id, name, type) VALUES ($1,$2,'Grupo','holding')`, [ORG, TENANT]);
  await db.query(`INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1,$2,'a@b.c','x')`, [USER, TENANT]);
  await db.query(
    `INSERT INTO legal_entities (id, organization_id, tenant_id, name, entity_type, tax_id, tax_id_type, incorporation_country)
     VALUES ($1,$2,$3,'Acme','corporation','AAA010101AAA','rfc','MX')`,
    [ENTIDAD, ORG, TENANT]
  );
  await db.query(
    `INSERT INTO accounts (id, entity_id, code, name, account_type, normal_balance, created_by)
     VALUES ($1,$2,'1110','Bancos','asset','debit',$3)`,
    [CUENTA, ENTIDAD, USER]
  );
  await db.query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id)
     VALUES ($1,$2,'Cta','Banco',$3)`,
    [BANCARIA, ENTIDAD, CUENTA]
  );
}, 600_000);

afterAll(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${BASE}`);
  await admin?.end();
});

describe('la 072 sobre una instalación que registró la 051 vieja', () => {
  it('el daño antes del remedio: la segunda comisión legítima se pierde y la huella se puede forjar', async () => {
    // EL DINERO. Dos comisiones de manejo de -50.00 el mismo día son dos
    // hechos distintos; el hash se calcula sobre (cuenta|fecha|importe|
    // descripción), donde no hay nada que los distinga. Con el índice ÚNICO y
    // el `ON CONFLICT DO NOTHING` sin blanco que usa `insertarLineas`, la
    // segunda no entra y NADIE se entera: el sistema la reporta como
    // «duplicada», acusando al banco de repetir un renglón que era bueno.
    expect(await dosComisionesIdenticas('2026-07-15'), 'el índice único se traga una').toBe(1);
    const libros = await db.query<{ s: string }>(
      `SELECT COALESCE(sum(amount), 0)::text AS s FROM bank_transactions WHERE transaction_date = '2026-07-15'`
    );
    expect(libros.rows[0].s, 'los libros dicen la mitad de lo que cobró el banco').toBe('-50.0000');

    // LA GARANTÍA. El disparador no vigila `content_hash`, así que escribirlo
    // a mano NO lo recalcula: la huella se forja. Y la 058 selló esa garantía.
    await db.query(`UPDATE bank_transactions SET content_hash = repeat('f', 64)`);
    const forjadas = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bank_transactions WHERE content_hash = repeat('f', 64)`
    );
    expect(Number(forjadas.rows[0].n), 'la huella escrita a mano se queda').toBe(1);

    const t = await disparador();
    expect(t.vigila, 'el disparador no vigila la columna que promete imponer').toBe(false);
    expect(t.sello, 'y sin embargo la 058 lo selló: la garantía es falsa, no ausente').toBe('A');
  });

  it('la 072 repara los tres residuos y repone el sello de la 058', async () => {
    const fallo = await correrLa072();
    expect(fallo, 'la 072 aplica sobre la base torcida').toBeUndefined();

    const censo = avisos.find((a) => /la 051 sin reparar/.test(a.message));
    expect(censo?.message, 'y dice en qué la encontró').toMatch(/indice unico=t/);
    expect(censo?.message).toMatch(/disparador ciego=t/);

    const idx = await indiceDeContenido();
    expect(idx?.nombre).toBe('idx_bank_tx_contenido');
    expect(idx?.unico, 'la huella es huella, no llave: dos movimientos idénticos son dos hechos').toBe(false);

    const t = await disparador();
    expect(t.vigila, 'ahora sí impone la huella escriba quien escriba').toBe(true);
    // LA TRAMPA QUE ESTA ASERCIÓN VIGILA: `CREATE OR REPLACE TRIGGER` degrada
    // `tgenabled` de 'A' a 'O' en silencio y conserva el comentario, y
    // `DROP`+`CREATE` pierde los dos. Un remedio que no reponga ambos deja el
    // sello de la 058 colgado de un disparador que se puede volver a apagar.
    expect(t.sello, 'el ENABLE ALWAYS de la 058 vuelve a su sitio').toBe('A');
    expect(t.comentario ?? '', 'y su comentario también, o doctor deja de contarlo').toMatch(/^garantia-sellada:/);

    const col = await db.query<{ c: string }>(
      `SELECT col_description('bank_transactions'::regclass, attnum) AS c
         FROM pg_attribute WHERE attrelid = 'bank_transactions'::regclass AND attname = 'content_hash'`
    );
    expect(col.rows[0].c, 'y la documentación de la base deja de prometer lo que no daba').toMatch(/es la HUELLA de la línea, no su llave/i);
  });

  it('la huella forjada se recalcula, y ninguna fila sana se reescribe', async () => {
    const forjadas = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bank_transactions WHERE content_hash = repeat('f', 64)`
    );
    expect(Number(forjadas.rows[0].n), 'la que se escribió a mano vuelve a su valor').toBe(0);

    // Y no se reescribió la tabla entera para no cambiar nada: `xmin` de una
    // fila sana no se mueve al reejecutar.
    const antes = await db.query<{ x: string }>(
      `SELECT xmin::text AS x FROM bank_transactions ORDER BY id LIMIT 1`
    );
    const fallo = await correrLa072(false);
    expect(fallo, 'reejecutarla no falla').toBeUndefined();
    const despues = await db.query<{ x: string }>(
      `SELECT xmin::text AS x FROM bank_transactions ORDER BY id LIMIT 1`
    );
    expect(despues.rows[0].x, 'ninguna fila sana se reescribe').toBe(antes.rows[0].x);

    const dice = avisos.find((a) => /todas las huellas corresponden/.test(a.message));
    expect(dice, 'y lo dice: sobre una base ya sana no cambia nada').toBeDefined();
  });

  it('reparada la base, las dos comisiones legítimas del mismo día entran las dos', async () => {
    expect(await dosComisionesIdenticas('2026-08-20'), 'ya no se traga ninguna').toBe(2);
    const libros = await db.query<{ s: string }>(
      `SELECT sum(amount)::text AS s FROM bank_transactions WHERE transaction_date = '2026-08-20'`
    );
    expect(libros.rows[0].s, 'y los libros cuadran con el extracto').toBe('-100.0000');

    // LO QUE EL REMEDIO NO DEVUELVE, y la prueba lo fija para que nadie lo
    // confunda: la línea que el índice único ya se tragó no está, y este
    // archivo no puede inventarla. Devuelve la capacidad, no el dato.
    const julio = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bank_transactions WHERE transaction_date = '2026-07-15'`
    );
    expect(Number(julio.rows[0].n), 'lo perdido sigue perdido: hay que reimportar').toBe(1);
  });

  it('y la huella ya no se puede forjar: escribirla a mano la recalcula', async () => {
    const fila = await db.query<{ id: string; h: string }>(
      `SELECT id, content_hash AS h FROM bank_transactions ORDER BY id LIMIT 1`
    );
    await db.query(`UPDATE bank_transactions SET content_hash = repeat('a', 64) WHERE id = $1`, [fila.rows[0].id]);
    const despues = await db.query<{ h: string }>(
      `SELECT content_hash AS h FROM bank_transactions WHERE id = $1`,
      [fila.rows[0].id]
    );
    expect(despues.rows[0].h, 'el disparador ignora lo que mande el llamador').toBe(fila.rows[0].h);
  });
});
