import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase, withTransaction } from '../../src/database/connection.js';
import { crearInquilino } from './helpers/tenant-fixture.js';
import { VOCABULARIOS } from '../../src/database/enums.js';
import { entriesOf, headOf, registry } from '../../src/language/vocabulary-registry.js';

/**
 * CONTRATO ENTRE LOS VOCABULARIOS Y SUS CHECK.
 *
 * Hermana de schema-contract: aquélla comprueba que las tablas y columnas
 * existan; ésta, que las LISTAS DE VALORES no se separen. Es la clase de
 * divergencia que el escáner de SQL no puede ver, porque no vive en una
 * consulta sino en un `z.enum([...])` de TypeScript.
 *
 * Lo que destapó al escribirla: de los nueve valores en juego entre los tres
 * enums de blockchain_config y sus CHECK, coincidía UNO. El endpoint de
 * configuración aceptaba tres valores que Postgres rechaza y no dejaba
 * escribir cinco que sí acepta.
 */

interface Definicion {
  tabla: string;
  columna: string;
  def: string;
}

let porColumna: Map<string, string[]>;

/**
 * Los valores de un `CHECK (col IN (...))` tal como los devuelve Postgres:
 *   CHECK (((run_type)::text = ANY ((ARRAY['regular'::character varying, …])::text[])))
 * Se leen los literales entre comillas simples, que es lo único estable de
 * esa forma.
 */
