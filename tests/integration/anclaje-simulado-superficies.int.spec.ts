import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import blockchainRouter from '../../src/api/rest/routes/blockchain.js';
import publicVerificationRouter from '../../src/api/rest/routes/public-verification.js';

/**
 * NINGUNA SUPERFICIE PRESENTA UN ANCLAJE FABRICADO COMO PRUEBA.
 *
 * E1.4 puso el cerrojo en un solo endpoint —`/public/v1/verify/:entryHash`— y
 * dejó fuera los otros tres sitios donde el mismo dato sale a la calle:
 *
 *  · `GET /v1/admin/blockchain/attestations`, autenticado pero leído por el
 *    administrador y el auditor del propio inquilino, servía `status:
 *    'confirmed'` junto a un `chain_attestations` con txHash, blockNumber y
 *    explorerUrl fabricados, y ni siquiera seleccionaba `is_simulated`.
 *  · `GET /public/v1/entities/:e/periods/:p`, SIN autenticar, servía el sello
 *    del periodo —que es la carga útil de la prueba— sin mirar la marca.
 *  · `GET /public/v1/entities/:e/aggregates`, ídem con las cifras publicadas.
 *
 * Estas pruebas hablan por HTTP con los routers reales. La suite de E1.4
 * afirmaba sobre el TEXTO del archivo, que pasa igual si el manejador cambia
 * de sitio.
 */

let f: Fixture;
let s: Servidor;
let periodoSimulado: string;
let periodoReal: string;

/** Un periodo del ejercicio de la entidad, distinto en cada llamada. */
async function periodoLibre(): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM fiscal_periods
      WHERE entity_id = $1
        AND id NOT IN (SELECT period_id FROM period_commitments WHERE entity_id = $1)
      ORDER BY start_date LIMIT 1`,
    [f.entityId]
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  f = await crearInquilino('Superficies de anclaje');

  // Una atestación simulada, como las que escribe hoy el orquestador.
  await query(
    `INSERT INTO blockchain_attestations (
       id, tenant_id, entity_id, source_type, source_id, entry_hash, commitment,
       status, chain_attestations, is_simulated
     ) VALUES ($1,$2,$3,'journal_entry',$4,$5,'x','confirmed',$6::jsonb,true)`,
    [uuidv4(), f.tenantId, f.entityId, uuidv4(), `0x${'a'.repeat(64)}`,
     JSON.stringify([{ chainId: 'arbitrum-one', txHash: '0xfabricado', blockNumber: 1, explorerUrl: 'https://x/tx/0xfabricado' }])]
  );

  periodoSimulado = await periodoLibre();
  await query(
    `INSERT INTO period_commitments (
       id, tenant_id, entity_id, period_id, merkle_root, entry_count, tree_depth,
       balance_commitment, status, committed_at, is_simulated
     ) VALUES ($1,$2,$3,$4,$5,3,2,'bc','committed',NOW(),true)`,
    [uuidv4(), f.tenantId, f.entityId, periodoSimulado, `0x${'b'.repeat(64)}`]
  );

  // Y uno NO simulado, para comprobar que el cerrojo no es una manta: el día
  // que exista un adaptador real, estos endpoints tienen que responder.
  periodoReal = await periodoLibre();
  await query(
    `INSERT INTO period_commitments (
       id, tenant_id, entity_id, period_id, merkle_root, entry_count, tree_depth,
       balance_commitment, status, committed_at, is_simulated
     ) VALUES ($1,$2,$3,$4,$5,7,3,'bc','committed',NOW(),false)`,
    [uuidv4(), f.tenantId, f.entityId, periodoReal, `0x${'c'.repeat(64)}`]
  );

  for (const [periodo, simulada, valor] of [
    [periodoSimulado, true, 'activo_simulado'],
    [periodoReal, false, 'activo_real'],
  ] as Array<[string, boolean, string]>) {
    await query(
      `INSERT INTO published_aggregates (
         id, tenant_id, entity_id, period_id, dimension_type, dimension_value,
         dimension_hash, aggregate_commitment, transaction_count, public_amount, is_simulated
       ) VALUES ($1,$2,$3,$4,'account_type',$5,'h','ac',9,'1000.00',$6)`,
      [uuidv4(), f.tenantId, f.entityId, periodo, valor, simulada]
    );
  }

  s = await levantar(
    [
      ['/v1/admin/blockchain', blockchainRouter],
      ['/public/v1', publicVerificationRouter],
    ],
    sesionDe(f)
  );
});

afterAll(async () => {
  await s.cerrar();
  await closeDatabase();
});

describe('la ruta de administración nombra lo que sirve', () => {
  it('devuelve is_simulated en cada fila', async () => {
    const r = await pedir(s, 'GET', `/v1/admin/blockchain/attestations?entity_id=${f.entityId}`);
    expect(r.status).toBe(200);
    const filas = (r.body.data as Array<Record<string, unknown>>);
    expect(filas.length).toBeGreaterThan(0);
    for (const fila of filas) {
      expect(
        fila,
        'sin la columna, el administrador ve un txHash fabricado y nada que lo diga'
      ).toHaveProperty('is_simulated');
    }
  });

  it('avisa, y el aviso dice cuántas de cuántas', async () => {
    const r = await pedir(s, 'GET', `/v1/admin/blockchain/attestations?entity_id=${f.entityId}`);
    expect(String(r.body.aviso)).toMatch(/SIMULADAS/);
    expect(String(r.body.aviso), 'el aviso tiene que dar la proporción').toMatch(/\d+ de \d+/);
    expect(String(r.body.aviso)).toMatch(/no corresponden a ninguna transacción/i);
  });
});

describe('el endpoint público del sello', () => {
  it('se niega con 501 ante un compromiso simulado', async () => {
    const r = await pedir(s, 'GET', `/public/v1/entities/${f.entityId}/periods/${periodoSimulado}`);
    expect(r.status, 'servía el sello fabricado como prueba, sin autenticar').toBe(501);
    const errores = r.body.errors as Array<{ code: string; message: string }>;
    expect(errores[0].code).toBe('ATTESTATION_SIMULATED');
    expect(errores[0].message).toMatch(/compromiso de ese periodo/i);
  });

  it('no es una manta: un compromiso real sí se sirve', async () => {
    const r = await pedir(s, 'GET', `/public/v1/entities/${f.entityId}/periods/${periodoReal}`);
    expect(r.status).toBe(200);
    const d = r.body.data as { commitment: { entryCount: number } };
    expect(d.commitment.entryCount).toBe(7);
  });

  it('no devuelve 404: la contabilidad existe, lo que falta es la prueba', async () => {
    // Un 404 diría «no existe». El auditor tiene que poder distinguir «no hay
    // periodo» de «hay periodo y su anclaje no vale».
    const r = await pedir(s, 'GET', `/public/v1/entities/${f.entityId}/periods/${periodoSimulado}`);
    expect(r.status).not.toBe(404);
  });
});

describe('el endpoint público de agregados', () => {
  it('no sirve los simulados, y sí los reales', async () => {
    const r = await pedir(s, 'GET', `/public/v1/entities/${f.entityId}/aggregates`);
    expect(r.status).toBe(200);
    const valores = (r.body.data as Array<{ dimension_value: string }>).map((x) => x.dimension_value);
    expect(valores, 'una cifra con anclaje fabricado no es una cifra publicable').not.toContain('activo_simulado');
    expect(valores).toContain('activo_real');
  });
});
