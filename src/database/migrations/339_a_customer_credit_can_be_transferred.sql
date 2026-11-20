-- ============================================================
-- 339 · A CUSTOMER CREDIT CAN BE TRANSFERRED (#695, MNE-001-498)
--
-- The entity owes customer A the cash A left on account. A assigns that
-- credit to customer B (CCF art. 2029), and the entity's recorded agreement
-- stands for the notice (art. 2038). Nothing is collected, returned or
-- caused by the assignment: B's IVA is caused later, when the credit settles
-- an invoice of B (LIVA art. 1o.-B), which is part 2 (MNE-001-499).
--
-- A ROW OF ITS OWN FOR B, in customer_payments, linked to the receipt it
-- comes from. apply, unapply, reverse, the IVA paper and rep-expected.ts
-- already read a receipt by its own customer and date, so part 2 teaches
-- them one link instead of a new source table. Its method is
-- 'balance_transfer', and the method says it: no bank, a source, a reason.
--
--   · A transfer row and its source go together: the method and the link
--     are both there or neither is.
--   · A transfer moves no money, so it has no bank account.
--   · A transfer is agreed, so it says why.
--   · A row is not its own source.
--
-- CONTRACT: schema, compatible. Additive: two nullable columns, one more
-- value in the closed list of methods, four CHECKs every existing row
-- satisfies with its NULLs, and one partial index. No data moves, so there
-- is no row-level-security opt-in, and the table's policy is untouched.
-- ============================================================

ALTER TABLE customer_payments
    ADD COLUMN IF NOT EXISTS transferred_from_payment_id UUID REFERENCES customer_payments(id),
    ADD COLUMN IF NOT EXISTS transfer_reason TEXT;

ALTER TABLE customer_payments
    DROP CONSTRAINT IF EXISTS customer_payments_payment_method_check,
    ADD CONSTRAINT customer_payments_payment_method_check
        CHECK (payment_method IN (
            'cash', 'check', 'credit_card', 'debit_card',
            'ach', 'wire', 'spei', 'stripe', 'paypal', 'other',
            'balance_transfer'
        ));

ALTER TABLE customer_payments
    DROP CONSTRAINT IF EXISTS customer_payments_transfer_has_source,
    ADD CONSTRAINT customer_payments_transfer_has_source
        CHECK ((payment_method = 'balance_transfer') = (transferred_from_payment_id IS NOT NULL)),
    DROP CONSTRAINT IF EXISTS customer_payments_transfer_has_no_bank,
    ADD CONSTRAINT customer_payments_transfer_has_no_bank
        CHECK (payment_method <> 'balance_transfer' OR bank_account_id IS NULL),
    DROP CONSTRAINT IF EXISTS customer_payments_transfer_has_reason,
    ADD CONSTRAINT customer_payments_transfer_has_reason
        CHECK (payment_method <> 'balance_transfer' OR btrim(COALESCE(transfer_reason, '')) <> ''),
    DROP CONSTRAINT IF EXISTS customer_payments_transfer_not_its_own_source,
    ADD CONSTRAINT customer_payments_transfer_not_its_own_source
        CHECK (transferred_from_payment_id IS NULL OR transferred_from_payment_id <> id);

CREATE INDEX IF NOT EXISTS idx_customer_payments_transferred_from
    ON customer_payments(transferred_from_payment_id)
    WHERE transferred_from_payment_id IS NOT NULL;

COMMENT ON COLUMN customer_payments.transferred_from_payment_id IS
    'The receipt whose cash on account this row received by an agreed transfer (MNE-001-498): set exactly when payment_method is balance_transfer. The source''s cash on account is its amount less its live allocations less its live transfers out.';
COMMENT ON COLUMN customer_payments.transfer_reason IS
    'Why the credit was transferred: the agreement between the two customers and the entity. Required on a transfer row; it is also the reason of its audit row.';
