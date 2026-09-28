-- ============================================================
-- 105 · A PAYMENT APPLICATION CAN BE UNAPPLIED (#98 · MNE-001-037)
--
-- The three columns 050 deliberately left out, arriving with the command that
-- writes them (`payment unapply`), as 050's header promised: a column no code
-- writes is declared capability, not delivered capability.
--
-- An unapplied row is history, not state. It is never deleted: the bill it
-- settled reopens, the cash goes back on account (1150) and the row keeps who
-- closed it, when and why. `unapplied_at` carries the unapply's DATE (the
-- operator may date it, `--date`), so an "as of" reader asks
-- `unapplied_at IS NULL OR unapplied_at::date > <cut-off>`, the same rule
-- payment_allocations follows since 049.
--
-- Every sum over payment_applications that means "what is applied" filters
-- `unapplied_at IS NULL` from the same commit: the three sites 050 listed
-- (postVendorPaymentEntry, remanenteDeVendorPago, applyVendorPayment) and
-- billsAppliedBy, the IVA base of a later payment on the same bill.
--
-- Pure DDL: no rows are read or written, so RLS has nothing to hide here.
-- ============================================================

ALTER TABLE payment_applications
    ADD COLUMN unapplied_at TIMESTAMPTZ,
    ADD COLUMN unapplied_by UUID,
    ADD COLUMN unapply_reason TEXT;

-- NOTE: the three are set together or not at all. A closure without its
-- author or its reason is exactly the silent correction this column exists
-- to prevent.
ALTER TABLE payment_applications
    ADD CONSTRAINT payment_applications_unapply_complete
    CHECK ((unapplied_at IS NULL) = (unapplied_by IS NULL)
       AND (unapplied_at IS NULL) = (unapply_reason IS NULL));

COMMENT ON COLUMN payment_applications.unapplied_at IS
  'Date the application was undone by `payment unapply`. NULL = live. A closed row is history: it no longer settles its bill after this date.';
COMMENT ON COLUMN payment_applications.unapplied_by IS
  'User who unapplied the row. Set together with unapplied_at.';
COMMENT ON COLUMN payment_applications.unapply_reason IS
  'Why it was unapplied, as the operator wrote it. Set together with unapplied_at.';

-- From 105 on, every application records the IVA it released, 0 included:
-- the ones born WITH their payment (postVendorPaymentEntry) and the ones
-- applied later (applyVendorPayment). Unapplying re-parks that exact amount.
-- NULL now means only "written before 105": nobody recorded it.
COMMENT ON COLUMN payment_applications.iva_reclass_amount IS
  'Creditable IVA this application moved from 1135 to 1130, stored when applied so it can be undone exactly. 0 when it moved none (PUE bill, entity without cash-basis IVA). NULL only on rows written before 105, which did not store it.';
