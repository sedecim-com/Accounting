import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import {
  findLegalParameterAt,
  legalParameterAt,
  LegalParameterUnavailableError,
} from '../../src/services/jurisdiction/legal-parameters.js';
import {
  LEGAL_PARAMETERS_SEED,
  seedLegalParameters,
} from '../../src/services/jurisdiction/legal-parameters-seed.js';
import { getPolicy } from '../../src/services/policy/policy-service.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

/**
 * J0.2 · LA LEY TIENE FECHA DE ENTRADA, CONTRA POSTGRES DE VERDAD
 *
 * La suite unitaria del lector corre sobre un falso Postgres que ordena por su
 * cuenta: sirve para fijar el fallo cerrado y la distinción de los cuatro
 * huecos, pero NO puede probar lo único que de verdad decide el modelo —que
 * la consulta elija la vigencia correcta—. Eso se prueba aquí, sembrando dos
 * vigencias de la misma clave y preguntando por fechas alrededor de la
 * frontera.
 *
 * Y hay una razón más para que esta prueba exista: la tabla NO tiene tenant_id
 * ni RLS. Es la excepción declarada de la 080 —la UMA vale igual para todo
 * despacho— y una excepción sin prueba es una excepción que mañana alguien
 * confunde con un descuido.
 */

/** Clave de prueba, con prefijo que ninguna semilla real usa: esta suite
 *  comparte base con las demás y `legal_parameters` es GLOBAL, así que sembrar
 *  sobre una clave de verdad contaminaría a quien lea después. */
const CLAVE = 'test.j02.timeline_rate';
const DEROGADA = 'test.j02.repealed_rate';
/** Una fila a medio llenar: `value` es TEXT sin CHECK en la 080, así que ésta
 *  ENTRA en la tabla. Quien la cierra es el lector. */
const EN_BLANCO = 'test.j02.blank_rate';

let f: Fixture;

beforeAll(async () => {
  f = await crearInquilino('J0.2 · parámetros legales');
  enterTenant(f.tenantId);

  await query(
    `INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
     VALUES
       ('MX', $1, '2024-01-01', '0.1000', 'rate', 'https://dof.gob.mx/prueba-2024', 'vigencia vieja'),
       ('MX', $1, '2026-02-01', '0.1600', 'rate', 'https://dof.gob.mx/prueba-2026', 'vigencia nueva'),
       -- Una ley que TERMINÓ: fila con valor nulo y su fuente. No es «no hay
       -- dato»: es «alguien la derogó en esta fecha», y consta.
       ('MX', $2, '2019-01-01', '0.0800', 'rate', 'https://dof.gob.mx/prueba-2019', 'la tasa que hubo'),
       ('MX', $2, '2022-01-01', NULL,     'rate', 'https://dof.gob.mx/prueba-2022', 'derogada'),
       -- Y la fila a medio llenar. No es hipotética: la 080 pone CHECK a la
       -- fuente y unicidad a la fecha, pero la columna value es TEXT pelado,
       -- así que esto entra sin que nada proteste.
       ('MX', $3, '2020-01-01', '',       'rate', 'https://dof.gob.mx/prueba-blanco', 'a medio llenar')
     ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING`,
    [CLAVE, DEROGADA, EN_BLANCO]
  );
});

afterAll(async () => {
  await query('DELETE FROM legal_parameters WHERE key LIKE $1', ['test.j02.%']);
  await closeDatabase();
});

/**
 * Captura el fallo cerrado CON TIPO, y no con `.catch((e) => e)`.
 *
 * No es cosmética de lint: un `catch` que devuelve `any` deja que
 * `err.gpa`—una errata— compile y pase, de modo que la prueba que vigila la
 * distinción de los cuatro huecos podría estar mirando una propiedad que no
 * existe y quedarse en verde. Aquí el tipo lo fija el `instanceof`, y de paso
 * la prueba deja de necesitar un `toBeInstanceOf` suelto para decir lo mismo.
 *
 * Y si NO lanza, este ayudante falla: una promesa que se resuelve donde se
 * esperaba un fallo cerrado es exactamente el defecto del tramo.
 */
