import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { cryptoService } from './crypto-service.js';

// ============================================================
// BITCOIN ANCHOR SERVICE
// Anchors accounting Merkle roots to Bitcoin via OP_RETURN
// or OpenTimestamps (free alternative).
//
// OP_RETURN payload format (80 bytes max):
//   [4 bytes] Protocol ID: "TRPA" (Triple-entry Accounting)
//   [1 byte]  Version: 0x01
//   [1 byte]  Type: 0x01=single-tenant, 0x02=multi-tenant
//   [32 bytes] Merkle root
//   [8 bytes]  Entry count (big-endian uint64)
//   [34 bytes] Reserved/metadata
// ============================================================

export interface AnchorEntry {
  tenantId: string;
  entryType: 'journal_entry' | 'period_commitment' | 'aggregate';
  entryId: string;
  entryHash: string;
}

/**
 * La prueba de anclaje tal y como sale del servicio.
 *
 * `isSimulated` es OBLIGATORIA y no opcional a propósito: cualquier
 * superficie que arme su respuesta a partir de este objeto tiene el dato
 * delante, y la que decida no publicarlo lo estará decidiendo, no olvidando.
 * `explorerUrl` es nulable por la misma razón —ver getBitcoinProof.
 */
export interface BitcoinProof {
  entryHash: string;
  bitcoinTxid: string;
  blockHeight: number | null;
  confirmations: number;
  merkleProof: Array<{ position: string; data: string }>;
  leafIndex: number;
  merkleRoot: string;
  opReturnData: string;
  /** Si el txid se fabricó localmente en vez de difundirse a la cadena. */
  isSimulated: boolean;
  /** Enlace al explorador público. NULO cuando el anclaje es simulado. */
  explorerUrl: string | null;
  verificationCode: string;
}

export interface AnchorResult {
  anchorId: string;
  merkleRoot: string;
  bitcoinTxid?: string;
  opReturnData: Buffer;
  feeSatoshis: number;
  feeUsd: string;
  otsProof?: Buffer;
  status: 'pending' | 'broadcast' | 'confirmed';
}

/**
 * G3 · ESTE SERVICIO NO DIFUNDE NADA A LA CADENA.
 *
 * `anchorToBitcoin` fabrica el txid con un sha256 del payload y la hora, y
 * `confirmAnchor` recibe la altura de bloque de quien la llame. No hay
 * bitcoinjs-lib, no hay RPC de nodo y no hay llamada a Blockstream: el
 * comentario de cabecera del método siempre dijo «Simulate broadcast».
 *
 * La constante existe para que el hecho tenga UN sitio. El día que llegue la
 * difusión de verdad, lo que cambia es esta línea y la firma que la elija —no
 * un DEFAULT de una migración, que es donde este valor vivía sin que ningún
 * código lo sostuviera.
 */
const ESTE_ANCLAJE_ES_SIMULADO = true;

const PROTOCOL_ID = Buffer.from('TRPA', 'utf8');
const PROTOCOL_VERSION = 0x01;
const TYPE_SINGLE = 0x01;
const TYPE_MULTI = 0x02;

export class BitcoinAnchorService {
  /**
   * Build 80-byte OP_RETURN payload
   */
  buildOpReturnPayload(merkleRoot: string, entryCount: number, isMultiTenant: boolean): Buffer {
    const rootHex = merkleRoot.startsWith('0x') ? merkleRoot.slice(2) : merkleRoot;
    const rootBuf = Buffer.from(rootHex, 'hex');
    if (rootBuf.length !== 32) {
      throw new Error(`Merkle root must be 32 bytes, got ${rootBuf.length}`);
    }

    const payload = Buffer.alloc(80);
    let offset = 0;

    PROTOCOL_ID.copy(payload, offset);
    offset += 4;

    payload.writeUInt8(PROTOCOL_VERSION, offset);
    offset += 1;

    payload.writeUInt8(isMultiTenant ? TYPE_MULTI : TYPE_SINGLE, offset);
    offset += 1;

    rootBuf.copy(payload, offset);
    offset += 32;

    payload.writeBigUInt64BE(BigInt(entryCount), offset);
    offset += 8;

    // Remaining 34 bytes reserved
    return payload;
  }

