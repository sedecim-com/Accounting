import { v4 as uuidv4 } from 'uuid';
import { query } from '../../database/connection.js';
import { requireByIdInScope, tenantScope } from '../../database/scope.js';
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
   * ¿El anclaje de esta configuración es SIMULADO?
   *
   * Basta un eslabón fabricado para que la cadena entera deje de probar
   * nada, así que se pregunta a todos y con que uno simule, simula el
   * conjunto: la capa de verificación (zkVerify) y cada cadena a la que se
   * fuera a enrutar.
   *
   * Esto existe porque `is_simulated` vivía del DEFAULT `true` de la
   * migración 034 y NINGÚN código lo escribía. Un default es una suposición,
   * no una medida: el día que llegue un adaptador real, un valor heredado
   * habría seguido marcando como simulados anclajes que ya no lo son —y, en
   * el sentido contrario y peor, un default mal elegido habría marcado como
   * reales los fabricados—. Ahora el valor lo declara quien lo sabe.
   */
  private anclajeSimulado(config: BlockchainConfig): boolean {
    if (zkVerifyClient.simulado) return true;
    const cadenas = [
      config.primary_chain,
      ...(config.redundancy_mode !== 'none'
        ? config.secondary_chains.map((s) => s.chain_id)
        : []),
    ];
    return cadenas.some((c) => chainAdapterFactory.get(c as ChainId).simulado);
  }

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
        entry_hash, commitment, status, is_simulated
      ) VALUES ($1, $2, $3, 'journal_entry', $4, $5, $6, 'pending', $7)`,
      [attestationId, params.tenantId, params.entityId, params.journalEntryId, entryHash, Buffer.from(commitment.commitment.slice(2), 'hex'), this.anclajeSimulado(config)]
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
   * LA PAREJA (tenantId, entityId) SE ESCRIBE EN LA FILA; HAY QUE PROBARLA.
   *
   * Las dos rutas que llegan aquí toman `tenant_id` del token y `entity_id`
   * del CUERPO de la petición, y nadie comprobaba que la segunda colgara del
   * primero. El resultado se INSERTA tal cual en period_commitments y en
   * published_aggregates: filas con el inquilino del atacante y la entidad de
   * la víctima. Y published_aggregates se sirve después SIN AUTENTICAR en
   * `GET /public/v1/entities/:entityId/aggregates`, que filtra sólo por
   * entity_id — así que la escritura era el vehículo y la lectura pública el
   * destino. Exfiltración de cifras contables por escritura.
   *
   * Hay un segundo efecto, más silencioso: publishAggregates busca los
   * umbrales de privacidad con `WHERE tenant_id = $1 AND entity_id = $2`. Con
   * la pareja cruzada no encuentra fila y cae a los valores por omisión
   * (agregación mínima 5, redondeo a 1000). O sea que los umbrales que la
   * víctima hubiera endurecido no se aplicaban: se publicaba con los de fábrica.
   *
   * La comprobación va aquí, en el servicio, y no sólo en la ruta: `entityId`
   * y `tenantId` entran por parámetro desde cualquier llamador presente o
   * futuro, y la fila se escribe aquí.
   */
  private async exigirEntidadDelInquilino(tenantId: string, entityId: string): Promise<void> {
    await requireByIdInScope('legal_entities', entityId, tenantScope(tenantId), { columns: 'id' });
  }

  /**
   * Commit a fiscal period by building a Merkle tree of all posted entries
   */
  async commitPeriod(params: {
    tenantId: string;
    entityId: string;
    periodId: string;
  }): Promise<{ commitmentId: string; merkleRoot: string; entryCount: number }> {
    await this.exigirEntidadDelInquilino(params.tenantId, params.entityId);

    // LEER un sello existente va PRIMERO, antes de cualquier comprobación.
    //
    // La primera versión de ATE-1 puso la negativa por asientos sin atestar
    // por encima de esto, y así un periodo YA sellado dejaba de poder
    // devolver su sello en cuanto entraba un solo posteado sin hash: la
    // llamada reventaba antes de mirar si la fila existía. Como
    // `POST /commit-period` es el único camino autenticado a
    // `period_commitments` —no hay GET—, el sello quedaba ilegible para
    // siempre. Negarse a EMITIR un sello incompleto es el punto del
    // elemento; negarse a LEER uno ya emitido es perder información.
    //
    // Y devuelve lo guardado, no lo recalculado. Antes daba el commitmentId
    // de la fila junto al merkleRoot
    // y el entryCount de ESTA llamada. Si el periodo había recibido asientos
    // desde el primer sello, el llamador recibía una raíz que no está en
    // ninguna parte: ni comprometida, ni anclada, ni igual a la que sirve el
    // endpoint público. Un sello vale por lo que se firmó, no por lo que se
    // podría firmar ahora.
    const existing = await query<{ id: string; merkle_root: string; entry_count: number }>(
      `SELECT id, merkle_root, entry_count FROM period_commitments
        WHERE tenant_id = $1 AND entity_id = $2 AND period_id = $3`,
      [params.tenantId, params.entityId, params.periodId]
    );

    if (existing.rows.length > 0) {
      return {
        commitmentId: existing.rows[0].id,
        merkleRoot: existing.rows[0].merkle_root,
        entryCount: existing.rows[0].entry_count,
      };
    }


    // TODOS los asientos posteados del periodo, con hash o sin él.
    //
    // Antes esta consulta llevaba `AND entry_hash IS NOT NULL` y el sello se
    // emitía sobre lo que quedara. Con 100 asientos posteados y 3 atestados
    // se sellaban 3, se guardaba entry_count = 3, y ese 3 se servía SIN
    // AUTENTICAR como la cuenta del periodo (public-verification.ts). Un
    // tercero leía «3 asientos» sin manera de saber que el periodo tenía 100:
    // el sello no distinguía «periodo de 3» de «periodo de 100 del que sólo
    // pude probar 3». Es la misma familia que CLI-5 —reportar el éxito de un
    // acto que no se realizó del todo—, y aquí encima se firma.
    const entries = await query<{ id: string; entry_hash: string | null }>(
      `SELECT id, entry_hash FROM journal_entries
       WHERE fiscal_period_id = $1 AND entity_id = $2 AND status = 'posted'
       ORDER BY entry_date, entry_number`,
      [params.periodId, params.entityId]
    );

    if (entries.rows.length === 0) {
      throw new Error('No posted entries in period');
    }

    // Se NIEGA en vez de declarar cobertura parcial, por tres razones.
    //
    // Primera: sellar declarando la laguna deja escrito para siempre un sello
    // que no cubre el periodo, y la rama de idempotencia de más abajo lo
    // congela — devuelve el commitmentId almacenado con un merkleRoot
    // recalculado que nunca se comprometió. Segunda: negarse no bloquea nada,
    // porque el cierre de periodo no llama aquí; sellar es un acto aparte y
    // reintentarlo es gratis. Tercera: la atestación es asíncrona, así que la
    // laguna casi siempre es una carrera y no un hecho — negarse invita a
    // repetir, y declarar invitaría a firmar la foto movida.
    const sinAtestar = entries.rows.filter((e) => e.entry_hash === null);
    if (sinAtestar.length > 0) {
      throw new Error(
        `El periodo tiene ${entries.rows.length} asientos posteados y ${sinAtestar.length} ` +
          `sin atestar, así que un sello sólo probaría ${entries.rows.length - sinAtestar.length}. ` +
          'Un sello que cubre parte del periodo y no lo dice es peor que ninguno: se publica ' +
          'como la cuenta del periodo. Espera a que termine la atestación —es asíncrona— o ' +
          'revisa que el inquilino tenga configuración de anclaje activa; sin ella no se ' +
          'escribe ningún hash y ningún periodo será sellable.'
      );
    }

    const hashes = entries.rows.map((e) => e.entry_hash!);
    const tree = cryptoService.buildMerkleTree(hashes);
    const merkleRoot = '0x' + tree.getRoot().toString('hex');
    const treeDepth = Math.ceil(Math.log2(Math.max(hashes.length, 2)));

    // Balance commitment (aggregate sum commitment)
    const balanceCommitment = cryptoService.sha256Hex(`balance:${params.periodId}:${merkleRoot}`);

    const commitmentId = uuidv4();

    const config = await this.getConfig(params.tenantId);

    await query(
      `INSERT INTO period_commitments (
        id, tenant_id, entity_id, period_id,
        merkle_root, entry_count, tree_depth, balance_commitment,
        status, committed_at, is_simulated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'committed', NOW(), $9)`,
      [commitmentId, params.tenantId, params.entityId, params.periodId,
       merkleRoot, entries.rows.length, treeDepth, balanceCommitment,
       config ? this.anclajeSimulado(config) : true]
    );

    // Link to fiscal period. Acotado por entidad aunque hoy sea inalcanzable
    // de otra forma —un periodo de otra entidad no tiene asientos de ésta, y
    // arriba se habría lanzado ya—: la escritura no debería depender de que
    // ese razonamiento siga siendo cierto.
    await query(
      `UPDATE fiscal_periods SET period_commitment_id = $1 WHERE id = $2 AND entity_id = $3`,
      [commitmentId, params.periodId, params.entityId]
    );

    // Attest the period commitment itself to zkVerify + chains.
    // `config` ya se resolvió arriba, para decidir is_simulated.
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
    await this.exigirEntidadDelInquilino(params.tenantId, params.entityId);

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

    // Se resuelve aquí, no dentro del bucle: la marca de simulación es la
    // misma para todas las dimensiones de una publicación.
    const config = await this.getConfig(params.tenantId);

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
          aggregate_commitment, transaction_count, public_amount, is_simulated
        ) VALUES ($1, $2, $3, $4, 'account_type', $5, $6, $7, $8, $9, $10)
        ON CONFLICT (tenant_id, entity_id, period_id, dimension_type, dimension_value)
        DO UPDATE SET
          aggregate_commitment = $7, transaction_count = $8, public_amount = $9,
          is_simulated = $10, published_at = NOW()`,
        [
          uuidv4(), params.tenantId, params.entityId, params.periodId,
          agg.account_type, dimensionHash,
          aggregateCommitment, count, rounded,
          config ? this.anclajeSimulado(config) : true,
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
