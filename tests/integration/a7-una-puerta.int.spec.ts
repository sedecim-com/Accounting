import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import {
  seedPolicies,
  resolvePolicy,
  getPolicy,
} from '../../src/services/policy/policy-service.js';
import { resolverUmbralesConPanel } from '../../src/ai/ingest-thresholds.js';

/**
 * A7 · UNA SOLA PUERTA AL AUTO-POSTEO, contra la base real.
 *
 * Dos propiedades que sólo se ven con Postgres delante:
 *
 *   · la DECISIÓN se escribe en el alcance que se MIDIÓ — antes el UPDATE no
 *     acotaba por entidad, así que resolver desde una entidad podía encender
 *     la fila del inquilino, que gobierna a todas (pilar 6 del plan);
 *   · el panel es la única puerta: con 'shadow' resuelto, ni el archivo del
 *     operador ni la bandera encienden, y la sombra sigue viva.
 */

let f: Fixture;
let otra: Fixture;

beforeAll(async () => {
  f = await crearInquilino('A7 · entidad medida');
  // Segunda entidad DEL MISMO inquilino: el caso que el defecto necesitaba.
  const r = await query<{ id: string }>(
    `INSERT INTO legal_entities (
       id, tenant_id, organization_id, name, entity_type, tax_id, tax_id_type,
       incorporation_country, functional_currency, accounting_standard,
       fiscal_year_start_month, is_active
     )
     SELECT gen_random_uuid(), tenant_id, organization_id, 'A7 · entidad hermana',
            entity_type, 'XAXX010101001', tax_id_type, incorporation_country,
            functional_currency, accounting_standard, fiscal_year_start_month, true
       FROM legal_entities WHERE id = $1
     RETURNING id`,
    [f.entityId]
  );
  otra = { ...f, entityId: r.rows[0].id };
});

afterAll(async () => {
  await drainAttestations(1000);
  await closeDatabase();
});

describe('la decisión se escribe en el alcance que se midió', () => {
  it('resolver desde una entidad NO toca la fila de la otra ni la del inquilino', async () => {
    // Tres filas pendientes de la misma clave: inquilino, entidad A y B.
    await seedPolicies({ tenantId: f.tenantId });
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    await seedPolicies({ tenantId: f.tenantId, entityId: otra.entityId });

    await resolvePolicy(
      { tenantId: f.tenantId, entityId: f.entityId },
      'ingest_auto_post', 'shadow', 'victor@test'
    );

    const filas = await query<{ entity_id: string | null; status: string; resolved_value: string | null }>(
      `SELECT entity_id, status, resolved_value FROM policy_decisions
        WHERE tenant_id = $1 AND key = 'ingest_auto_post'
        ORDER BY entity_id NULLS FIRST`,
      [f.tenantId]
    );
    expect(filas.rows.length, 'tres alcances de la misma clave').toBe(3);

    const delInquilino = filas.rows.find((x) => x.entity_id === null);
    const deA = filas.rows.find((x) => x.entity_id === f.entityId);
    const deB = filas.rows.find((x) => x.entity_id === otra.entityId);

    expect(deA?.status, 'la entidad que resolvió').toBe('resolved');
    expect(deA?.resolved_value).toBe('shadow');
    expect(delInquilino?.status, 'la del inquilino gobierna a TODAS: no puede moverse').toBe('pending');
    expect(deB?.status, 'la entidad hermana no decidió nada').toBe('pending');
  });

  it('y la lectura de la otra entidad no ve la decisión ajena', async () => {
    const enB = await getPolicy({ tenantId: f.tenantId, entityId: otra.entityId }, 'ingest_auto_post');
    expect(enB.defined, 'B tiene su propia fila pendiente: no hereda la resuelta de A').toBe(false);
  });

  it('resolver en un alcance sin fila pendiente falla diciendo el alcance', async () => {
    await expect(
      resolvePolicy(
        { tenantId: f.tenantId, entityId: f.entityId },
        'ingest_auto_post', 'off', 'victor@test'
      )
    ).rejects.toThrow(/entity/);
  });
});

describe('el panel es la única puerta al encendido', () => {
  it("con 'shadow' resuelto, el archivo del operador NO enciende y la sombra sigue viva", async () => {
    // El escenario exacto que la auditoría integral II ejecutó y que producía
    // posteo real con cero evidencia registrada.
    const conArchivoEncendido = await resolverUmbralesConPanel(
      {},
      { tenantId: f.tenantId, entityId: f.entityId },
      __dirname // sin mnemosine.config.json: el archivo no habla
    );
    expect(conArchivoEncendido.sombra).toBe(true);
    expect(conArchivoEncendido.autoPost).toBe(false);

    // Y con la bandera pidiendo encender explícitamente:
    const conBandera = await resolverUmbralesConPanel(
      { autoPost: true },
      { tenantId: f.tenantId, entityId: f.entityId },
      __dirname
    );
    expect(conBandera.autoPost, 'la bandera rodearía el peaje de la evidencia').toBe(false);
    expect(conBandera.sombra, 'y la sombra debe seguir midiendo').toBe(true);
    expect(conBandera.encendidoIgnorado).toBe(true);
    expect(conBandera.fuentes?.autoPost).toBe('politica');
  });

  it('la bandera SÍ apaga: lo local puede ser más estricto', async () => {
    const r = await resolverUmbralesConPanel(
      { autoPost: false },
      { tenantId: f.tenantId, entityId: f.entityId },
      __dirname
    );
    expect(r.autoPost).toBe(false);
    expect(r.fuentes?.autoPost).toBe('bandera');
    expect(r.encendidoIgnorado).toBe(false);
  });
});
