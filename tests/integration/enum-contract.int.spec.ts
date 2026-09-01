import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { VOCABULARIOS } from '../../src/database/enums.js';

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
