-- ============================================================
-- 012: Backstop against double-posting of AI drafts
-- Even though approveDraft is atomic (FOR UPDATE + a single
-- transaction), this partial unique index guarantees at the database
-- level that the same draft can never generate two journal entries.
-- ============================================================

CREATE UNIQUE INDEX uq_je_ai_draft_source
    ON journal_entries(source_id)
    WHERE source_type = 'ai_draft';
