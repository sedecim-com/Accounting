-- ============================================================
-- 027: SKILL DRAFTS (staged skill writes + trust scanning)
--
-- The AI never writes skill files (./skills/<name>/SKILL.md)
-- directly: every create/update/delete lands here first as a
-- draft, ALWAYS pre-scanned by the trust scanner
-- (src/ai/skills/trust-scanner.ts) whose report is stored in
-- scan_report. Skills are EXECUTABLE CONFIG — instructions a
-- model will follow — so third-party or AI-authored content is
-- treated as untrusted code: a flagged draft can be listed and
-- reviewed, but approving it requires the reviewer to
-- explicitly accept the flagged risks, and that acceptance is
-- recorded in reviewed_by.
--
-- Transitions are guarded UPDATEs (status = 'pending_review'
-- predicate + entity scoping + rowCount check), same idiom as
-- ai_drafts: two racing reviewers cannot both consume a draft.
-- approveSkillDraft (src/ai/skills/skill-drafts.ts) is the ONLY
-- code path that materializes the file on disk.
--
-- RLS: the table carries tenant_id NOT NULL, so the generated
-- tenant_isolation policy in src/database/rls-policies.sql (applied
-- by migrate.ts after every migration) covers it automatically.
-- ============================================================

CREATE TABLE skill_drafts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    skill_name VARCHAR(100) NOT NULL,
    action VARCHAR(10) NOT NULL CHECK (action IN ('create', 'update', 'delete')),
    -- Full proposed SKILL.md; NULL for 'delete' drafts.
    content TEXT,
    -- Snapshot of the file at draft time (diff base for the review
    -- UI); NULL for 'create' drafts.
    previous_content TEXT,
    -- Trust-scanner output: {threats: [{kind, line, excerpt}], clean}.
    -- Written at creation time, before any human sees the draft.
    scan_report JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending_review'
        CHECK (status IN ('pending_review', 'approved', 'rejected')),
    -- Model that proposed the change (audit trail).
    model VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_by VARCHAR(255),
    reviewed_at TIMESTAMPTZ,

    -- A delete proposes no content; create/update must carry the file.
    CHECK ((action = 'delete') = (content IS NULL))
);

-- The review queue's hot path: open drafts per entity.
CREATE INDEX idx_skill_drafts_pending
    ON skill_drafts(entity_id, status)
    WHERE status = 'pending_review';
