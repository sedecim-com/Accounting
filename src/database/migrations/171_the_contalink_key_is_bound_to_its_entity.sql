-- ============================================================
-- 171: THE CONTALINK KEY IS BOUND TO ITS ENTITY (#357, ADR-0004)
--
-- One process-wide CONTALINK_API_KEY wrote every entity's approved
-- operations into whichever Contalink company that key belonged to.
-- ADR-0004 fixes one writer per Contalink company, identified by RFC,
-- so the key now belongs to one entity and names the RFC it writes for.
--
-- Same shape as 014_fiscal_credentials: the key NEVER lives in this
-- table, only the vault reference and the metadata needed to route and
-- refuse without decrypting (provider, RFC, status). A dump of this
-- database contains nobody's Contalink key.
-- ============================================================

CREATE TABLE external_system_credentials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    provider VARCHAR(40) NOT NULL CHECK (provider IN ('contalink')),

    -- The RFC of the external company this key writes to. Checked against
    -- the entity's RFC at registration AND at every use: an entity whose
    -- RFC changed after registration must not keep writing to the old one.
    rfc VARCHAR(13) NOT NULL,

    -- Vault reference (NOT the secret)
    vault_backend VARCHAR(40) NOT NULL,
    vault_ref     TEXT NOT NULL,
    vault_version TEXT,

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
    registered_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active key per entity and provider; revoked rows stay as history.
CREATE UNIQUE INDEX uq_external_system_credentials_active
    ON external_system_credentials (entity_id, provider)
    WHERE status = 'active';

CREATE INDEX idx_external_system_credentials_tenant
    ON external_system_credentials (tenant_id);
