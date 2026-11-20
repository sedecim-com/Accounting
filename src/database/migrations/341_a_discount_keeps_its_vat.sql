-- ============================================================
-- 341 · AN EARLY-PAYMENT DISCOUNT TAKES ITS VAT OUT OF 1135 (#831, MNE-001-597)
--
-- On cash-basis books a received bill parks its VAT in 1135 and each payment
-- moves the share of the cash it pays to 1130 (LIVA art. 5 fr. III). A
-- discount taken at payment lowers the price, and with it the VAT (art. 7):
-- its share was never paid, so it is never creditable. Until this migration
-- the whole discount went to 5200 and that share stayed in 1135 on a paid bill.
-- From 341 it leaves 1135 against the discount, in the same entry.
--
-- discount_iva_amount is that share for one application, at four decimals,
-- stored when it is posted so that `payment unapply` gives back exactly what
-- left (the lesson of 050) and `receivedVatStillParked` nets it. It is in the
-- functional currency, as 1135 and iva_reclass_amount are: on a bill in
-- another currency it is the share at the bill's rate, while discount_amount
-- stays in the bill's currency, so the two are not compared here.
--
-- NULL means a row written before this migration: on cash-basis books its
-- discount's VAT stayed in 1135, so an unapply gives back nothing for it,
-- which is the truth, and there is no backfill. From 341 every application a
-- payment or an apply posts stores it, 0 included.
--
-- CONTRACT: schema, compatible. Additive: one nullable column and one CHECK
-- every existing row satisfies with its NULL. No data moves, so there is no
-- row-level-security opt-in, and the table's policy is untouched.
-- ============================================================

ALTER TABLE payment_applications
    ADD COLUMN IF NOT EXISTS discount_iva_amount DECIMAL(19,4);

-- What left 1135 is never negative: giving VAT back is the unapply's entry.
ALTER TABLE payment_applications
    DROP CONSTRAINT IF EXISTS payment_applications_discount_iva_not_negative,
    ADD CONSTRAINT payment_applications_discount_iva_not_negative
        CHECK (discount_iva_amount IS NULL OR discount_iva_amount >= 0);

COMMENT ON COLUMN payment_applications.discount_iva_amount IS
    'The VAT of this application''s early-payment discount that left 1135 without becoming creditable (LIVA arts. 5-III and 7; MNE-001-597), in the functional currency. 0 when nothing left; NULL on a row written before 341, whose discount''s VAT stayed in 1135.';
