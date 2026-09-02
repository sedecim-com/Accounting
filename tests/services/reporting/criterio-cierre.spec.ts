import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  currentTenant: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));

import {
  criterioDeCierreEnInformes,
  predicadoSinCierre,
  contarAsientosDeCierre,
  avisoDeCierreEnRango,
} from '../../../src/services/reporting/criterio-cierre.js';
import { query, currentTenant } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';

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
  mockPolicy.mockResolvedValue({ key: 'informes_asientos_de_cierre', value, defined: true });

const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');
const params = (call: number): unknown[] => mockQuery.mock.calls[call][1] as unknown[];

// ============================================================
// El criterio decide qué CUENTA cada documento. Equivocarlo no rompe
// nada visible: sólo cambia una cifra firmada.
// ============================================================

describe('criterioDeCierreEnInformes', () => {
  it('por omisión el estado de resultados los excluye y la balanza los cuenta', async () => {
    conPolitica('estado_sin_cierre_balanza_con_cierre');
    const c = await criterioDeCierreEnInformes(ENTITY);
    expect(c.enEstadoDeResultados).toBe(false);
    expect(c.enBalanza).toBe(true);
  });

  it('«excluir_siempre» los saca de los dos', async () => {
    conPolitica('excluir_siempre');
    const c = await criterioDeCierreEnInformes(ENTITY);
    expect(c.enEstadoDeResultados).toBe(false);
    expect(c.enBalanza).toBe(false);
  });

  it('«incluir_siempre_y_advertir» los mete en los dos', async () => {
    conPolitica('incluir_siempre_y_advertir');
    const c = await criterioDeCierreEnInformes(ENTITY);
    expect(c.enEstadoDeResultados).toBe(true);
    expect(c.enBalanza).toBe(true);
  });

  it('un valor que el panel no reconoce cae en la combinación conservadora, no en «cuéntalo todo»', async () => {
    conPolitica('lo_que_alguien_tecleó');
    const c = await criterioDeCierreEnInformes(ENTITY);
    expect(c.enEstadoDeResultados).toBe(false);
    expect(c.enBalanza).toBe(true);
  });

  it('lee la política del inquilino del contexto sin ir a buscarlo a la base', async () => {
    conPolitica('excluir_siempre');
    await criterioDeCierreEnInformes(ENTITY);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockPolicy).toHaveBeenCalledWith(
      { tenantId: TENANT, entityId: ENTITY },
      'informes_asientos_de_cierre'
    );
  });

  it('sin contexto RLS resuelve el inquilino por la entidad', async () => {
    mockTenant.mockReturnValue(undefined);
    mockQuery.mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }] });
    conPolitica('excluir_siempre');
    await criterioDeCierreEnInformes(ENTITY);
    expect(sql(0)).toMatch(/FROM legal_entities WHERE id = \$1/);
    expect(mockPolicy).toHaveBeenCalledWith(
      { tenantId: TENANT, entityId: ENTITY },
      'informes_asientos_de_cierre'
    );
  });

  it('una entidad sin inquilino no revienta el informe: aplica el criterio declarado', async () => {
    // Un informe es una LECTURA. Morir por no poder resolver una política
    // dejaría sin balanza a quien sólo quería mirar.
    mockTenant.mockReturnValue(undefined);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const c = await criterioDeCierreEnInformes(ENTITY);
    expect(mockPolicy).not.toHaveBeenCalled();
    expect(c.enEstadoDeResultados).toBe(false);
    expect(c.enBalanza).toBe(true);
  });
});