  /**
   * Parse OP_RETURN payload
   */
  parseOpReturnPayload(payload: Buffer): {
    protocol: string;
    version: number;
    type: 'single_tenant' | 'multi_tenant';
    merkleRoot: string;
    entryCount: number;
  } {
    if (payload.length < 46) {
      throw new Error('Invalid payload: too short');
    }

    const protocol = payload.subarray(0, 4).toString('utf8');
    if (protocol !== 'TRPA') {
      throw new Error('Invalid protocol ID');
    }

    const version = payload.readUInt8(4);
    const type = payload.readUInt8(5) === TYPE_MULTI ? 'multi_tenant' : 'single_tenant';
    const merkleRoot = '0x' + payload.subarray(6, 38).toString('hex');
    const entryCount = Number(payload.readBigUInt64BE(38));

    return { protocol, version, type, merkleRoot, entryCount };
  }

  /**
   * Anchor entries to Bitcoin (single-tenant or aggregate).
   * In production: build and broadcast Bitcoin tx via node RPC or Blockstream API.
   */
  async anchorToBitcoin(
    entries: AnchorEntry[],
    tenantId: string | null,
    options: {
      feeStrategy?: 'economy' | 'standard' | 'priority';
      anchorMethod?: 'direct_op_return' | 'opentimestamps' | 'both';
    } = {}
  ): Promise<AnchorResult> {
    if (entries.length === 0) throw new Error('No entries to anchor');

    // Build Merkle tree of entry hashes
    const hashes = entries.map((e) => e.entryHash);
    const tree = cryptoService.buildMerkleTree(hashes);
    const merkleRoot = '0x' + tree.getRoot().toString('hex');

    const isMultiTenant = tenantId === null;
    const opReturnPayload = this.buildOpReturnPayload(merkleRoot, entries.length, isMultiTenant);

    const anchorId = uuidv4();

    // Simulate fee based on strategy
    const feeRates: Record<string, number> = { economy: 5, standard: 20, priority: 50 };
    const feeRate = feeRates[options.feeStrategy || 'economy'];
    const txSize = 250; // approximate vB for OP_RETURN tx
    const feeSatoshis = feeRate * txSize;
    const btcUsdPrice = 60000; // approximate
    const feeUsd = new Decimal(feeSatoshis).dividedBy(100_000_000).times(btcUsdPrice).toFixed(4);

    // Simulate broadcast (production: use bitcoinjs-lib + node RPC)
    const bitcoinTxid = crypto.createHash('sha256')
      .update(opReturnPayload)
      .update(String(Date.now()))
      .digest('hex');

    // Save anchor record
    await query(
      `INSERT INTO bitcoin_anchors (
        id, tenant_id, anchor_type, merkle_root, entry_count,
        op_return_payload, protocol_version, bitcoin_txid,
        fee_satoshis, fee_usd, fee_rate_sat_vb,
        status, broadcast_at, is_simulated
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'broadcast',NOW(),$12)`,
      [
        anchorId, tenantId, isMultiTenant ? 'multi_tenant' : 'single_tenant',
        merkleRoot, entries.length,
        opReturnPayload, PROTOCOL_VERSION, bitcoinTxid,
        feeSatoshis, feeUsd, feeRate,
        // G3: el valor va EXPLÍCITO en el INSERT, no heredado del DEFAULT de
        // la 061. Un default es una suposición; esta columna es una
        // afirmación, y quien la escribe es el único que sabe si el txid
        // salió de un nodo o de un sha256 local. Mientras `bitcoinTxid` se
        // calcule tres líneas más arriba con `crypto.createHash`, la
        // respuesta es SIMULADO y esta constante lo dice en una palabra.
        // El día que haya difusión real, es aquí donde se decide —igual que
        // `anclajeSimulado()` decide en el orquestador—, no en el esquema.
        ESTE_ANCLAJE_ES_SIMULADO,
      ]
    );

    // Save entry proofs
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const proof = cryptoService.getMerkleProof(tree, entry.entryHash);

      await query(
        `INSERT INTO bitcoin_anchor_entries (
          id, bitcoin_anchor_id, tenant_id, entry_type, entry_id,
          entry_hash, leaf_index, merkle_proof
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          uuidv4(), anchorId, entry.tenantId, entry.entryType, entry.entryId,
          entry.entryHash, i, JSON.stringify(proof.proof),
        ]
      );
    }

    return {
      anchorId,
      merkleRoot,
      bitcoinTxid,
      opReturnData: opReturnPayload,
      feeSatoshis,
      feeUsd,
      status: 'broadcast',
    };
  }

  /**
   * Confirm a Bitcoin anchor after it's been mined
   */
  async confirmAnchor(
    anchorId: string,
    txInfo: { blockHeight: number; blockHash: string; blockTimestamp: Date; confirmations: number }
  ): Promise<void> {
    await query(
      `UPDATE bitcoin_anchors SET
        bitcoin_block_height = $1, bitcoin_block_hash = $2,
        bitcoin_block_timestamp = $3, confirmations = $4,
        status = 'confirmed', confirmed_at = NOW()
       WHERE id = $5`,
      [txInfo.blockHeight, txInfo.blockHash, txInfo.blockTimestamp, txInfo.confirmations, anchorId]
    );
  }

  /**
   * Get Bitcoin proof for any entry
   */
  async getBitcoinProof(entryHash: string): Promise<BitcoinProof | null> {
    const result = await query<{
      anchor_id: string;
      bitcoin_txid: string;
      bitcoin_block_height: number | null;
      confirmations: number;
      merkle_root: string;
      merkle_proof: string;
      leaf_index: number;
      op_return_payload: string;
      is_simulated: boolean;
    }>(
      `SELECT
        ba.id as anchor_id, ba.bitcoin_txid, ba.bitcoin_block_height,
        ba.confirmations, ba.merkle_root,
        bae.merkle_proof, bae.leaf_index,
        encode(ba.op_return_payload, 'hex') as op_return_payload,
        ba.is_simulated
       FROM bitcoin_anchor_entries bae
       JOIN bitcoin_anchors ba ON ba.id = bae.bitcoin_anchor_id
       WHERE bae.entry_hash = $1
       ORDER BY ba.confirmed_at DESC NULLS LAST, ba.broadcast_at DESC
       LIMIT 1`,
      [entryHash]
    );

    if (result.rows.length === 0) return null;

    const r = result.rows[0];
    const merkleProof = typeof r.merkle_proof === 'string'
      ? JSON.parse(r.merkle_proof)
      : r.merkle_proof;

    return {
      entryHash,
      bitcoinTxid: r.bitcoin_txid,
      blockHeight: r.bitcoin_block_height,
      confirmations: r.confirmations,
      merkleProof,
      leafIndex: r.leaf_index,
      merkleRoot: r.merkle_root,
      opReturnData: r.op_return_payload,
      isSimulated: r.is_simulated,
      // G3: EL ENLACE ES CONDICIONAL, y es la mitad cara del arreglo.
      //
      // `https://mempool.space/tx/<txid>` sobre un txid fabricado localmente
      // es la forma más cara de mentir: no falla aquí, falla en el navegador
      // de un tercero —el auditor del cliente— que abre el enlace, ve que la
      // transacción no existe en la cadena, y para entonces ya se la
      // enseñaron. Un `null` con `isSimulated: true` al lado se lee mal una
      // vez; un explorador que dice «no encontrada» se lee como fraude.
      explorerUrl: r.is_simulated ? null : `https://mempool.space/tx/${r.bitcoin_txid}`,
      // Las instrucciones de verificación independiente tampoco se sirven
      // sobre un anclaje simulado: son una receta para ir a la cadena a
      // comprobar algo que no está en la cadena.
      verificationCode: r.is_simulated
        ? '// Anclaje SIMULADO: el txid se fabricó localmente y no existe en Bitcoin.\n' +
          '// No hay verificación independiente que correr hasta que el anclaje sea real.'
        : `
// Independent verification (Node.js / bitcoinjs-lib):
// 1. Fetch Bitcoin transaction ${r.bitcoin_txid}
// 2. Extract OP_RETURN output, verify it starts with "TRPA"
// 3. Extract Merkle root (bytes 6-38 of OP_RETURN)
// 4. Expected root: ${r.merkle_root}
// 5. Verify Merkle proof for leaf ${entryHash} using sha256 + sortPairs
`.trim(),
    };
  }
}

export const bitcoinAnchorService = new BitcoinAnchorService();
