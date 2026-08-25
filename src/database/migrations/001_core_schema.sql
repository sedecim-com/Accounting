-- ============================================================
-- Migration 001: Core Accounting Schema
-- Multi-tenant foundation + Chart of Accounts + Journal Entries
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================
-- MULTI-TENANCY: Shared Tables (public schema)
-- ============================================================

CREATE TABLE public.tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    subdomain VARCHAR(100) UNIQUE NOT NULL,
    schema_name VARCHAR(100) UNIQUE NOT NULL,
    plan VARCHAR(50) NOT NULL DEFAULT 'free'
        CHECK (plan IN ('free', 'starter', 'professional', 'enterprise')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id),
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    is_active BOOLEAN NOT NULL DEFAULT true,
    roles JSONB NOT NULL DEFAULT '[]',
    permissions JSONB NOT NULL DEFAULT '[]',
    accessible_entities JSONB NOT NULL DEFAULT '[]',
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, email)
);

CREATE TABLE public.sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id),
    refresh_token_hash VARCHAR(255) NOT NULL,
    ip_address INET,
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_sessions_user ON public.sessions(user_id);
CREATE INDEX idx_sessions_refresh ON public.sessions(refresh_token_hash);

-- ============================================================
-- TENANT SCHEMA TEMPLATE
-- These tables are created per-tenant in their isolated schema
-- ============================================================

-- Organizations & Legal Entities
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('holding', 'operating')),
    parent_id UUID REFERENCES organizations(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE legal_entities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    tenant_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    entity_type VARCHAR(50) NOT NULL
        CHECK (entity_type IN ('corporation', 'llc', 'partnership', 'sapi', 'sa', 'sc')),
    tax_id VARCHAR(50) NOT NULL,
    tax_id_type VARCHAR(20) NOT NULL CHECK (tax_id_type IN ('rfc', 'ein', 'vat')),
    incorporation_country CHAR(2) NOT NULL,
    functional_currency CHAR(3) NOT NULL DEFAULT 'USD',
    accounting_standard VARCHAR(20) NOT NULL DEFAULT 'us_gaap'
        CHECK (accounting_standard IN ('us_gaap', 'mx_nif', 'ifrs')),
    fiscal_year_start_month INTEGER NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_legal_entities_org ON legal_entities(organization_id);
CREATE INDEX idx_legal_entities_country ON legal_entities(incorporation_country);

-- ============================================================
-- CHART OF ACCOUNTS
-- ============================================================

CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    parent_id UUID REFERENCES accounts(id),
    account_level INTEGER NOT NULL DEFAULT 1,
    full_code VARCHAR(255),
    account_type VARCHAR(50) NOT NULL
        CHECK (account_type IN (
            'asset', 'liability', 'equity', 'revenue', 'expense',
            'contra_asset', 'contra_liability', 'contra_equity'
        )),
    account_subtype VARCHAR(100),
    fs_category VARCHAR(100)
        CHECK (fs_category IN (
            'current_assets', 'non_current_assets',
            'current_liabilities', 'long_term_liabilities',
            'equity', 'revenue', 'cogs',
            'operating_expenses', 'other_income', 'other_expenses', 'tax'
        )),
    is_control_account BOOLEAN NOT NULL DEFAULT false,
    is_system_account BOOLEAN NOT NULL DEFAULT false,
    allow_manual_entries BOOLEAN NOT NULL DEFAULT true,
    require_subsidiary BOOLEAN NOT NULL DEFAULT false,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    currency_code CHAR(3),
    tax_line_id UUID,
    us_gaap_code VARCHAR(50),
    mx_nif_code VARCHAR(50),
    ifrs_code VARCHAR(50),
    normal_balance VARCHAR(10) NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_header BOOLEAN NOT NULL DEFAULT false,
    description TEXT,
    tags JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL,
    updated_by UUID,
    UNIQUE(code, entity_id),
    CHECK (is_header = false OR allow_manual_entries = false)
);

CREATE INDEX idx_accounts_code ON accounts(code);
CREATE INDEX idx_accounts_parent ON accounts(parent_id);
CREATE INDEX idx_accounts_type ON accounts(account_type);
CREATE INDEX idx_accounts_entity ON accounts(entity_id);
CREATE INDEX idx_accounts_active ON accounts(is_active);
CREATE INDEX idx_accounts_tags ON accounts USING GIN (tags);

