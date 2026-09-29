-- ============================================================
-- 118 · A VENDOR PAYMENT CAN BE REVERSED (#98 · MNE-001-128)
--
-- 105 let an application be undone (`payment unapply`): the cash goes back
-- on account, the payment stays. A duplicated transfer that the vendor or the
-- bank sends back is another event: the payment itself is undone. Every entry
-- it posted gets its NIF B-1 mirror, the bills it settled are owed again, its
-- live applications are closed with the 105 columns, and the payment says so.
--
-- 'reversed', the same word 049 gave customer_payments: the payment HAPPENED
-- and was undone. 'void' stays for what never should have existed, and that
-- difference is exactly what an auditor asks.
--
-- `reversed_at` carries the reversal's DATE (the operator may date it,
-- `--date`), the same date as its mirrors and as the `unapplied_at` of the
-- rows it closes, so an "as of" reader sees all three move together. Who and
-- why live in the closed rows (unapplied_by / unapply_reason) and in the
-- audit log, as for customer_payments.
--
-- Pure DDL: no rows are read or written, so RLS has nothing to hide here.
-- ============================================================

ALTER TABLE vendor_payments
    DROP CONSTRAINT vendor_payments_status_check;
ALTER TABLE vendor_payments
    ADD CONSTRAINT vendor_payments_status_check
        CHECK (status IN ('draft', 'pending', 'processing', 'completed', 'failed', 'void', 'reversed'));

ALTER TABLE vendor_payments
    ADD COLUMN reversed_at TIMESTAMPTZ;

-- NOTE: a reversed payment carries its date, and only a reversed one does.
ALTER TABLE vendor_payments
    ADD CONSTRAINT vendor_payments_reversed_dated
        CHECK ((status = 'reversed') = (reversed_at IS NOT NULL));

COMMENT ON COLUMN vendor_payments.reversed_at IS
  'Date the payment was undone by `payment reverse` (status ''reversed''): every entry it posted has a mirror on this date and its live applications were closed on it. NULL on every other status.';
