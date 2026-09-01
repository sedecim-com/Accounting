import { Router, Request, Response } from 'express';
import { consultaPublica } from '../../../database/consulta-publica.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { preAuthRateLimiter } from '../middleware/rate-limiter.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { bitcoinAnchorService } from '../../../services/blockchain/bitcoin-anchor.js';
import { cryptoService } from '../../../services/blockchain/crypto-service.js';

// PUBLIC verification endpoints — NO authentication required
// These expose cryptographic proofs so third parties can verify
// journal entry attestations without access to internal data.

const router = Router();

// EL FRENO VIVE AQUÍ, NO EN EL MONTAJE.
//
// Este router sirve sin credenciales y hace trabajo caro: /verify/merkle-proof
// verifica criptográficamente lo que mande cualquiera. Ponerlo en el montaje
// funcionaba, pero dejaba la protección a un archivo de distancia —invisible
// para quien lee este router y para el análisis estático, que lo señalaba como
// `js/missing-rate-limiting`—. Aquí viaja con el router a donde se monte.
router.use(preAuthRateLimiter);

// ============================================================
// UNA PRUEBA FABRICADA ES PEOR QUE NINGUNA.
//
// Los adaptadores de cadena no anclan nada: `simulateBlockNumber()`,
// `simulateGasCost()` y un `confirmations: 12` fijo fabrican la atestación
// entera. Este router sirve esas filas SIN AUTENTICACIÓN, y su propósito es
// que un tercero —el auditor del cliente— se las crea.
//
// Es la misma clase que retiró CLI-5, en su peor variante: un timbre
// inventado engaña a quien lo emitió; una atestación inventada engaña a
// quien vino a comprobarla. Así que mientras el anclaje sea simulado, este
// router no sirve nada y lo dice.
//
// No es un 404. Un 404 diría «no existe», y existe: lo que no existe es la
// prueba. La distinción importa porque el auditor tiene que saber que la
// contabilidad está ahí y que lo que falta es el anclaje.
// ============================================================
function rechazarSimulada(res: Response, que: string): void {
  res.status(501).json({
    errors: [{
      code: 'ATTESTATION_SIMULATED',
      message:
        `${que} existe, pero su anclaje es SIMULADO: ningún hash se escribió en ninguna cadena, ` +
        `así que no hay nada que un tercero pueda comprobar. Este endpoint se niega a presentarlo ` +
        `como prueba. Volverá a responder cuando exista un adaptador de cadena real.`,
    }],
    meta: { timestamp: new Date().toISOString(), version: 'v1' },
  });
}

// Rate limiter stub - 100 req/min per IP (already covered by global rate-limiter)

// ============================================================
// ENTRY VERIFICATION
// ============================================================

