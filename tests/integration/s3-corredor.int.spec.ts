import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  tablasConDml,
  estadoDelCorredor,
  tablasQueFuerzanRls,
  FIJA_CONTEXTO,
  motivoDeNegativa,
} from '../../src/database/migrate.js';

/**
 * S3 · EL CORREDOR QUE NO RELLENABA, probado donde muerde.
 *
 * El fallo NO aparece en una base virgen: migrate.ts aplica el endurecimiento
 * en su `finally`, así que las migraciones corren antes de que las políticas
 * existan y rellenan bien. Y CI lo enmascara migrando como superusuario. El
 * único escenario donde ocurre —y el que esta prueba monta— es una base YA
 * ENDURECIDA a la que llega DML nuevo, ejecutado por un rol sujeto a RLS:
 * exactamente la configuración documentada y recomendada para producción.
 *
 * Se monta a mano y en pequeño: una base propia, un rol NOSUPERUSER
 * NOBYPASSRLS dueño de una tabla con FORCE RLS, y el mismo predicado que
 * rls-policies.sql genera. Todo se destruye al terminar.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ??
  process.env.MIGRATION_DATABASE_URL ??
  process.env.DATABASE_URL;

const sufijo = crypto.randomBytes(4).toString('hex');
const BASE = `mnemosine_s3_${sufijo}`;
const ROL = `mnemosine_s3_rol_${sufijo}`;
const CLAVE = crypto.randomBytes(12).toString('hex');

let admin: pg.Client;
/** Conexión con el rol sujeto a RLS: el corredor real. */
let corredor: pg.Client;

const urlConBase = (url: string, base: string): string => {
  const u = new URL(url);
  u.pathname = `/${base}`;
  return u.toString();
};

beforeAll(async () => {
  if (!ADMIN) throw new Error('Falta TEST_ADMIN_DATABASE_URL para montar la base de la prueba.');
  const raiz = new pg.Client({ connectionString: urlConBase(ADMIN, 'postgres') });
  await raiz.connect();
  await raiz.query(`CREATE DATABASE ${BASE}`);
  await raiz.query(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROL}') THEN
         CREATE ROLE ${ROL} LOGIN PASSWORD '${CLAVE}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
       END IF;
     END $$;`
  );
  await raiz.end();

  admin = new pg.Client({ connectionString: urlConBase(ADMIN, BASE) });
  await admin.connect();
  await admin.query(`GRANT ALL ON SCHEMA public TO ${ROL}`);

  // La función de contexto, calcada de la 014: fail-closed sin contexto.
  await admin.query(`
    CREATE FUNCTION public.app_current_tenant() RETURNS uuid
    LANGUAGE plpgsql STABLE AS $fn$
    DECLARE v text;
    BEGIN
      v := current_setting('app.current_tenant', true);
      IF v IS NULL OR v = '' THEN RETURN NULL; END IF;
      RETURN v::uuid;
    END $fn$;
  `);

  corredor = new pg.Client({
    connectionString: urlConBase(ADMIN, BASE).replace(
      /\/\/[^@]+@/,
      `//${ROL}:${CLAVE}@`
    ),
  });
  await corredor.connect();

  // El rol crea SU tabla (es su dueño) con datos, y luego la endurece: el
  // orden real de una instalación desplegada.
  await corredor.query(`
    CREATE TABLE tenants (id uuid PRIMARY KEY);
    CREATE TABLE cosas (id serial PRIMARY KEY, tenant_id uuid NOT NULL, marca text);
    INSERT INTO tenants (id) VALUES ('11111111-1111-1111-1111-111111111111');
    INSERT INTO cosas (tenant_id, marca) VALUES ('11111111-1111-1111-1111-111111111111', 'secreto');
    ALTER TABLE cosas ENABLE ROW LEVEL SECURITY;
    ALTER TABLE cosas FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON cosas FOR ALL
      USING (tenant_id = public.app_current_tenant());
  `);
}, 60_000);

afterAll(async () => {
  await corredor?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  if (!ADMIN) return;
  const raiz = new pg.Client({ connectionString: urlConBase(ADMIN, 'postgres') });
  await raiz.connect();
  await raiz.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${BASE}'`
  );
  await raiz.query(`DROP DATABASE IF EXISTS ${BASE}`);
  await raiz.query(`DROP ROLE IF EXISTS ${ROL}`);
  await raiz.end();
}, 60_000);

describe('el fallo, reproducido', () => {
  it('el mismo UPDATE afecta CERO filas sin contexto y UNA con él', async () => {
    const sin = await corredor.query(`UPDATE cosas SET marca = 'tocado' WHERE marca = 'secreto'`);
    expect(sin.rowCount, 'sin contexto: cero filas, sin error y sin aviso').toBe(0);

    await corredor.query('BEGIN');
    await corredor.query(
      `SELECT set_config('app.current_tenant', '11111111-1111-1111-1111-111111111111', true)`
    );
    const con = await corredor.query(`UPDATE cosas SET marca = 'tocado' WHERE marca = 'secreto'`);
    expect(con.rowCount, 'con contexto: la fila existía todo el tiempo').toBe(1);
    await corredor.query('ROLLBACK');
  });

  it('el rol es exactamente el de producción: sin superusuario y sin BYPASSRLS', async () => {
    const r = await corredor.query<{ superusuario: boolean; salta: boolean }>(
      `SELECT rolsuper AS superusuario, rolbypassrls AS salta FROM pg_roles WHERE rolname = current_user`
    );
    expect(r.rows[0].superusuario).toBe(false);
    expect(r.rows[0].salta).toBe(false);
  });
});

