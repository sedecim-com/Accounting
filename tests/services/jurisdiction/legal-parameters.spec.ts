import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import {
  findLegalParameterAt,
  legalParameterAt,
  LegalParameterUnavailableError,
} from '../../../src/services/jurisdiction/legal-parameters.js';
import { query } from '../../../src/database/connection.js';
import { ValidationError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;

// ============================================================
// EL LECTOR DE LA LEY, Y QUÉ PRUEBA CADA MITAD (J0.2)
//
// Esta suite corre SIN Postgres, así que hay que ser explícito sobre lo que
// puede y no puede afirmar — la lección de G1a: report-service.ts exhibía 88 %
// con `query` mockeado y, con ese arnés, invertir el signo de las sumas
// firmadas pasaba en verde, porque el mock RECOMPONÍA la resta que la consulta
// declaraba.
//
// Aquí el reparto es:
//
//  · EL FALSO POSTGRES DE ABAJO no reimplementa la elección de la vigencia:
//    guarda las filas y aplica la regla del modelo —mayor `effective_from` que
//    no exceda la fecha— en cinco líneas legibles. Sirve para probar lo que sí
//    vive en TypeScript: que sin fila se LANZA, que los cuatro huecos se
//    distinguen, y que el mensaje nombra clave, jurisdicción y fecha.
//  · POR ESO, ADEMÁS, SE FIJA EL SQL. Si alguien cambia el ORDER BY a
//    ascendente o el `<=` a `=`, el falso Postgres seguiría contestando bien
//    —él no lee el SQL— y la suite pasaría en verde con un lector roto. Las
//    aserciones sobre el texto de la consulta cierran ese hueco.
//  · Y LA ELECCIÓN DE VERDAD la prueba la de integración
//    (tests/integration/j02-legal-parameters.int.spec.ts), que siembra dos
//    vigencias de la misma clave en un Postgres real y pregunta por fechas.
//    Ninguna de las dos sustituye a la otra.
// ============================================================

interface Fila {
  jurisdiction: string;
  key: string;
  effective_from: string;
  value: string | null;
  unit: string;
  source_url: string;
  source_note: string | null;
}

/** Las dos vigencias de la UMA: el caso que da nombre al tramo. Enero de 2026
 *  se rige por la de 2025 aunque la de 2026 ya esté publicada, porque la de
 *  2026 no entra hasta el 1 de febrero (LDVUMA art. 5). */
const TABLA: Fila[] = [
  {
    jurisdiction: 'MX', key: 'uma.daily', effective_from: '2025-02-01',
    value: '113.1400', unit: 'MXN',
    source_url: 'https://dof.gob.mx/uma-2025', source_note: 'UMA 2025',
  },
  {
    jurisdiction: 'MX', key: 'uma.daily', effective_from: '2026-02-01',
    value: '117.3100', unit: 'MXN',
    source_url: 'https://dof.gob.mx/uma-2026', source_note: 'UMA 2026',
  },
  // Una ley que terminó sin sustituta: fila con valor nulo. El art. 2 de la
  // LIVA (tasa de la franja fronteriza) es el caso real que lo motiva.
  {
    jurisdiction: 'MX', key: 'vat.border_rate', effective_from: '2014-01-01',
    value: null, unit: 'rate',
    source_url: 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf',
    source_note: 'LIVA art. 2, derogado',
  },
  // La tasa CERO de verdad: el art. 2-A de la LIVA. Tiene que pasar, o el
  // módulo estaría prohibiendo un valor que la ley sí fija.
  {
    jurisdiction: 'MX', key: 'vat.zero_rate', effective_from: '1980-01-01',
    value: '0.0000', unit: 'rate',
    source_url: 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf',
    source_note: 'LIVA art. 2-A',
  },
  // Y las tres formas de guardar un no-número donde iba una cifra. `value` es
  // TEXT sin CHECK en la 075, así que estas filas ENTRAN: quien las cierra es
  // el lector.
  {
    jurisdiction: 'MX', key: 'test.empty', effective_from: '2020-01-01',
    value: '', unit: 'rate', source_url: 'https://dof.gob.mx/x', source_note: null,
  },
  {
    jurisdiction: 'MX', key: 'test.blank', effective_from: '2020-01-01',
    value: '   ', unit: 'MXN', source_url: 'https://dof.gob.mx/x', source_note: null,
  },
  {
    jurisdiction: 'MX', key: 'test.words', effective_from: '2020-01-01',
    value: 'no aplica', unit: 'MXN', source_url: 'https://dof.gob.mx/x', source_note: null,
  },
];

/** Qué SQL se envió en la llamada n. */
const sqlDe = (n = 0): string => String(mockQuery.mock.calls[n][0]).replace(/\s+/g, ' ');

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    const [jurisdiction, key, onDate] = params as string[];
    const dela = TABLA.filter((f) => f.jurisdiction === jurisdiction && f.key === key);

    // La consulta de diagnóstico (MIN) devuelve SIEMPRE una fila, con NULL
    // cuando no hay ninguna: es lo que hace Postgres con un agregado sin
    // GROUP BY, y el lector depende de ello.
    if (/MIN\(effective_from\)/.test(sql)) {
      const fechas = dela.map((f) => f.effective_from).sort();
      return { rows: [{ effectiveFrom: fechas[0] ?? null }], rowCount: 1 };
    }

    const vigente = dela
      .filter((f) => f.effective_from <= onDate)
      .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
    return {
      rows: vigente
        ? [{
            jurisdiction: vigente.jurisdiction, key: vigente.key, value: vigente.value,
            unit: vigente.unit, effectiveFrom: vigente.effective_from,
            sourceUrl: vigente.source_url, sourceNote: vigente.source_note,
          }]
        : [],
      rowCount: vigente ? 1 : 0,
    };
  });
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

