-- ============================================================
-- 086 · THE DRAFT KNOWS WHICH CFDI IT CAME FROM (ING-1 · #318)
--
-- Until now the only bridge between an AI draft and the received CFDI it was
-- drafted for was the `reference` text the MODEL wrote ("<serie+folio> ·
-- <uuid>"). Approving such a draft posted the entry and nothing else: no
-- vendor bill was born, the pre-registration stayed in 'ready', and a later
-- `bill inbox run` would post the same expense a second time.
--
-- The link is written by the SYSTEM at ingest time (ingest-service.ts, right
-- after the model's turn), never by the model, and approval reads it under the
-- draft's row lock to create the bill in the same transaction.
--
-- CONTRACT: schema — one additive, nullable column; GET /v1/ai/drafts now
-- returns it (and the CFDI it points to) as `pre_registration_id` / `origin`.
--
-- NULL means "not drafted from a CFDI" (chat drafts, reconciliation
-- adjustments): those keep posting exactly as before.
-- ============================================================

ALTER TABLE ai_drafts
    ADD COLUMN IF NOT EXISTS pre_registration_id UUID NULL REFERENCES pre_registrations(id);

CREATE INDEX IF NOT EXISTS idx_ai_drafts_pre_registration
    ON ai_drafts(pre_registration_id)
    WHERE pre_registration_id IS NOT NULL;

COMMENT ON COLUMN ai_drafts.pre_registration_id IS
  'The pre-registration of the received CFDI this draft was proposed for. Written by the ingest pipeline, never by the model. When set, approving the draft creates the vendor bill and closes the pre-registration in the same transaction (#318).';
