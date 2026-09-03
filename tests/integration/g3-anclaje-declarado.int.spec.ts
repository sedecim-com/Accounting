import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import blockchainRouter from '../../src/api/rest/routes/blockchain.js';
import publicVerificationRouter from '../../src/api/rest/routes/public-verification.js';
import { bitcoinAnchorService } from '../../src/services/blockchain/bitcoin-anchor.js';

/**
 * G3 · NINGUNA SUPERFICIE SIRVE UN ANCLAJE DE BITCOIN SIN DECIR SI ES SIMULADO.
 *
 * La migración 034 le enseñó a declararse simuladas a las tres tablas de
 * atestación —`blockchain_attestations`, `period_commitments`,
 * `published_aggregates`— y dejó fuera la cuarta: `bitcoin_anchors`. La 061
 * la añade, y esto comprueba las dos mitades del arreglo.
 *
 * EL ESCRITOR: `anchorToBitcoin` fabrica el txid con un sha256 del payload y
 * la hora —«Simulate broadcast», lo dice su propio comentario desde 006— y
 * tiene que declararlo, no heredarlo del DEFAULT de la migración. Un DEFAULT
 * es una suposición; el día que exista difusión real, un valor heredado
 * seguiría marcando como simulado lo que ya no lo es.
 *
 * EL LECTOR, que es la mitad cara: `https://mempool.space/tx/<txid>` sobre un
 * txid fabricado no falla aquí. Falla en el navegador del auditor del
 * cliente, que abre el enlace, ve que la transacción no existe, y para
 * entonces ya se la enseñaron a un tercero.
 */

let f: Fixture;
let s: Servidor;

/** Hash de asiento de un anclaje SIMULADO, y de uno REAL. */
let hashSimulado: string;
let hashReal: string;
let txidSimulado: string;
let txidReal: string;

/** Inserta un anclaje con su entrada, declarando explícitamente la simulación. */
async function anclar(simulado: boolean, marca: string): Promise<{ txid: string; hash: string }> {
  const anchorId = uuidv4();
  const txid = marca.repeat(64).slice(0, 64);
  const hash = `0x${marca.repeat(64).slice(0, 64)}`;
  await query(
    `INSERT INTO bitcoin_anchors (
       id, tenant_id, anchor_type, merkle_root, entry_count, op_return_payload,
       protocol_version, bitcoin_txid, bitcoin_block_height, confirmations,
       status, broadcast_at, confirmed_at, is_simulated
     ) VALUES ($1,$2,'single_tenant',$3,1,$4,1,$5,880000,6,'confirmed',NOW(),NOW(),$6)`,
    [anchorId, f.tenantId, `0x${'1'.repeat(64)}`, Buffer.alloc(80), txid, simulado]
  );
  await query(
    `INSERT INTO bitcoin_anchor_entries (
       id, bitcoin_anchor_id, tenant_id, entry_type, entry_id, entry_hash,
       leaf_index, merkle_proof
     ) VALUES ($1,$2,$3,'journal_entry',$4,$5,0,'[]'::jsonb)`,
    [uuidv4(), anchorId, f.tenantId, uuidv4(), hash]
  );
  return { txid, hash };
}

