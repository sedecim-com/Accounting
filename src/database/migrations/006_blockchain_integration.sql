-- ============================================================
-- Migration 006: Triple Entry Blockchain Integration
-- ============================================================

-- ============================================================
-- BLOCKCHAIN CONFIG (per tenant)
-- ============================================================

CREATE TABLE blockchain_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL UNIQUE,

    -- Primary chain
    primary_chain VARCHAR(50) NOT NULL DEFAULT 'arbitrum-one',
    primary_chain_contract_address VARCHAR(66),

    -- Secondary chains (JSONB array of chain configs)
    secondary_chains JSONB NOT NULL DEFAULT '[]',

    -- Redundancy mode
    redundancy_mode VARCHAR(20) NOT NULL DEFAULT 'none'
        CHECK (redundancy_mode IN ('none', 'async_backup', 'sync_multi', 'consensus')),
    required_confirmations INTEGER DEFAULT 1,

    -- Verification layer
    verification_layer VARCHAR(20) NOT NULL DEFAULT 'zkverify'
        CHECK (verification_layer IN ('zkverify', 'native', 'both')),

    -- Messaging protocol
    messaging_protocol VARCHAR(20) DEFAULT 'layerzero'
        CHECK (messaging_protocol IN ('layerzero', 'wormhole', 'axelar', 'ccip')),

    -- Cost controls
    max_gas_price_gwei DECIMAL(10, 2),
    max_tx_cost_usd DECIMAL(10, 2),

    -- Status
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_validated_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID,
    updated_by UUID
);

-- ============================================================
-- DISCLOSURE CONFIG (per tenant + entity)
-- ============================================================

CREATE TABLE disclosure_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),

    category_disclosure JSONB NOT NULL DEFAULT '{
        "assets": 2, "liabilities": 2, "equity": 2,
        "revenue": 3, "expenses": 3
    }',

    publish_geography BOOLEAN NOT NULL DEFAULT true,
    publish_line_of_business BOOLEAN NOT NULL DEFAULT true,
    publish_customer_segment BOOLEAN NOT NULL DEFAULT false,
    publish_channel BOOLEAN NOT NULL DEFAULT false,

    publication_delay_minutes INTEGER NOT NULL DEFAULT 0,
    aggregation_period VARCHAR(20) NOT NULL DEFAULT 'daily',
    minimum_aggregation_count INTEGER NOT NULL DEFAULT 5,
    round_to_nearest DECIMAL(15, 2) NOT NULL DEFAULT 1000,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(tenant_id, entity_id)
);

-- ============================================================
-- BITCOIN ANCHOR CONFIG (per tenant)
-- ============================================================

CREATE TABLE bitcoin_anchor_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL UNIQUE,

    is_enabled BOOLEAN NOT NULL DEFAULT false,

    anchor_frequency VARCHAR(20) NOT NULL DEFAULT 'monthly'
        CHECK (anchor_frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'on_period_close')),

    anchor_method VARCHAR(20) NOT NULL DEFAULT 'opentimestamps'
        CHECK (anchor_method IN ('direct_op_return', 'opentimestamps', 'both')),

    fee_strategy VARCHAR(20) DEFAULT 'economy'
        CHECK (fee_strategy IN ('economy', 'standard', 'priority')),
    max_fee_usd DECIMAL(10, 2) DEFAULT 10.00,
    use_own_wallet BOOLEAN DEFAULT false,
    wallet_address VARCHAR(100),

    ots_calendars JSONB DEFAULT '["https://a.pool.opentimestamps.org", "https://b.pool.opentimestamps.org"]',
    ots_upgrade_check_interval VARCHAR(20) DEFAULT 'daily',

    notify_on_complete BOOLEAN DEFAULT true,
    notify_on_failure BOOLEAN DEFAULT true,
    notification_emails JSONB DEFAULT '[]',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- BITCOIN ANCHORS (records of on-chain Bitcoin commitments)
-- ============================================================