-- Trigger: compute full_code path
CREATE OR REPLACE FUNCTION compute_account_full_code()
RETURNS TRIGGER AS $$
DECLARE
    parent_full_code VARCHAR(255);
BEGIN
    IF NEW.parent_id IS NULL THEN
        NEW.full_code := NEW.code;
        NEW.account_level := 1;
    ELSE
        SELECT full_code, account_level + 1
        INTO parent_full_code, NEW.account_level
        FROM accounts WHERE id = NEW.parent_id;
        NEW.full_code := parent_full_code || '.' || NEW.code;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_account_full_code
    BEFORE INSERT OR UPDATE OF code, parent_id ON accounts
    FOR EACH ROW
    EXECUTE FUNCTION compute_account_full_code();

-- ============================================================
-- FISCAL PERIODS
-- ============================================================

CREATE TABLE fiscal_years (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    year_number INTEGER NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_calendar_year BOOLEAN NOT NULL DEFAULT true,
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(entity_id, year_number)
);

CREATE TABLE fiscal_periods (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    fiscal_year_id UUID NOT NULL REFERENCES fiscal_years(id),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    period_number INTEGER NOT NULL CHECK (period_number BETWEEN 1 AND 13),
    period_name VARCHAR(50) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    period_type VARCHAR(50) NOT NULL DEFAULT 'regular'
        CHECK (period_type IN ('regular', 'adjustment', 'closing')),
    status VARCHAR(50) NOT NULL DEFAULT 'future'
        CHECK (status IN ('future', 'open', 'soft_close', 'hard_close', 'locked')),
    soft_close_date TIMESTAMPTZ,
    hard_close_date TIMESTAMPTZ,
    closed_by UUID,
    close_checklist JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(fiscal_year_id, period_number)
);

CREATE INDEX idx_fiscal_periods_entity ON fiscal_periods(entity_id);
CREATE INDEX idx_fiscal_periods_dates ON fiscal_periods(start_date, end_date);
CREATE INDEX idx_fiscal_periods_status ON fiscal_periods(status);

-- ============================================================
-- JOURNAL ENTRIES & LINES
-- ============================================================

CREATE TABLE journal_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entry_number VARCHAR(50) NOT NULL,
    entry_type VARCHAR(50) NOT NULL
        CHECK (entry_type IN (
            'standard', 'adjusting', 'closing', 'reversing', 'correction',
            'auto_invoice', 'auto_payment', 'auto_depreciation', 'auto_reconciliation'
        )),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    fiscal_period_id UUID NOT NULL REFERENCES fiscal_periods(id),
    source_type VARCHAR(50),
    source_id UUID,
    reference VARCHAR(255),
    entry_date DATE NOT NULL,
    posted_date TIMESTAMPTZ,
    status VARCHAR(50) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'pending_approval', 'approved', 'posted', 'void')),
    is_reversal BOOLEAN NOT NULL DEFAULT false,
    reverses_entry_id UUID REFERENCES journal_entries(id),
    reversed_by_entry_id UUID REFERENCES journal_entries(id),
    description TEXT,
    notes TEXT,
    attachments JSONB DEFAULT '[]',
    total_debits DECIMAL(19,4) NOT NULL DEFAULT 0,
    total_credits DECIMAL(19,4) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL,
    posted_by UUID,
    approved_by UUID,
    UNIQUE(entry_number, entity_id),
    CHECK (status != 'posted' OR (total_debits = total_credits AND total_debits > 0)),
    CHECK (status != 'posted' OR posted_date IS NOT NULL)
);

CREATE INDEX idx_je_entity ON journal_entries(entity_id);
CREATE INDEX idx_je_period ON journal_entries(fiscal_period_id);
CREATE INDEX idx_je_status ON journal_entries(status);
CREATE INDEX idx_je_date ON journal_entries(entry_date);
CREATE INDEX idx_je_source ON journal_entries(source_type, source_id);
CREATE INDEX idx_je_number ON journal_entries(entry_number);

