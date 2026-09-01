import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import {
  conLlave,
  hashDeCarga,
  ConflictoDeIdempotencia,
} from '../../src/services/idempotency/idempotency-store.js';

/**
 * LA LLAVE DE IDEMPOTENCIA POR FIN SE GUARDA (039 + S0.6).
 *
 * El kernel inyecta --idempotency-key en todo comando irreversible o externo
 * desde que existe, y hasta hoy se aceptaba con un aviso de que nada
 * deduplicaba sobre ella. Esto fija el contrato del almacén que la vuelve
 * verdadera: el reintento idéntico devuelve el resultado grabado sin ejecutar,
 * el reuso con otra carga es conflicto (salida 6 vía statusCode 409), y sin
 * llave el almacén ni se toca — dos corridas legítimamente idénticas no deben
 * deduplicarse solas.
 */

let f: Fixture;
let g: Fixture;

beforeAll(async () => {
  f = await crearInquilino('Idempotencia A');
  g = await crearInquilino('Idempotencia B');
});

afterAll(async () => {
  await closeDatabase();
});

const cuenta = async (tenantId: string): Promise<number> => {
  const r = await query<{ n: string }>(
    `SELECT count(*) AS n FROM idempotency_keys WHERE tenant_id = $1`,
    [tenantId]
  );
  return Number(r.rows[0].n);
};

describe('el contrato del almacén', () => {
  it('sin llave, ejecuta y no toca el almacén', async () => {
    const antes = await cuenta(f.tenantId);
    const acto = await conLlave(
      { tenantId: f.tenantId, entityId: f.entityId },
      { scope: 'prueba', payloadHash: hashDeCarga('x') },
      async () => ({ hecho: true })
    );
    expect(acto.repetido).toBe(false);
    expect(acto.resultado.hecho).toBe(true);
    expect(await cuenta(f.tenantId), 'sin llave no se guarda nada').toBe(antes);
  });

  it('el reintento con la misma llave y carga devuelve lo grabado SIN ejecutar', async () => {
    let ejecuciones = 0;
    const carga = { scope: 'prueba', clave: 'K-1', payloadHash: hashDeCarga('acto', 1) };
    const primera = await conLlave(
      { tenantId: f.tenantId, entityId: f.entityId },
      carga,
      async () => {
        ejecuciones++;
        return { numero: 'POL-001' };
      }
    );
    expect(primera.repetido).toBe(false);

    const segunda = await conLlave(
      { tenantId: f.tenantId, entityId: f.entityId },
      carga,
      async () => {
        ejecuciones++;
        return { numero: 'POL-XXX' };
      }
    );
    expect(segunda.repetido, 'la llave consumada devuelve el acto grabado').toBe(true);
    expect(segunda.resultado.numero, 'el resultado es el de la PRIMERA corrida').toBe('POL-001');
    expect(ejecuciones, 'el reintento no ejecuta').toBe(1);
  });

  it('la misma llave con otra carga es conflicto, y el kernel lo mapea a salida 6', async () => {
    const intento = conLlave(
      { tenantId: f.tenantId, entityId: f.entityId },
      { scope: 'prueba', clave: 'K-1', payloadHash: hashDeCarga('acto', 'DISTINTO') },
      async () => ({ numero: 'POL-002' })
    );
    await expect(intento).rejects.toThrow(ConflictoDeIdempotencia);
    await expect(intento).rejects.toMatchObject({ statusCode: 409 });
  });

  it('la unicidad es por (tenant, scope, clave): otro despacho y otro scope no chocan', async () => {
    const otroTenant = await conLlave(
      { tenantId: g.tenantId, entityId: g.entityId },
      { scope: 'prueba', clave: 'K-1', payloadHash: hashDeCarga('acto', 2) },
      async () => ({ numero: 'POL-OTRA' })
    );
    expect(otroTenant.repetido, 'la llave la elige el cliente; otro tenant es otro mundo').toBe(false);

    const otroScope = await conLlave(
      { tenantId: f.tenantId, entityId: f.entityId },
      { scope: 'otro comando', clave: 'K-1', payloadHash: hashDeCarga('acto', 3) },
      async () => ({ numero: 'POL-003' })
    );
    expect(otroScope.repetido, 'la misma llave en otro comando no choca').toBe(false);
  });

  it('si fn revienta, no queda llave: el reintento tras un fallo sigue siendo posible', async () => {
    await expect(
      conLlave(
        { tenantId: f.tenantId, entityId: f.entityId },
        { scope: 'prueba', clave: 'K-FALLA', payloadHash: hashDeCarga('boom') },
        async () => {
          throw new Error('se murió a la mitad');
        }
      )
    ).rejects.toThrow('se murió a la mitad');

    const reintento = await conLlave(
      { tenantId: f.tenantId, entityId: f.entityId },
      { scope: 'prueba', clave: 'K-FALLA', payloadHash: hashDeCarga('boom') },
      async () => ({ ok: true })
    );
    expect(reintento.repetido, 'la fila se graba DESPUÉS del acto: un fallo no consume la llave').toBe(false);
    expect(reintento.resultado.ok).toBe(true);
  });
});
