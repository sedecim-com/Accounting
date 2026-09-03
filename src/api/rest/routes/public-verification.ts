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

/** ceil(log2(hojas)): 64 cubre un árbol de 2^64 hojas. Ver /verify/merkle-proof. */
const MAX_ELEMENTOS_PRUEBA = 64;
/** Un digest sha256 en hexadecimal, con o sin el 0x de cortesía. */
const DIGEST_HEX = /^(0x)?[0-9a-f]{64}$/i;

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      // Este manejador ya rechazó con 501 la atestación simulada, así que
      // llegar aquí significa que la atestación es real. El anclaje de
      // Bitcoin es OTRA fila y puede seguir siendo simulado: se sirve
      // marcado, y sin enlace al explorador cuando lo es (getBitcoinProof
      // devuelve `explorerUrl: null` en ese caso). Servirlo sin la marca
      // sería exactamente lo que E1.4 vino a impedir, una tabla más allá.
      bitcoin: btcProof
        ? {
            txid: btcProof.bitcoinTxid,
            blockHeight: btcProof.blockHeight,
            confirmations: btcProof.confirmations,
            explorerUrl: btcProof.explorerUrl,
            isSimulated: btcProof.isSimulated,
          }
        : null,
      independentVerification: {
        steps: [
          '1. Fetch journal entry data from source system',
          '2. Compute SHA-256 hash of canonical JSON representation',
          '3. Verify computed hash matches this entryHash',
          '4. Verify zkVerify attestation on zkVerify explorer',
          '5. Verify chain transactions on respective block explorers',
          btcProof && !btcProof.isSimulated
            ? '6. Verify Bitcoin OP_RETURN contains expected Merkle root'
            : btcProof
              ? '6. El anclaje de Bitcoin es SIMULADO: no hay OP_RETURN en la cadena que comprobar'
              : '',
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

const PERIOD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve one end of a ?from_period=/&to_period= range.
 *
 * Both name a fiscal period by the same id that
 * GET /public/v1/entities/:entityId/periods/:periodId serves, and that this
 * endpoint already echoes back as `period_id`. A UUID carries no order, so the
 * range can only be expressed through the dates of the period each bound
 * points at -- hence the read, and hence the join in the caller.
 *
 * The bound is validated up front rather than folded into the WHERE clause: a
 * subquery against an id that does not exist yields NULL, every comparison
 * against it is false, and the caller gets an empty page that looks exactly
 * like "this entity published no aggregates". Failing loudly is the point of
 * the whole fix.
 */
async function periodBound(
  entityId: string,
  raw: unknown,
  field: 'from_period' | 'to_period'
): Promise<{ start_date: string; end_date: string }> {
  const id = String(raw);
  if (!PERIOD_UUID.test(id)) {
    throw new ValidationError(`${field} must be a fiscal period UUID`, field);
  }

  // ::text, as close-service.ts:51 and pending-service.ts:141 already do: with
  // no setTypeParser override in src/database, pg turns a DATE column into a
  // Date at LOCAL midnight, and handing that back as a query parameter
  // re-serializes it through the driver's timestamp path. A plain
  // 'YYYY-MM-DD' makes the round trip unambiguous, and a date filter that
  // slips by a day would be the same silent-wrong answer this fix is about.
  //
  // Y consultaPublica, no `query`: TODO lo que sirve este router pasa por el
  // rol mnemosine_verifier. Bajo RLS forzada, `query` con mnemosine_app y sin
  // contexto de inquilino devolvería cero filas y este helper contestaría
  // «no es un periodo de esta entidad» a un id perfectamente válido.
  const period = await consultaPublica<{ start_date: string; end_date: string }>(
    'SELECT start_date::text, end_date::text FROM fiscal_periods WHERE id = $1 AND entity_id = $2',
    [id, entityId]
  );

  // An unknown id and another entity's id answer identically. This endpoint is
  // unauthenticated; separating the two would turn it into an oracle for
  // whether a given UUID is some other entity's fiscal period.
  if (period.rows.length === 0) {
    throw new ValidationError(`${field} is not a fiscal period of this entity`, field);
  }
  return period.rows[0];
}

// GET /public/v1/entities/:entityId/aggregates
router.get('/entities/:entityId/aggregates', asyncHandler(async (req: Request, res: Response) => {
  const { entityId } = req.params;
  const { dimension, value, from_period, to_period } = req.query;

  if (!UUID_RE.test(entityId)) throw new ValidationError('entityId must be a uuid');

  let where = 'WHERE pa.entity_id = $1';
  const params: unknown[] = [entityId];
  let idx = 2;

  if (dimension) { where += ` AND pa.dimension_type = $${idx++}`; params.push(dimension); }
  if (value) { where += ` AND pa.dimension_value = $${idx++}`; params.push(value); }

  // The range closes on the bound periods' own dates, not on their ids.
  if (from_period) {
    const from = await periodBound(entityId, from_period, 'from_period');
    where += ` AND fp.start_date >= $${idx++}`;
    params.push(from.start_date);
  }
  if (to_period) {
    const to = await periodBound(entityId, to_period, 'to_period');
    where += ` AND fp.end_date <= $${idx++}`;
    params.push(to.end_date);
  }

  // Dos filtros que NO se estorban y no se puede quitar ninguno:
  //
  //  · `pa.is_simulated = false` — los agregados simulados no se sirven, y se
  //    filtran en el propio SQL para que la cifra nunca dependa de que alguien
  //    se acuerde de filtrar en JavaScript. (La política del verificador lo
  //    repite en la base; aquí queda a la vista de quien lee la consulta.)
  //  · el JOIN con fiscal_periods — es lo que da sentido al WHERE de arriba.
  //    published_aggregates.period_id es NOT NULL REFERENCES fiscal_periods(id),
  //    así que la unión interna no puede perder renglones: una llamada sin
  //    rango devuelve lo mismo que devolvía.
  // Y se pide UNA fila de más que el tope, para declarar el truncamiento en
  // vez de presentar un listado parcial como si fuera el conjunto entero.
  const LIMIT = 100;
  const result = await consultaPublica(
    `SELECT pa.dimension_type, pa.dimension_value, pa.public_amount, pa.transaction_count,
            pa.period_id, pa.published_at, pa.aggregate_commitment
     FROM published_aggregates pa
     JOIN fiscal_periods fp ON fp.id = pa.period_id
     ${where} AND pa.is_simulated = false
     ORDER BY pa.published_at DESC LIMIT ${LIMIT + 1}`,
    params
  );

  const truncated = result.rows.length > LIMIT;
  res.json({
    data: result.rows.slice(0, LIMIT),
    meta: { timestamp: new Date().toISOString(), version: 'v1', limit: LIMIT, truncated },
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
    is_simulated: boolean;
  }>(
    `SELECT id, anchor_type, merkle_root, entry_count,
            bitcoin_block_height, bitcoin_block_hash, confirmations, status,
            broadcast_at, confirmed_at,
            encode(op_return_payload, 'hex') as op_return_payload,
            is_simulated
     FROM bitcoin_anchors WHERE bitcoin_txid = $1`,
    [txid]
  );

  if (anchor.rows.length === 0) throw new NotFoundError('Bitcoin anchor');

  const a = anchor.rows[0];
  // G3: el hueco que la 034 dejó abierto. Las tres tablas de atestación
  // aprendieron a declararse simuladas; `bitcoin_anchors` no, y este endpoint
  // —SIN autenticar— servía un `bitcoin_block_height`, un
  // `confirmations` y un `explorerUrl` de mempool.space sobre un txid que
  // `anchorToBitcoin` calcula con un sha256 local. Quien abriera ese enlace
  // encontraría que la transacción no existe: es la mentira más cara posible,
  // porque quien la descubre es el tercero al que ya se la enseñaron.
  if (a.is_simulated) {
    rechazarSimulada(res, 'Ese anclaje de Bitcoin');
    return;
  }
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

  // G3: la doctrina de este router, entera, en una rama. `/verify/:entryHash`
  // sirve el anclaje marcado porque su carga principal es OTRA cosa —la
  // atestación, que ya se comprobó real—; este endpoint no tiene otra carga:
  // se llama «proof» y devuelve el txid, la raíz, la prueba de Merkle y las
  // instrucciones para ir a comprobarlo a la cadena. Servir eso sobre un
  // anclaje fabricado es entregar una receta que termina en un explorador
  // diciendo «no encontrada».
  if (proof.isSimulated) {
    rechazarSimulada(res, 'La prueba de anclaje de ese asiento');
    return;
  }

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

  // TRABAJO ACOTADO ANTES DE EMPEZARLO.
  //
  // Todo lo que sigue son datos del solicitante, y este endpoint no pide
  // credenciales: verifyMerkleProof recorre `proof` decodificando y hasheando
  // elemento por elemento. Sin tope, un arreglo de un millón de entradas son un
  // millón de sha256 que cualquiera puede pedir gratis —el mismo patrón que el
  // lote de XML sin `.max()`—.
  //
  // El tope no es arbitrario: una prueba de Merkle tiene ceil(log2(hojas))
  // elementos, así que 64 cubre árboles de 2^64 hojas. Un `proof` más largo que
  // eso no es una prueba grande: es otra cosa.
  if (!Array.isArray(proof) || proof.length === 0 || proof.length > MAX_ELEMENTOS_PRUEBA) {
    throw new ValidationError(
      `proof must be an array of 1 to ${MAX_ELEMENTOS_PRUEBA} elements`, 'proof'
    );
  }
  // Cada elemento es un digest sha256 y su lado. Validar la FORMA aquí evita
  // que Buffer.from(...,'hex') se coma megabytes de basura por elemento.
  for (const p of proof) {
    if (!p || typeof p !== 'object' || (p.position !== 'left' && p.position !== 'right')) {
      throw new ValidationError("each proof element needs position 'left' or 'right'", 'proof');
    }
    if (typeof p.data !== 'string' || !DIGEST_HEX.test(p.data)) {
      throw new ValidationError('each proof element data must be a 32-byte hex digest', 'proof');
    }
  }
  for (const [nombre, valor] of [['leaf', leaf], ['root', root]] as const) {
    if (typeof valor !== 'string' || !DIGEST_HEX.test(valor)) {
      throw new ValidationError(`${nombre} must be a 32-byte hex digest`, nombre);
    }
  }

  const valid = cryptoService.verifyMerkleProof({ leaf, proof, root });

  res.json({
    data: { valid, leaf, root },
    meta: { timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
