-- ============================================================
-- 028: INBOUND AI WEBHOOKS (dedicated tokens + delivery log)
--
-- External sources (bank notification relays, SAT mailbox
-- forwarders, generic integrations) POST documents to
-- /v1/ai/webhooks/:tokenName with a DEDICATED bearer token —
-- never a user JWT. The payload wakes a RESTRICTED reader agent
-- (read tools + draft/question creation only, body wrapped as
-- UNTRUSTED — src/ai/webhooks/reader-agent.ts); every outcome is
-- a staged draft or a logged question, never a ledger write.
--
-- ai_webhook_tokens stores ONLY the sha256 hash of the token:
-- the raw value is printed exactly once at creation
-- (`mnemosine webhooks create`) and cannot be recovered.
--
-- ai_webhook_deliveries is the idempotency ledger: document_key
-- derives from the payload's own document id (bank tx id, CFDI
-- UUID; unknown shape → sha256 of the body), and the UNIQUE
-- (token_id, document_key) makes a replayed delivery a no-op
-- that NEVER re-wakes the agent.
--
-- RLS: both tables carry tenant_id NOT NULL, so the generated
-- tenant_isolation policy in src/database/rls-policies.sql
-- (applied by migrate.ts after every migration) covers them
-- automatically. ai_webhook_tokens additionally needs a
-- pre-auth read path — token verification happens BEFORE the
-- caller's tenant is known, exactly like the users/sessions
-- exclusion documented in rls-policies.sql — so it gets an
-- extra permissive SELECT policy below (policies OR-combine;
-- rls-policies.sql only drops/recreates `tenant_isolation`, so
-- this one survives every re-run). Rows expose only the HASH,
-- never a usable secret. All writes stay tenant-scoped.
-- ============================================================

CREATE TABLE ai_webhook_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    -- URL-safe name: it is the routing segment in
    -- POST /v1/ai/webhooks/:tokenName.
    name VARCHAR(64) NOT NULL,
    -- sha256 hex of the raw token. NEVER the raw token.
    token_hash CHAR(64) NOT NULL,
    source_kind VARCHAR(20) NOT NULL
        CHECK (source_kind IN ('bank_notification', 'sat_mailbox', 'generic')),
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,

    -- One name per entity: `mnemosine webhooks disable <name>` and the
    -- route lookup must be unambiguous within the entity.
    UNIQUE (entity_id, name)
);

-- The route's hot path: enabled tokens by routing name (cross-tenant
-- candidates are then confirmed by constant-time hash comparison in code).
CREATE INDEX idx_ai_webhook_tokens_name
    ON ai_webhook_tokens(name)
    WHERE enabled = true;

-- Pre-auth verification path (see header). SELECT only; INSERT/UPDATE/
-- DELETE remain governed solely by tenant_isolation.
ALTER TABLE ai_webhook_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_token_auth ON ai_webhook_tokens;
CREATE POLICY webhook_token_auth ON ai_webhook_tokens FOR SELECT USING (true);

CREATE TABLE ai_webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_id UUID NOT NULL REFERENCES ai_webhook_tokens(id),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    -- Idempotency key: the payload's own document id (bank tx id,
    -- CFDI UUID) or sha256 of the raw body when the shape is unknown.
    document_key VARCHAR(255) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status VARCHAR(20) NOT NULL DEFAULT 'received'
        CHECK (status IN ('received', 'processed', 'duplicate', 'rejected')),
    -- scanImportedText-style suspicion reasons found in the body
    -- (instruction-like phrases, invisible Unicode, marker delimiters…).
    suspicion JSONB,
    drafts_created INT NOT NULL DEFAULT 0,

    -- The idempotency guarantee: a replay of the same document through
    -- the same token can never create a second delivery row.
    UNIQUE (token_id, document_key)
);

-- `mnemosine webhooks deliveries`: recent log per entity.
CREATE INDEX idx_ai_webhook_deliveries_recent
    ON ai_webhook_deliveries(entity_id, received_at DESC);