// GET /public/v1/verify/:entryHash
router.get('/verify/:entryHash', asyncHandler(async (req: Request, res: Response) => {
  const entryHash = req.params.entryHash;

  if (!/^0x[a-fA-F0-9]{64}$/.test(entryHash)) {
    throw new ValidationError('entryHash must be 0x followed by 64 hex chars');
  }

  const attestation = await consultaPublica<{
    id: string;
    tenant_id: string;
    entity_id: string;
    entry_hash: string;
    zkverify_attestation_id: string | null;
    zkverify_merkle_root: string | null;
    zkverify_confirmed_at: Date | null;
    chain_attestations: unknown;
    status: string;
    created_at: Date;
    is_simulated: boolean;
  }>(
    `SELECT id, tenant_id, entity_id, entry_hash,
            zkverify_attestation_id, zkverify_merkle_root, zkverify_confirmed_at,
            chain_attestations, status, created_at, is_simulated
     FROM blockchain_attestations WHERE entry_hash = $1 LIMIT 1`,
    [entryHash]
  );

  if (attestation.rows.length === 0) {
    res.status(404).json({
      errors: [{ code: 'NOT_FOUND', message: 'No attestation found for entry hash' }],
      meta: { timestamp: new Date().toISOString(), version: 'v1' },
    });
    return;
  }

  const a = attestation.rows[0];
  if (a.is_simulated) {
    rechazarSimulada(res, 'La atestación de ese asiento');
    return;
  }
  const chains = Array.isArray(a.chain_attestations) ? a.chain_attestations : [];

  // Check Bitcoin anchor
  const btcProof = await bitcoinAnchorService.getBitcoinProof(entryHash);

  res.json({
    data: {
      entryHash,
      verified: a.status === 'confirmed',
      status: a.status,
      entityId: a.entity_id,
      zkVerify: a.zkverify_attestation_id
        ? {
            attestationId: a.zkverify_attestation_id,
            merkleRoot: a.zkverify_merkle_root,
            verifiedAt: a.zkverify_confirmed_at,
          }
        : null,
      chains: chains.map((c: Record<string, unknown>) => ({
        chainId: c.chainId,
        txHash: c.txHash,
        blockNumber: c.blockNumber,
        explorerUrl: c.explorerUrl,
        confirmations: c.status === 'confirmed' ? 12 : 0,
        status: c.status,
      })),
      bitcoin: btcProof
        ? {
            txid: btcProof.bitcoinTxid,
            blockHeight: btcProof.blockHeight,
            confirmations: btcProof.confirmations,
            explorerUrl: btcProof.explorerUrl,
          }
        : null,
      independentVerification: {
        steps: [
          '1. Fetch journal entry data from source system',
          '2. Compute SHA-256 hash of canonical JSON representation',
          '3. Verify computed hash matches this entryHash',
          '4. Verify zkVerify attestation on zkVerify explorer',
          '5. Verify chain transactions on respective block explorers',
          btcProof ? '6. Verify Bitcoin OP_RETURN contains expected Merkle root' : '',
        ].filter(Boolean),
        codeSnippet: `
// Node.js verification
import crypto from 'crypto';
const entry = /* fetch from source */;
const canonical = JSON.stringify({ id: entry.id, ... });
const hash = '0x' + crypto.createHash('sha256').update(canonical).digest('hex');
console.log(hash === '${entryHash}');
`.trim(),
      },
      createdAt: a.created_at,
    },
    meta: { timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /public/v1/entities/:entityId
router.get('/entities/:entityId', asyncHandler(async (req: Request, res: Response) => {
  const entityId = req.params.entityId;

  const entity = await consultaPublica<{
    id: string;
    name: string;
    entity_type: string;
    incorporation_country: string;
    accounting_standard: string;
  }>(
    `SELECT id, name, entity_type, incorporation_country, accounting_standard
     FROM legal_entities WHERE id = $1 AND is_active = true`,
    [entityId]
  );

  if (entity.rows.length === 0) throw new NotFoundError('Entity', entityId);

  // Aggregate stats (public info only)
  const stats = await consultaPublica<{ total_attestations: string; total_periods: string }>(
    `SELECT
      (SELECT COUNT(*)::text FROM blockchain_attestations WHERE entity_id = $1 AND status = 'confirmed') as total_attestations,
      (SELECT COUNT(*)::text FROM period_commitments WHERE entity_id = $1) as total_periods`,
    [entityId]
  );

  res.json({
    data: {
      ...entity.rows[0],
      stats: {
        totalAttestations: parseInt(stats.rows[0].total_attestations, 10),
        totalPeriodCommitments: parseInt(stats.rows[0].total_periods, 10),
      },
    },
    meta: { timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /public/v1/entities/:entityId/periods/:periodId
router.get('/entities/:entityId/periods/:periodId', asyncHandler(async (req: Request, res: Response) => {
  const { entityId, periodId } = req.params;

  const commitment = await consultaPublica<{
    id: string;
    merkle_root: string;
    entry_count: number;
    tree_depth: number;
    balance_commitment: string;
    zkverify_attestation_id: string | null;
    chain_commitments: unknown;
    status: string;
    committed_at: Date | null;
    is_simulated: boolean;
  }>(
    `SELECT id, merkle_root, entry_count, tree_depth, balance_commitment,
            zkverify_attestation_id, chain_commitments, status, committed_at,
            is_simulated
     FROM period_commitments WHERE entity_id = $1 AND period_id = $2`,
    [entityId, periodId]
  );

  if (commitment.rows.length === 0) throw new NotFoundError('Period commitment');

  // E1.4 puso este cerrojo en /verify/:entryHash y no aquí, que es donde vive
  // la carga útil de la prueba: el sello del periodo y su `entryCount`. Un
  // compromiso simulado se servía sin autenticar, sin marca y sin rechazo.
  if (commitment.rows[0].is_simulated) {
    rechazarSimulada(res, 'El compromiso de ese periodo');
    return;
  }

  // Get published aggregates
  const aggregates = await consultaPublica<{
    dimension_type: string;
    dimension_value: string;
    public_amount: string | null;
    transaction_count: number;
    published_at: Date;
  }>(
    `SELECT dimension_type, dimension_value, public_amount, transaction_count, published_at
     FROM published_aggregates WHERE entity_id = $1 AND period_id = $2`,
    [entityId, periodId]
  );

  res.json({
    data: {
      commitment: {
        merkleRoot: commitment.rows[0].merkle_root,
        entryCount: commitment.rows[0].entry_count,
        treeDepth: commitment.rows[0].tree_depth,
        balanceCommitment: commitment.rows[0].balance_commitment,
        zkVerifyAttestation: commitment.rows[0].zkverify_attestation_id,
        chainCommitments: commitment.rows[0].chain_commitments,
        status: commitment.rows[0].status,
        committedAt: commitment.rows[0].committed_at,
      },
      aggregates: aggregates.rows.map((a) => ({
        dimensionType: a.dimension_type,
        dimensionValue: a.dimension_value,
        publicAmount: a.public_amount,
        transactionCount: a.transaction_count,
        publishedAt: a.published_at,
      })),
    },
    meta: { timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /public/v1/entities/:entityId/aggregates
router.get('/entities/:entityId/aggregates', asyncHandler(async (req: Request, res: Response) => {
  const { entityId } = req.params;
  const { dimension, value, from_period, to_period } = req.query;

  let where = 'WHERE entity_id = $1';
  const params: unknown[] = [entityId];
  let idx = 2;

  if (dimension) { where += ` AND dimension_type = $${idx++}`; params.push(dimension); }
  if (value) { where += ` AND dimension_value = $${idx++}`; params.push(value); }

  // Los agregados simulados no se sirven: se filtran en el propio SQL, no
  // después, para que la cifra de este endpoint nunca dependa de que alguien
  // se acuerde de filtrar en JavaScript. Un listado vacío es la respuesta
  // correcta mientras el anclaje sea fabricado.
  const result = await consultaPublica(
    `SELECT dimension_type, dimension_value, public_amount, transaction_count,
            period_id, published_at, aggregate_commitment
     FROM published_aggregates ${where} AND is_simulated = false
     ORDER BY published_at DESC LIMIT 100`,
    params
  );

  res.json({
    data: result.rows,
    meta: { timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /public/v1/bitcoin/verify/:txid
router.get('/bitcoin/verify/:txid', asyncHandler(async (req: Request, res: Response) => {
  const txid = req.params.txid;

  if (!/^[a-fA-F0-9]{64}$/.test(txid)) {
    throw new ValidationError('txid must be 64 hex chars');
  }

  const anchor = await consultaPublica<{
    id: string;
    anchor_type: string;
    merkle_root: string;
    entry_count: number;
    bitcoin_block_height: number | null;
    bitcoin_block_hash: string | null;
    confirmations: number;
    status: string;
    broadcast_at: Date | null;
    confirmed_at: Date | null;
    op_return_payload: string;
  }>(
    `SELECT id, anchor_type, merkle_root, entry_count,
            bitcoin_block_height, bitcoin_block_hash, confirmations, status,
            broadcast_at, confirmed_at,
            encode(op_return_payload, 'hex') as op_return_payload
     FROM bitcoin_anchors WHERE bitcoin_txid = $1`,
    [txid]
  );

  if (anchor.rows.length === 0) throw new NotFoundError('Bitcoin anchor');

  const a = anchor.rows[0];
  res.json({
    data: {
      txid,
      anchorId: a.id,
      anchorType: a.anchor_type,
      merkleRoot: a.merkle_root,
      entryCount: a.entry_count,
      blockHeight: a.bitcoin_block_height,
      blockHash: a.bitcoin_block_hash,
      confirmations: a.confirmations,
      status: a.status,
      broadcastAt: a.broadcast_at,
      confirmedAt: a.confirmed_at,
      opReturnPayload: a.op_return_payload,
      explorerUrl: `https://mempool.space/tx/${txid}`,
    },
    meta: { timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /public/v1/bitcoin/proof/:entryHash
router.get('/bitcoin/proof/:entryHash', asyncHandler(async (req: Request, res: Response) => {
  const entryHash = req.params.entryHash;

  if (!/^0x[a-fA-F0-9]{64}$/.test(entryHash)) {
    throw new ValidationError('entryHash must be 0x followed by 64 hex chars');
  }

  const proof = await bitcoinAnchorService.getBitcoinProof(entryHash);
  if (!proof) throw new NotFoundError('Bitcoin proof for entry');

  res.json({
    data: proof,
    meta: { timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /public/v1/verify/merkle-proof
// Verify a user-submitted Merkle proof against our root
router.post('/verify/merkle-proof', asyncHandler(async (req: Request, res: Response) => {
  const { leaf, proof, root } = req.body;

  if (!leaf || !proof || !root) {
    throw new ValidationError('leaf, proof, and root are required');
  }

  const valid = cryptoService.verifyMerkleProof({ leaf, proof, root });

  res.json({
    data: { valid, leaf, root },
    meta: { timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
