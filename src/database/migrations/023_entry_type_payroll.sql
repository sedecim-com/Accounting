-- ============================================================
-- 023: extend journal_entries.entry_type CHECK with 'payroll'
-- The TS enum (JournalEntryType.PAYROLL) and the REST schema accept
-- 'payroll' and payroll GL posting sends it, but the original CHECK
-- in 001 never listed it: every payroll post died at the DB with a
-- constraint violation. Recreate the CHECK with the full list.
-- ============================================================

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_entry_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_entry_type_check
    CHECK (entry_type IN (
        'standard', 'adjusting', 'closing', 'reversing', 'correction',
        'auto_invoice', 'auto_payment', 'auto_depreciation', 'auto_reconciliation',
        'payroll'
    ));
