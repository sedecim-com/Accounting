-- ============================================================
-- 335 · A RECEIPT KEEPS THE BANK THE CUSTOMER PAID FROM (#611, MNE-001-567)
--
-- In a receipt the money comes from the customer. PolizasPeriodo 1.3
-- requires that origin on the payment node: Transferencia/@BancoOriNal and
-- Cheque/@BanEmisNal are required c_Banco codes, Cheque/@CtaOri (the account
-- the cheque is drawn on) is required, and Transferencia/@CtaOri is
-- «requerido cuando se cuente con la información». 064 gave customer_payments
-- the destination only, so every customer transfer left the vouchers file
-- without its node and blocked the month.
--
-- ON THE RECEIPT, NOT ON THE CUSTOMER, for 064's reason: the voucher declares
-- the account of that movement, and a customer pays from more than one.
--
-- NATIONAL OR FOREIGN, NOT BOTH, as 064's CHECK on the destination. The row
-- keeps one fact; a foreign bank is declared as 999 with its name in
-- BancoOriExt / BanEmisExt, and the generator derives the 999 (#532).
--
-- CONTRACT: schema, compatible. Additive: three nullable columns and one
-- CHECK every existing row satisfies with its NULLs. No data moves, so there
-- is no row-level-security opt-in, and the table's policy is untouched.
-- ============================================================

ALTER TABLE customer_payments
    ADD COLUMN IF NOT EXISTS cuenta_origen VARCHAR(50),
    ADD COLUMN IF NOT EXISTS banco_origen_sat VARCHAR(3),
    ADD COLUMN IF NOT EXISTS banco_origen_extranjero VARCHAR(150);

ALTER TABLE customer_payments
    DROP CONSTRAINT IF EXISTS banco_origen_nacional_o_extranjero_cobro,
    ADD CONSTRAINT banco_origen_nacional_o_extranjero_cobro
        CHECK (banco_origen_sat IS NULL OR banco_origen_extranjero IS NULL);

COMMENT ON COLUMN customer_payments.cuenta_origen IS
    'The account the customer paid from: CtaOri of the payment node (Anexo 24). Required on a Cheque (the account it is drawn on), declared on a Transferencia when known. Kept on the receipt, not on the customer: the voucher declares the account of that movement.';
COMMENT ON COLUMN customer_payments.banco_origen_sat IS
    'c_Banco code of the bank the customer paid from (BancoOriNal, or BanEmisNal of a cheque). Checked against the c_Banco of the vendored XSD when the receipt is recorded. NULL when banco_origen_extranjero holds a foreign bank.';
COMMENT ON COLUMN customer_payments.banco_origen_extranjero IS
    'Full name of the foreign bank the customer paid from (BancoOriExt / BanEmisExt, max 150). The file declares it with code 999 (#532); never together with banco_origen_sat.';
