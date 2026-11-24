-- ============================================================
-- 343 · AN OWN BANK ACCOUNT CAN BE AT A FOREIGN BANK (#697, MNE-001-502)
--
-- Anexo 24 (RMF 2026), apartado C, defines a foreign bank by residence: «no
-- tiene residencia en el país». Its payment nodes declare such a bank with a
-- c_Banco code in the `*Nal` attribute and its full name in the `*Ext` one.
-- `bank_accounts` had nowhere to say that one of the entity's own accounts is
-- at such a bank, so a cheque or a transfer from it had no code to declare and
-- its month never delivered.
--
-- bank_is_foreign is that fact. Only a person sets it, through
-- `bank account edit --foreign-bank --reason`, and the reason lands in the
-- audit trail. It is never inferred: a missing code, a SWIFT, an IBAN, the
-- currency or the bank's name are no evidence of non-residence, and calling a
-- resident bank foreign would be false in the records (CFF art. 28 fr. III).
-- The vouchers file reads it when it is generated, as it reads sat_bank_code,
-- and declares the account's bank as 999 with bank_name in the `*Ext`.
--
-- A foreign account has neither a sat_bank_code nor a CLABE: both name a bank
-- resident in Mexico, and the row would then say two incompatible things about
-- the same bank. The CHECK keeps that out, as 064's does for a payment's
-- destination bank; the service refuses it first with a message that names
-- the datum to clear.
--
-- CONTRACT: schema, compatible. Additive: one NOT NULL column whose DEFAULT
-- false every existing row takes, so no account becomes foreign, and one CHECK
-- every existing row satisfies with that false. No data moves, so there is no
-- row-level-security opt-in, and the table's policy is untouched.
-- ============================================================

ALTER TABLE bank_accounts
    ADD COLUMN IF NOT EXISTS bank_is_foreign BOOLEAN NOT NULL DEFAULT false;

-- National or foreign, not both: a c_Banco code or a CLABE says the bank is
-- resident in Mexico.
ALTER TABLE bank_accounts
    DROP CONSTRAINT IF EXISTS bank_accounts_foreign_bank_has_no_national_identifier,
    ADD CONSTRAINT bank_accounts_foreign_bank_has_no_national_identifier
        CHECK (NOT bank_is_foreign OR (sat_bank_code IS NULL AND clabe_encrypted IS NULL));

COMMENT ON COLUMN bank_accounts.bank_is_foreign IS
    'The account''s bank is not resident in Mexico (Anexo 24, apartado C), as a person recorded with a reason in the audit trail; never inferred (MNE-001-502). The vouchers file declares it as c_Banco 999 with bank_name in BanEmisExt, BancoOriExt or BancoDestExt. A foreign account has no sat_bank_code and no CLABE.';