CREATE TABLE journal_entry_lines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(id),
    debit_amount DECIMAL(19,4),
    credit_amount DECIMAL(19,4),
    cost_center_id UUID,
    department_id UUID,
    project_id UUID,
    class_id UUID,
    currency_code CHAR(3),
    foreign_debit DECIMAL(19,4),
    foreign_credit DECIMAL(19,4),
    exchange_rate DECIMAL(19,10),
    is_reconciled BOOLEAN NOT NULL DEFAULT false,
    reconciled_at TIMESTAMPTZ,
    reconciliation_id UUID,
    description TEXT,
    tags JSONB DEFAULT '{}',
    UNIQUE(journal_entry_id, line_number),
    CHECK (
        (debit_amount IS NOT NULL AND credit_amount IS NULL) OR
        (debit_amount IS NULL AND credit_amount IS NOT NULL)
    ),
    CHECK (debit_amount IS NULL OR debit_amount > 0),
    CHECK (credit_amount IS NULL OR credit_amount > 0),
    CHECK (
        currency_code IS NULL OR
        (exchange_rate IS NOT NULL AND (foreign_debit IS NOT NULL OR foreign_credit IS NOT NULL))
    )
);

CREATE INDEX idx_jel_entry ON journal_entry_lines(journal_entry_id);
CREATE INDEX idx_jel_account ON journal_entry_lines(account_id);
CREATE INDEX idx_jel_reconciled ON journal_entry_lines(is_reconciled);

-- Trigger: update journal entry totals when lines change
CREATE OR REPLACE FUNCTION update_je_totals()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE journal_entries
    SET
        total_debits = COALESCE((
            SELECT SUM(COALESCE(debit_amount, 0))
            FROM journal_entry_lines
            WHERE journal_entry_id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id)
        ), 0),
        total_credits = COALESCE((
            SELECT SUM(COALESCE(credit_amount, 0))
            FROM journal_entry_lines
            WHERE journal_entry_id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id)
        ), 0)
    WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_je_totals
    AFTER INSERT OR UPDATE OR DELETE ON journal_entry_lines
    FOR EACH ROW
    EXECUTE FUNCTION update_je_totals();

-- ============================================================
-- TRANSACTIONS (higher-level business events)
-- ============================================================

CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_number VARCHAR(50) NOT NULL,
    transaction_type VARCHAR(50) NOT NULL
        CHECK (transaction_type IN (
            'invoice', 'bill', 'payment_received', 'payment_made',
            'expense', 'deposit', 'transfer', 'adjustment'
        )),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    customer_id UUID,
    vendor_id UUID,
    amount DECIMAL(19,4) NOT NULL,
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    exchange_rate DECIMAL(19,10) NOT NULL DEFAULT 1.0,
    functional_amount DECIMAL(19,4) NOT NULL,
    transaction_date DATE NOT NULL,
    due_date DATE,
    status VARCHAR(50) NOT NULL DEFAULT 'draft'
        CHECK (status IN (
            'draft', 'pending', 'approved', 'posted',
            'paid', 'partially_paid', 'void', 'cancelled'
        )),
    amount_paid DECIMAL(19,4) NOT NULL DEFAULT 0,
    amount_due DECIMAL(19,4) NOT NULL,
    journal_entry_id UUID REFERENCES journal_entries(id),
    description TEXT,
    memo TEXT,
    reference VARCHAR(255),
    terms VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL,
    UNIQUE(transaction_number, entity_id)
);

CREATE INDEX idx_transactions_entity ON transactions(entity_id);
CREATE INDEX idx_transactions_type ON transactions(transaction_type);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_date ON transactions(transaction_date);

-- ============================================================
-- EXCHANGE RATES
-- ============================================================

CREATE TABLE exchange_rates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_currency CHAR(3) NOT NULL,
    to_currency CHAR(3) NOT NULL,
    rate DECIMAL(19,10) NOT NULL CHECK (rate > 0),
    inverse_rate DECIMAL(19,10) GENERATED ALWAYS AS (1.0 / rate) STORED,
    effective_date DATE NOT NULL,
    effective_until DATE,
    source VARCHAR(100) NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual', 'banco_mexico', 'ecb', 'fed', 'xe', 'openexchangerates')),
    source_metadata JSONB,
    rate_type VARCHAR(50) NOT NULL DEFAULT 'spot'
        CHECK (rate_type IN ('spot', 'average', 'budget', 'historical')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL,
    UNIQUE(from_currency, to_currency, effective_date, rate_type)
);