beforeAll(async () => {
  f = await crearInquilino('G3 · anclaje declarado');

  const sim = await anclar(true, 'a');
  txidSimulado = sim.txid;
  hashSimulado = sim.hash;

  // Y uno NO simulado. Sin él, todas las filas serían simuladas y un cerrojo
  // que rechazara SIEMPRE pasaría todas las pruebas del lado del rechazo sin
  // ser un cerrojo: sería una manta.
  const real = await anclar(false, 'b');
  txidReal = real.txid;
  hashReal = real.hash;

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

describe('el escritor declara la simulación en vez de heredarla', () => {
  it('un anclaje escrito por el servicio nace marcado como simulado', async () => {
    const r = await bitcoinAnchorService.anchorToBitcoin(
      [{
        tenantId: f.tenantId,
        entryType: 'journal_entry',
        entryId: uuidv4(),
        entryHash: `0x${'c'.repeat(64)}`,
      }],
      f.tenantId
    );

    const fila = await query<{ is_simulated: boolean; bitcoin_txid: string }>(
      'SELECT is_simulated, bitcoin_txid FROM bitcoin_anchors WHERE id = $1',
      [r.anchorId]
    );
    expect(fila.rows).toHaveLength(1);
    expect(
      fila.rows[0].is_simulated,
      'el txid sale de un sha256 local: si la fila no lo dice, las superficies no pueden decirlo'
    ).toBe(true);
    // Y el txid tiene forma de txid real —64 hex—, que es precisamente por lo
    // que la marca hace falta: nada en el dato lo delata.
    expect(fila.rows[0].bitcoin_txid).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * La columna se escribe EXPLÍCITA en el INSERT, no se hereda del DEFAULT.
   * Se comprueba quitando el DEFAULT: si el escritor lo estuviera heredando,
   * el INSERT moriría por NOT NULL. Se restaura al terminar.
   */
  it('el valor viaja en el INSERT: sin DEFAULT en la columna, el escritor sigue funcionando', async () => {
    await query('ALTER TABLE bitcoin_anchors ALTER COLUMN is_simulated DROP DEFAULT');
    try {
      const r = await bitcoinAnchorService.anchorToBitcoin(
        [{
          tenantId: f.tenantId,
          entryType: 'journal_entry',
          entryId: uuidv4(),
          entryHash: `0x${'d'.repeat(64)}`,
        }],
        f.tenantId
      );
      const fila = await query<{ is_simulated: boolean }>(
        'SELECT is_simulated FROM bitcoin_anchors WHERE id = $1',
        [r.anchorId]
      );
      expect(fila.rows[0].is_simulated).toBe(true);
    } finally {
      await query('ALTER TABLE bitcoin_anchors ALTER COLUMN is_simulated SET DEFAULT true');
    }
  });
});

describe('el lector del servicio no fabrica un enlace a un explorador público', () => {
  it('un anclaje simulado sale marcado y SIN explorerUrl', async () => {
    const p = await bitcoinAnchorService.getBitcoinProof(hashSimulado);
    expect(p).not.toBeNull();
    expect(p!.isSimulated).toBe(true);
    expect(
      p!.explorerUrl,
      'un enlace a mempool.space sobre un txid inventado se descubre en el navegador de un tercero'
    ).toBeNull();
    // Y las instrucciones de verificación independiente tampoco se sirven:
    // son una receta para ir a comprobar algo que no está en la cadena.
    expect(p!.verificationCode).toMatch(/SIMULADO/);
    expect(p!.verificationCode).not.toContain('bitcoinjs-lib');
  });

  it('un anclaje real sí trae su enlace: el cerrojo no es una manta', async () => {
    const p = await bitcoinAnchorService.getBitcoinProof(hashReal);
    expect(p).not.toBeNull();
    expect(p!.isSimulated).toBe(false);
    expect(p!.explorerUrl).toBe(`https://mempool.space/tx/${txidReal}`);
    expect(p!.verificationCode).toContain('bitcoinjs-lib');
  });
});

describe('la superficie pública se niega ante un anclaje simulado', () => {
  it('GET /public/v1/bitcoin/verify/:txid responde 501, no un bloque y un enlace', async () => {
    const r = await pedir(s, 'GET', `/public/v1/bitcoin/verify/${txidSimulado}`);
    expect(
      r.status,
      'servía bloque, confirmaciones y explorerUrl de un txid fabricado, SIN autenticar'
    ).toBe(501);
    const errores = r.body.errors as Array<{ code: string; message: string }>;
    expect(errores[0].code).toBe('ATTESTATION_SIMULATED');
    expect(errores[0].message).toMatch(/anclaje de Bitcoin/i);
    // Y no se cuela el enlace en el cuerpo del rechazo.
    expect(JSON.stringify(r.body)).not.toContain('mempool.space');
  });

  it('no es 404: la contabilidad existe, lo que falta es la prueba', async () => {
    const r = await pedir(s, 'GET', `/public/v1/bitcoin/verify/${txidSimulado}`);
    expect(r.status).not.toBe(404);
  });

  it('un anclaje real se sirve con su enlace', async () => {
    const r = await pedir(s, 'GET', `/public/v1/bitcoin/verify/${txidReal}`);
    expect(r.status).toBe(200);
    const d = r.body.data as { explorerUrl: string; confirmations: number };
    expect(d.explorerUrl).toBe(`https://mempool.space/tx/${txidReal}`);
    expect(d.confirmations).toBe(6);
  });

  it('GET /public/v1/bitcoin/proof/:entryHash se niega sobre lo simulado y sirve lo real', async () => {
    const sim = await pedir(s, 'GET', `/public/v1/bitcoin/proof/${hashSimulado}`);
    expect(sim.status).toBe(501);
    expect((sim.body.errors as Array<{ code: string }>)[0].code).toBe('ATTESTATION_SIMULATED');

    const real = await pedir(s, 'GET', `/public/v1/bitcoin/proof/${hashReal}`);
    expect(real.status).toBe(200);
    const d = real.body.data as { isSimulated: boolean; explorerUrl: string };
    expect(d.isSimulated).toBe(false);
    expect(d.explorerUrl).toBe(`https://mempool.space/tx/${txidReal}`);
  });
});

describe('la vista de administración nombra lo que sirve, sin negarse', () => {
  /**
   * Aquí NO se rechaza y es deliberado: el administrador tiene derecho a ver
   * el estado real de su instalación. Una lista vacía le escondería que sí
   * hay anclajes, sólo que fabricados. Lo que no puede pasar es que los vea
   * creyendo otra cosa.
   */
  it('devuelve is_simulated en cada fila y avisa con la proporción de verdad', async () => {
    const r = await pedir(s, 'GET', '/v1/admin/blockchain/bitcoin/anchors');
    expect(r.status).toBe(200);
    const filas = r.body.data as Array<Record<string, unknown>>;
    expect(filas.length).toBeGreaterThan(0);
    for (const fila of filas) {
      expect(fila, 'sin la columna el administrador ve un txid fabricado y nada que lo diga')
        .toHaveProperty('is_simulated');
    }

    const simulados = filas.filter((x) => x.is_simulated === true).length;
    const aviso = String(r.body.aviso);
    expect(aviso).toMatch(/SIMULADOS/);
    // La proporción EXACTA, no un patrón: un contador que dijera siempre
    // «todos» pasaría un `/\d+ de \d+/`. El fixture tiene un anclaje real, así
    // que el numerador tiene que ser menor que el denominador.
    expect(aviso).toContain(`${simulados} de ${filas.length}`);
    expect(simulados).toBeLessThan(filas.length);
    expect(aviso).toMatch(/no existe en Bitcoin/i);
  });
});
