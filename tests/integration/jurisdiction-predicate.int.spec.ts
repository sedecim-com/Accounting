import { describe, it, expect, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, getClient, closeDatabase } from '../../src/database/connection.js';
import { entityUsesCashBasisIva } from '../../src/services/accounting/iva-cash-basis.js';
import { crearInquilino } from './helpers/tenant-fixture.js';
import {
  keepsMexicanBooks,
  sqlKeepsMexicanBooks,
} from '../../src/services/jurisdiction/jurisdiction.js';
import { censarIvaPpd } from '../../src/services/accounting/iva-ppd-reclass.js';
import { checkAccountRoles } from '../../src/ai/doctor-service.js';

/**
 * EL CONMUTADOR TIENE DOS MITADES Y TIENEN QUE DECIR LO MISMO.
 *
 * J0.1 unifica el predicado de jurisdicción, pero lo unifica en DOS
 * expresiones: una en TypeScript, para quien ya tiene la fila en la mano, y
 * un fragmento de SQL, para las dos consultas que tienen que acotar dentro
 * del WHERE —el censo de IVA PPD y la revisión de roles del doctor—. «Un solo
 * conmutador» que en realidad son dos que deben concordar a mano es el
 * defecto del §1.1 mejor vestido, así que esta prueba las corre a las dos
 * sobre la MISMA tabla de pares y exige que coincidan renglón por renglón.
 *
 * TIENE QUE SER DE INTEGRACIÓN, y no por comodidad: lo que se está probando
 * es semántica de Postgres que ningún mock reproduce. `incorporation_country`
 * es `CHAR(2)`, de modo que la cadena vacía se almacena rellenada con espacios
 * y la comparación de bpchar ignora los blancos de cola; `upper(btrim(NULL))`
 * es NULL y `NULL IN (...)` no es cierto. Los tipos de las columnas de la
 * tabla de abajo son los de `legal_entities` a propósito.
 */

/** Los pares de la tabla de verdad, con la respuesta que da el TypeScript. */
const PAIRS: Array<{ country: string | null; standard: string | null }> = [
  // El caso normal, por los dos caminos.
  { country: 'MX', standard: 'mx_nif' },
  { country: 'MX', standard: 'us_gaap' },
  { country: 'MX', standard: 'ifrs' },
  { country: 'US', standard: 'us_gaap' },
  { country: 'US', standard: 'ifrs' },
  // La filial de Delaware con libros en NIF: el «O» que no es redundante.
  { country: 'US', standard: 'mx_nif' },
  // Los bordes de la columna, que son los que las tres copias en crudo
  // contestaban al revés que el conmutador.
  { country: '', standard: 'us_gaap' },
  { country: '  ', standard: 'us_gaap' },
  { country: 'mx', standard: 'us_gaap' },
  { country: 'mx', standard: null },
  // Un tercer país: almacenable, y fuera del estrato fiscal mexicano.
  { country: 'CA', standard: 'us_gaap' },
  { country: 'ES', standard: 'ifrs' },
  { country: 'DE', standard: null },
  // Blancos que NO son el espacio ASCII. `btrim` sin segundo argumento sólo
  // quita el espacio; `String.prototype.trim` quita todo blanco Unicode. Sin
  // estas tres filas las dos mitades podían contestar distinto sobre la misma
  // columna —true en TypeScript, false en el WHERE— y ninguna prueba lo veía.
  { country: '\t\t', standard: 'us_gaap' },
  { country: '\n\n', standard: 'us_gaap' },
  { country: '\u00a0\u00a0', standard: 'us_gaap' },
  // Nulos: la columna es NOT NULL, pero un LEFT JOIN sí los produce.
  { country: null, standard: null },
  { country: null, standard: 'mx_nif' },
  { country: 'US', standard: null },
];

afterAll(async () => {
  await closeDatabase();
});