describe('legalParameterAt — la ley se lee en la fecha del hecho', () => {
  it('la fecha EXACTA de entrada devuelve esa fila, no la anterior', async () => {
    const p = await legalParameterAt('MX', 'uma.daily', '2026-02-01');
    expect(p.value).toBe('117.3100');
    expect(p.effectiveFrom).toBe('2026-02-01');
    // La comparación es `<=` y no `<`: el día que la ley entra, la ley rige.
    // Un `<` dejaría el 1 de febrero regido por la UMA del año anterior.
    expect(sqlDe()).toContain('effective_from <= $3::date');
  });

  it('una fecha POSTERIOR devuelve la vigencia más reciente que la precede', async () => {
    const p = await legalParameterAt('MX', 'uma.daily', '2026-08-15');
    expect(p.value).toBe('117.3100');
    expect(p.effectiveFrom).toBe('2026-02-01');
    // Sin el DESC, la consulta devolvería la de 2025 y el falso Postgres de
    // esta suite no lo notaría: él ordena por su cuenta.
    expect(sqlDe()).toContain('ORDER BY effective_from DESC');
    expect(sqlDe()).toContain('LIMIT 1');
  });

  it('EL CASO DEL TRAMO: en enero de 2026 rige la UMA de 2025, aunque la de 2026 ya esté publicada', async () => {
    const enero = await legalParameterAt('MX', 'uma.daily', '2026-01-15');
    expect(enero.value).toBe('113.1400');
    expect(enero.effectiveFrom).toBe('2025-02-01');
    // Y el 1 de febrero cambia sola, sin que nadie cierre la vigencia
    // anterior: no hay `effective_to` que mantener.
    const febrero = await legalParameterAt('MX', 'uma.daily', '2026-02-01');
    expect(febrero.value).toBe('117.3100');
  });

  it('devuelve también unidad, fecha de entrada y fuente: la cifra viaja con su procedencia', async () => {
    const p = await legalParameterAt('MX', 'uma.daily', '2026-03-01');
    expect(p).toEqual({
      jurisdiction: 'MX',
      key: 'uma.daily',
      value: '117.3100',
      unit: 'MXN',
      effectiveFrom: '2026-02-01',
      sourceUrl: 'https://dof.gob.mx/uma-2026',
      sourceNote: 'UMA 2026',
    });
  });
});

