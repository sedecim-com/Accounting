-- ============================================================
-- 338 · AN UNAPPLY KEEPS WHAT IT LEFT CAUSED (#792, MNE-001-574)
--
-- An unapply moves no money: a plain receipt's cash stays with the firm, so
-- the IVA its collection of a PPD invoice caused stays caused (LIVA art. 1-B,
-- first paragraph; only a return, discount or bonus takes it back, art. 7).
-- The cash goes back on account as an advance that already carries that IVA,
-- and a later application nets it against the share it releases
-- (MNE-001-461), so each invoice's IVA is caused once.
--
-- unapply_kept_iva_amount is that IVA for one closed allocation: the share
-- of its stored release (iva_reclass_amount) its plain cash carried, at four
-- decimals. It is the pool a later application takes from (`keptOnAccount`),
-- and the IVA the paper puts back on account (`cashOnAccountOfMonth`).
--
-- NULL means a live row, a row that re-parked, a row with nothing to keep
-- (PUE, off Mexican books, a release capped to 0), or a row closed before
-- this migration, which re-parked: the truth, so there is no backfill. The
-- row records what happened, so a later change of the rule does not rewrite
-- history.
--
-- CONTRACT: schema, compatible. Additive: one nullable column and one CHECK
-- every existing row satisfies with its NULL. No data moves, so there is no
-- row-level-security opt-in, and the table's policy is untouched.
-- ============================================================

ALTER TABLE payment_allocations
    ADD COLUMN IF NOT EXISTS unapply_kept_iva_amount DECIMAL(19,4);

-- Only a closed row keeps IVA, and what it keeps is never 0: a row with
-- nothing to keep stores NULL.
ALTER TABLE payment_allocations
    DROP CONSTRAINT IF EXISTS payment_allocations_unapply_kept_iva_closed,
    ADD CONSTRAINT payment_allocations_unapply_kept_iva_closed
        CHECK (unapply_kept_iva_amount IS NULL OR (unapply_kept_iva_amount > 0 AND unapplied_at IS NOT NULL));

COMMENT ON COLUMN payment_allocations.unapply_kept_iva_amount IS
    'The IVA this unapply left caused for the row''s plain cash, back on account as an advance carrying it (LIVA art. 1-B; MNE-001-574). NULL on a live row, one that re-parked, one with nothing to keep, or one closed before 338.';
