import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import {
  LEGAL_PARAMETERS_SEED,
  seedLegalParameters,
} from '../../../src/services/jurisdiction/legal-parameters-seed.js';
import { query } from '../../../src/database/connection.js';

const mockQuery = query as unknown as Mock;

// ============================================================
// LA SEMILLA DE LA LEY, REVISADA COMO DATO (J0.2)
//
// Una semilla de parámetros legales no es código: es una TABLA DE DATOS que
// alguien transcribió de un decreto, y las tablas transcritas se degradan de
// una forma que ninguna prueba de comportamiento ve —una URL que se acorta al
// copiar, un valor con dos decimales en vez de cuatro, una fecha de captura
// puesta donde iba la de entrada en vigor—. Estas comprobaciones son sobre el
// dato, no sobre la función, y por eso valen aunque nadie llame a la semilla.
//
// Lo que NO pueden comprobar es que la cifra sea la que dice el DOF. Eso lo
// sostiene la fuente obligatoria de cada fila y la revisión humana; lo que
// aquí se impide es que una fila pierda la fuente por el camino.
// ============================================================

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: LEGAL_PARAMETERS_SEED.length });
});

describe('la tabla de la semilla: pocas filas, todas fundamentadas', () => {
  it('ninguna fila se queda sin fuente oficial, que es por lo que source_url es NOT NULL', () => {
    for (const p of LEGAL_PARAMETERS_SEED) {
      expect(p.sourceUrl, `${p.key} sin fuente`).toMatch(/^https:\/\/\S+$/);
      // Y la nota dice QUÉ artículo: una URL a un PDF de 313 páginas sin el
      // artículo no es una fuente, es un sitio donde buscar.
      expect(p.sourceNote.length, `${p.key} sin nota de fuente`).toBeGreaterThan(30);
    }
  });

  it('los valores son CADENA a cuatro decimales: ni float, ni dos decimales, ni notación científica', () => {
    for (const p of LEGAL_PARAMETERS_SEED) {
      expect(typeof p.value).toBe('string');
      expect(p.value, `${p.key} = ${p.value}`).toMatch(/^\d+\.\d{4}$/);
    }
  });

  it('las fechas de entrada son YYYY-MM-DD y ninguna es futura respecto de lo publicado', () => {
    for (const p of LEGAL_PARAMETERS_SEED) {
      expect(p.effectiveFrom, p.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Una fecha que no existe (30 de febrero) pasa el regex y muere en el
      // `::date`: aquí se atrapa antes de llegar a la base.
      const d = new Date(`${p.effectiveFrom}T00:00:00Z`);
      expect(Number.isNaN(d.getTime()), `${p.key}: ${p.effectiveFrom} no es una fecha`).toBe(false);
      expect(d.toISOString().slice(0, 10)).toBe(p.effectiveFrom);
    }
  });

  it('no hay dos filas con la misma jurisdicción, clave y fecha: la unicidad de la 075 se respeta en el origen', () => {
    const llaves = LEGAL_PARAMETERS_SEED.map((p) => `${p.jurisdiction}|${p.key}|${p.effectiveFrom}`);
    expect(new Set(llaves).size).toBe(llaves.length);
  });

  it('las claves nacen en INGLÉS y en minúsculas con punto: son identidad de máquina (I0/I5)', () => {
    for (const p of LEGAL_PARAMETERS_SEED) {
      expect(p.key, p.key).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
    // Y no se cuela ninguna de las españolas del documento rector, que se
    // escribió antes de que el épico #141 fusionara I0 e I5.
    const claves = LEGAL_PARAMETERS_SEED.map((p) => p.key).join(' ');
    expect(claves).not.toMatch(/\biva\.|lisr\.|tasa_|efectivo_max/);
  });

  it('la UMA entra el 1 de FEBRERO, que es la fila por la que existe la tabla', () => {
    const uma = LEGAL_PARAMETERS_SEED.find((p) => p.key === 'uma.daily');
    expect(uma).toBeDefined();
    // Si alguien la «corrige» a enero, la tabla vuelve a ser una fila por año
    // y el mes que la ley reparte entre dos UMA desaparece.
    expect(uma?.effectiveFrom).toBe('2026-02-01');
  });

  it('sólo México: sembrar media jurisdicción haría creer que la tabla ya contesta por las dos', () => {
    expect(new Set(LEGAL_PARAMETERS_SEED.map((p) => p.jurisdiction))).toEqual(new Set(['MX']));
  });
});

describe('seedLegalParameters — el escritor que la tabla necesitaba', () => {
  it('manda las siete columnas en arreglos de la misma longitud, en un solo viaje', async () => {
    await seedLegalParameters();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const params = mockQuery.mock.calls[0][1] as unknown[][];
    expect(params).toHaveLength(7);
    for (const columna of params) {
      expect(columna).toHaveLength(LEGAL_PARAMETERS_SEED.length);
    }
    // El orden importa: UNNEST empareja por posición, y una columna cambiada
    // de sitio guardaría la fuente en la unidad sin que nada se queje.
    expect(params[1]).toContain('uma.daily');
    expect(params[3]).toContain('117.3100');
  });

  it('es idempotente: DO NOTHING, no DO UPDATE — una corrección no es un efecto colateral', async () => {
    await seedLegalParameters();
    const sql = String(mockQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING');
    expect(sql).not.toContain('DO UPDATE');
  });

  it('cuenta lo que insertó y lo que ya estaba, para que correrla dos veces se note', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const r = await seedLegalParameters();
    expect(r).toEqual({
      offered: LEGAL_PARAMETERS_SEED.length,
      inserted: 0,
      alreadyPresent: LEGAL_PARAMETERS_SEED.length,
    });
  });

  it('un rowCount nulo se lee como CERO insertadas, no como «se sembró todo»', async () => {
    // `rowCount` es `number | null` en el driver. Sin el `?? 0`, un nulo haría
    // `alreadyPresent = 6 - null = 6` y `inserted = null`, y la corrida
    // informaría de una siembra que no ocurrió — el error de esta casa: una
    // cifra que cuadra sin que nadie haya hecho el trabajo.
    mockQuery.mockResolvedValue({ rows: [], rowCount: null });
    const r = await seedLegalParameters();
    expect(r.inserted).toBe(0);
    expect(r.alreadyPresent).toBe(LEGAL_PARAMETERS_SEED.length);
  });

  it('siembra dentro de la transacción del llamador cuando le dan cliente', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 6 }) };
    const r = await seedLegalParameters({ client: client as never });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(r.inserted).toBe(6);
  });
});
