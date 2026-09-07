import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  withTransaction: vi.fn(),
  currentTenant: vi.fn(),
}));

import { censarIvaPpd } from '../../src/services/accounting/iva-ppd-reclass.js';
import { sqlEsContabilidadMexicana } from '../../src/services/jurisdiccion/jurisdiccion.js';
import { query } from '../../src/database/connection.js';

const mockQuery = query as unknown as Mock;

const TENANT = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

async function sqlDelCenso(): Promise<string> {
  await censarIvaPpd(TENANT);
  const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
  return sql;
}

// ============================================================
// EL BORDE DE JURISDICCIÓN DE ESTE CENSO VIVE DENTRO DEL SQL
//
// Este censo alimenta a `reclasificar`, que ESCRIBE asientos y puede reabrir
// periodos cerrados. Su frontera no puede ser un `filter` en memoria: si la
// consulta trae de más, basta un olvido para que la corrección toque libros
// que no le tocan. Estas pruebas fijan las dos mitades de esa promesa — que
// el predicado sigue en el `WHERE`, y que es EL predicado y no una copia.
// ============================================================

describe('censarIvaPpd — la frontera de jurisdicción, dentro de la consulta', () => {
  it('el predicado que acota por jurisdicción está en el WHERE, antes del ORDER BY', async () => {
    const sql = await sqlDelCenso();
    const posicion = sql.indexOf(sqlEsContabilidadMexicana('le'));
    expect(posicion).toBeGreaterThan(-1);
    expect(posicion).toBeGreaterThan(sql.indexOf('WHERE'));
    expect(posicion).toBeLessThan(sql.indexOf('ORDER BY'));
  });

  /**
   * No basta con que el predicado esté: tiene que ser el MISMO texto que el
   * módulo de jurisdicción emite. Una copia escrita a mano aquí sería el
   * defecto original con otro nombre — cuatro predicados que coincidían en el
   * caso normal y diferían en el borde.
   */
  it('el texto lo emite el conmutador, no está escrito a mano en este archivo', async () => {
    const sql = await sqlDelCenso();
    expect(sql).toContain(sqlEsContabilidadMexicana('le'));
    // Y las dos comparaciones en crudo que este archivo tenía ya no están: si
    // vuelven, es que alguien reintrodujo la copia.
    expect(sql).not.toContain("le.incorporation_country = 'MX'");
    expect(sql).not.toMatch(/incorporation_country\s*=\s*'MX'/);
  });

  /**
   * El borde de este consumidor es el mismo que el del módulo, y por eso se
   * pregunta desde aquí: la escritura de la columna —dos espacios en blanco,
   * minúsculas— no puede dejar fuera del censo a una entidad cuyo catálogo es
   * mexicano. `CHAR(2)` sin CHECK admite las dos formas y el `= 'MX'` que
   * este archivo tenía las descartaba.
   */
  it('el borde de la columna viaja con el predicado: btrim, upper y el nulo como ausente', async () => {
    const sql = await sqlDelCenso();
    expect(sql).toContain("coalesce(upper(btrim(le.incorporation_country)), '') IN ('', 'MX')");
    expect(sql).toContain("coalesce(le.accounting_standard, '') = 'mx_nif'");
  });

  it('sigue acotando por inquilino y por entidad dentro del SQL, no después', async () => {
    const sql = await sqlDelCenso();
    expect(sql).toContain('le.tenant_id = $1');
    expect(sql).toContain('le.id = $2::uuid');
  });

  it('pasa el inquilino, la entidad opcional y la marca de idempotencia como parámetros', async () => {
    await censarIvaPpd(TENANT, null);
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(TENANT);
    expect(params[1]).toBeNull();
    expect(params[2]).toBe('iva_reclass');
  });
});