CREATE TABLE bitcoin_anchors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID,

    anchor_type VARCHAR(20) NOT NULL
        CHECK (anchor_type IN ('single_tenant', 'multi_tenant', 'global')),

    -- Merkle tree
    merkle_root VARCHAR(66) NOT NULL,
    entry_count INTEGER NOT NULL,
    tree_data BYTEA,

    -- OP_RETURN payload (80 bytes max)
    op_return_payload BYTEA NOT NULL,
    protocol_version INTEGER DEFAULT 1,

    -- Bitcoin transaction
    bitcoin_txid VARCHAR(66),
    bitcoin_block_height INTEGER,
    bitcoin_block_hash VARCHAR(66),
    bitcoin_block_timestamp TIMESTAMPTZ,
    confirmations INTEGER DEFAULT 0,

    -- OpenTimestamps
    ots_proof BYTEA,
    ots_status VARCHAR(20) DEFAULT 'none'
        CHECK (ots_status IN ('none', 'pending', 'upgraded', 'confirmed')),

    -- Fees
    fee_satoshis BIGINT,
    fee_usd DECIMAL(10, 4),
    fee_rate_sat_vb DECIMAL(10, 2),

    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'broadcast', 'confirmed', 'failed')),
    error_message TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    broadcast_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,

    period_range_start DATE,
    period_range_end DATE
);

CREATE INDEX idx_bitcoin_anchors_tenant ON bitcoin_anchors(tenant_id);
CREATE INDEX idx_bitcoin_anchors_txid ON bitcoin_anchors(bitcoin_txid);
CREATE INDEX idx_bitcoin_anchors_status ON bitcoin_anchors(status);
CREATE INDEX idx_bitcoin_anchors_root ON bitcoin_anchors(merkle_root);

-- ============================================================
-- BITCOIN ANCHOR ENTRIES (junction: entries → anchor)
-- ============================================================

CREATE TABLE bitcoin_anchor_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bitcoin_anchor_id UUID NOT NULL REFERENCES bitcoin_anchors(id) ON DELETE CASCADE,

    tenant_id UUID NOT NULL,
    entry_type VARCHAR(30) NOT NULL
        CHECK (entry_type IN ('journal_entry', 'period_commitment', 'aggregate')),
    entry_id UUID NOT NULL,
    entry_hash VARCHAR(66) NOT NULL,

    leaf_index INTEGER NOT NULL,
    merkle_proof JSONB NOT NULL,

    tenant_root VARCHAR(66),
    tenant_proof JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(bitcoin_anchor_id, entry_hash)
);

CREATE INDEX idx_anchor_entries_entry ON bitcoin_anchor_entries(entry_type, entry_id);
CREATE INDEX idx_anchor_entries_hash ON bitcoin_anchor_entries(entry_hash);

-- ============================================================
-- BLOCKCHAIN ATTESTATIONS
-- ============================================================

CREATE TABLE blockchain_attestations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),

    source_type VARCHAR(30) NOT NULL
        CHECK (source_type IN ('journal_entry', 'period_commitment', 'aggregate')),
    source_id UUID NOT NULL,

    -- Attestation data
    entry_hash VARCHAR(66) NOT NULL,
    commitment BYTEA NOT NULL,
    range_proof BYTEA,

    -- zkVerify
    zkverify_attestation_id VARCHAR(100),
    zkverify_merkle_root VARCHAR(66),
    zkverify_proof BYTEA,
    zkverify_submitted_at TIMESTAMPTZ,
    zkverify_confirmed_at TIMESTAMPTZ,

    -- Chain attestations
    chain_attestations JSONB NOT NULL DEFAULT '[]',

    -- Bitcoin (if anchored)
    bitcoin_anchor_id UUID REFERENCES bitcoin_anchors(id),

    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed')),
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    next_retry_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(tenant_id, source_type, source_id)
);

CREATE INDEX idx_attestations_tenant ON blockchain_attestations(tenant_id);
CREATE INDEX idx_attestations_source ON blockchain_attestations(source_type, source_id);
CREATE INDEX idx_attestations_status ON blockchain_attestations(status) WHERE status != 'confirmed';
CREATE INDEX idx_attestations_hash ON blockchain_attestations(entry_hash);