describe('el predicado de jurisdicción dice lo mismo en SQL que en TypeScript', () => {
  it('coincide renglón por renglón sobre la tabla de verdad completa', async () => {
    // Los tipos son los de legal_entities: CHAR(2) y VARCHAR(20). Sin el cast
    // la prueba mediría `text`, que no rellena con espacios, y dejaría pasar
    // exactamente el borde que se quiere fijar.
    const values = PAIRS.map((_, i) => `($${i * 2 + 1}::char(2), $${i * 2 + 2}::varchar(20))`).join(', ');
    const params = PAIRS.flatMap((p) => [p.country, p.standard]);
    const sql = `
      SELECT v.incorporation_country AS country,
             v.accounting_standard   AS standard,
             ${sqlKeepsMexicanBooks('v')} AS mexican_books
      FROM (VALUES ${values}) AS v(incorporation_country, accounting_standard)`;

    const r = await query<{ country: string | null; standard: string | null; mexican_books: boolean }>(sql, params);
    expect(r.rows).toHaveLength(PAIRS.length);

    r.rows.forEach((row, i) => {
      const { country, standard } = PAIRS[i];
      const inTypeScript = keepsMexicanBooks(country, standard);
      expect(
        row.mexican_books,
        `desacuerdo en (country=${JSON.stringify(country)}, standard=${JSON.stringify(standard)}): ` +
          `SQL dice ${String(row.mexican_books)} y TypeScript dice ${String(inTypeScript)}`
      ).toBe(inTypeScript);
    });
  });

  /**
   * Que las dos mitades coincidan no sirve de nada si coinciden en el
   * resultado equivocado. Estos tres renglones fijan la respuesta ESPERADA,
   * no sólo el acuerdo: el país en blanco entra, el tercer país no, y la
   * filial con libros en NIF entra por la norma.
   */
  it('y coincide en la respuesta correcta, no sólo consigo mismo', async () => {
    const r = await query<{ mexican_books: boolean }>(
      `SELECT ${sqlKeepsMexicanBooks('v')} AS mexican_books
         FROM (VALUES ($1::char(2), $2::varchar(20))) AS v(incorporation_country, accounting_standard)`,
      ['', 'us_gaap']
    );
    // CHAR(2) guarda la cadena vacía como dos espacios; el btrim la recupera.
    expect(r.rows[0].mexican_books).toBe(true);

    const thirdCountry = await query<{ mexican_books: boolean }>(
      `SELECT ${sqlKeepsMexicanBooks('v')} AS mexican_books
         FROM (VALUES ($1::char(2), $2::varchar(20))) AS v(incorporation_country, accounting_standard)`,
      ['CA', 'us_gaap']
    );
    expect(thirdCountry.rows[0].mexican_books).toBe(false);

    const delaware = await query<{ mexican_books: boolean }>(
      `SELECT ${sqlKeepsMexicanBooks('v')} AS mexican_books
         FROM (VALUES ($1::char(2), $2::varchar(20))) AS v(incorporation_country, accounting_standard)`,
      ['US', 'mx_nif']
    );
    expect(delaware.rows[0].mexican_books).toBe(true);
  });
});

/**
 * Un fragmento interpolado se rompe de una forma que ninguna unitaria ve: el
 * SQL deja de ser válido contra el esquema real. Estas dos corridas no miran
 * el resultado —sin inquilino en contexto las dos consultas devuelven cero
 * filas—; miran que Postgres acepte la consulta con el predicado dentro.
 */
describe('las dos consultas que llevan el predicado siguen siendo SQL válido', () => {
  it('el censo de IVA PPD se planifica contra el esquema real', async () => {
    await expect(censarIvaPpd(uuidv4())).resolves.toEqual([]);
  });

  it('la revisión de roles del doctor se planifica contra el esquema real', async () => {
    const r = await checkAccountRoles();
    expect(['ok', 'warn', 'fail']).toContain(r.level);
  });
});

/**
 * LA FILA AUSENTE NO PASA POR EL CONMUTADOR. `entityUsesCashBasisIva` es el
 * único consumidor del predicado que puede recibir un id sin fila —de otro
 * inquilino bajo RLS, o inventado— y ahí «ante la duda, mexicana» sería
 * regalar régimen fiscal a algo que no está en los libros. Ningún llamador
 * de producción ejercita ese borde (todos pasan la entidad de un documento
 * que existe), así que la rama vivía sin prueba y la cobertura de ramas del
 * archivo cayó por debajo de su umbral cuando el `||` que la acompañaba se
 * fue al conmutador. Las tres filas de abajo fijan las dos respuestas y el
 * borde: existe y es mexicana → true; existe y es estadounidense → false;
 * no existe → false, sin consultar al conmutador.
 */
describe('entityUsesCashBasisIva lee la fila, y sin fila no hay régimen', () => {
  it('una entidad mexicana que existe acredita IVA sobre flujo', async () => {
    const mx = await crearInquilino('J0.1 · fila mexicana');
    const client = await getClient();
    try {
      expect(await entityUsesCashBasisIva(client, mx.entityId)).toBe(true);
    } finally {
      client.release();
    }
  });

  it('una entidad estadounidense que existe no lo hace, aunque exista', async () => {
    const us = await crearInquilino('J0.1 · fila estadounidense', { pais: 'US', norma: 'us_gaap' });
    const client = await getClient();
    try {
      expect(await entityUsesCashBasisIva(client, us.entityId)).toBe(false);
    } finally {
      client.release();
    }
  });

  it('un id sin fila —inexistente o ajeno— no recibe régimen mexicano por la duda', async () => {
    const client = await getClient();
    try {
      expect(await entityUsesCashBasisIva(client, uuidv4())).toBe(false);
    } finally {
      client.release();
    }
  });
});
