-- ============================================================
-- 016: PENDING POLICY DECISIONS
-- Distinct from ai_questions (a question about ONE document): these
-- are policy definitions that affect the behavior of the whole
-- system. Until they are defined, the system operates with a
-- declared default and keeps it visible in `/pendientes`.
-- ============================================================

CREATE TABLE policy_decisions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    -- NULL = applies to the whole tenant; set = specific to one entity
    entity_id UUID REFERENCES legal_entities(id),

    -- Stable key the code uses to read the policy
    key VARCHAR(80) NOT NULL,
    category VARCHAR(40) NOT NULL,
    question TEXT NOT NULL,
    /** Why it matters: what changes in the system depending on the answer. */
    impact TEXT NOT NULL,
    options JSONB NOT NULL DEFAULT '[]',

    /** What the system uses WHILE it remains undefined. */
    default_value TEXT,
    default_rationale TEXT,

    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'resolved', 'dismissed')),
    resolved_value TEXT,
    resolved_by VARCHAR(255),
    resolved_at TIMESTAMPTZ,
    resolution_notes TEXT,

    /** To order the agenda: 1 = decide this first. */
    priority INTEGER NOT NULL DEFAULT 50,
    /** Where it came from: 'seed' or the module that raised it. */
    source VARCHAR(60) NOT NULL DEFAULT 'seed',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (status != 'resolved' OR resolved_value IS NOT NULL),
    UNIQUE (tenant_id, entity_id, key)
);

CREATE INDEX idx_policy_pending ON policy_decisions(tenant_id, status, priority);
