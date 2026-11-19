-- ============================================================
-- 330 · A CUSTOMER CHEQUE KEEPS THE DAY THE BANK CASHED IT (#700, MNE-001-506)
--
-- A price paid by cheque, and its IVA, is paid on the day the cheque is
-- cashed (LIVA art. 1-B, second paragraph). A receipt by cheque could not
-- say when that was: the cashing columns of 055 exist on vendor_payments
-- only. The receipt now keeps the bank credit that paid the cheque and that
-- credit's date, as 055 did for a vendor cheque.
--
-- TOGETHER OR NOT AT ALL. The date without the credit is a statement with no
-- proof, and the credit without the date is a proof that does not say when.
--
-- NOT UNIQUE. One deposit can pay several cheques, so several receipts may
-- hold the same credit; the service decides when a credit is already used.
-- deposit_date (002) stays unused: it never had a credit to prove it.
--
-- CONTRACT: schema, compatible. Additive: two nullable columns, one CHECK
-- every existing row satisfies with its two NULLs, and one partial index. No
-- data moves, so there is no row-level-security opt-in, and the table's
-- policy is untouched.
-- ============================================================

ALTER TABLE customer_payments
    ADD COLUMN IF NOT EXISTS check_cashed_date DATE,
    ADD COLUMN IF NOT EXISTS check_cashed_tx_id UUID REFERENCES bank_transactions(id);

ALTER TABLE customer_payments
    DROP CONSTRAINT IF EXISTS customer_payments_check_cashing_whole,
    ADD CONSTRAINT customer_payments_check_cashing_whole
        CHECK ((check_cashed_date IS NULL) = (check_cashed_tx_id IS NULL));

CREATE INDEX IF NOT EXISTS idx_customer_payments_check_cashed_tx
    ON customer_payments(check_cashed_tx_id)
    WHERE check_cashed_tx_id IS NOT NULL;

COMMENT ON COLUMN customer_payments.check_cashed_date IS
    'The day the bank cashed the cheque: the date of the credit in check_cashed_tx_id. Under LIVA art. 1-B the price and its IVA are paid on this day, not on payment_date. NULL exactly when check_cashed_tx_id is.';
COMMENT ON COLUMN customer_payments.check_cashed_tx_id IS
    'The bank credit that paid the cheque (MNE-001-506). Several receipts of one deposit may hold the same credit.';
