-- ============================================================
-- 342 · AN UNAPPLY KEEPS NO IVA A NOTE RESTITUTED (#814, MNE-001-592)
--
-- A credit note (a CFDI de egreso) reduced the consideration and restituted
-- its IVA (LIVA art. 7), and no later act causes it again. When cash that
-- carried an advance's IVA is unapplied from an invoice such a note reduced,
-- the advance's IVA no longer goes back to 2120 whole: what the note
-- restituted stays out, and the cash it covers is a balance owed back to the
-- customer, carrying none (decision (A) on #792; LIVA art. 1-B: no money is
-- received again). This covers a receipt with a treatment (MNE-001-462) and
-- the pool a plain receipt took from (MNE-001-574, MNE-001-591).
--
-- unapply_restituted_iva_amount is that IVA for one closed allocation: its
-- share of what the note restituted, split by the advance IVA it carried
-- back, at four decimals. A later application reads it to take that IVA and
-- the cash it covers out of the advance (`advanceLeft`), and the IVA paper
-- to take it out of what the unapply ended (`ENDED_SHARE_IVA`).
--
-- NULL means a live row, a row with nothing restituted, or a row closed
-- before this migration, which restored its advance's whole IVA: the truth of
-- its day, so there is no backfill. The row records what happened, so a later
-- change of the rule does not rewrite history.
--
-- CONTRACT: schema, compatible. Additive: one nullable column and one CHECK
-- every existing row satisfies with its NULL. No data moves, so there is no
-- row-level-security opt-in, and the table's policy is untouched.
-- ============================================================

ALTER TABLE payment_allocations
    ADD COLUMN IF NOT EXISTS unapply_restituted_iva_amount DECIMAL(19,4);

-- Only a closed row stores a restitution, and it is never 0: a row with
-- nothing restituted stores NULL.
ALTER TABLE payment_allocations
    DROP CONSTRAINT IF EXISTS payment_allocations_unapply_restituted_iva_closed,
    ADD CONSTRAINT payment_allocations_unapply_restituted_iva_closed
        CHECK (unapply_restituted_iva_amount IS NULL OR (unapply_restituted_iva_amount > 0 AND unapplied_at IS NOT NULL));

COMMENT ON COLUMN payment_allocations.unapply_restituted_iva_amount IS
    'The advance IVA this unapply did not restore because a credit note had restituted it (LIVA art. 7; MNE-001-592): the cash it covers is owed back and carries none. NULL on a live row, one with nothing restituted, or one closed before 342.';
