import { v4 as uuidv4 } from 'uuid';
import { query } from '../../database/connection.js';
import { cryptoService } from './crypto-service.js';
import { chainAdapterFactory, ChainId, ChainTransactionResult } from './chain-adapters.js';
import { zkVerifyClient } from './zkverify-client.js';
import { bitcoinAnchorService, AnchorEntry } from './bitcoin-anchor.js';

// ============================================================
// BLOCKCHAIN ORCHESTRATOR
// Coordinates: crypto → zkVerify → chain adapters → Bitcoin anchoring
// ============================================================

interface BlockchainConfig {
  primary_chain: string;
  secondary_chains: Array<{ chain_id: string }>;
  redundancy_mode: 'none' | 'async_backup' | 'sync_multi' | 'consensus';
  verification_layer: 'zkverify' | 'native' | 'both';
  is_active: boolean;
}

export class BlockchainOrchestrator {
  /**
   * Attest a journal entry to blockchain.
   * Returns attestation record ID.
   */
  async attestJournalEntry(params: {
    tenantId: string;
    entityId: string;
    journalEntryId: string;
  }): Promise<{ attestationId: string; status: string } | null> {
    // Load tenant config
    const config = await this.getConfig(params.tenantId);
    if (!config || !config.is_active) return null;

    // Load entry with lines
    const entryResult = await query<{
      id: string;
      entity_id: string;
      fiscal_period_id: string;
      entry_date: Date;
      total_debits: string;
      total_credits: string;
    }>(
      `SELECT id, entity_id, fiscal_period_id, entry_date, total_debits, total_credits
       FROM journal_entries WHERE id = $1`,
      [params.journalEntryId]
    );
    if (entryResult.rows.length === 0) return null;

    const linesResult = await query<{
      account_id: string;
      debit_amount: string | null;
      credit_amount: string | null;
    }>(
      `SELECT account_id, debit_amount, credit_amount
       FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number`,
      [params.journalEntryId]
    );

    // Compute hash
    const entryHash = cryptoService.hashJournalEntry({
      ...entryResult.rows[0],
      lines: linesResult.rows,
    });

    // Update journal entry with hash
    await query(`UPDATE journal_entries SET entry_hash = $1 WHERE id = $2`, [entryHash, params.journalEntryId]);

    // Create Pedersen commitment on total_debits
    const commitment = cryptoService.createCommitment(entryResult.rows[0].total_debits);

    // Check existing attestation
    const existing = await query(
      `SELECT id FROM blockchain_attestations WHERE tenant_id = $1 AND source_type = 'journal_entry' AND source_id = $2`,
      [params.tenantId, params.journalEntryId]
    );
    if (existing.rows.length > 0) {
      return { attestationId: existing.rows[0].id as string, status: 'exists' };
    }

    // Create attestation record
    const attestationId = uuidv4();
    await query(
      `INSERT INTO blockchain_attestations (
        id, tenant_id, entity_id, source_type, source_id,
        entry_hash, commitment, status
      ) VALUES ($1, $2, $3, 'journal_entry', $4, $5, $6, 'pending')`,
      [attestationId, params.tenantId, params.entityId, params.journalEntryId, entryHash, Buffer.from(commitment.commitment.slice(2), 'hex')]
    );

    // Link attestation to journal entry
    await query(
      `UPDATE journal_entries SET blockchain_attestation_id = $1, commitment = $2 WHERE id = $3`,
      [attestationId, Buffer.from(commitment.commitment.slice(2), 'hex'), params.journalEntryId]
    );

    // Generate range proof
    const rangeProof = cryptoService.generateRangeProof(
      entryResult.rows[0].total_debits,
      commitment.blindingFactor,
      0,
      1_000_000_000_000 // 1 trillion max
    );

    // Submit to zkVerify
    const zkResult = await zkVerifyClient.verifyProof({
      proof: rangeProof.proof,
      publicInputs: [commitment.commitment, entryHash],
      proofSystem: 'ultraplonk',
    });

    // Update with zkVerify result
    await query(
      `UPDATE blockchain_attestations SET
        zkverify_attestation_id = $1, zkverify_merkle_root = $2,
        zkverify_proof = $3, zkverify_submitted_at = NOW(), zkverify_confirmed_at = NOW(),
        range_proof = $4
       WHERE id = $5`,
      [zkResult.attestationId, zkResult.merkleRoot, zkResult.proof, rangeProof.proof, attestationId]
    );

    // Submit to chains based on redundancy mode
    const chainResults = await this.routeToChains(config, {
      attestationId,
      entryHash,
      commitment: commitment.commitment,
      zkVerifyProof: '0x' + zkResult.proof.toString('hex'),
      zkVerifyRoot: zkResult.merkleRoot,
    });

    await query(
      `UPDATE blockchain_attestations SET
        chain_attestations = $1::jsonb, status = 'confirmed', updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(chainResults), attestationId]
    );

    return { attestationId, status: 'confirmed' };
  }

  /**
   * Route attestation to primary + secondary chains
   */
  private async routeToChains(
    config: BlockchainConfig,
    submission: {
      attestationId: string;
      entryHash: string;
      commitment: string;
      zkVerifyProof: string;
      zkVerifyRoot: string;
    }
  ): Promise<ChainTransactionResult[]> {
    const results: ChainTransactionResult[] = [];

    // Primary chain (always sync)
    try {
      const primaryAdapter = chainAdapterFactory.get(config.primary_chain as ChainId);
      const primaryResult = await primaryAdapter.submitAttestation(submission);
      results.push(primaryResult);
    } catch (err) {
      results.push({
        chainId: config.primary_chain as ChainId,
        txHash: '',
        blockNumber: 0,
        blockTimestamp: new Date().toISOString(),
        contractAddress: '',
        status: 'failed',
        gasUsed: '0',
        gasCostUsd: '0',
        protocol: 'native',
        explorerUrl: '',
        error: (err as Error).message,
      });
    }

    // Secondary chains
    if (config.redundancy_mode !== 'none') {
      for (const sc of config.secondary_chains) {
        try {
          const adapter = chainAdapterFactory.get(sc.chain_id as ChainId);
          const result = await adapter.submitAttestation(submission);
          results.push(result);
        } catch (err) {
          results.push({
            chainId: sc.chain_id as ChainId,
            txHash: '',
            blockNumber: 0,
            blockTimestamp: new Date().toISOString(),
            contractAddress: '',
            status: 'failed',
            gasUsed: '0',
            gasCostUsd: '0',
            protocol: 'native',
            explorerUrl: '',
            error: (err as Error).message,
          });
        }
      }
    }

    return results;
  }

  /**
   * Commit a fiscal period by building a Merkle tree of all posted entries
   */
  async commitPeriod(params: {
    tenantId: string;
    entityId: string;
    periodId: string;
  }): Promise<{ commitmentId: string; merkleRoot: string; entryCount: number }> {
    // Fetch all posted journal entries in period
    const entries = await query<{ id: string; entry_hash: string | null }>(
      `SELECT id, entry_hash FROM journal_entries
       WHERE fiscal_period_id = $1 AND entity_id = $2 AND status = 'posted' AND entry_hash IS NOT NULL
       ORDER BY entry_date, entry_number`,
      [params.periodId, params.entityId]
    );

    if (entries.rows.length === 0) {
      throw new Error('No posted entries with hashes in period');
    }

    const hashes = entries.rows.map((e) => e.entry_hash!);
    const tree = cryptoService.buildMerkleTree(hashes);
    const merkleRoot = '0x' + tree.getRoot().toString('hex');
    const treeDepth = Math.ceil(Math.log2(Math.max(hashes.length, 2)));

    // Balance commitment (aggregate sum commitment)
    const balanceCommitment = cryptoService.sha256Hex(`balance:${params.periodId}:${merkleRoot}`);

    const commitmentId = uuidv4();

    // Check existing
    const existing = await query(
      `SELECT id FROM period_commitments WHERE tenant_id = $1 AND entity_id = $2 AND period_id = $3`,
      [params.tenantId, params.entityId, params.periodId]
    );

    if (existing.rows.length > 0) {
      return {
        commitmentId: existing.rows[0].id as string,
        merkleRoot,
        entryCount: entries.rows.length,
      };
    }

    await query(
      `INSERT INTO period_commitments (
        id, tenant_id, entity_id, period_id,
        merkle_root, entry_count, tree_depth, balance_commitment,
        status, committed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'committed', NOW())`,
      [commitmentId, params.tenantId, params.entityId, params.periodId,
       merkleRoot, entries.rows.length, treeDepth, balanceCommitment]
    );

    // Link to fiscal period
    await query(
      `UPDATE fiscal_periods SET period_commitment_id = $1 WHERE id = $2`,
      [commitmentId, params.periodId]
    );

    // Attest the period commitment itself to zkVerify + chains
    const config = await this.getConfig(params.tenantId);
    if (config?.is_active) {
      const zkResult = await zkVerifyClient.verifyProof({
        proof: Buffer.from(JSON.stringify({ merkleRoot, balanceCommitment })),
        publicInputs: [merkleRoot, balanceCommitment],
        proofSystem: 'ultraplonk',
      });

      const chainResults = await this.routeToChains(config, {
        attestationId: commitmentId,
        entryHash: merkleRoot,
        commitment: balanceCommitment,
        zkVerifyProof: '0x' + zkResult.proof.toString('hex'),
        zkVerifyRoot: zkResult.merkleRoot,
      });

      await query(
        `UPDATE period_commitments SET
          zkverify_attestation_id = $1, chain_commitments = $2::jsonb
         WHERE id = $3`,
        [zkResult.attestationId, JSON.stringify(chainResults), commitmentId]
      );
    }

    return { commitmentId, merkleRoot, entryCount: entries.rows.length };
  }

  /**
   * Publish aggregates by dimension (account type, geography, etc.)
   */
  async publishAggregates(params: {
    tenantId: string;
    entityId: string;
    periodId: string;
  }): Promise<{ published: number }> {
    // Aggregate by account type (simple dimension)
    const aggregates = await query<{ account_type: string; total: string; count: string }>(
      `SELECT a.account_type,
              COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0)::text as total,
              COUNT(*)::text as count
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id
       WHERE je.entity_id = $1 AND je.fiscal_period_id = $2 AND je.status = 'posted'
       GROUP BY a.account_type`,
      [params.entityId, params.periodId]
    );

    const disclosure = await query<{ minimum_aggregation_count: number; round_to_nearest: string }>(
      `SELECT minimum_aggregation_count, round_to_nearest::text
       FROM disclosure_config WHERE tenant_id = $1 AND entity_id = $2`,
      [params.tenantId, params.entityId]
    );

    const minCount = disclosure.rows[0]?.minimum_aggregation_count || 5;
    const roundTo = disclosure.rows[0]?.round_to_nearest ? parseFloat(disclosure.rows[0].round_to_nearest) : 1000;

    let published = 0;
    for (const agg of aggregates.rows) {
      const count = parseInt(agg.count, 10);
      if (count < minCount) continue; // Privacy: below threshold

      const total = parseFloat(agg.total);
      const rounded = Math.round(total / roundTo) * roundTo;

      const dimensionHash = cryptoService.hashDimension('account_type', agg.account_type);
      const aggregateCommitment = cryptoService.sha256Hex(`${dimensionHash}:${params.periodId}:${total}`);

      await query(
        `INSERT INTO published_aggregates (
          id, tenant_id, entity_id, period_id,
          dimension_type, dimension_value, dimension_hash,
          aggregate_commitment, transaction_count, public_amount
        ) VALUES ($1, $2, $3, $4, 'account_type', $5, $6, $7, $8, $9)
        ON CONFLICT (tenant_id, entity_id, period_id, dimension_type, dimension_value)
        DO UPDATE SET
          aggregate_commitment = $7, transaction_count = $8, public_amount = $9,
          published_at = NOW()`,
        [
          uuidv4(), params.tenantId, params.entityId, params.periodId,
          agg.account_type, dimensionHash,
          aggregateCommitment, count, rounded,
        ]
      );
      published++;
    }

    return { published };
  }

  /**
   * Anchor tenant's recent entries to Bitcoin
   */
  async anchorToBitcoin(params: { tenantId: string }): Promise<{ anchorId: string; merkleRoot: string; entryCount: number } | null> {
    const btcConfig = await query<{ is_enabled: boolean; fee_strategy: string; anchor_method: string }>(
      `SELECT is_enabled, fee_strategy, anchor_method FROM bitcoin_anchor_config WHERE tenant_id = $1`,
      [params.tenantId]
    );

    if (btcConfig.rows.length === 0 || !btcConfig.rows[0].is_enabled) return null;

    // Get entries since last anchor
    const lastAnchor = await query<{ confirmed_at: Date | null; broadcast_at: Date | null }>(
      `SELECT confirmed_at, broadcast_at FROM bitcoin_anchors
       WHERE tenant_id = $1 ORDER BY broadcast_at DESC NULLS LAST LIMIT 1`,
      [params.tenantId]
    );

    const since = lastAnchor.rows[0]?.broadcast_at || new Date(0);

    const entries = await query<{
      id: string;
      entry_hash: string;
    }>(
      `SELECT je.id, je.entry_hash
       FROM journal_entries je
       JOIN legal_entities le ON le.id = je.entity_id
       WHERE le.tenant_id = $1 AND je.status = 'posted'
         AND je.entry_hash IS NOT NULL
         AND je.posted_date > $2`,
      [params.tenantId, since]
    );

    if (entries.rows.length === 0) return null;

    const anchorEntries: AnchorEntry[] = entries.rows.map((e) => ({
      tenantId: params.tenantId,
      entryType: 'journal_entry' as const,
      entryId: e.id,
      entryHash: e.entry_hash,
    }));

    const result = await bitcoinAnchorService.anchorToBitcoin(
      anchorEntries,
      params.tenantId,
      { feeStrategy: (btcConfig.rows[0].fee_strategy as 'economy' | 'standard' | 'priority') || 'economy' }
    );

    return {
      anchorId: result.anchorId,
      merkleRoot: result.merkleRoot,
      entryCount: anchorEntries.length,
    };
  }

  private async getConfig(tenantId: string): Promise<BlockchainConfig | null> {
    const result = await query<{
      primary_chain: string;
      secondary_chains: unknown;
      redundancy_mode: string;
      verification_layer: string;
      is_active: boolean;
    }>(
      `SELECT primary_chain, secondary_chains, redundancy_mode, verification_layer, is_active
       FROM blockchain_config WHERE tenant_id = $1`,
      [tenantId]
    );
    if (result.rows.length === 0) return null;

    const r = result.rows[0];
    return {
      primary_chain: r.primary_chain,
      secondary_chains: (r.secondary_chains as Array<{ chain_id: string }>) || [],
      redundancy_mode: r.redundancy_mode as BlockchainConfig['redundancy_mode'],
      verification_layer: r.verification_layer as BlockchainConfig['verification_layer'],
      is_active: r.is_active,
    };
  }
}

export const blockchainOrchestrator = new BlockchainOrchestrator();
