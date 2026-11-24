-- ============================================================
-- 344 · A VENDOR APPLICATION KEEPS THE DAY IT WAS APPLIED (#787, MNE-001-677)
--
-- The vendor side of 332. Cash paid to a vendor on account and applied to a
-- bill later (`payment apply`) has no date of its own: payment_applications
-- keeps only created_at (002), a clock. The ledger dates the application's
-- entry the day the command runs, while the DIOT and the IVA workpaper date
-- the row by its payment, so a payment of March 20th applied on May 10th
-- credits its VAT in May in the ledger and in March in the other two.
--
-- applied_on is that day. This migration adds the column and nothing reads or
-- writes it yet: MNE-001-678 makes `payment create` write the payment's own
-- date and `payment apply` the date it is given, and MNE-001-679 makes the
-- DIOT and the workpaper ask `COALESCE(applied_on, payment_date)`.
--
-- NULLABLE, AND NOT BACKFILLED. A NULL is a row written before a writer
-- stored the day, and every reader falls back to its payment's payment_date,
-- the date the DIOT and the workpaper gave it until today: no DIOT and no IVA
-- paper already shown moves (history before overwrite, ADR-0006, Decision 2).
-- Such a row does carry created_at (002), and one written by an earlier
-- `payment apply` holds the day its entry was posted; it is not copied here,
-- because a backfill would rewrite figures already shown.
--
-- CONTRACT: schema, compatible. Additive: one nullable column, no CHECK and
-- no index. No data moves, so there is no row-level-security opt-in, and the
-- table's policy is untouched.
-- ============================================================

ALTER TABLE payment_applications
    ADD COLUMN IF NOT EXISTS applied_on DATE;

COMMENT ON COLUMN payment_applications.applied_on IS
    'The day the cash was applied to the bill (MNE-001-677): the payment''s date for `payment create`, the date given to `payment apply`. NULL on rows written before a writer stored it (MNE-001-678); readers then take the payment''s payment_date.';