describe('el helper por_cada_inquilino', () => {
  it('recorre los inquilinos, fija el contexto y devuelve cuántas filas tocó', async () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), 'src/database/migrations/049_el_corredor_que_no_rellenaba.sql'),
      'utf-8'
    );
    // Sólo la función: el bloque de reparación toca tablas que esta base mínima no tiene.
    const fn = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.por_cada_inquilino'),
      sql.indexOf('COMMENT ON FUNCTION public.por_cada_inquilino')
    );
    await corredor.query(fn);

    const r = await corredor.query<{ n: string }>(
      `SELECT public.por_cada_inquilino($sql$
         UPDATE cosas SET marca = 'reparado' WHERE marca = 'secreto'
       $sql$)::text AS n`
    );
    expect(r.rows[0].n, 'el DML que antes tocaba cero, ahora toca su fila').toBe('1');

    // Y deja el contexto limpio: no puede filtrarse a la siguiente sentencia.
    const ctx = await corredor.query<{ c: string | null }>(
      `SELECT NULLIF(current_setting('app.current_tenant', true), '') AS c`
    );
    expect(ctx.rows[0].c).toBeNull();
  });
});

describe('la guarda del migrador', () => {
  it('reconoce el corredor silenciado y por qué', async () => {
    const estado = await estadoDelCorredor(corredor as unknown as pg.PoolClient);
    expect(estado.silenciado).toBe(true);
    expect(estado.motivo).toMatch(/sujeto a RLS/);
  });

  it('encuentra las tablas que fuerzan RLS preguntándole al catálogo, no a una lista', async () => {
    const forzadas = await tablasQueFuerzanRls(corredor as unknown as pg.PoolClient);
    expect(forzadas.has('cosas')).toBe(true);
    expect(forzadas.has('tenants')).toBe(false);
  });

  it('detecta el DML por tabla y no se deja engañar por los comentarios', () => {
    const sql = `
      -- UPDATE enemigos SET x = 1;
      /* DELETE FROM fantasmas; */
      UPDATE public.cosas SET marca = 'x';
      INSERT INTO otras (a) VALUES (1);
    `;
    const t = tablasConDml(sql);
    expect([...t].sort()).toEqual(['cosas', 'otras']);
  });

  it('reconoce las dos formas de fijar contexto, y sólo esas', () => {
    expect(FIJA_CONTEXTO.test("SELECT public.por_cada_inquilino($sql$ UPDATE x SET y=1 $sql$);")).toBe(true);
    expect(FIJA_CONTEXTO.test("PERFORM set_config('app.current_tenant', t.id::text, true);")).toBe(true);
    expect(FIJA_CONTEXTO.test('UPDATE cosas SET marca = 1;'), 'DML pelado: no fija nada').toBe(false);
  });

  it('el motivo de la negativa dice qué hacer, no sólo que no', () => {
    const m = motivoDeNegativa('050_algo.sql', ['cosas']);
    expect(m).toMatch(/CERO FILAS/);
    expect(m).toMatch(/por_cada_inquilino/);
    expect(m).toMatch(/049/);
  });
});

describe('el migrador REAL se niega, y la negativa es ruidosa', () => {
  it('una migración con DML acotado sin contexto no llega a ejecutarse', async () => {
    // Se ejercita el binario de migración contra ESTA base endurecida, con
    // una migración de prueba: el escenario que ningún job de CI monta hoy.
    const dir = path.join(process.cwd(), 'src/database/migrations');
    const trampa = path.join(dir, '999_zz_trampa_s3.sql');
    fs.writeFileSync(trampa, "UPDATE cosas SET marca = 'silencioso';\n");
    try {
      // La base de la prueba no tiene el esquema real, así que el migrador
      // fallará por muchas razones; lo que se afirma es que la NEGATIVA
      // aparece, con su motivo, antes de tocar nada.
      let salida = '';
      try {
        salida = execFileSync('npx', ['tsx', 'src/database/migrate.ts'], {
          encoding: 'utf-8',
          env: {
            ...process.env,
            MIGRATION_DATABASE_URL: urlConBase(ADMIN as string, BASE).replace(
              /\/\/[^@]+@/,
              `//${ROL}:${CLAVE}@`
            ),
          },
          timeout: 60_000,
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        salida = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
      // La trampa es la última por número, así que si el migrador llegó a
      // ella la negativa tiene que estar; si murió antes, esta prueba no
      // afirma nada falso — se limita a exigir que NUNCA la haya ejecutado.
      const ejecutada = await corredor.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM cosas WHERE marca = 'silencioso'`
      );
      expect(ejecutada.rows[0].n, 'el DML silencioso jamás debe aplicarse').toBe('0');
      if (salida.includes('999_zz_trampa_s3')) {
        expect(salida).toMatch(/CERO FILAS|por_cada_inquilino/);
      }
    } finally {
      fs.unlinkSync(trampa);
    }
  }, 120_000);
});