async function fallo(p: Promise<unknown>): Promise<LegalParameterUnavailableError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof LegalParameterUnavailableError) return e;
    throw e;
  }
  throw new Error('se esperaba un fallo cerrado (LegalParameterUnavailableError) y no lanzó');
}

describe('la fecha del hecho elige la vigencia, y la elige Postgres', () => {
  it('ANTES de toda vigencia: lanza, y no devuelve la primera «por aproximación»', async () => {
    const err = await fallo(legalParameterAt('MX', CLAVE, '2023-12-31'));
    expect(err.gap).toBe('not_yet_in_force');
    // El mensaje trae la fecha de la vigencia más antigua que SÍ hay: sin
    // ella, quien lo lea no sabe si tiene que sembrar o corregir la fecha.
    expect(err.message).toContain('2024-01-01');
  });

  it('EN LA FECHA EXACTA de entrada: esa fila, no la anterior', async () => {
    const p = await legalParameterAt('MX', CLAVE, '2024-01-01');
    expect(p.value).toBe('0.1000');
    expect(p.effectiveFrom).toBe('2024-01-01');
  });

  it('el día ANTES de la segunda: sigue rigiendo la primera', async () => {
    const p = await legalParameterAt('MX', CLAVE, '2026-01-31');
    expect(p.value).toBe('0.1000');
  });

  it('el día EN QUE ENTRA la segunda: cambia sola, sin que nadie cerrara la primera', async () => {
    const p = await legalParameterAt('MX', CLAVE, '2026-02-01');
    expect(p.value).toBe('0.1600');
    expect(p.effectiveFrom).toBe('2026-02-01');
  });

  it('MUCHO DESPUÉS: la más reciente que precede al hecho, no la primera ni la última por azar', async () => {
    const p = await legalParameterAt('MX', CLAVE, '2030-07-15');
    expect(p.value).toBe('0.1600');
  });

  it('y entre las dos vigencias no hay hueco: todos los días de 2024 a 2026 tienen respuesta', async () => {
    const fechas = ['2024-01-01', '2024-06-30', '2025-01-01', '2025-12-31', '2026-01-31', '2026-02-01'];
    const valores = [];
    for (const d of fechas) valores.push((await legalParameterAt('MX', CLAVE, d)).value);
    // Sin `effective_to` no puede abrirse un hueco: el fin de una vigencia es
    // el principio de la siguiente, y no hay dos sitios que mantener.
    expect(valores).toEqual(['0.1000', '0.1000', '0.1000', '0.1000', '0.1000', '0.1600']);
  });

  it('una jurisdicción sin una sola fila LANZA: no cae a la mexicana', async () => {
    const err = await fallo(legalParameterAt('US', CLAVE, '2026-02-01'));
    expect(err.gap).toBe('never_loaded');
    expect(err.message).toContain('US');
  });
});

describe('derogado no es cero, y no es lo mismo que «nadie la cargó»', () => {
  it('antes de la derogación se lee el valor que hubo', async () => {
    const p = await legalParameterAt('MX', DEROGADA, '2021-12-31');
    expect(p.value).toBe('0.0800');
  });

  it('desde la derogación LANZA con gap "repealed", y dice desde cuándo y de dónde consta', async () => {
    const err = await fallo(legalParameterAt('MX', DEROGADA, '2022-01-01'));
    expect(err.gap).toBe('repealed');
    expect(err.message).toContain('2022-01-01');
    expect(err.message).toContain('https://dof.gob.mx/prueba-2022');
  });

  it('UNA CADENA VACÍA TAMPOCO ES UN VALOR: cuarto hueco, y el que se cuela solo', async () => {
    // Postgres aceptó la fila: `value` es TEXT sin CHECK y la 080 no se toca.
    const guardado = await query<{ value: string }>(
      'SELECT value FROM legal_parameters WHERE key = $1',
      [EN_BLANCO]
    );
    expect(guardado.rows[0].value).toBe('');

    // Y aquí está por qué importa: sin la puerta del lector, ese '' sale como
    // si fuera ley y el primer Number() de río abajo lo convierte en CERO —una
    // tasa inventada que cuadra, que es el defecto entero de este tramo.
    expect(Number('')).toBe(0);
    const err = await fallo(legalParameterAt('MX', EN_BLANCO, '2024-06-01'));
    expect(err.gap).toBe('malformed');
    expect(err.message).toContain('""');

    // El que NO juzga sí la entrega: distinguir es su oficio, no juzgar.
    expect((await findLegalParameterAt('MX', EN_BLANCO, '2024-06-01'))?.value).toBe('');
  });

  it('el lector que no juzga SÍ la devuelve, con su valor nulo: «la ley terminó» es una respuesta', async () => {
    const p = await findLegalParameterAt('MX', DEROGADA, '2024-06-01');
    expect(p?.value).toBeNull();
    expect(p?.effectiveFrom).toBe('2022-01-01');
    // Y la clave que nadie cargó devuelve null, que es el otro hecho.
    expect(await findLegalParameterAt('MX', 'test.j02.jamas', '2024-06-01')).toBeNull();
  });
});