CREATE INDEX idx_exchange_rates_pair ON exchange_rates(from_currency, to_currency);
CREATE INDEX idx_exchange_rates_date ON exchange_rates(effective_date);

-- Function: get exchange rate with fallback
CREATE OR REPLACE FUNCTION get_exchange_rate(
    p_from CHAR(3),
    p_to CHAR(3),
    p_date DATE,
    p_rate_type VARCHAR(50) DEFAULT 'spot'
)
RETURNS DECIMAL(19,10) AS $$
DECLARE
    v_rate DECIMAL(19,10);
BEGIN
    -- Direct rate
    SELECT rate INTO v_rate
    FROM exchange_rates
    WHERE from_currency = p_from
      AND to_currency = p_to
      AND effective_date <= p_date
      AND (effective_until IS NULL OR effective_until >= p_date)
      AND rate_type = p_rate_type
    ORDER BY effective_date DESC
    LIMIT 1;

    IF v_rate IS NOT NULL THEN RETURN v_rate; END IF;

    -- Inverse rate
    SELECT inverse_rate INTO v_rate
    FROM exchange_rates
    WHERE from_currency = p_to
      AND to_currency = p_from
      AND effective_date <= p_date
      AND (effective_until IS NULL OR effective_until >= p_date)
      AND rate_type = p_rate_type
    ORDER BY effective_date DESC
    LIMIT 1;

    IF v_rate IS NOT NULL THEN RETURN v_rate; END IF;

    -- Cross-rate via USD
    IF p_from != 'USD' AND p_to != 'USD' THEN
        DECLARE
            v_from_usd DECIMAL(19,10);
            v_usd_to DECIMAL(19,10);
        BEGIN
            v_from_usd := get_exchange_rate(p_from, 'USD', p_date, p_rate_type);
            v_usd_to := get_exchange_rate('USD', p_to, p_date, p_rate_type);
            IF v_from_usd IS NOT NULL AND v_usd_to IS NOT NULL THEN
                RETURN v_from_usd * v_usd_to;
            END IF;
        END;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- AUDIT LOG
-- ============================================================

CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL
        CHECK (action IN ('create', 'update', 'delete', 'post', 'void', 'approve', 'close', 'reopen')),
    entity_type VARCHAR(100) NOT NULL,
    entity_id UUID NOT NULL,
    old_values JSONB,
    new_values JSONB,
    ip_address INET,
    user_agent TEXT,
    request_id UUID,
    reason TEXT,
    approver_id UUID
);

CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_user ON audit_log(user_id);
CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_log_tenant ON audit_log(tenant_id);

-- ============================================================
-- ACCOUNT BALANCES (denormalized for performance)
-- ============================================================

CREATE TABLE account_balances (
    account_id UUID NOT NULL REFERENCES accounts(id),
    fiscal_period_id UUID NOT NULL REFERENCES fiscal_periods(id),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    beginning_balance DECIMAL(19,4) NOT NULL DEFAULT 0,
    debit_total DECIMAL(19,4) NOT NULL DEFAULT 0,
    credit_total DECIMAL(19,4) NOT NULL DEFAULT 0,
    ending_balance DECIMAL(19,4) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, fiscal_period_id)
);

CREATE INDEX idx_account_balances_entity ON account_balances(entity_id);
CREATE INDEX idx_account_balances_period ON account_balances(fiscal_period_id);

-- ============================================================
-- MATERIALIZED VIEW: Trial Balance
-- ============================================================

CREATE MATERIALIZED VIEW mv_trial_balance AS
SELECT
    a.id AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    a.account_type,
    a.entity_id,
    fp.id AS fiscal_period_id,
    fp.period_name,
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
GROUP BY a.id, a.code, a.name, a.account_type, a.entity_id, fp.id, fp.period_name;

CREATE UNIQUE INDEX idx_mv_trial_balance ON mv_trial_balance(account_id, fiscal_period_id);

-- Trigger: refresh materialized view after posting
CREATE OR REPLACE FUNCTION refresh_trial_balance()
RETURNS TRIGGER AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_trial_balance;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_refresh_trial_balance
    AFTER INSERT OR UPDATE ON journal_entries
    FOR EACH ROW
    WHEN (NEW.status = 'posted')
    EXECUTE FUNCTION refresh_trial_balance();
