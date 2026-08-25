-- ============================================================
-- Migration 007: Integration Framework
-- Foundation tables for all external integrations (PAC, Stripe, Plaid, etc.)
-- ============================================================

-- ============================================================
-- INTEGRATION CREDENTIALS (per tenant, per provider)
-- Encrypted credentials + OAuth tokens for every external service
-- ============================================================

CREATE TABLE integration_credentials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    provider VARCHAR(50) NOT NULL,                    -- 'finkok', 'stripe', 'plaid', etc.
    provider_account_id VARCHAR(255),                 -- External account identifier
    credentials_encrypted TEXT NOT NULL,              -- AES-256-GCM encrypted JSON
    scopes JSONB DEFAULT '[]',                        -- OAuth scopes
    expires_at TIMESTAMPTZ,
    refresh_token_encrypted TEXT,

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'error', 'expired', 'revoked')),

    last_sync_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error TEXT,
    last_error_at TIMESTAMPTZ,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,

    priority INTEGER NOT NULL DEFAULT 100,            -- For multi-provider routing (lower = higher priority)
    is_primary BOOLEAN NOT NULL DEFAULT false,
    metadata JSONB NOT NULL DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID,

    UNIQUE(tenant_id, provider, provider_account_id)
);

CREATE INDEX idx_integration_creds_tenant ON integration_credentials(tenant_id);
CREATE INDEX idx_integration_creds_provider ON integration_credentials(provider);
CREATE INDEX idx_integration_creds_status ON integration_credentials(status);
CREATE INDEX idx_integration_creds_priority ON integration_credentials(tenant_id, provider, priority)
    WHERE status = 'active';

-- ============================================================
-- INTEGRATION SYNC JOBS
-- Track periodic sync operations (Plaid transactions, SAT downloads, etc.)
-- ============================================================

CREATE TABLE integration_sync_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    integration_id UUID REFERENCES integration_credentials(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    sync_type VARCHAR(50) NOT NULL,                   -- 'transactions', 'customers', 'invoices', 'cfdi_download'

    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),

    cursor VARCHAR(500),                              -- Pagination/resume cursor
    date_range_start DATE,
    date_range_end DATE,

    items_synced INTEGER NOT NULL DEFAULT 0,
    items_failed INTEGER NOT NULL DEFAULT 0,

    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,

    error_log JSONB DEFAULT '[]',
    result_summary JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID
);

CREATE INDEX idx_sync_jobs_tenant ON integration_sync_jobs(tenant_id);
CREATE INDEX idx_sync_jobs_status ON integration_sync_jobs(status);
CREATE INDEX idx_sync_jobs_provider ON integration_sync_jobs(provider, status);

-- ============================================================
-- INTEGRATION MAPPINGS (internal ID <-> external ID)
-- Maps local entities to their counterparts in external systems
-- ============================================================

CREATE TABLE integration_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    provider VARCHAR(50) NOT NULL,
    internal_entity_type VARCHAR(50) NOT NULL,        -- 'customer', 'vendor', 'invoice', 'bill', 'bank_account'
    internal_id UUID NOT NULL,
    external_id VARCHAR(255) NOT NULL,
    external_type VARCHAR(50),

    sync_direction VARCHAR(20) NOT NULL DEFAULT 'bidirectional'
        CHECK (sync_direction IN ('inbound', 'outbound', 'bidirectional')),

    last_synced_at TIMESTAMPTZ,
    last_sync_hash VARCHAR(64),                       -- To detect changes
    sync_metadata JSONB DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(tenant_id, provider, internal_entity_type, internal_id),
    UNIQUE(tenant_id, provider, external_id)
);

CREATE INDEX idx_mappings_tenant ON integration_mappings(tenant_id);
CREATE INDEX idx_mappings_internal ON integration_mappings(internal_entity_type, internal_id);
CREATE INDEX idx_mappings_external ON integration_mappings(provider, external_id);

-- ============================================================
-- PAC PREFERENCES (Multi-PAC routing per tenant)
-- Defines priority order and failover strategy for CFDI PACs
-- ============================================================

CREATE TABLE pac_preferences (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL UNIQUE,

    pac_primary VARCHAR(50) NOT NULL DEFAULT 'finkok',
    pac_secondary VARCHAR(50) DEFAULT 'sw_sapien',
    pac_tertiary VARCHAR(50) DEFAULT 'edicom',

    auto_failover BOOLEAN NOT NULL DEFAULT true,
    failover_health_threshold INTEGER NOT NULL DEFAULT 3,  -- N consecutive failures → skip PAC
    circuit_breaker_timeout_seconds INTEGER NOT NULL DEFAULT 60,

    -- Per-PAC stats for routing decisions
    stats JSONB NOT NULL DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- PROVIDER HEALTH (real-time circuit breaker state)
-- Tracks operational state per provider per tenant
-- ============================================================

CREATE TABLE provider_health (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    provider VARCHAR(50) NOT NULL,

    circuit_state VARCHAR(20) NOT NULL DEFAULT 'closed'
        CHECK (circuit_state IN ('closed', 'open', 'half_open')),

    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    consecutive_successes INTEGER NOT NULL DEFAULT 0,
    total_requests INTEGER NOT NULL DEFAULT 0,
    total_failures INTEGER NOT NULL DEFAULT 0,

    avg_latency_ms INTEGER,
    last_failure_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    circuit_opened_at TIMESTAMPTZ,
    circuit_will_retry_at TIMESTAMPTZ,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(tenant_id, provider)
);

CREATE INDEX idx_provider_health_state ON provider_health(circuit_state) WHERE circuit_state != 'closed';

-- ============================================================
-- INTEGRATION EVENTS (inbound webhooks from providers)
-- Stripe webhooks, SAT notifications, Plaid updates, etc.
-- ============================================================

CREATE TABLE integration_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID,
    provider VARCHAR(50) NOT NULL,
    event_type VARCHAR(100) NOT NULL,                 -- 'stripe.charge.succeeded', 'plaid.transactions.updated', etc.

    external_event_id VARCHAR(255),                   -- For dedup
    payload JSONB NOT NULL,
    signature VARCHAR(500),                           -- Original webhook signature
    signature_valid BOOLEAN,

    status VARCHAR(20) NOT NULL DEFAULT 'received'
        CHECK (status IN ('received', 'processing', 'processed', 'failed', 'ignored')),

    processed_at TIMESTAMPTZ,
    error_message TEXT,

    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_ip INET,

    UNIQUE(provider, external_event_id)
);

CREATE INDEX idx_integration_events_tenant ON integration_events(tenant_id);
CREATE INDEX idx_integration_events_provider ON integration_events(provider, event_type);
CREATE INDEX idx_integration_events_status ON integration_events(status) WHERE status IN ('received', 'processing');
