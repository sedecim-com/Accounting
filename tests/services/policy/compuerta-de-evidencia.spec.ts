import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));
vi.mock('../../../src/ai/shadow-verdicts.js', () => ({
  concordanciaSombra: (...a: unknown[]) => concordanciaMock(...a),
}));
const { concordanciaMock } = vi.hoisted(() => ({
  concordanciaMock: vi.fn(),
}));

import { resolvePolicy } from '../../../src/services/policy/policy-service.js';
import { query } from '../../../src/database/connection.js';
import {
  FLOOR_SOMBRA_DIAS,
  FLOOR_SOMBRA_ACUERDO,
  FLOOR_SOMBRA_VEREDICTOS,
} from '../../../src/ai/floor.js';

const mockQuery = query as unknown as Mock;
const CTX = { tenantId: 't1', entityId: 'e1' };

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });
  concordanciaMock.mockReset();
});

describe("A4 · encender ingest_auto_post='on' exige la evidencia de sombra", () => {
  it('sin historial suficiente, el encendido se RECHAZA con la evidencia en el mensaje', async () => {
    concordanciaMock.mockResolvedValue({
      veredictos: 3, decididos: 3, acuerdos: 3, tasa_acuerdo: '1.000', dias_con_veredictos: 2,
    });
    await expect(
      resolvePolicy(CTX, 'ingest_auto_post', 'on', 'victor@test')
    ).rejects.toThrow(/evidencia de sombra/);
    // Nada se escribió: el rechazo es ANTES del UPDATE.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('con el piso cumplido (días, decididos y acuerdo), el encendido pasa', async () => {
    concordanciaMock.mockResolvedValue({
      veredictos: 30,
      decididos: FLOOR_SOMBRA_VEREDICTOS,
      acuerdos: FLOOR_SOMBRA_VEREDICTOS,
      tasa_acuerdo: '1.000',
      dias_con_veredictos: FLOOR_SOMBRA_DIAS,
    });
    await resolvePolicy(CTX, 'ingest_auto_post', 'on', 'victor@test');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('acuerdo por debajo del piso rechaza aunque los días y el volumen sobren', async () => {
    concordanciaMock.mockResolvedValue({
      veredictos: 100, decididos: 50, acuerdos: 30, tasa_acuerdo: '0.600', dias_con_veredictos: 30,
    });
    await expect(
      resolvePolicy(CTX, 'ingest_auto_post', 'on', 'victor@test')
    ).rejects.toThrow(new RegExp(`≥ ${FLOOR_SOMBRA_ACUERDO}`));
  });

  it("las demás respuestas de la MISMA clave no pagan el peaje: 'shadow' y 'off' pasan sin historial", async () => {
    await resolvePolicy(CTX, 'ingest_auto_post', 'shadow', 'victor@test');
    await resolvePolicy(CTX, 'ingest_auto_post', 'off', 'victor@test');
    expect(concordanciaMock).not.toHaveBeenCalled();
  });

  it('otras claves no consultan la sombra jamás', async () => {
    await resolvePolicy(CTX, 'segregacion_de_funciones', 'on', 'victor@test');
    expect(concordanciaMock).not.toHaveBeenCalled();
  });
});
