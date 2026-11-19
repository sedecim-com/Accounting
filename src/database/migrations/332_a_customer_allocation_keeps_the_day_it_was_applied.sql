-- ============================================================
-- 332 · A CUSTOMER ALLOCATION KEEPS THE DAY IT WAS APPLIED (#623, MNE-001-460)
--
-- `receipt apply` and `receipt unapply` take `--date`. The day dates the
-- entry, the invoice's last_payment_date and, for an unapply, the closure
-- (unapplied_at, 049). The allocation itself had no date: every "as of"
-- reader dated it by its receipt's payment_date, so cash applied on May 20th
-- from a receipt of May 10th settled the invoice on May 10th in the AR
-- balance, while the ledger moved it on May 20th.
--
-- applied_on is that day. `receipt record` writes the receipt's own date and
-- `receipt apply` the date it was given, so a reader asks
-- `COALESCE(applied_on, payment_date)`.
--
-- NULLABLE, AND NOT BACKFILLED. A NULL is a row written before this column,
-- and every reader falls back to its receipt's payment_date, the date every
-- reader gave it until today: no balance "as of" a date and no IVA paper
-- already shown moves (history before overwrite, ADR-0006, Decision 2). Such
-- a row does carry created_at (002), and one written by an earlier
-- `receipt apply` holds the day its entry was posted; it is not copied here,
-- because a backfill would rewrite figures already shown.
--
-- CONTRACT: schema, compatible. Additive: one nullable column, no CHECK and
-- no index. No data moves, so there is no row-level-security opt-in, and the
-- table's policy is untouched.
-- ============================================================

ALTER TABLE payment_allocations
    ADD COLUMN IF NOT EXISTS applied_on DATE;

COMMENT ON COLUMN payment_allocations.applied_on IS
    'The day the cash was applied to the invoice (MNE-001-460): the receipt''s date for `receipt record`, the date given to `receipt apply`. NULL on rows written before migration 332; readers then take the receipt''s payment_date.';