-- ============================================================
-- PERIOD COMMITMENTS
-- ============================================================

CREATE TABLE period_commitments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    period_id UUID NOT NULL REFERENCES fiscal_periods(id),

    merkle_root VARCHAR(66) NOT NULL,
    entry_count INTEGER NOT NULL,
    tree_depth INTEGER NOT NULL,

    balance_proof BYTEA,
    balance_commitment VARCHAR(66) NOT NULL,

    zkverify_attestation_id VARCHAR(100),
    chain_commitments JSONB NOT NULL DEFAULT '[]',

    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'committed', 'finalized', 'failed')),
    committed_at TIMESTAMPTZ,
    finalized_at TIMESTAMPTZ,

    bitcoin_anchor_id UUID REFERENCES bitcoin_anchors(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(tenant_id, entity_id, period_id)
);

CREATE INDEX idx_period_commitments_status ON period_commitments(status);

-- ============================================================
-- PUBLISHED AGGREGATES
-- ============================================================

CREATE TABLE published_aggregates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    period_id UUID NOT NULL REFERENCES fiscal_periods(id),

    dimension_type VARCHAR(30) NOT NULL
        CHECK (dimension_type IN ('geography', 'line_of_business', 'customer_segment', 'channel', 'combined', 'account_type')),
    dimension_value VARCHAR(100) NOT NULL,
    dimension_hash VARCHAR(66) NOT NULL,

    aggregate_commitment VARCHAR(66) NOT NULL,
    transaction_count INTEGER NOT NULL,
    aggregation_proof BYTEA,

    public_amount DECIMAL(20, 2),

    chain_attestations JSONB NOT NULL DEFAULT '[]',

    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(tenant_id, entity_id, period_id, dimension_type, dimension_value)
);

CREATE INDEX idx_aggregates_entity_period ON published_aggregates(entity_id, period_id);
CREATE INDEX idx_aggregates_dimension ON published_aggregates(dimension_type, dimension_value);

-- ============================================================
-- BLOCKCHAIN JOBS
-- ============================================================

CREATE TABLE blockchain_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID,

    job_type VARCHAR(50) NOT NULL
        CHECK (job_type IN (
            'attestation_submit', 'period_commit', 'aggregate_publish',
            'bitcoin_anchor', 'ots_upgrade', 'cross_chain_sync',
            'confirmation_check'
        )),

    payload JSONB NOT NULL,

    priority INTEGER DEFAULT 5,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter')),

    attempt INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 10,
    last_error TEXT,
    next_retry_at TIMESTAMPTZ,

    result JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_blockchain_jobs_status ON blockchain_jobs(status, scheduled_at)
    WHERE status IN ('pending', 'processing');
CREATE INDEX idx_blockchain_jobs_tenant ON blockchain_jobs(tenant_id);
CREATE INDEX idx_blockchain_jobs_type ON blockchain_jobs(job_type);

-- ============================================================
-- MODIFICATIONS TO EXISTING TABLES
-- ============================================================

ALTER TABLE journal_entries
    ADD COLUMN IF NOT EXISTS blockchain_attestation_id UUID REFERENCES blockchain_attestations(id),
    ADD COLUMN IF NOT EXISTS entry_hash VARCHAR(66),
    ADD COLUMN IF NOT EXISTS commitment BYTEA;

CREATE INDEX IF NOT EXISTS idx_journal_entries_attestation ON journal_entries(blockchain_attestation_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_hash ON journal_entries(entry_hash);

ALTER TABLE fiscal_periods
    ADD COLUMN IF NOT EXISTS period_commitment_id UUID REFERENCES period_commitments(id),
    ADD COLUMN IF NOT EXISTS bitcoin_anchor_id UUID REFERENCES bitcoin_anchors(id),
    ADD COLUMN IF NOT EXISTS blockchain_finalized_at TIMESTAMPTZ;
