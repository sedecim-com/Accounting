import { describe, it, expect, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import {
  esContabilidadMexicana,
  sqlEsContabilidadMexicana,
} from '../../src/services/jurisdiccion/jurisdiccion.js';
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
const PARES: Array<{ pais: string | null; norma: string | null }> = [
  // El caso normal, por los dos caminos.
  { pais: 'MX', norma: 'mx_nif' },
  { pais: 'MX', norma: 'us_gaap' },
  { pais: 'MX', norma: 'ifrs' },
  { pais: 'US', norma: 'us_gaap' },
  { pais: 'US', norma: 'ifrs' },
  // La filial de Delaware con libros en NIF: el «O» que no es redundante.
  { pais: 'US', norma: 'mx_nif' },
  // Los bordes de la columna, que son los que las tres copias en crudo
  // contestaban al revés que el conmutador.
  { pais: '', norma: 'us_gaap' },
  { pais: '  ', norma: 'us_gaap' },
  { pais: 'mx', norma: 'us_gaap' },
  { pais: 'mx', norma: null },
  // Un tercer país: almacenable, y fuera del estrato fiscal mexicano.
  { pais: 'CA', norma: 'us_gaap' },
  { pais: 'ES', norma: 'ifrs' },
  { pais: 'DE', norma: null },
  // Blancos que NO son el espacio ASCII. `btrim` sin segundo argumento sólo
  // quita el espacio; `String.prototype.trim` quita todo blanco Unicode. Sin
  // estas tres filas las dos mitades podían contestar distinto sobre la misma
  // columna —true en TypeScript, false en el WHERE— y ninguna prueba lo veía.
  { pais: '\t\t', norma: 'us_gaap' },
  { pais: '\n\n', norma: 'us_gaap' },
  { pais: '\u00a0\u00a0', norma: 'us_gaap' },
  // Nulos: la columna es NOT NULL, pero un LEFT JOIN sí los produce.
  { pais: null, norma: null },
  { pais: null, norma: 'mx_nif' },
  { pais: 'US', norma: null },
];

afterAll(async () => {
  await closeDatabase();
});

describe('el predicado de jurisdicción dice lo mismo en SQL que en TypeScript', () => {
  it('coincide renglón por renglón sobre la tabla de verdad completa', async () => {
    // Los tipos son los de legal_entities: CHAR(2) y VARCHAR(20). Sin el cast
    // la prueba mediría `text`, que no rellena con espacios, y dejaría pasar
    // exactamente el borde que se quiere fijar.
    const valores = PARES.map((_, i) => `($${i * 2 + 1}::char(2), $${i * 2 + 2}::varchar(20))`).join(', ');
    const params = PARES.flatMap((p) => [p.pais, p.norma]);
    const sql = `
      SELECT v.incorporation_country AS pais,
             v.accounting_standard   AS norma,
             ${sqlEsContabilidadMexicana('v')} AS mexicana
      FROM (VALUES ${valores}) AS v(incorporation_country, accounting_standard)`;

    const r = await query<{ pais: string | null; norma: string | null; mexicana: boolean }>(sql, params);
    expect(r.rows).toHaveLength(PARES.length);

    r.rows.forEach((fila, i) => {
      const { pais, norma } = PARES[i];
      const enTypeScript = esContabilidadMexicana(pais, norma);
      expect(
        fila.mexicana,
        `desacuerdo en (pais=${JSON.stringify(pais)}, norma=${JSON.stringify(norma)}): ` +
          `SQL dice ${String(fila.mexicana)} y TypeScript dice ${String(enTypeScript)}`
      ).toBe(enTypeScript);
    });
  });

  /**
   * Que las dos mitades coincidan no sirve de nada si coinciden en el
   * resultado equivocado. Estos tres renglones fijan la respuesta ESPERADA,
   * no sólo el acuerdo: el país en blanco entra, el tercer país no, y la
   * filial con libros en NIF entra por la norma.
   */
  it('y coincide en la respuesta correcta, no sólo consigo mismo', async () => {
    const r = await query<{ mexicana: boolean }>(
      `SELECT ${sqlEsContabilidadMexicana('v')} AS mexicana
         FROM (VALUES ($1::char(2), $2::varchar(20))) AS v(incorporation_country, accounting_standard)`,
      ['', 'us_gaap']
    );
    // CHAR(2) guarda la cadena vacía como dos espacios; el btrim la recupera.
    expect(r.rows[0].mexicana).toBe(true);

    const tercero = await query<{ mexicana: boolean }>(
      `SELECT ${sqlEsContabilidadMexicana('v')} AS mexicana
         FROM (VALUES ($1::char(2), $2::varchar(20))) AS v(incorporation_country, accounting_standard)`,
      ['CA', 'us_gaap']
    );
    expect(tercero.rows[0].mexicana).toBe(false);

    const delaware = await query<{ mexicana: boolean }>(
      `SELECT ${sqlEsContabilidadMexicana('v')} AS mexicana
         FROM (VALUES ($1::char(2), $2::varchar(20))) AS v(incorporation_country, accounting_standard)`,
      ['US', 'mx_nif']
    );
    expect(delaware.rows[0].mexicana).toBe(true);
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
