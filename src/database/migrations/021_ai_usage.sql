-- ============================================================
-- 021: AI USAGE LEDGER
-- One row per completed model call (turn): who spent, on which
-- provider/model, and how many tokens of each type. The cost is
-- an ESTIMATE computed in code from a local price table
-- (src/ai/providers/prices.ts) at insert time — good enough for
-- budgeting and attribution, never a substitute for the
-- provider's invoice. Unknown models are still recorded, with
-- estimated_cost_usd NULL.
--
-- session_id is nullable on purpose: usage can come from paths
-- without a persisted session (one-shot commands, probes), and a
-- deleted session must not erase the spend it caused
-- (ON DELETE SET NULL, not CASCADE).
--
-- RLS: tenant_id NOT NULL means the catalog-driven policies in
-- src/database/rls-policies.sql (applied by migrate.ts after
-- every migration, see 014) cover this table automatically.
-- ============================================================

CREATE TABLE ai_usage (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    session_id UUID REFERENCES ai_sessions(id) ON DELETE SET NULL,

    provider VARCHAR(60) NOT NULL,
    model VARCHAR(100) NOT NULL,

    -- Normalized token counts. Anthropic usage fields and
    -- OpenAI-compat usage ({prompt_tokens, completion_tokens,
    -- prompt_tokens_details.cached_tokens}) both map into these.
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,

    -- NULL = the model was not in the local price table when the
    -- row was written. The tokens are still on the record.
    estimated_cost_usd NUMERIC(12,6),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- `mnemosine usage` always filters by entity and a time window.
CREATE INDEX idx_ai_usage_entity_created ON ai_usage(entity_id, created_at);
