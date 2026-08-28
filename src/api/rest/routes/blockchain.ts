import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess, assertEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { ValidationError } from '../../../utils/errors.js';
import { blockchainOrchestrator } from '../../../services/blockchain/orchestrator.js';
import { CHAIN_CONFIGS, ChainId } from '../../../services/blockchain/chain-adapters.js';
import { REDUNDANCY_MODES, VERIFICATION_LAYERS, MESSAGING_PROTOCOLS } from '../../../database/enums.js';

const router = Router();

// ─── Schemas ───
const secondaryChainSchema = z.object({
  chain_id: z.string(),
}).passthrough();

const blockchainConfigSchema = z.object({
  primary_chain: z.string().optional(),
  primary_chain_contract_address: z.string().optional(),
  secondary_chains: z.array(secondaryChainSchema).optional(),
  // Los tres vocabularios de blockchain_config estaban separados de sus
  // CHECK: de los nueve valores en juego coincidía UNO.
  redundancy_mode: z.enum(REDUNDANCY_MODES).optional(),
  required_confirmations: z.number().int().min(1).max(100).optional(),
  verification_layer: z.enum(VERIFICATION_LAYERS).optional(),
  messaging_protocol: z.enum(MESSAGING_PROTOCOLS).optional(),
  max_gas_price_gwei: z.union([z.string(), z.number()]).optional(),
  max_tx_cost_usd: z.union([z.string(), z.number()]).optional(),
  is_active: z.boolean().optional(),
});

const validateConfigSchema = z.object({
  primary_chain: z.string().optional(),
  secondary_chains: z.array(secondaryChainSchema).optional(),
});

const disclosureConfigSchema = z.object({
  entity_id: z.string().uuid().optional(),
  category_disclosure: z.record(z.number()).optional(),
  publish_geography: z.boolean().optional(),
  publish_line_of_business: z.boolean().optional(),
  publish_customer_segment: z.boolean().optional(),
  publish_channel: z.boolean().optional(),
  publication_delay_minutes: z.number().int().nonnegative().optional(),
  aggregation_period: z.enum(['daily', 'weekly', 'monthly', 'quarterly']).optional(),
  minimum_aggregation_count: z.number().int().positive().optional(),
  round_to_nearest: z.number().positive().optional(),
}).passthrough();

const bitcoinConfigSchema = z.object({
  is_enabled: z.boolean().optional(),
  anchor_frequency: z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'on_period_close']).optional(),
  anchor_method: z.enum(['opentimestamps', 'direct', 'hybrid']).optional(),
  fee_strategy: z.enum(['economy', 'standard', 'priority']).optional(),
  max_fee_usd: z.union([z.string(), z.number()]).optional(),
  use_own_wallet: z.boolean().optional(),
  wallet_address: z.string().optional(),
  ots_calendars: z.array(z.string().url()).optional(),
  notify_on_complete: z.boolean().optional(),
  notify_on_failure: z.boolean().optional(),
  notification_emails: z.array(z.string().email()).optional(),
});

const bitcoinEstimateSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'on_period_close']).optional(),
  feeStrategy: z.enum(['economy', 'standard', 'priority']).optional(),
});

const commitPeriodSchema = z.object({
  entity_id: z.string().uuid(),
  period_id: z.string().uuid(),
});

// ============================================================
// BLOCKCHAIN CONFIG
// ============================================================

