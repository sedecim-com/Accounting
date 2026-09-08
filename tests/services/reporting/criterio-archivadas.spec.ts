import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  currentTenant: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));

import {
  CRITERIO_ARCHIVADAS_POR_OMISION,
  criterioDeCuentasArchivadas,
  predicadoDeCuentaEnBalanza,
} from '../../../src/services/reporting/criterio-archivadas.js';
import { query, currentTenant } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';
import { POLICY_CATALOG } from '../../../src/services/policy/pending-catalog.js';

const mockQuery = query as unknown as Mock;
const mockTenant = currentTenant as unknown as Mock;
const mockPolicy = getPolicy as unknown as Mock;

const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TENANT = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  mockQuery.mockReset();
  mockTenant.mockReset();
  mockPolicy.mockReset();
  mockTenant.mockReturnValue(TENANT);
});

const conPolitica = (value: string) =>
  mockPolicy.mockResolvedValue({ key: 'informes_cuentas_archivadas', value, defined: true });

const RETIRA = { valor: 'retirar_cuando_no_tiene_nada', retirarSinCifras: true };
const MANTIENE = { valor: 'mantener_en_la_balanza', retirarSinCifras: false };

// ============================================================
// T13 · UNA POLÍTICA SIN LECTOR ES UNA PREGUNTA QUE NO CAMBIA NADA.
//
// La ficha del panel y su lector viajan en el mismo commit, y esta suite es
// la que lo comprueba: que la clave que se lee sea la que el catálogo declara,
// y que el defecto del lector sea el defecto de la ficha.
// ============================================================

describe('criterioDeCuentasArchivadas — el lector de la ficha', () => {
  it('lee la MISMA clave que el catálogo declara, y con el mismo defecto', async () => {
    const ficha = POLICY_CATALOG.find((p) => p.key === 'informes_cuentas_archivadas');
    expect(ficha, 'la ficha desapareció del panel: el lector quedaría leyendo una clave muerta').toBeDefined();
    expect(ficha!.defaultValue).toBe(CRITERIO_ARCHIVADAS_POR_OMISION);
    // Las dos opciones que la ficha ofrece son las dos que el lector distingue.
    expect(ficha!.options.map((o) => o.value).sort()).toEqual([
      'mantener_en_la_balanza',
      'retirar_cuando_no_tiene_nada',
    ]);

    conPolitica('retirar_cuando_no_tiene_nada');
    await criterioDeCuentasArchivadas(ENTITY);
    expect(mockPolicy).toHaveBeenCalledWith(
      { tenantId: TENANT, entityId: ENTITY },
      'informes_cuentas_archivadas'
    );
  });

  it('«mantener» es el ÚNICO valor que conserva el renglón vacío', async () => {
    conPolitica('mantener_en_la_balanza');
    expect(await criterioDeCuentasArchivadas(ENTITY)).toEqual(MANTIENE);
  });

  it('el defecto, y cualquier valor que el panel no reconozca, retiran', async () => {
    for (const v of ['retirar_cuando_no_tiene_nada', 'una_opcion_que_no_existe']) {
      conPolitica(v);
      const c = await criterioDeCuentasArchivadas(ENTITY);
      expect(c.retirarSinCifras, `«${v}» debería retirar`).toBe(true);
      expect(c.valor).toBe(v);
    }
  });

  it('sin contexto de inquilino lo resuelve por la entidad antes de leer el panel', async () => {
    mockTenant.mockReturnValue(undefined);
    mockQuery.mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }] });
    conPolitica('mantener_en_la_balanza');
    const c = await criterioDeCuentasArchivadas(ENTITY);
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/FROM legal_entities WHERE id = \$1/);
    expect(c.valor).toBe('mantener_en_la_balanza');
  });

  it('una entidad sin inquilino no revienta el informe: aplica el criterio por omisión', async () => {
    // Una entidad que no existe no tiene datos que informar; morir aquí
    // convertiría un informe en una excepción por no poder leer una política.
    mockTenant.mockReturnValue(undefined);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const c = await criterioDeCuentasArchivadas(ENTITY);
    expect(mockPolicy).not.toHaveBeenCalled();
    expect(c).toEqual({ valor: CRITERIO_ARCHIVADAS_POR_OMISION, retirarSinCifras: true });
  });
});

describe('predicadoDeCuentaEnBalanza — el SQL que ya no puede tapar dinero', () => {
  it('sin criterio (la balanza EN CRUDO del cotejo) no recorta nada', () => {
    expect(predicadoDeCuentaEnBalanza(null, {}, 0)).toBe('');
  });

  it('«mantener» tampoco recorta: entran todas las cuentas de la entidad', () => {
    expect(predicadoDeCuentaEnBalanza(MANTIENE, { asOfDate: '2026-12-31' }, 2)).toBe('');
  });

  it('el rescate es un OR, no un AND: si fuera AND caerían las dos poblaciones', () => {
    const sql = predicadoDeCuentaEnBalanza(RETIRA, {}, 0);
    // La cuenta VIVA entra siempre —la balanza conserva las que no se
    // movieron— y la ARCHIVADA entra cuando el mayor la respalda.
    expect(sql).toContain('(a.is_active = true OR EXISTS (');
    expect(sql).not.toContain('a.is_active = true AND EXISTS');
    // Sin tope no hay recorte por fecha: basta con que el mayor tenga algo.
    expect(sql).not.toContain('arch_je.entry_date');
  });

  it('mira el MAYOR y no el saldo: 100 al debe y 100 al haber es cero y SÍ se movió', () => {
    const sql = predicadoDeCuentaEnBalanza(RETIRA, {}, 0);
    expect(sql).toContain('FROM journal_entry_lines arch_jel');
    expect(sql).toContain("arch_je.status = 'posted'");
    // Un rescate por saldo dejaría fuera justo a la cuenta de resultados que
    // el cierre acaba de barrer, que es el caso que este archivo arregla.
    expect(sql).not.toMatch(/SUM\(|balance/);
  });

  it('con fecha de corte usa el MISMO $n del informe', () => {
    expect(predicadoDeCuentaEnBalanza(RETIRA, { untilDate: '2026-12-31' }, 3)).toContain(
      'AND arch_je.entry_date <= $3'
    );
  });

  it('con periodo fiscal traduce el periodo a su fecha fin', () => {
    // El movimiento se recorta por `fiscal_period_id` y el arrastre por fecha:
    // sin la traducción, una archivada con saldo arrastrado se caería de la
    // balanza y con ella su SaldoIni.
    expect(predicadoDeCuentaEnBalanza(RETIRA, { fiscalPeriodId: 'fp-3' }, 2)).toContain(
      'AND arch_je.entry_date <= (SELECT fp.end_date FROM fiscal_periods fp WHERE fp.id = $2)'
    );
  });

  it('el periodo fiscal gana al corte por fecha, con la precedencia de entryFilter', () => {
    // Si las dos precedencias no coincidieran, el `$n` del rescate apuntaría
    // al parámetro del otro filtro: un corte contra un uuid.
    const sql = predicadoDeCuentaEnBalanza(
      RETIRA,
      { fiscalPeriodId: 'fp-3', asOfDate: '2026-12-31', untilDate: '2026-12-31' },
      2
    );
    expect(sql).toContain('FROM fiscal_periods fp');
  });
});
