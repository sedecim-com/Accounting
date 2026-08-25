-- ============================================================
-- 019: APPROVAL INTEGRITY (content-hash binding)
--
-- A human approves WHAT THEY SAW, not a row id. Storing the
-- canonical sha256 of the approved content closes the TOCTOU
-- window between review and execution: the service recomputes
-- the hash from the payload read under the row lock (drafts) or
-- after the atomic claim (external ops) and aborts on mismatch.
--
-- The hash is computed in code (canonicalDraftHash /
-- canonicalOpHash): stable key order, amounts normalized to
-- 2-decimal strings. sha256 hex = 64 chars.
-- ============================================================

ALTER TABLE ai_drafts
    ADD COLUMN approved_content_hash VARCHAR(64);

ALTER TABLE ai_external_ops
    ADD COLUMN approved_content_hash VARCHAR(64);