// GET /v1/admin/blockchain/config
router.get('/config', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  const result = await query(
    'SELECT * FROM blockchain_config WHERE tenant_id = $1',
    [req.user!.tenant_id]
  );

  res.json({
    data: result.rows[0] || null,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// PUT /v1/admin/blockchain/config
router.put('/config', requirePermission('settings:manage'), validateBody(blockchainConfigSchema), asyncHandler(async (req: Request, res: Response) => {
  const {
    primary_chain, primary_chain_contract_address,
    secondary_chains, redundancy_mode, required_confirmations,
    verification_layer, messaging_protocol,
    max_gas_price_gwei, max_tx_cost_usd, is_active,
  } = req.body;

  // Validate chain IDs
  if (primary_chain && !(primary_chain in CHAIN_CONFIGS)) {
    throw new ValidationError(`Unknown primary_chain: ${primary_chain}`);
  }
  if (secondary_chains) {
    for (const sc of secondary_chains) {
      if (!(sc.chain_id in CHAIN_CONFIGS)) {
        throw new ValidationError(`Unknown secondary chain: ${sc.chain_id}`);
      }
    }
  }

  const result = await query(
    `INSERT INTO blockchain_config (
      id, tenant_id, primary_chain, primary_chain_contract_address,
      secondary_chains, redundancy_mode, required_confirmations,
      verification_layer, messaging_protocol,
      max_gas_price_gwei, max_tx_cost_usd, is_active,
      created_by, updated_by
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $13)
    ON CONFLICT (tenant_id) DO UPDATE SET
      primary_chain = COALESCE(EXCLUDED.primary_chain, blockchain_config.primary_chain),
      primary_chain_contract_address = COALESCE(EXCLUDED.primary_chain_contract_address, blockchain_config.primary_chain_contract_address),
      secondary_chains = COALESCE(EXCLUDED.secondary_chains, blockchain_config.secondary_chains),
      redundancy_mode = COALESCE(EXCLUDED.redundancy_mode, blockchain_config.redundancy_mode),
      required_confirmations = COALESCE(EXCLUDED.required_confirmations, blockchain_config.required_confirmations),
      verification_layer = COALESCE(EXCLUDED.verification_layer, blockchain_config.verification_layer),
      messaging_protocol = COALESCE(EXCLUDED.messaging_protocol, blockchain_config.messaging_protocol),
      max_gas_price_gwei = EXCLUDED.max_gas_price_gwei,
      max_tx_cost_usd = EXCLUDED.max_tx_cost_usd,
      is_active = COALESCE(EXCLUDED.is_active, blockchain_config.is_active),
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING *`,
    [
      uuidv4(), req.user!.tenant_id,
      primary_chain || 'arbitrum-one', primary_chain_contract_address || null,
      JSON.stringify(secondary_chains || []),
      redundancy_mode || 'none', required_confirmations || 1,
      verification_layer || 'zkverify', messaging_protocol || 'layerzero',
      max_gas_price_gwei || null, max_tx_cost_usd || null,
      is_active !== false,
      req.user!.user_id,
    ]
  );

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/admin/blockchain/config/validate
router.post('/config/validate', requirePermission('settings:manage'), validateBody(validateConfigSchema), asyncHandler(async (req: Request, res: Response) => {
  const { primary_chain, secondary_chains } = req.body;
  const chains: string[] = [primary_chain, ...((secondary_chains || []).map((c: { chain_id: string }) => c.chain_id))].filter(Boolean);

  const results = [];
  for (const chainId of chains) {
    const config = CHAIN_CONFIGS[chainId as ChainId];
    if (!config) {
      results.push({ chain_id: chainId, valid: false, error: 'Unknown chain' });
      continue;
    }
    try {
      // In production: ping RPC endpoint
      results.push({ chain_id: chainId, valid: true, rpc_urls: config.rpcUrls, explorer: config.explorerUrl });
    } catch (err) {
      results.push({ chain_id: chainId, valid: false, error: (err as Error).message });
    }
  }

  res.json({
    data: { all_valid: results.every((r) => r.valid), results },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /v1/admin/blockchain/chains
router.get('/chains', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  res.json({
    data: Object.values(CHAIN_CONFIGS),
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// ============================================================
// DISCLOSURE CONFIG
// ============================================================

// GET /v1/admin/disclosure-config
router.get('/disclosure-config', requirePermission('settings:manage'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id } = req.query;
  const entityId = entity_id as string || req.entityId;

  const result = await query(
    'SELECT * FROM disclosure_config WHERE tenant_id = $1 AND entity_id = $2',
    [req.user!.tenant_id, entityId]
  );

  res.json({
    data: result.rows[0] || null,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// PUT /v1/admin/disclosure-config
router.put('/disclosure-config', requirePermission('settings:manage'), requireEntityAccess, validateBody(disclosureConfigSchema), asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, ...body } = req.body;
  const entityId = entity_id || req.entityId;

  const result = await query(
    `INSERT INTO disclosure_config (
      id, tenant_id, entity_id,
      category_disclosure,
      publish_geography, publish_line_of_business, publish_customer_segment, publish_channel,
      publication_delay_minutes, aggregation_period, minimum_aggregation_count, round_to_nearest
    ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (tenant_id, entity_id) DO UPDATE SET
      category_disclosure = EXCLUDED.category_disclosure,
      publish_geography = EXCLUDED.publish_geography,
      publish_line_of_business = EXCLUDED.publish_line_of_business,
      publish_customer_segment = EXCLUDED.publish_customer_segment,
      publish_channel = EXCLUDED.publish_channel,
      publication_delay_minutes = EXCLUDED.publication_delay_minutes,
      aggregation_period = EXCLUDED.aggregation_period,
      minimum_aggregation_count = EXCLUDED.minimum_aggregation_count,
      round_to_nearest = EXCLUDED.round_to_nearest,
      updated_at = NOW()
    RETURNING *`,
    [
      uuidv4(), req.user!.tenant_id, entityId,
      JSON.stringify(body.category_disclosure || { assets: 2, liabilities: 2, equity: 2, revenue: 3, expenses: 3 }),
      body.publish_geography !== false, body.publish_line_of_business !== false,
      body.publish_customer_segment === true, body.publish_channel === true,
      body.publication_delay_minutes || 0, body.aggregation_period || 'daily',
      body.minimum_aggregation_count || 5, body.round_to_nearest || 1000,
    ]
  );

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// ============================================================
// BITCOIN ANCHOR CONFIG
// ============================================================

// GET /v1/admin/bitcoin/config
router.get('/bitcoin/config', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  const result = await query(
    'SELECT * FROM bitcoin_anchor_config WHERE tenant_id = $1',
    [req.user!.tenant_id]
  );

  res.json({
    data: result.rows[0] || null,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// PUT /v1/admin/bitcoin/config
router.put('/bitcoin/config', requirePermission('settings:manage'), validateBody(bitcoinConfigSchema), asyncHandler(async (req: Request, res: Response) => {
  const {
    is_enabled, anchor_frequency, anchor_method,
    fee_strategy, max_fee_usd, use_own_wallet, wallet_address,
    ots_calendars, notify_on_complete, notify_on_failure, notification_emails,
  } = req.body;

  const result = await query(
    `INSERT INTO bitcoin_anchor_config (
      id, tenant_id, is_enabled, anchor_frequency, anchor_method,
      fee_strategy, max_fee_usd, use_own_wallet, wallet_address,
      ots_calendars, notify_on_complete, notify_on_failure, notification_emails
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb)
    ON CONFLICT (tenant_id) DO UPDATE SET
      is_enabled = EXCLUDED.is_enabled,
      anchor_frequency = EXCLUDED.anchor_frequency,
      anchor_method = EXCLUDED.anchor_method,
      fee_strategy = EXCLUDED.fee_strategy,
      max_fee_usd = EXCLUDED.max_fee_usd,
      use_own_wallet = EXCLUDED.use_own_wallet,
      wallet_address = EXCLUDED.wallet_address,
      ots_calendars = EXCLUDED.ots_calendars,
      notify_on_complete = EXCLUDED.notify_on_complete,
      notify_on_failure = EXCLUDED.notify_on_failure,
      notification_emails = EXCLUDED.notification_emails,
      updated_at = NOW()
    RETURNING *`,
    [
      uuidv4(), req.user!.tenant_id,
      is_enabled || false, anchor_frequency || 'monthly', anchor_method || 'opentimestamps',
      fee_strategy || 'economy', max_fee_usd || 10.00,
      use_own_wallet || false, wallet_address || null,
      JSON.stringify(ots_calendars || ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org']),
      notify_on_complete !== false, notify_on_failure !== false,
      JSON.stringify(notification_emails || []),
    ]
  );

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/admin/bitcoin/estimate
router.post('/bitcoin/estimate', requirePermission('settings:manage'), validateBody(bitcoinEstimateSchema), asyncHandler(async (req: Request, res: Response) => {
  const { frequency, feeStrategy } = req.body;

  const feeRates: Record<string, number> = { economy: 5, standard: 20, priority: 50 };
  const rate = feeRates[feeStrategy || 'economy'] || 5;
  const txSize = 250; // vB
  const feeSatoshis = rate * txSize;
  const btcPrice = 60000;
  const costPerAnchor = (feeSatoshis / 100_000_000) * btcPrice;

  const anchorsPerMonth: Record<string, number> = {
    daily: 30, weekly: 4, monthly: 1, quarterly: 0.33, on_period_close: 1,
  };
  const monthly = (anchorsPerMonth[frequency || 'monthly'] || 1) * costPerAnchor;

  res.json({
    data: {
      estimatedCostPerAnchor: Number(costPerAnchor.toFixed(4)),
      estimatedMonthlyCost: Number(monthly.toFixed(2)),
      estimatedAnnualCost: Number((monthly * 12).toFixed(2)),
      currentFeeRate: rate,
      estimatedTxSizeVB: txSize,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/admin/bitcoin/anchor-now
router.post('/bitcoin/anchor-now', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  const result = await blockchainOrchestrator.anchorToBitcoin({ tenantId: req.user!.tenant_id });

  if (!result) {
    res.json({
      data: { anchored: false, reason: 'No new entries to anchor or Bitcoin anchoring disabled' },
      meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
    });
    return;
  }

  res.json({
    data: { anchored: true, ...result },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// ============================================================
// ATTESTATIONS (authenticated admin view)
// ============================================================

// GET /v1/admin/blockchain/attestations
router.get('/attestations', requirePermission('settings:manage'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, status, source_type, page = '1', per_page = '50' } = req.query;
  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(100, parseInt(per_page as string, 10));

  let where = 'WHERE tenant_id = $1';
  const params: unknown[] = [req.user!.tenant_id];
  let idx = 2;

  if (entity_id) { where += ` AND entity_id = $${idx++}`; params.push(entity_id); }
  if (status) { where += ` AND status = $${idx++}`; params.push(status); }
  if (source_type) { where += ` AND source_type = $${idx++}`; params.push(source_type); }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM blockchain_attestations ${where}`,
    params
  );

  const result = await query(
    `SELECT id, tenant_id, entity_id, source_type, source_id,
            entry_hash, zkverify_attestation_id, zkverify_merkle_root,
            chain_attestations, status, created_at
     FROM blockchain_attestations ${where}
     ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
    [...params, perPage, (pageNum - 1) * perPage]
  );

  res.json({
    data: result.rows,
    pagination: {
      page: pageNum, per_page: perPage,
      total_pages: Math.ceil(parseInt(countResult.rows[0].count, 10) / perPage),
      total_count: parseInt(countResult.rows[0].count, 10),
      next_cursor: null, prev_cursor: null,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/admin/blockchain/commit-period
//
// `requireEntityAccess` NO sirve aquí, y conviene decir por qué: mira el
// PRIMERO de (req.entityId, params.entity_id, body.entity_id), y req.entityId
// siempre tiene valor — así que en una ruta cuyo id de entidad viaja en el
// cuerpo validaría la cabecera y nunca el cuerpo. La pertenencia del
// entity_id del cuerpo se comprueba explícitamente.
router.post('/commit-period', requirePermission('periods:close'), validateBody(commitPeriodSchema), asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, period_id } = req.body;
  assertEntityAccess(req.user!, entity_id);

  const result = await blockchainOrchestrator.commitPeriod({
    tenantId: req.user!.tenant_id, entityId: entity_id, periodId: period_id,
  });

  res.json({
    data: result,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/admin/blockchain/publish-aggregates
//
// Lo que esta ruta publica se sirve DESPUÉS SIN AUTENTICAR en
// GET /public/v1/entities/:entityId/aggregates, que filtra sólo por entity_id.
// Escribir aquí con la entidad de otro era publicar sus cifras al mundo.
router.post('/publish-aggregates', requirePermission('periods:close'), validateBody(commitPeriodSchema), asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, period_id } = req.body;
  assertEntityAccess(req.user!, entity_id);

  const result = await blockchainOrchestrator.publishAggregates({
    tenantId: req.user!.tenant_id, entityId: entity_id, periodId: period_id,
  });

  res.json({
    data: result,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// ============================================================
// BITCOIN ANCHORS (authenticated admin view)
// ============================================================

// GET /v1/admin/bitcoin/anchors
router.get('/bitcoin/anchors', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  const result = await query(
    `SELECT id, anchor_type, merkle_root, entry_count,
            bitcoin_txid, bitcoin_block_height, confirmations,
            fee_satoshis, fee_usd, status, broadcast_at, confirmed_at
     FROM bitcoin_anchors WHERE tenant_id = $1 OR tenant_id IS NULL
     ORDER BY broadcast_at DESC NULLS LAST, created_at DESC LIMIT 100`,
    [req.user!.tenant_id]
  );

  res.json({
    data: result.rows,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
