import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/ai/shadow-verdicts.js', () => ({
  concordanciaSombra: vi.fn(),
}));

import { resolvePolicy, getPolicyNumber } from '../../../src/services/policy/policy-service.js';
import { getPolicySpec } from '../../../src/services/policy/pending-catalog.js';
import { query } from '../../../src/database/connection.js';

const mockQuery = query as unknown as Mock;
const CTX = { tenantId: 't1', entityId: 'e1' };

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });
});

// ============================================================
// UNA RESPUESTA EN BLANCO NO ES UNA RESPUESTA.
//
// La ruta interactiva de `pending define` recorta y cancela con vacío; la ruta
// por ARGUMENTO no hacía ninguna de las dos, así que una fila entraba como
// `resolved` con el valor en blanco y el sistema se la presentaba al agente
// bajo el sello «tu despacho decidió esto, síguelo».
//
// El daño estaba un piso más abajo y era contable: `Number('   \n  ')` es 0 y
// `Number.isFinite(0)` es true, de modo que el respaldo al default declarado
// nunca se disparaba y el umbral de capitalización del motor quedaba en CERO
// —«capitalízalo todo»— sobre cada compra del cliente, en silencio.
// ============================================================

describe('la escritura: una política no se contesta en blanco', () => {
  it.each(['', '   ', '\n', ' \t \n '])(
    'resolvePolicy RECHAZA el valor %j y no escribe nada',
    async (blanco) => {
      await expect(
        resolvePolicy(CTX, 'umbral_capitalizacion_mxn', blanco, 'victor@test')
      ).rejects.toThrow(/no se contesta en blanco/);
      // El rechazo es ANTES del UPDATE: una fila a medias sería el defecto.
      expect(mockQuery).not.toHaveBeenCalled();
    }
  );

  it('un valor de verdad sí pasa: la guarda no cierra la puerta buena', async () => {
    await expect(
      resolvePolicy(CTX, 'umbral_capitalizacion_mxn', '5000', 'victor@test')
    ).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalled();
  });
});

describe('la lectura: un blanco heredado no se confunde con cero', () => {
  const DEFECTO = Number(getPolicySpec('umbral_capitalizacion_mxn')?.defaultValue ?? 0);

  it('el default declarado del umbral NO es cero: si lo fuera, esta prueba no probaría nada', () => {
    expect(DEFECTO).toBeGreaterThan(0);
  });

  it.each(['', '   ', '\n  '])(
    'una fila resuelta con %j cae al default declarado, no a cero',
    async (blanco) => {
      // La fila existe y dice `resolved`: es exactamente lo que entraba por la
      // ruta por argumento antes de la guarda de arriba.
      mockQuery.mockResolvedValue({
        rowCount: 1,
        rows: [{ status: 'resolved', resolved_value: blanco, default_value: String(DEFECTO) }],
      });
      const n = await getPolicyNumber(CTX, 'umbral_capitalizacion_mxn');
      expect(n).not.toBe(0);
      expect(n).toBe(DEFECTO);
    }
  );

  it('un valor numérico de verdad se respeta tal cual', async () => {
    mockQuery.mockResolvedValue({
      rowCount: 1,
      rows: [{ status: 'resolved', resolved_value: '5000', default_value: String(DEFECTO) }],
    });
    expect(await getPolicyNumber(CTX, 'umbral_capitalizacion_mxn')).toBe(5000);
  });
});
