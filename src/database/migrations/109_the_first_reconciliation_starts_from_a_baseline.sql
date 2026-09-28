-- ============================================================
-- 109 · THE FIRST RECONCILIATION STARTS FROM A BASELINE (#324 · MNE-001-038)
--
-- The first session of a bank account had nothing to start from: item
-- discovery is cumulative up to the period end, so every unsealed ledger line
-- of the account's whole history (the migrated opening included) came up as a
-- "deposit in transit" or an "outstanding check". The end-to-end walk of
-- 2026-09-25 opened its first session with 260 000 of such "transit" and no
-- way to seal it.
--
-- A baseline is two facts declared when the FIRST session is opened: on
-- `baseline_date` bank and books agreed on `baseline_balance`, and everything
-- up to that date is already reconciled. The service refuses a baseline that
-- disagrees with the books at that date; the schema keeps the two facts
-- together and before the period they anchor.
--
-- Discovery reads the account's baseline date as a floor for EVERY later
-- session too, so the history does not come back in the second month.
-- ============================================================

ALTER TABLE reconciliation_sessions
    ADD COLUMN baseline_date DATE,
    ADD COLUMN baseline_balance DECIMAL(19,4);

ALTER TABLE reconciliation_sessions
    ADD CONSTRAINT session_baseline_complete_and_before_period
        CHECK (
            (baseline_date IS NULL AND baseline_balance IS NULL)
            OR (baseline_date IS NOT NULL AND baseline_balance IS NOT NULL
                AND baseline_date < start_date)
        );

COMMENT ON COLUMN reconciliation_sessions.baseline_date IS
  'Declared on the first session of an account: up to this date bank and books agreed and everything is reconciled. Item discovery of this and every later session of the account ignores what is dated on or before it.';

COMMENT ON COLUMN reconciliation_sessions.baseline_balance IS
  'The reconciled balance at baseline_date. Opening the session refuses it unless it equals the posted book balance at that date.';
