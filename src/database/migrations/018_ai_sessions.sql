-- ============================================================
-- 018: AI SESSIONS & TRANSCRIPTS
-- Durable record of every CLI conversation with the agent. The
-- transcript captures WHAT HAPPENED (user turns, assistant
-- answers, tool activity), independent of any provider wire
-- format: resuming a session continues the same transcript even
-- though the model context starts fresh.
--
-- ai_messages carries no tenant_id/entity_id on purpose: every
-- row belongs to exactly one ai_sessions row (ON DELETE CASCADE),
-- and the application always reaches it THROUGH ai_sessions —
-- whose own tenant_id RLS policy scopes the join.
-- ============================================================

CREATE TABLE ai_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),

    -- First user message truncated to 60 chars; set on the first turn.
    title VARCHAR(80),

    provider VARCHAR(60) NOT NULL,
    model VARCHAR(100) NOT NULL,

    -- Identifies the terminal the session was started from
    -- (TMUX_PANE / TERM_SESSION_ID), so `--continue` picks up the
    -- conversation of THIS terminal first when several are open.
    terminal_key VARCHAR(120),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ai_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,

    -- Position within the session's transcript (1-based, gapless per
    -- session in practice; the unique index makes concurrent writers
    -- fail loudly instead of silently interleaving).
    seq INTEGER NOT NULL,

    role VARCHAR(20) NOT NULL
        CHECK (role IN ('user', 'assistant', 'tool', 'system')),
    content TEXT NOT NULL,

    -- role = 'tool' rows only: which tool ran and with what input.
    tool_name VARCHAR(100),
    tool_calls JSONB,

    token_count INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_ai_messages_session_seq ON ai_messages(session_id, seq);
CREATE INDEX idx_ai_sessions_entity_active ON ai_sessions(entity_id, last_active_at DESC);