describe('predicadoSinCierre', () => {
  it('va sobre `je`, que es donde viven las dos columnas que mira', () => {
    const p = predicadoSinCierre();
    expect(p.startsWith('AND ')).toBe(true);
    expect(p).toMatch(/je\.entry_type/);
    expect(p).toMatch(/je\.reverses_entry_id/);
  });

  it('deja fuera el cierre Y el espejo que lo deshace, no sólo el cierre', () => {
    // El espejo del recierre nace 'reversing', no 'closing'. Un predicado que
    // sólo mirara entry_type lo dejaba pasar, y el espejo devolvía al estado
    // de resultados justo lo que el cierre reversado le había quitado: el
    // ejercicio salía al DOBLE.
    const p = predicadoSinCierre();
    expect(p).toMatch(/rev\.entry_type = 'closing'/);
    expect(p).toMatch(/rev\.id = je\.reverses_entry_id/);
    // Y sigue siendo una NEGACIÓN: lo que casa se descarta.
    expect(p).toMatch(/^AND NOT /);
  });

  it('no descarta la reversa de un asiento normal, que sí es actividad', () => {
    // El reconocimiento es por el asiento REVERSADO, no por el tipo del
    // espejo: por eso la cancelación de una venta —que apunta a un
    // 'standard'— sigue contando y baja el ingreso.
    expect(predicadoSinCierre()).not.toMatch(/je\.entry_type = 'reversing'/);
  });
});

describe('contarAsientosDeCierre', () => {
  it('cuenta sólo lo posteado, del tipo del cierre y de la entidad', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '2' }] });
    const n = await contarAsientosDeCierre(ENTITY, { sinceDate: '2026-01-01', untilDate: '2026-12-31' });
    expect(n).toBe(2);
    expect(sql(0)).toMatch(/je\.entity_id = \$1/);
    expect(sql(0)).toMatch(/je\.status = 'posted'/);
    expect(sql(0)).toMatch(/je\.entry_type = 'closing'/);
    expect(sql(0)).toMatch(/AND je\.entry_date >= \$2 AND je\.entry_date <= \$3/);
    expect(params(0)).toEqual([ENTITY, '2026-01-01', '2026-12-31']);
  });

  it('el periodo fiscal gana a las fechas, igual que en la balanza', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '0' }] });
    await contarAsientosDeCierre(ENTITY, { fiscalPeriodId: 'fp-1', asOfDate: '2026-06-30' });
    expect(sql(0)).toMatch(/AND je\.fiscal_period_id = \$2/);
    expect(params(0)).toEqual([ENTITY, 'fp-1']);
  });
});

describe('avisoDeCierreEnRango', () => {
  const conConteo = (n: number) => mockQuery.mockResolvedValueOnce({ rows: [{ n: String(n) }] });

  it('calla cuando el rango no contiene ningún cierre', async () => {
    conPolitica('estado_sin_cierre_balanza_con_cierre');
    conConteo(0);
    expect(await avisoDeCierreEnRango(ENTITY, { asOfDate: '2026-06-30' }, 'trial-balance')).toBeNull();
  });

  it('la balanza dice que los cuenta; el estado de resultados, que los deja fuera', async () => {
    conPolitica('estado_sin_cierre_balanza_con_cierre');
    conConteo(1);
    const balanza = await avisoDeCierreEnRango(ENTITY, { asOfDate: '2026-12-31' }, 'trial-balance');
    expect(balanza!.included).toBe(true);
    expect(balanza!.note).toMatch(/counted here/);

    conConteo(1);
    const estado = await avisoDeCierreEnRango(ENTITY, { asOfDate: '2026-12-31' }, 'income-statement');
    expect(estado!.included).toBe(false);
    expect(estado!.note).toMatch(/left out/);
  });

  it('concuerda en número: un asiento no son «1 entries»', async () => {
    conPolitica('estado_sin_cierre_balanza_con_cierre');
    conConteo(1);
    expect((await avisoDeCierreEnRango(ENTITY, {}, 'trial-balance'))!.note).toContain('1 year-end closing entry');

    conConteo(3);
    expect((await avisoDeCierreEnRango(ENTITY, {}, 'trial-balance'))!.note).toContain('3 year-end closing entries');
  });
});
