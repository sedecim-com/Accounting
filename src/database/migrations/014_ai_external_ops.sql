-- ============================================================
-- 014: EXTERNAL OPERATIONS OUTBOX (3rd-party accounting systems)
-- The AI only ENQUEUES writes to external systems
-- (Contalink, etc.); a human executes them with `mnemosine outbox`.
-- Atomic pending→executing claim so that two sessions never execute
-- the same operation (lesson learned from the double-posting).
-- ============================================================

CREATE TABLE ai_external_ops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    provider VARCHAR(50) NOT NULL,
    operation VARCHAR(50) NOT NULL CHECK (operation IN (
        'create_policy', 'update_policy', 'upload_xml',
        'bank_transaction', 'reconcile_invoice'
    )),
    payload JSONB NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'executing', 'executed', 'failed', 'rejected')),

    ai_reasoning TEXT NOT NULL,
    ai_model VARCHAR(100),
    user_request TEXT,

    result JSONB,
    error TEXT,
    reviewed_by VARCHAR(255),
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (status != 'executed' OR result IS NOT NULL)
);

CREATE INDEX idx_ai_external_ops_entity_status ON ai_external_ops(entity_id, status);
