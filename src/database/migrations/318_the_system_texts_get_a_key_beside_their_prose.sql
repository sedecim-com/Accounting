-- ============================================================
-- 318 · THE SYSTEM TEXTS GET A KEY BESIDE THEIR PROSE (#158, MNE-001-170)
--
-- The system writes English prose into rows an accountant reads (journal
-- descriptions, audit reasons, payroll notes, period names). Translating the
-- surface by key, not by prose (AGENTS.md, "El idioma"), needs a stable key
-- stored next to the text. This migration only adds the columns:
--
-- - journal_entries / journal_entry_lines: description_key + description_params
-- - audit_log: reason_key
-- - ai_drafts: review_kind (replaces matching on the prose of review_notes)
-- - fiscal_periods: period_key (e.g. '2026-01'); period_name is kept
-- - paycheck_taxes: notes_key + notes_params (calculation_notes is kept)
--
-- Additive and nullable, with no backfill: rows already persisted keep their
-- prose exactly as written (they are what the firm signed). Writers and
-- renderers follow in MNE-001-171 to 176. Keys are identifiers, never
-- translated; params are jsonb so a renderer can interpolate them.
-- ============================================================

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS description_key VARCHAR(100),
  ADD COLUMN IF NOT EXISTS description_params JSONB;

ALTER TABLE journal_entry_lines
  ADD COLUMN IF NOT EXISTS description_key VARCHAR(100),
  ADD COLUMN IF NOT EXISTS description_params JSONB;

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS reason_key VARCHAR(100);

ALTER TABLE ai_drafts
  ADD COLUMN IF NOT EXISTS review_kind VARCHAR(50);

ALTER TABLE fiscal_periods
  ADD COLUMN IF NOT EXISTS period_key VARCHAR(20);

ALTER TABLE paycheck_taxes
  ADD COLUMN IF NOT EXISTS notes_key VARCHAR(100),
  ADD COLUMN IF NOT EXISTS notes_params JSONB;
