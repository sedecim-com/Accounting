-- ============================================================
-- 020: GRADUATED APPROVAL POLICIES (once / session / always)
--
-- A human can pre-authorize a PATTERN of staged writes (e.g.
-- recurring payroll drafts under $25,000, or Contalink
-- create_invoice ops) instead of clicking approve every time.
-- The pattern is matched CONSERVATIVELY in code
-- (src/ai/approval-policy.ts): every field the pattern specifies
-- must match the candidate, and amounts are compared numerically.
--
-- The effective policy is ALWAYS the strictest of config vs
-- stored approvals, and the FLOOR (src/ai/floor.ts) wins over
-- everything: a stored approval can never authorize above
-- FLOOR_MAX_AUTO_POST or execute an op past FLOOR_MAX_OP_AGE_DAYS.
--
-- Modes:
--   once    — consumed atomically on first use (revoked_at set by
--             a guarded UPDATE, so two sessions cannot both spend it);
--   session — valid only for the granting session (session_id);
--   always  — valid until explicitly revoked.
--
-- RLS: the table carries tenant_id NOT NULL, so the generated
-- tenant_isolation policy in src/database/rls-policies.sql (applied
-- by migrate.ts after every migration) covers it automatically.
-- ============================================================

CREATE TABLE ai_approval_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    scope VARCHAR(20) NOT NULL CHECK (scope IN ('draft', 'external_op')),
    -- Free-form matcher, e.g. {"kind": "payroll", "max_amount": "25000",
    -- "provider": "contalink", "operation": "create_invoice"}.
    -- max_amount is a numeric string; every other field is compared
    -- for exact equality. Unspecified field = wildcard.
    pattern JSONB NOT NULL,
    mode VARCHAR(10) NOT NULL CHECK (mode IN ('once', 'session', 'always')),
    -- The granting session: required for 'session' mode, where the
    -- policy matches only candidates evaluated in that same session.
    session_id UUID,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    -- Soft revocation: 'once' consumption and explicit revokes both
    -- set this; matching only ever considers revoked_at IS NULL rows.
    revoked_at TIMESTAMPTZ,

    CHECK (mode != 'session' OR session_id IS NOT NULL)
);

-- The matcher's hot path: live (non-revoked) policies per entity+scope.
CREATE INDEX idx_ai_approval_policies_live
    ON ai_approval_policies(entity_id, scope)
    WHERE revoked_at IS NULL;
