import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';

/**
 * LA 070 SE PRUEBA CORRIÉNDOLA, NO LEYÉNDOLA.
 *
 * La 070 corrige `imss_employee.enfermedades_maternidad` de 0.00625 a 0.004
 * (art. 106-II LSS: 0.40 % del excedente de tres UMA). El criterio E4.1 del
 * tablero la vigila con expresiones regulares sobre el archivo: comprueba que
 * el número ESTÉ ESCRITO. Eso da verde con la migración escrita y no aplicada,
 * que es exactamente el falso verde que ya pagaron los criterios de la 040 y
 * la 043 —leían el DML y daban por hecho el efecto— hasta que se convirtieron
 * en criterios que preguntan a los datos.
 *
 * Aquí se ejecutan las cuatro conductas de la 070 sobre una base de verdad
 * migrada hasta la 069, es decir sobre el ESTADO HISTÓRICO real: la fila
 * MX/2026 con 0.00625 no se fabrica, la siembra la 009 como en cualquier
 * instalación desplegada antes de este arreglo.
 *
 * ── UNA ADVERTENCIA SOBRE LA RAMA QUE SE FUERZA ─────────────────────────
 *
 * La guarda `RAISE EXCEPTION ... sigue en 0.00625` es INALCANZABLE por el
 * camino real, y conviene que quede escrito en vez de disimulado con una
 * prueba que la «cubra» sin ejecutarla. Su SELECT (¿queda alguna fila en
 * 0.00625?) y el WHERE del UPDATE son equivalentes sobre el conjunto que les
 * importa: si el SELECT ve la fila, el UPDATE ya la reescribió. Sólo se
 * separan si algo IMPIDE el UPDATE dejando la fila visible —un trigger, una
 * RULE, o una carrera con otra sesión, que el corredor de una sola conexión
 * (`migrate.ts`, pool `max: 1`) no puede producir—.
 *
 * Así que el caso 2 la fuerza con un trigger BEFORE UPDATE que devuelve NULL.
 * El artificio es deliberado y lo que prueba es real: cuando la guarda salta,
 * la transacción entera se deshace y la migración NO queda registrada. Sin esa
 * prueba, la única defensa de esa rama es su propio mutante, y un mutante
 * comprueba que el texto cambió, no que Postgres haga lo que el texto dice.
 *
 * La RLS no interviene: `tax_parameters` está deliberadamente excluida en
 * `rls-policies.sql` («global/shared») porque no tiene `tenant_id` —la ley es
 * la misma para todos los inquilinos—, y el corredor corre además con
 * `row_security = off`, que aquí se reproduce.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;

const BASE = `mnem_070_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');

/** El nombre exacto con el que el corredor la anota en `public.migrations`. */
const ARCHIVO_070 = '070_la_cuota_que_el_trabajador_no_debia.sql';

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

/** El texto REAL del archivo en disco: si alguien lo cambia, cambia lo probado. */
function sql070(): string {
  return fs.readFileSync(path.join(DIR, ARCHIVO_070), 'utf-8');
}

interface Aviso {
  severity: string;
  code: string;
  message: string;
}

let admin: pg.Client;
let db: pg.Client;
let avisos: Aviso[] = [];

/**
 * Corre la 070 como la corre `migrate.ts`: el archivo entero y el apunte en
 * `public.migrations` dentro de UNA transacción, con ROLLBACK de las dos cosas
 * si algo revienta (migrate.ts:128-141). Que sean un solo acto es la mitad de
 * lo que esta prueba vigila: si se registrara aparte, un fallo dejaría la
 * migración anotada y sin aplicar, o aplicada y sin anotar.
 */
async function correrLa070(): Promise<Error | undefined> {
  await db.query('BEGIN');
  try {
    await db.query(sql070());
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [ARCHIVO_070]);
    await db.query('COMMIT');
    return undefined;
  } catch (e) {
    await db.query('ROLLBACK');
    return e as Error;
  }
}

