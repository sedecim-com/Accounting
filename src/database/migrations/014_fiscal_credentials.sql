-- ============================================================
-- 014: FISCAL CREDENTIALS (e.firma / CSD)
-- The material NEVER lives in this table: only the vault reference
-- (AWS Secrets Manager ARN) and the metadata that allows operating
-- without decrypting (RFC, validity, type).
-- A dump of this database contains nobody's e.firma.
-- ============================================================

CREATE TABLE fiscal_credentials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    credential_type VARCHAR(20) NOT NULL
        CHECK (credential_type IN ('efirma', 'csd')),

    -- Certificate metadata: makes it possible to warn about expirations,
    -- validate the RFC and decide routing WITHOUT touching the material.
    rfc VARCHAR(13) NOT NULL,
    cert_serial VARCHAR(64) NOT NULL,
    cert_subject TEXT,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to   TIMESTAMPTZ NOT NULL,

    -- Vault reference (NOT the secret)
    vault_backend VARCHAR(40) NOT NULL,
    vault_ref     TEXT NOT NULL,
    vault_version TEXT,

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'revoked', 'invalid')),

    -- Explicit, informed consent (LFPDPPP + legal defense)
    consent_at      TIMESTAMPTZ NOT NULL,
    consent_by      VARCHAR(255) NOT NULL,
    consent_version VARCHAR(20) NOT NULL,

    -- Unattended access policy: the scheduler may decrypt only
    -- if unattended_access = true, up to max_daily_access times.
    unattended_access BOOLEAN NOT NULL DEFAULT true,
    max_daily_access  INTEGER NOT NULL DEFAULT 24
        CHECK (max_daily_access > 0),

    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (valid_from < valid_to),
    -- One active credential per entity and type; revoked ones coexist
    -- to preserve the audit history.
    UNIQUE (entity_id, credential_type, cert_serial)
);

CREATE UNIQUE INDEX uq_fiscal_credentials_active
    ON fiscal_credentials (entity_id, credential_type)
    WHERE status = 'active';

CREATE INDEX idx_fiscal_credentials_tenant ON fiscal_credentials(tenant_id);
CREATE INDEX idx_fiscal_credentials_expiry
    ON fiscal_credentials(valid_to) WHERE status = 'active';

-- ============================================================
-- ACCESS LOG — append-only
-- Every decryption leaves a trace. The app only has INSERT and SELECT:
-- neither the code nor an attacker holding the app's connection can
-- erase the history. (CloudTrail backs it up on the AWS side.)
-- ============================================================

CREATE TABLE fiscal_credential_access_log (
    id BIGSERIAL PRIMARY KEY,
    credential_id UUID NOT NULL REFERENCES fiscal_credentials(id),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL,

    purpose VARCHAR(50) NOT NULL,     -- sat_auth | validation | healthcheck | export
    actor   VARCHAR(255) NOT NULL,    -- user's email or 'scheduler'
    unattended BOOLEAN NOT NULL,      -- no human present?
    request_id TEXT,                  -- correlation with the app logs
    source_host TEXT,

    outcome VARCHAR(20) NOT NULL
        CHECK (outcome IN ('success', 'denied', 'error')),
    denied_reason TEXT,               -- e.g. 'rate_limit', 'unattended_disabled'
    error TEXT,

    accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fcal_credential ON fiscal_credential_access_log(credential_id, accessed_at DESC);
CREATE INDEX idx_fcal_tenant ON fiscal_credential_access_log(tenant_id, accessed_at DESC);

REVOKE UPDATE, DELETE, TRUNCATE ON fiscal_credential_access_log FROM PUBLIC;
