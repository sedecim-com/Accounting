-- ============================================================
-- 165 · A COLLECTION CARRIES THE CUSTOMER'S WITHHOLDING (#309, MNE-001-113)
--
-- A legal entity that pays an individual for fees or a lease withholds ISR
-- and two thirds of the VAT, and pays the invoice net. On the issuer's side
-- the invoice is settled in full: the cash covers part, and the withholding
-- the customer remits to the SAT on the issuer's behalf covers the rest
-- (LISR 106 and 116; LIVA 1-A and 5-D). `receipt apply --withholding` books
-- that rest to isr_retenido_a_favor / iva_retenido_a_favor.
--
-- WHY COLUMNS AND NOT ROWS: amount_applied is cash, and the on-account
-- remainder of a collection is payment_amount − SUM(amount_applied). A
-- withholding is not cash of this collection, so it cannot live in that
-- column; it rides on the allocation it settled, so unapplying or reversing
-- the allocation reopens exactly what it closed.
--
-- Additive: two columns with a zero default; every existing row keeps its
-- meaning.
-- ============================================================

ALTER TABLE payment_allocations
    ADD COLUMN IF NOT EXISTS withholding_isr_amount DECIMAL(19,4) NOT NULL DEFAULT 0
        CHECK (withholding_isr_amount >= 0),
    ADD COLUMN IF NOT EXISTS withholding_iva_amount DECIMAL(19,4) NOT NULL DEFAULT 0
        CHECK (withholding_iva_amount >= 0);

COMMENT ON COLUMN payment_allocations.withholding_isr_amount IS
    'ISR the customer withheld on this allocation (MNE-001-113): settles the invoice with amount_applied, is not cash of the collection.';
COMMENT ON COLUMN payment_allocations.withholding_iva_amount IS
    'VAT the customer withheld on this allocation (MNE-001-113): settles the invoice with amount_applied, is not cash of the collection.';