/** La hoja que la 070 corrige, leída como NÚMERO y no como texto. */
async function cuotaObrera(anio: number): Promise<string | null> {
  const r = await db.query<{ v: string | null }>(
    `SELECT (params #>> '{imss_employee,enfermedades_maternidad}')::numeric::text AS v
       FROM tax_parameters WHERE jurisdiction = 'MX' AND tax_year = $1`,
    [anio]
  );
  return r.rows[0]?.v ?? null;
}

async function anotadaLa070(): Promise<number> {
  const r = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM public.migrations WHERE filename = $1',
    [ARCHIVO_070]
  );
  return Number(r.rows[0].n);
}

beforeAll(async () => {
  if (!ADMIN) throw new Error('falta TEST_ADMIN_DATABASE_URL / MIGRATION_DATABASE_URL / DATABASE_URL');
  admin = new pg.Client({ connectionString: urlConBase(ADMIN, 'postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${BASE}`);

  db = new pg.Client({ connectionString: urlConBase(ADMIN, BASE) });
  await db.connect();
  // NOTICE y WARNING no viajan en el resultado: llegan por el canal asíncrono
  // de libpq. Sin escucharlos, la rama que «avisa» se probaría sólo por lo que
  // NO hace, que es como no probarla.
  // El `@types/pg` instalado no exporta el tipo del aviso, así que se declara
  // la forma que se usa en vez de dejarla en `any`: lo que no se nombra, el
  // lint lo cuenta como acceso inseguro, y con razón.
  const escucha = db as unknown as {
    on(evento: 'notice', cb: (n: { severity?: string; code?: string; message?: string }) => void): void;
  };
  escucha.on('notice', (n) => {
    avisos.push({ severity: n.severity ?? '', code: n.code ?? '', message: n.message ?? '' });
  });

  // El piso del corredor (migrate.ts:90), a nivel de sesión y antes de las
  // transacciones, igual que en producción.
  await db.query('SET row_security = off');

  // Una base PRE-070: lo que tiene una instalación desplegada antes de este
  // arreglo, con su fila MX/2026 sembrada por la 009 y equivocada.
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  for (const archivo of migracionesHasta(69)) {
    await db.query('BEGIN');
    await db.query(fs.readFileSync(path.join(DIR, archivo), 'utf-8'));
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [archivo]);
    await db.query('COMMIT');
  }
}, 600_000);

afterAll(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${BASE}`);
  await admin?.end();
});

beforeEach(() => {
  avisos = [];
});

describe('la 070 sobre una instalación que ya cobraba de más', () => {
  it('el estado histórico es el que dejó la 009: la cuota obrera vale 0.00625 y la 070 no está anotada', async () => {
    // EL BANCO SE COMPRUEBA, NO SE AFIRMA. Que la base esté migrada hasta la
    // 069 es la premisa de todo lo demás: si el montaje se quedara corto, los
    // casos siguientes medirían otra cosa y nadie se enteraría.
    const aplicadas = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.migrations');
    expect(Number(aplicadas.rows[0].n), 'la base está migrada hasta la 069, ni más ni menos').toBe(
      migracionesHasta(69).length
    );

    expect(await cuotaObrera(2026), 'la 009 la sembró con el valor de la casilla de al lado').toBe('0.00625');
    expect(await anotadaLa070(), 'todavía no se ha aplicado').toBe(0);

    // La pareja del mismo artículo, para poder comprobar la obrera contra la
    // ley y no contra sí misma: patrón 1.10 % sobre el MISMO excedente.
    const patronal = await db.query<{ v: string }>(
      `SELECT (params #>> '{imss_employer,enfermedades_maternidad_excedente}')::numeric::text AS v
         FROM tax_parameters WHERE jurisdiction = 'MX' AND tax_year = 2026`
    );
    expect(patronal.rows[0].v, 'la mitad patronal del art. 106-II ya estaba bien').toBe('0.011');
  });

  it('si algo impide el UPDATE, la guarda detiene la actualización y NO la deja anotada', async () => {
    // ARTIFICIO DELIBERADO, explicado en la cabecera: por el camino real esta
    // rama no se alcanza, porque el SELECT de la guarda y el WHERE del UPDATE
    // son equivalentes. El trigger reproduce la única situación que las separa
    // —el UPDATE no alcanza una fila que el SELECT sí ve— para poder probar lo
    // que la guarda hace CUANDO salta, que es de lo que depende que una
    // instalación no quede registrada como corregida sin estarlo.
    await db.query(`
      CREATE FUNCTION congela_tax_parameters() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$
    `);
    await db.query(`
      CREATE TRIGGER congelada BEFORE UPDATE ON tax_parameters
      FOR EACH ROW EXECUTE FUNCTION congela_tax_parameters()
    `);

    try {
      const fallo = await correrLa070();

      expect(fallo, 'un relleno que no rellenó nada tiene que detener la actualización').toBeDefined();
      expect((fallo as unknown as { code?: string })?.code, 'RAISE EXCEPTION sin ERRCODE es P0001').toBe('P0001');
      expect(fallo!.message).toMatch(/sigue en 0\.00625 en 1 fila\(s\)/);

      expect(await anotadaLa070(), 'la 070 NO queda anotada: la siguiente corrida la reintenta').toBe(0);
      expect(await cuotaObrera(2026), 'y no queda medio aplicada: el dato sigue como estaba').toBe('0.00625');
    } finally {
      await db.query('DROP TRIGGER congelada ON tax_parameters');
      await db.query('DROP FUNCTION congela_tax_parameters()');
    }
  });

  it('corrige la cuota obrera a 0.004, deja intactas las otras cuatro y queda anotada', async () => {
    const fallo = await correrLa070();
    expect(fallo, 'sobre el estado histórico la 070 aplica sin quejarse').toBeUndefined();

    expect(await cuotaObrera(2026), 'art. 106-II LSS: 0.40 % del excedente de tres UMA').toBe('0.004');

    // Y ES UN NÚMERO, no una cadena: la hoja tiene que seguir siendo del mismo
    // tipo que sus vecinas, o `imss-calculator.ts` compararía peras con textos.
    const tipo = await db.query<{ t: string }>(
      `SELECT jsonb_typeof(params #> '{imss_employee,enfermedades_maternidad}') AS t
         FROM tax_parameters WHERE jurisdiction = 'MX' AND tax_year = 2026`
    );
    expect(tipo.rows[0].t).toBe('number');

    // LAS OTRAS CUATRO NO SE TOCAN. `invalidez_vida` vale 0.00625 —es el art.
    // 147 y es correcto—, así que una corrección de brocha gorda («quítese todo
    // 0.00625 del JSON») rompería la ley por el otro lado. Esta aserción es la
    // que impide ese arreglo.
    const otras = await db.query<{ iv: string; pd: string; gm: string; cv: string }>(
      `SELECT (params #>> '{imss_employee,invalidez_vida}')::numeric::text AS iv,
              (params #>> '{imss_employee,prestaciones_dinero}')::numeric::text AS pd,
              (params #>> '{imss_employee,gastos_medicos_pensionados}')::numeric::text AS gm,
              (params #>> '{imss_employee,cesantia_vejez}')::numeric::text AS cv
         FROM tax_parameters WHERE jurisdiction = 'MX' AND tax_year = 2026`
    );
    expect(otras.rows[0]).toEqual({ iv: '0.00625', pd: '0.0025', gm: '0.00375', cv: '0.01125' });

    expect(await anotadaLa070(), 'y ahora sí queda anotada, en el mismo acto').toBe(1);

    const dice = avisos.find((a) => /corregida a 0\.004/.test(a.message));
    expect(dice?.message, 'la migración cuenta cuántos ejercicios tocó, o nadie sabe si tocó alguno').toMatch(
      /en 1 ejercicio\(s\)/
    );
  });

  it('reejecutarla no reescribe la fila: la segunda pasada corrige cero', async () => {
    const antes = await db.query<{ x: string }>(
      `SELECT xmin::text AS x FROM tax_parameters WHERE jurisdiction = 'MX' AND tax_year = 2026`
    );

    await db.query('BEGIN');
    await db.query(sql070()); // sin el apunte: `filename` es UNIQUE y no es lo que se prueba aquí
    await db.query('COMMIT');

    expect(await cuotaObrera(2026), 'sigue en la cifra de la ley').toBe('0.004');
    const despues = await db.query<{ x: string }>(
      `SELECT xmin::text AS x FROM tax_parameters WHERE jurisdiction = 'MX' AND tax_year = 2026`
    );
    // xmin es la transacción que escribió la versión viva de la fila. Si la
    // segunda pasada la hubiera reescrito con el mismo valor, cambiaría: es la
    // diferencia entre «no hizo falta» y «lo volvió a hacer».
    expect(despues.rows[0].x, 'ninguna fila reescrita').toBe(antes.rows[0].x);

    const dice = avisos.find((a) => /corregida a 0\.004/.test(a.message));
    expect(dice?.message).toMatch(/en 0 ejercicio\(s\)/);
  });

  it('un valor distinto de los dos conocidos no se toca, pero se nombra', async () => {
    // Una corrección local deliberada: la migración no tiene por qué pisarla,
    // pero un parámetro fiscal que nadie sabe de dónde salió es su propio
    // problema y tiene que salir por pantalla.
    await db.query(
      `INSERT INTO tax_parameters (jurisdiction, tax_year, params)
       VALUES ('MX', 2025, '{"imss_employee":{"enfermedades_maternidad":0.005}}'::jsonb)`
    );
    try {
      await db.query('BEGIN');
      await db.query(sql070());
      await db.query('COMMIT');

      expect(await cuotaObrera(2025), 'no se toca').toBe('0.005');

      const aviso = avisos.find((a) => a.severity === 'WARNING');
      expect(aviso, 'y no pasa callada').toBeDefined();
      expect(aviso!.code, 'RAISE WARNING es 01000').toBe('01000');
      // El aviso sin jurisdicción, ejercicio y valor no sirve de nada: hay que
      // poder ir a la fila.
      expect(aviso!.message).toMatch(/MX/);
      expect(aviso!.message).toMatch(/2025/);
      expect(aviso!.message).toMatch(/0\.005/);
    } finally {
      await db.query(`DELETE FROM tax_parameters WHERE jurisdiction = 'MX' AND tax_year = 2025`);
    }
  });

  it('el mal valor escrito de otra forma también se corrige: la comparación es numérica, no de texto', async () => {
    // `0.00625`, `6.25e-3` y la CADENA "0.00625" son el mismo error escrito de
    // tres maneras, y jsonb conserva la forma en que entró. Comparar el texto
    // habría dejado escapar dos de las tres.
    await db.query(
      `INSERT INTO tax_parameters (jurisdiction, tax_year, params)
       VALUES ('MX', 2024, '{"imss_employee":{"enfermedades_maternidad":6.25e-3}}'::jsonb),
              ('MX', 2023, '{"imss_employee":{"enfermedades_maternidad":"0.00625"}}'::jsonb)`
    );
    try {
      await db.query('BEGIN');
      await db.query(sql070());
      await db.query('COMMIT');

      expect(await cuotaObrera(2024), 'notación exponencial').toBe('0.004');
      expect(await cuotaObrera(2023), 'la misma cifra guardada como cadena').toBe('0.004');
    } finally {
      await db.query(`DELETE FROM tax_parameters WHERE jurisdiction = 'MX' AND tax_year IN (2023, 2024)`);
    }
  });
});
