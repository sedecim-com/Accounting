-- ============================================================
-- 327 · A REVERSED RECEIPT SAYS WHAT HAPPENED TO THE MONEY (#701, MNE-001-509)
--
-- `receipt reverse` undid every receipt as a bounced cheque (049). Two
-- different things can have happened, and the IVA follows each differently:
--   not_collected  the money never became the firm's, so it never caused
--                  the IVA (LIVA art. 1-B);
--   taken_back     the money arrived and was taken away, which leaves the
--                  IVA only by a restitution (LIVA art. 7; RLIVA art. 24).
-- Which one happened is a fact of each receipt, stated by a person. The
-- receipt keeps it with the instant it was stated, written once.
--
-- A reversed receipt may carry no cause: the reversal of any method but a
-- cheque with none stated. NULL in both columns is also every row written
-- before this migration.
--
-- CONTRACT: schema, compatible. Additive: two nullable columns and three
-- CHECKs that every existing row satisfies with its two NULLs. No data
-- moves, so there is no row-level-security opt-in, and the table's policy
-- is untouched.
-- ============================================================

ALTER TABLE customer_payments
    ADD COLUMN IF NOT EXISTS reversal_cause VARCHAR(20),
    ADD COLUMN IF NOT EXISTS reversal_cause_stated_at TIMESTAMPTZ;

ALTER TABLE customer_payments
    DROP CONSTRAINT IF EXISTS customer_payments_reversal_cause_known,
    ADD CONSTRAINT customer_payments_reversal_cause_known
        CHECK (reversal_cause IS NULL OR reversal_cause IN ('not_collected', 'taken_back')),
    DROP CONSTRAINT IF EXISTS customer_payments_reversal_cause_dated,
    ADD CONSTRAINT customer_payments_reversal_cause_dated
        CHECK ((reversal_cause IS NULL) = (reversal_cause_stated_at IS NULL)),
    -- NOTE: only a reversed receipt has a cause; a reversed one may have none.
    DROP CONSTRAINT IF EXISTS customer_payments_reversal_cause_only_reversed,
    ADD CONSTRAINT customer_payments_reversal_cause_only_reversed
        CHECK (reversal_cause IS NULL OR status = 'reversed');

COMMENT ON COLUMN customer_payments.reversal_cause IS
    'not_collected | taken_back: what happened to the money of a reversed receipt (MNE-001-509). NULL: not reversed, or reversed with no cause stated.';
COMMENT ON COLUMN customer_payments.reversal_cause_stated_at IS
    'The instant reversal_cause was stated: the reversal itself, or later. NULL exactly when reversal_cause is.';
