-- ============================================================
-- Migration 004: Partitioning, Materialized Views, Performance
-- ============================================================

-- ============================================================
-- TABLE PARTITIONING for journal_entry_lines
-- Convert to partitioned table for high-volume transaction data
-- ============================================================

-- Create a partitioned copy (note: in production, migrate data with pg_partman)
-- For now, create partition-ready indexes on the existing table
CREATE INDEX IF NOT EXISTS idx_jel_entry_date ON journal_entry_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_jel_account_date ON journal_entry_lines(account_id, journal_entry_id);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_je_entity_status_date ON journal_entries(entity_id, status, entry_date);
CREATE INDEX IF NOT EXISTS idx_je_entity_period_status ON journal_entries(entity_id, fiscal_period_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_entity_status_date ON invoices(entity_id, status, invoice_date);
CREATE INDEX IF NOT EXISTS idx_bills_entity_status_date ON bills(entity_id, status, bill_date);
CREATE INDEX IF NOT EXISTS idx_bank_tx_account_date_matched ON bank_transactions(bank_account_id, transaction_date, is_matched);

-- ============================================================
-- MATERIALIZED VIEW: Trial Balance (refreshed after journal posting)
-- ============================================================

DROP MATERIALIZED VIEW IF EXISTS mv_trial_balance;

CREATE MATERIALIZED VIEW mv_trial_balance AS
SELECT
    a.id AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    a.account_type,
    a.normal_balance,
    a.entity_id,
    fp.id AS fiscal_period_id,
    fp.period_name,
    fp.start_date AS period_start,
    fp.end_date AS period_end,
    COALESCE(SUM(jel.debit_amount), 0) AS total_debits,
    COALESCE(SUM(jel.credit_amount), 0) AS total_credits,
    COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0) -
    COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0) AS net_balance
FROM accounts a
CROSS JOIN fiscal_periods fp
LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
    AND je.fiscal_period_id = fp.id
    AND je.status = 'posted'
WHERE a.entity_id = fp.entity_id
  AND a.is_active = true
GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance,
         a.entity_id, fp.id, fp.period_name, fp.start_date, fp.end_date;

CREATE UNIQUE INDEX idx_mv_trial_balance ON mv_trial_balance(account_id, fiscal_period_id);
CREATE INDEX idx_mv_trial_balance_entity ON mv_trial_balance(entity_id);

-- ============================================================
-- MATERIALIZED VIEW: Account Balance Summary
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_account_balance_summary AS
SELECT
    a.id AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    a.account_type,
    a.entity_id,
    COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0) AS total_debits,
    COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0) AS total_credits,
    COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) AS current_balance,
    COUNT(DISTINCT je.id) AS transaction_count,
    MAX(je.entry_date) AS last_transaction_date
FROM accounts a
LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted'
WHERE a.is_active = true
GROUP BY a.id, a.code, a.name, a.account_type, a.entity_id;

CREATE UNIQUE INDEX idx_mv_account_balance ON mv_account_balance_summary(account_id);
CREATE INDEX idx_mv_account_balance_entity ON mv_account_balance_summary(entity_id);

-- ============================================================
-- FUNCTION: Refresh materialized views (call after posting)
-- ============================================================

CREATE OR REPLACE FUNCTION refresh_materialized_views()
RETURNS TRIGGER AS $$
BEGIN
    -- Only refresh on posting (avoid on every update)
    IF NEW.status = 'posted' AND (OLD IS NULL OR OLD.status != 'posted') THEN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_trial_balance;
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_account_balance_summary;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop old trigger if exists
DROP TRIGGER IF EXISTS trg_refresh_trial_balance ON journal_entries;

CREATE TRIGGER trg_refresh_materialized_views
    AFTER INSERT OR UPDATE ON journal_entries
    FOR EACH ROW
    WHEN (NEW.status = 'posted')
    EXECUTE FUNCTION refresh_materialized_views();

-- ============================================================
-- SCHEDULED PAYMENT SUPPORT
-- ============================================================

CREATE TABLE IF NOT EXISTS scheduled_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    bill_id UUID REFERENCES bills(id),
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    payment_amount DECIMAL(19,4) NOT NULL,
    payment_method VARCHAR(50) NOT NULL,
    bank_account_id UUID REFERENCES bank_accounts(id),
    scheduled_date DATE NOT NULL,
    discount_amount DECIMAL(19,4) DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'processing', 'completed', 'failed', 'cancelled')),
    executed_at TIMESTAMPTZ,
    vendor_payment_id UUID REFERENCES vendor_payments(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL
);

CREATE INDEX idx_scheduled_payments_date ON scheduled_payments(scheduled_date) WHERE status = 'scheduled';
CREATE INDEX idx_scheduled_payments_entity ON scheduled_payments(entity_id);

-- ============================================================
-- CUSTOM REPORT DEFINITIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS custom_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    report_type VARCHAR(50) NOT NULL DEFAULT 'sql'
        CHECK (report_type IN ('sql', 'template', 'pivot')),
    definition JSONB NOT NULL,
    parameters JSONB DEFAULT '[]',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL
);

CREATE INDEX idx_custom_reports_entity ON custom_reports(entity_id);
