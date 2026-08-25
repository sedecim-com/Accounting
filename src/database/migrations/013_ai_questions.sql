-- ============================================================
-- 013: AI QUESTIONS (questions + precedents)
-- When the AI has a question that blocks its work, it asks:
-- in interactive mode the answer arrives immediately; in
-- non-interactive mode the question stays 'pending' and is resolved
-- with `mnemosine dudas`. Every answer becomes a PRECEDENT that the
-- agent consults (search_precedents) before asking again.
-- ============================================================

CREATE TABLE ai_questions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    status VARCHAR(50) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'answered', 'dismissed')),

    question TEXT NOT NULL,
    context TEXT,                 -- why it is asking (vendor, amount, doc)
    options JSONB,                -- options suggested by the AI (if applicable)
    topic VARCHAR(255),           -- slug for precedent matching,
                                  -- e.g. "clasificacion:Servicios Integrales SA"

    answer TEXT,
    answered_by VARCHAR(255),
    answered_at TIMESTAMPTZ,
    -- Answers are precedents by default; false = one-off answer
    -- that must not be generalized
    is_precedent BOOLEAN NOT NULL DEFAULT true,

    ai_model VARCHAR(100),
    user_request TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (status != 'answered' OR answer IS NOT NULL)
);

CREATE INDEX idx_ai_questions_entity_status ON ai_questions(entity_id, status);
CREATE INDEX idx_ai_questions_tenant ON ai_questions(tenant_id);