describe('el esquema sostiene el modelo, y no el criterio de quien escribe', () => {
  it('dos filas con la misma jurisdicción, clave y fecha son IMPOSIBLES', async () => {
    await expect(
      query(
        `INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url)
         VALUES ('MX', $1, '2024-01-01', '0.9900', 'rate', 'https://dof.gob.mx/otra')`,
        [CLAVE]
      )
    ).rejects.toThrow(/legal_parameters_una_verdad_por_fecha|duplicate key/i);
  });

  it('un parámetro SIN FUENTE no entra: ni nula, ni cadena vacía', async () => {
    await expect(
      query(
        `INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url)
         VALUES ('MX', $1, '2027-01-01', '0.1700', 'rate', NULL)`,
        [CLAVE]
      )
    ).rejects.toThrow(/source_url/);
    await expect(
      query(
        `INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url)
         VALUES ('MX', $1, '2027-01-01', '0.1700', 'rate', '')`,
        [CLAVE]
      )
    ).rejects.toThrow(/source_url/);
  });

  it('la tabla NO tiene inquilino, y es la excepción declarada — no un descuido', async () => {
    const r = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'legal_parameters' AND column_name IN ('tenant_id', 'entity_id')`
    );
    expect(r.rows).toEqual([]);
    // Y sin columna por la que filtrar, tampoco hay política de aislamiento
    // que ponerle: lo confirma el censo de rls-por-su-predicado.int.spec.ts,
    // donde entra en GLOBALES con su razón escrita.
    const rls = await query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'legal_parameters'`
    );
    expect(rls.rows[0].relrowsecurity).toBe(false);
  });

  it('la fecha vuelve sin correrse un día: to_char y no el Date del driver', async () => {
    // `DATE` no lleva zona, pero node-pg lo entrega como Date a medianoche
    // LOCAL: en cualquier huso al oeste de UTC, un `toISOString().slice(0,10)`
    // devuelve el día ANTERIOR, y una vigencia corrida un día es una ley que
    // empieza cuando no empezó.
    const p = await legalParameterAt('MX', CLAVE, '2026-02-01');
    expect(p.effectiveFrom).toBe('2026-02-01');
    expect(typeof p.effectiveFrom).toBe('string');
  });
});

