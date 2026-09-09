import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { getPolicy } from '../../../src/services/policy/policy-service.js';
import { query } from '../../../src/database/connection.js';

const mockQuery = query as unknown as Mock;

// ============================================================
// LA COLUMNA `policy_decisions.jurisdiction` TIENE LECTOR (J0.2)
//
// La 075 le dio al panel dónde decir de qué jurisdicción es cada respuesta.
// Sin lector, esa columna sería exactamente lo que `doctor` acusa: esquema
// que existe, compila, se migra, y al que no llega ninguna ruta.
//
// LO QUE ESTE TRAMO NO HACE, y conviene decirlo antes de leer las pruebas: la
// cascada de cinco eslabones, `PolicySpec.jurisdicciones` y la siembra
// filtrada son J0.3. Aquí sólo se abre el eslabón —la columna se selecciona,
// se acota y se propaga— y se fija que la resolución que YA funcionaba
// (entidad gana sobre inquilino) no se movió ni un renglón.
// ============================================================

/** Una fila del panel como la devuelve la base. */
function fila(over: Record<string, unknown> = {}) {
  return {
    id: 'p1', key: 'destino_del_resultado_del_ejercicio', category: 'cierre',
    question: '¿A dónde va el resultado del ejercicio?', impact: 'cierre anual',
    options: [], default_value: 'dos_pasos_hasta_asamblea', default_rationale: 'LGSM 19-20',
    status: 'resolved', resolved_value: 'directo_a_acumulados', resolved_by: 'victor',
    resolved_at: null, resolution_notes: null, priority: 1, entity_id: null,
    jurisdiction: null,
    ...over,
  };
}

const sql = (): string => String(mockQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
const params = (): unknown[] => mockQuery.mock.calls[0][1] as unknown[];

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [fila()], rowCount: 1 });
});

describe('getPolicy — la columna se selecciona y se propaga', () => {
  it('la consulta trae la jurisdicción: sin proyectarla, la columna seguiría muerta', async () => {
    await getPolicy({ tenantId: 't1' }, 'destino_del_resultado_del_ejercicio');
    expect(sql()).toContain('jurisdiction');
  });

  it('quien recibe la respuesta sabe con qué autoridad se le contestó', async () => {
    mockQuery.mockResolvedValue({ rows: [fila({ jurisdiction: 'US' })], rowCount: 1 });
    const p = await getPolicy(
      { tenantId: 't1', jurisdiction: 'US' },
      'destino_del_resultado_del_ejercicio'
    );
    expect(p.jurisdiction).toBe('US');
    expect(p.value).toBe('directo_a_acumulados');
  });

  it('cuando contesta el catálogo —no había fila— la respuesta es universal, no inventada', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const p = await getPolicy(
      { tenantId: 't1', jurisdiction: 'MX' },
      'destino_del_resultado_del_ejercicio'
    );
    expect(p.defined).toBe(false);
    // El catálogo todavía no sabe de jurisdicciones (`PolicySpec` es J0.3):
    // marcarla 'MX' aquí sería atribuirle al catálogo una intención que no
    // tiene, que es el mismo error que la 075 evita al no promover a
    // «mexicanas» las filas anteriores.
    expect(p.jurisdiction).toBeNull();
  });
});

describe('getPolicy — la jurisdicción se ACOTA, y se ordena DESPUÉS de la entidad', () => {
  it('sin jurisdicción en el contexto sólo entran las universales, que es lo que hoy hay', async () => {
    await getPolicy({ tenantId: 't1', entityId: 'e1' }, 'destino_del_resultado_del_ejercicio');
    expect(sql()).toContain('(jurisdiction IS NULL OR jurisdiction = $4)');
    // `jurisdiction = NULL` no es cierto en SQL, así que el cuarto parámetro
    // nulo deja el filtro en «sólo universales» sin una rama de más.
    expect(params()[3]).toBeNull();
  });

  it('con jurisdicción, entran la universal y la suya — y ninguna de otra', async () => {
    await getPolicy(
      { tenantId: 't1', entityId: 'e1', jurisdiction: 'MX' },
      'destino_del_resultado_del_ejercicio'
    );
    expect(params()).toEqual(['t1', 'destino_del_resultado_del_ejercicio', 'e1', 'MX']);
  });

  it('LA REGRESIÓN PROHIBIDA: la entidad sigue ganando al inquilino, y la jurisdicción sólo desempata dentro', async () => {
    await getPolicy(
      { tenantId: 't1', entityId: 'e1', jurisdiction: 'MX' },
      'destino_del_resultado_del_ejercicio'
    );
    // El orden de las dos claves no es cosmético: al revés, una respuesta de
    // INQUILINO marcada 'MX' le ganaría a la respuesta específica de la
    // entidad. La precedencia entidad > inquilino es de A7 y no se toca.
    expect(sql()).toContain('ORDER BY entity_id IS NULL ASC, jurisdiction IS NULL ASC');
    // Y el acote por entidad que la precede sigue en su sitio.
    expect(sql()).toContain('(entity_id IS NULL OR entity_id = $3::uuid)');
  });
});