function valoresDe(def: string): string[] {
  return [...def.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
}

beforeAll(async () => {
  const r = await query<Definicion>(
    `SELECT c.relname AS tabla, a.attname AS columna, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN unnest(con.conkey) AS k(attnum) ON true
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE con.contype = 'c' AND n.nspname = 'public'`
  );
  porColumna = new Map();
  for (const fila of r.rows) {
    // Sólo los CHECK de vocabulario cerrado: los de rango o de signo no
    // llevan listas de literales y no compiten con esto.
    if (!/\bANY\b|\bIN\b/.test(fila.def)) continue;
    const clave = `${fila.tabla}.${fila.columna}`;
    const valores = valoresDe(fila.def);
    if (valores.length === 0) continue;
    // Una columna puede tener más de un CHECK; se acumulan.
    porColumna.set(clave, [...(porColumna.get(clave) ?? []), ...valores]);
  }
});

afterAll(async () => {
  await closeDatabase();
});

describe('contrato de vocabularios', () => {
  it('la introspección encuentra los CHECK de vocabulario', () => {
    expect(porColumna.size).toBeGreaterThan(20);
    expect(porColumna.get('audit_log.action')).toContain('post');
  });

  for (const voc of VOCABULARIOS) {
    const clave = `${voc.tabla}.${voc.columna}`;

    it(`${clave} declara exactamente lo que el CHECK admite`, () => {
      const enBase = porColumna.get(clave);
      expect(enBase, `${clave} no tiene CHECK de vocabulario en el esquema`).toBeDefined();

      const declarados = [...voc.valores].sort();
      const reales = [...new Set(enBase)].sort();

      // Se comparan los dos sentidos por separado para que el fallo diga
      // CUÁL de los dos problemas es: aceptar lo que revienta, o esconder
      // lo que funciona.
      const sobran = declarados.filter((x) => !reales.includes(x));
      const faltan = reales.filter((x) => !declarados.includes(x));

      expect(
        sobran,
        `${clave} declara valores que el CHECK rechaza: Postgres lanzaría 23514 y el usuario vería un 500`
      ).toEqual([]);
      expect(
        faltan,
        `${clave} omite valores que el CHECK admite: esa capacidad existe en la base y es inalcanzable`
      ).toEqual([]);
    });
  }

  it('ningún vocabulario está declarado sin registrar', () => {
    // Declarar la constante y no meterla en VOCABULARIOS la deja fuera de
    // vigilancia, que es como volvieron a separarse las anteriores.
    const registrados = new Set(VOCABULARIOS.map((x) => `${x.tabla}.${x.columna}`));
    expect(registrados.size).toBe(VOCABULARIOS.length);
  });
});

// ============================================================
// EL REGISTRO DEL VOCABULARIO, CONTRA LA BASE DE VERDAD (I4 · issue #146)
//
// El criterio del plan comprueba el registro contra el TEXTO de las
// migraciones. Esto lo comprueba contra la base CONSTRUIDA, que es lo único
// que puede desmentir una entrada inventada: una migración puede nombrar una
// columna que otra posterior renombró, y el texto no lo nota.
//
// POR QUÉ ESTE BLOQUE NO ES UN BUCLE SOBRE TODO EL REGISTRO. El bucle de
// arriba exige `CHECK` a cada entrada, y ocho de las doce clases del registro
// no tienen ninguno —un código de error, una clave del panel o un nombre de
// migración no viven en una columna—. Aplicarles la misma prueba las pondría
// rojas por no ser lo que nunca dijeron ser. Cada clase se comprueba con lo
// que la base sabe de ella, y las que la base no conoce se declaran aquí en
// voz alta en vez de quedar fuera en silencio.
// ============================================================

describe('el registro del vocabulario contra el esquema vivo', () => {
  it('toda TABLA registrada existe en la base', async () => {
    const tables = entriesOf('table');
    expect(tables.length).toBeGreaterThan(0);
    const r = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const live = new Set(r.rows.map((x) => x.table_name));
    const ghosts = tables.map((e) => headOf(e.where)).filter((t) => !live.has(t));
    expect(ghosts, 'el registro nombra tables que la base no tiene').toEqual([]);
  });

  it('toda COLUMNA registrada existe en su tabla', async () => {
    // Una entrada inventada aquí es la más cara del registro: I23-I25 emitiría
    // un ALTER TABLE ... RENAME COLUMN sobre algo que no está, y la migración
    // del renombrado moriría a mitad de camino sobre datos reales.
    const columns = entriesOf('column');
    expect(columns.length).toBeGreaterThan(0);
    const r = await query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
    );
    const live = new Set(r.rows.map((x) => `${x.table_name}.${x.column_name}`));
    const ghosts = columns.map((e) => headOf(e.where)).filter((c) => !live.has(c));
    expect(ghosts, 'el registro nombra columns que la base no tiene').toEqual([]);
  });

  it('todo VALOR DE CHECK registrado lo admite el CHECK de verdad', () => {
    // El sentido que importa aquí: el registro promete traducir un valor que
    // la base acepta. Si el valor no está en el CHECK, el registro está
    // mapeando algo que ninguna fila puede tener.
    const orphans: string[] = [];
    for (const e of entriesOf('check-value')) {
      const allowed = porColumna.get(headOf(e.where));
      if (allowed === undefined) continue; // columna sin CHECK: no es de este bloque
      if (!allowed.includes(e.es)) orphans.push(`${headOf(e.where)} = '${e.es}'`);
    }
    expect(orphans, 'el registro mapea valores que el CHECK no admite').toEqual([]);
  });

  it('ningún rol GUARDADO en la base es desconocido para el registro', async () => {
    // `account_roles.role` no tiene CHECK: es la clase grande que la base no
    // protege, y por eso la issue la nombra aparte. La base no puede decir qué
    // roles DEBERÍAN existir, pero sí desmentir al registro si alguna fila
    // guarda uno que no está registrado.
    //
    // WIT-01 de la revisión de #191: esta prueba PROMETÍA eso y no lo hacía.
    // Construía el conjunto registrado, comprobaba su tamaño y que la columna
    // no tuviera CHECK, y no consultaba `account_roles` ni una vez — una fila
    // con un rol desconocido no movía una sola aserción, y ese valor habría
    // pasado CI para quedarse fuera de la migración de datos de I23–I25.
    const registered = new Set(entriesOf('account-role').map((e) => e.es));
    expect(registered.size).toBeGreaterThan(20);
    expect(porColumna.has('account_roles.role')).toBe(false);

    const stored = await query<{ role: string }>('SELECT DISTINCT role FROM account_roles ORDER BY role');
    const unknown = stored.rows.map((r) => r.role).filter((r) => !registered.has(r));
    expect(
      unknown,
      'hay roles persistidos que el registro no mapea: I23–I25 los renombraría sin saber a qué'
    ).toEqual([]);
  });

  it('y la comprobación MUERDE: un rol sin registrar la hace fallar', async () => {
    // POR QUÉ ESTA SEGUNDA PRUEBA NO ES UN LUJO. La base efímera nace VACÍA de
    // `account_roles` —medido: cero filas—, así que la comprobación de arriba
    // pasa hoy sin comparar nada. Corregir WIT-01 escribiendo sólo el SELECT
    // habría cambiado una prueba vacua por otra, con mejor redacción.
    //
    // Esto siembra el caso exacto que debe cazar y comprueba que lo caza. Va
    // dentro de una transacción que se revierte a propósito: el escenario no
    // deja residuo para las pruebas que corran después.
    const registered = new Set(entriesOf('account-role').map((e) => e.es));
    const unregistered = 'rol_que_nadie_registro';
    expect(registered.has(unregistered)).toBe(false);

    const fixture = await crearInquilino('I4 · rol sin registrar');
    const anyAccount = Object.values(fixture.cuentas)[0];
    expect(anyAccount, 'el fixture no sembró ninguna cuenta').toBeTruthy();

    class Rollback extends Error {
      constructor(readonly found: string[]) {
        super('revertir a propósito');
      }
    }

    let found: string[] = [];
    try {
      await withTransaction(async (client) => {
        await client.query(
          'INSERT INTO account_roles (tenant_id, entity_id, role, account_id) VALUES ($1, $2, $3, $4)',
          [fixture.tenantId, fixture.entityId, unregistered, anyAccount]
        );
        const rows = await client.query<{ role: string }>('SELECT DISTINCT role FROM account_roles');
        throw new Rollback(rows.rows.map((r) => r.role).filter((r) => !registered.has(r)));
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
      found = e.found;
    }

    expect(found).toContain(unregistered);

    // Y el residuo, comprobado: la transacción revirtió de verdad.
    const after = await query<{ n: string }>('SELECT count(*) AS n FROM account_roles WHERE role = $1', [
      unregistered,
    ]);
    expect(after.rows[0].n).toBe('0');
  });

  it('las clases que la base NO conoce se declaran, no se omiten', () => {
    // Escrito como prueba y no como comentario a propósito: si mañana alguien
    // le da respaldo en base a una de estas clases, esta lista deja de ser
    // cierta y la prueba lo dice.
    const withoutDb = [
      'as-const',
      'policy-key',
      'policy-value',
      'migration-name',
      'error-code',
      'openapi-extension',
      'golden-key',
      'sealed-artifact',
    ] as const;
    for (const c of withoutDb) expect(entriesOf(c).length, `${c} vacía`).toBeGreaterThan(0);
    // Y juntas con las cuatro de arriba son el registro entero: ninguna clase
    // se queda sin que alguien diga si la base la conoce o no.
    const covered = new Set<string>([...withoutDb, 'table', 'column', 'check-value', 'account-role']);
    const declared = new Set(registry().map((e) => e.class));
    expect([...declared].filter((c) => !covered.has(c))).toEqual([]);
  });
});