describe('legalParameterAt — falla CERRADO, y los cuatro huecos son distintos', () => {
  it('una fecha anterior a toda vigencia LANZA, y dice desde cuándo hay ley cargada', async () => {
    const err = await fallo(legalParameterAt('MX', 'uma.daily', '2019-06-30'));
    expect(err.gap).toBe('not_yet_in_force');
    // Las tres cosas que hacen falta para arreglarlo, en el mensaje.
    expect(err.message).toContain('uma.daily');
    expect(err.message).toContain('MX');
    expect(err.message).toContain('2019-06-30');
    // Y la cuarta, que es la que evita sembrar dos veces lo ya sembrado.
    expect(err.message).toContain('2025-02-01');
  });

  it('una jurisdicción que nadie cargó LANZA, y NO cae a la mexicana ni a cero', async () => {
    const err = await fallo(legalParameterAt('US', 'uma.daily', '2026-03-01'));
    expect(err.gap).toBe('never_loaded');
    expect(err.message).toContain('US');
  });

  it('una clave con errata LANZA: no se normaliza, porque normalizar esconde la errata', async () => {
    const err = await fallo(legalParameterAt('MX', 'UMA.Daily', '2026-03-01'));
    expect(err.gap).toBe('never_loaded');
  });

  it('DEROGADO no es cero: lanza, y se distingue de «nadie la cargó» sin leer el mensaje', async () => {
    const err = await fallo(legalParameterAt('MX', 'vat.border_rate', '2026-03-01'));
    expect(err.gap).toBe('repealed');
    // El hecho, entero: desde cuándo está derogada y de dónde consta.
    expect(err.message).toContain('2014-01-01');
    expect(err.message).toContain('LIVA.pdf');
    // Y no es el mismo hueco que la clave inexistente, que es el punto.
    const otro = await fallo(legalParameterAt('MX', 'vat.no_existe', '2026-03-01'));
    expect(otro.gap).toBe('never_loaded');
    expect(otro.gap).not.toBe(err.gap);
  });

  it('UNA CADENA VACÍA NO ES UN VALOR: lanza «malformed», porque Number("") vale CERO', async () => {
    const err = await fallo(legalParameterAt('MX', 'test.empty', '2026-03-01'));
    expect(err.gap).toBe('malformed');
    // Sin esta puerta el lector devolvía '' como si fuera ley, y el primer
    // `Number(p.value)` río abajo convertía «no hay dato» en «la tasa es cero».
    // Un cero de IVA o de UMA no rompe nada: sólo deja el cálculo mal, y cuadra.
    expect(Number('')).toBe(0);
    // El mensaje trae lo que hay guardado, entrecomillado, o quien lo lea no
    // distingue un vacío de un espacio.
    expect(err.message).toContain('""');
    expect(err.message).toContain('test.empty');
  });

  it('y unos espacios tampoco, que es el mismo cero con otra ropa', async () => {
    const err = await fallo(legalParameterAt('MX', 'test.blank', '2026-03-01'));
    expect(err.gap).toBe('malformed');
    expect(Number('   ')).toBe(0);
  });

  it('ni una frase: NaN se ve, pero se cierra por el mismo sitio', async () => {
    const err = await fallo(legalParameterAt('MX', 'test.words', '2026-03-01'));
    expect(err.gap).toBe('malformed');
    expect(err.message).toContain('no aplica');
  });

  it('PERO EL CERO DE VERDAD PASA: la tasa del art. 2-A de la LIVA es 0 %', async () => {
    // La puerta de arriba rechaza lo que PARECE cero sin serlo; si además
    // rechazara el cero, el módulo estaría prohibiendo un valor que la ley fija.
    const p = await legalParameterAt('MX', 'vat.zero_rate', '2026-03-01');
    expect(p.value).toBe('0.0000');
  });

  it('la fecha no es «hoy» por omisión: sin formato YYYY-MM-DD, ValidationError antes de tocar la base', async () => {
    await expect(legalParameterAt('MX', 'uma.daily', 'hoy')).rejects.toBeInstanceOf(ValidationError);
    await expect(
      legalParameterAt('MX', 'uma.daily', '2026-03-01T00:00:00.000Z')
    ).rejects.toThrow(/YYYY-MM-DD/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('findLegalParameterAt — el lector que NO juzga', () => {
  it('devuelve la fila derogada con su valor nulo: «la ley terminó» es una respuesta', async () => {
    const p = await findLegalParameterAt('MX', 'vat.border_rate', '2026-03-01');
    expect(p).not.toBeNull();
    expect(p?.value).toBeNull();
    expect(p?.effectiveFrom).toBe('2014-01-01');
  });

  it('devuelve null cuando no hay fila, y ésa es la otra mitad de la distinción', async () => {
    expect(await findLegalParameterAt('MX', 'vat.no_existe', '2026-03-01')).toBeNull();
    // Sin fila, NO consulta el MIN: el diagnóstico sólo lo paga quien lanza.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('no acota por inquilino, y la tabla no tiene la columna: es la excepción declarada', async () => {
    await findLegalParameterAt('MX', 'uma.daily', '2026-03-01');
    expect(sqlDe()).not.toMatch(/tenant_id|entity_id/);
  });
});

describe('el cliente del llamador se respeta: se lee DENTRO de su transacción', () => {
  it('con client, no se toma una segunda conexión del pool', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const p = await findLegalParameterAt(
      'MX', 'uma.daily', '2026-03-01', client as never
    );
    expect(p).toBeNull();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('y el diagnóstico del fallo también, o el mensaje leería fuera de la transacción', async () => {
    const client = {
      query: vi
        .fn()
        // La vigente: no hay.
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // El MIN del diagnóstico: una fila con NULL, como hace Postgres.
        .mockResolvedValueOnce({ rows: [{ effectiveFrom: null }], rowCount: 1 }),
    };
    await expect(
      legalParameterAt('MX', 'uma.daily', '2026-03-01', client as never)
    ).rejects.toBeInstanceOf(LegalParameterUnavailableError);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