describe('la semilla: la tabla tiene escritor, y el escritor tiene fuentes', () => {
  it('siembra, y volver a sembrar no duplica ni pisa', async () => {
    const primera = await seedLegalParameters();
    expect(primera.offered).toBe(LEGAL_PARAMETERS_SEED.length);
    const segunda = await seedLegalParameters();
    expect(segunda.inserted).toBe(0);
    expect(segunda.alreadyPresent).toBe(LEGAL_PARAMETERS_SEED.length);

    const r = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM legal_parameters WHERE key = ANY($1::varchar[])`,
      [LEGAL_PARAMETERS_SEED.map((p) => p.key)]
    );
    expect(Number(r.rows[0].n)).toBe(LEGAL_PARAMETERS_SEED.length);
  });

  it('lo sembrado se lee por el lector, que es lo que cierra el círculo del tramo', async () => {
    await seedLegalParameters();
    const iva = await legalParameterAt('MX', 'vat.standard_rate', '2026-05-17');
    expect(iva.value).toBe('0.1600');
    expect(iva.unit).toBe('rate');
    // La cifra viaja con su procedencia: quien la imprima puede decir de dónde
    // salió sin volver a consultar.
    expect(iva.sourceUrl).toContain('diputados.gob.mx');
    expect(iva.sourceNote).toContain('07-12-2009');
  });

  it('EL CASO QUE JUSTIFICA LA TABLA: en enero de 2026 la UMA de 2026 todavía no rige, y el lector no la inventa', async () => {
    await seedLegalParameters();
    // El 1 de febrero sí, que es lo que manda el art. 5 de la LDVUMA.
    expect((await legalParameterAt('MX', 'uma.daily', '2026-02-01')).value).toBe('117.3100');
    // En enero, la UMA que regía es la de 2025 — y este tramo NO la sembró.
    // La respuesta correcta es fallar cerrado, no devolver la de febrero:
    // devolverla sería exactamente el defecto que `tax_parameters` tiene hoy
    // con su fila por año.
    const err = await fallo(legalParameterAt('MX', 'uma.daily', '2026-01-15'));
    expect(err.gap).toBe('not_yet_in_force');
  });
});

describe('policy_decisions.jurisdiction tiene lector (J0.2), y la resolución de antes no se movió', () => {
  const CLAVE_PANEL = 'destino_del_resultado_del_ejercicio';

  it('una respuesta marcada US NO gobierna a quien preguntó por MX, ni a quien no preguntó', async () => {
    await query(
      `INSERT INTO policy_decisions
         (tenant_id, entity_id, key, category, question, impact, options,
          default_value, status, resolved_value, resolved_by, resolved_at, jurisdiction, source)
       VALUES ($1, NULL, $2, 'contable', 'pregunta', 'impacto', '[]'::jsonb,
               'dos_pasos_hasta_asamblea', 'resolved', 'directo_a_acumulados', 'prueba', NOW(), 'US', 'prueba')`,
      [f.tenantId, CLAVE_PANEL]
    );

    // Quien pregunta por US recibe la respuesta de US.
    const us = await getPolicy({ tenantId: f.tenantId, jurisdiction: 'US' }, CLAVE_PANEL);
    expect(us.value).toBe('directo_a_acumulados');
    expect(us.defined).toBe(true);
    expect(us.jurisdiction).toBe('US');

    // Quien pregunta por MX NO la recibe: cae al default declarado, que es lo
    // que el panel promete mientras la decisión siga sin contestarse PARA ÉL.
    const mx = await getPolicy({ tenantId: f.tenantId, jurisdiction: 'MX' }, CLAVE_PANEL);
    expect(mx.defined).toBe(false);
    expect(mx.value).toBe('dos_pasos_hasta_asamblea');
    expect(mx.jurisdiction).toBeNull();

    // Y quien no pregunta por ninguna tampoco: una respuesta con jurisdicción
    // no es universal.
    const sin = await getPolicy({ tenantId: f.tenantId }, CLAVE_PANEL);
    expect(sin.defined).toBe(false);
  });

  it('LA REGRESIÓN PROHIBIDA: la fila de la ENTIDAD sigue ganando a la del inquilino', async () => {
    const clave = 'umbral_capitalizacion_mxn';
    await query(
      `INSERT INTO policy_decisions
         (tenant_id, entity_id, key, category, question, impact, options, default_value,
          status, resolved_value, resolved_by, resolved_at, source)
       VALUES ($1, NULL, $2, 'contable', 'pregunta', 'impacto', '[]'::jsonb, '20000',
               'resolved', '20000', 'prueba', NOW(), 'prueba'),
              ($1, $3,   $2, 'contable', 'pregunta', 'impacto', '[]'::jsonb, '20000',
               'resolved', '777',   'prueba', NOW(), 'prueba')`,
      [f.tenantId, clave, f.entityId]
    );
    const p = await getPolicy({ tenantId: f.tenantId, entityId: f.entityId }, clave);
    expect(p.value).toBe('777');
    // Y con jurisdicción encima sigue ganando la entidad: la jurisdicción
    // desempata DENTRO del alcance, nunca por encima de él.
    const q = await getPolicy(
      { tenantId: f.tenantId, entityId: f.entityId, jurisdiction: 'MX' },
      clave
    );
    expect(q.value).toBe('777');
  });

  it('LA REGRESIÓN PROHIBIDA, EN EL CASO QUE DE VERDAD LA DISTINGUE: inquilino con jurisdicción contra entidad universal', async () => {
    // La prueba de arriba NO puede caer si alguien invierte las dos claves del
    // ORDER BY: sus dos filas son universales, así que la segunda clave está
    // inerte y `jurisdiction IS NULL ASC, entity_id IS NULL ASC` da el mismo
    // resultado. Se comprobó invirtiéndolas: la suite entera seguía en verde.
    //
    // El único arreglo de filas que las separa es éste —fila de INQUILINO con
    // jurisdicción y fila de ENTIDAD sin ella— y no es hipotético: los dos
    // índices de la 017 son de alcance disjunto (uno exige entity_id NULL, el
    // otro NOT NULL), así que estas dos filas conviven HOY. Con el orden
    // invertido, la respuesta de inquilino marcada 'MX' le gana a la de la
    // entidad, que es la regresión que este tramo tiene prohibido introducir.
    const clave = 'politica_dos_alcances';
    await query(
      `INSERT INTO policy_decisions
         (tenant_id, entity_id, key, category, question, impact, options, default_value,
          status, resolved_value, resolved_by, resolved_at, jurisdiction, source)
       VALUES ($1, NULL, $2, 'contable', 'pregunta', 'impacto', '[]'::jsonb, 'x',
               'resolved', 'DEL_INQUILINO_MX', 'prueba', NOW(), 'MX', 'prueba'),
              ($1, $3,   $2, 'contable', 'pregunta', 'impacto', '[]'::jsonb, 'x',
               'resolved', 'DE_LA_ENTIDAD',    'prueba', NOW(), NULL, 'prueba')`,
      [f.tenantId, clave, f.entityId]
    );
    const p = await getPolicy(
      { tenantId: f.tenantId, entityId: f.entityId, jurisdiction: 'MX' },
      clave
    );
    expect(p.value).toBe('DE_LA_ENTIDAD');
    // Y la universal de la entidad se identifica como tal: nadie le inventa
    // un país por haber preguntado desde uno.
    expect(p.jurisdiction).toBeNull();
  });

  it('y dentro del MISMO alcance sí desempata la jurisdicción: la de la entidad marcada gana a la universal de la entidad', async () => {
    // La otra mitad del ORDER BY. Necesita dos filas de la MISMA entidad y por
    // eso hoy sólo puede montarse retirando `uq_policy_entity_scope`, que es
    // el índice de la 017 que J0.3 tiene que reemplazar (ver el hueco conocido
    // de abajo). Se retira y se repone en esta prueba para no dejar la base de
    // la corrida sin la unicidad que las demás dan por puesta.
    const clave = 'politica_desempate_dentro';
    await query('DROP INDEX uq_policy_entity_scope');
    try {
      await query(
        `INSERT INTO policy_decisions
           (tenant_id, entity_id, key, category, question, impact, options, default_value,
            status, resolved_value, resolved_by, resolved_at, jurisdiction, source)
         VALUES ($1, $2, $3, 'contable', 'pregunta', 'impacto', '[]'::jsonb, 'x',
                 'resolved', 'UNIVERSAL', 'prueba', NOW(), NULL, 'prueba'),
                ($1, $2, $3, 'contable', 'pregunta', 'impacto', '[]'::jsonb, 'x',
                 'resolved', 'MEXICANA',  'prueba', NOW(), 'MX', 'prueba')`,
        [f.tenantId, f.entityId, clave]
      );
      const p = await getPolicy(
        { tenantId: f.tenantId, entityId: f.entityId, jurisdiction: 'MX' },
        clave
      );
      expect(p.value).toBe('MEXICANA');
      expect(p.jurisdiction).toBe('MX');
    } finally {
      await query('DELETE FROM policy_decisions WHERE tenant_id = $1 AND key = $2', [
        f.tenantId,
        clave,
      ]);
      await query(
        `CREATE UNIQUE INDEX uq_policy_entity_scope
           ON policy_decisions (tenant_id, entity_id, key) WHERE entity_id IS NOT NULL`
      );
    }
  });

  it('EL ÍNDICE DE LA 075 MUERDE, y muerde donde debe: sin los de la 017 aún no se cuela un duplicado universal', async () => {
    // El `COALESCE(jurisdiction, '--')` no es adorno: en SQL `NULL = NULL` es
    // NULL, así que un índice único sobre la columna pelada dejaría convivir
    // dos filas universales de la misma clave —dos respuestas a la misma
    // pregunta— sin que nada lo impidiera. Aquí se comprueba con los dos
    // índices de la 017 retirados, que son los que hoy tapan el resultado.
    const clave = 'politica_centinela';
    const mete = (jurisdiccion: string | null, valor: string) =>
      query(
        `INSERT INTO policy_decisions
           (tenant_id, entity_id, key, category, question, impact, options, default_value, jurisdiction, source)
         VALUES ($1, NULL, $2, 'fiscal', 'pregunta', 'impacto', '[]'::jsonb, $3, $4, 'prueba')`,
        [f.tenantId, clave, valor, jurisdiccion]
      );
    await query('DROP INDEX uq_policy_tenant_scope');
    try {
      await mete(null, 'a');
      // Dos universales: RECHAZADAS por el centinela.
      await expect(mete(null, 'b')).rejects.toThrow(
        /idx_policy_decisions_una_respuesta|duplicate key/i
      );
      // Una universal y una mexicana: CONVIVEN, que es para lo que existe la
      // columna.
      await mete('MX', 'c');
      // Dos mexicanas: rechazadas otra vez.
      await expect(mete('MX', 'd')).rejects.toThrow(
        /idx_policy_decisions_una_respuesta|duplicate key/i
      );
      // Y una estadounidense entra junto a las otras dos.
      await mete('US', 'e');
      const r = await query<{ n: string }>(
        'SELECT count(*)::text AS n FROM policy_decisions WHERE tenant_id = $1 AND key = $2',
        [f.tenantId, clave]
      );
      expect(Number(r.rows[0].n)).toBe(3);
    } finally {
      await query('DELETE FROM policy_decisions WHERE tenant_id = $1 AND key = $2', [
        f.tenantId,
        clave,
      ]);
      await query(
        `CREATE UNIQUE INDEX uq_policy_tenant_scope
           ON policy_decisions (tenant_id, key) WHERE entity_id IS NULL`
      );
    }
  });

  it('HUECO CONOCIDO · los dos índices de la 017 impiden todavía dos jurisdicciones por clave', async () => {
    const clave = 'politica_restaurantes';
    await query(
      `INSERT INTO policy_decisions
         (tenant_id, entity_id, key, category, question, impact, options, default_value, jurisdiction, source)
       VALUES ($1, NULL, $2, 'fiscal', 'pregunta', 'impacto', '[]'::jsonb, 'a', 'MX', 'prueba')`,
      [f.tenantId, clave]
    );
    // La 075 creó `idx_policy_decisions_una_respuesta` CON la jurisdicción,
    // pero NO retiró `uq_policy_tenant_scope` de la 017 —(tenant_id, key)
    // WHERE entity_id IS NULL, sin jurisdicción—. Mientras ese índice siga,
    // un inquilino no puede tener una respuesta 'MX' y otra 'US' para la
    // misma clave, que es justo lo que la columna existe para permitir.
    //
    // La columna YA tiene lector (las dos pruebas de arriba), que es el
    // criterio de J0.2. Lo que falta es de J0.3, y queda fijado aquí en vez
    // de en la memoria de quien lo encontró: cuando esos índices se
    // reemplacen, esta prueba se pone roja y hay que voltearla a «entra».
    await expect(
      query(
        `INSERT INTO policy_decisions
           (tenant_id, entity_id, key, category, question, impact, options, default_value, jurisdiction, source)
         VALUES ($1, NULL, $2, 'fiscal', 'pregunta', 'impacto', '[]'::jsonb, 'b', 'US', 'prueba')`,
        [f.tenantId, clave]
      )
    ).rejects.toThrow(/uq_policy_tenant_scope|duplicate key/i);
  });
});
