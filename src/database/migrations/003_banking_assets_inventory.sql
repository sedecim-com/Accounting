-- ============================================================
-- Migration 003: Banking, Fixed Assets & Inventory
-- ============================================================

-- ============================================================
-- BANK ACCOUNTS
-- ============================================================

CREATE TABLE bank_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    account_name VARCHAR(255) NOT NULL,
    account_number_encrypted TEXT,
    account_number_last4 VARCHAR(4),
    routing_number_encrypted TEXT,
    bank_name VARCHAR(255) NOT NULL,
    bank_branch VARCHAR(255),
    swift_code VARCHAR(20),
    iban VARCHAR(50),
    clabe VARCHAR(18),
    gl_account_id UUID NOT NULL REFERENCES accounts(id),
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    plaid_account_id VARCHAR(255),
    fintoc_account_id VARCHAR(255),
    belvo_account_id VARCHAR(255),
    auto_import_enabled BOOLEAN NOT NULL DEFAULT false,
    import_frequency VARCHAR(50) CHECK (import_frequency IN ('hourly', 'daily', 'weekly')),
    current_balance DECIMAL(19,4),
    available_balance DECIMAL(19,4),
    last_synced_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bank_accounts_entity ON bank_accounts(entity_id);
CREATE INDEX idx_bank_accounts_gl ON bank_accounts(gl_account_id);

-- ============================================================
-- BANK TRANSACTIONS
-- ============================================================

CREATE TABLE bank_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
    bank_transaction_id VARCHAR(255),
    transaction_date DATE NOT NULL,
    posted_date DATE,
    amount DECIMAL(19,4) NOT NULL,
    transaction_type VARCHAR(50) NOT NULL
        CHECK (transaction_type IN ('debit', 'credit', 'fee', 'interest', 'adjustment')),
    description TEXT,
    merchant_name VARCHAR(255),
    category VARCHAR(100),
    raw_data JSONB,
    is_matched BOOLEAN NOT NULL DEFAULT false,
    matched_at TIMESTAMPTZ,
    matched_by UUID,
    confidence_score DECIMAL(3,2),
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    import_batch_id UUID,
    UNIQUE(bank_account_id, bank_transaction_id)
);

CREATE INDEX idx_bank_tx_account ON bank_transactions(bank_account_id);
CREATE INDEX idx_bank_tx_date ON bank_transactions(transaction_date);
CREATE INDEX idx_bank_tx_matched ON bank_transactions(is_matched);
CREATE INDEX idx_bank_tx_batch ON bank_transactions(import_batch_id);

-- ============================================================
-- RECONCILIATION
-- ============================================================

CREATE TABLE reconciliation_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    beginning_balance DECIMAL(19,4) NOT NULL,
    ending_balance_per_bank DECIMAL(19,4) NOT NULL,
    ending_balance_per_books DECIMAL(19,4) NOT NULL DEFAULT 0,
    outstanding_checks DECIMAL(19,4) NOT NULL DEFAULT 0,
    deposits_in_transit DECIMAL(19,4) NOT NULL DEFAULT 0,
    bank_charges DECIMAL(19,4) NOT NULL DEFAULT 0,
    bank_interest DECIMAL(19,4) NOT NULL DEFAULT 0,
    other_adjustments DECIMAL(19,4) NOT NULL DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress', 'balanced', 'approved', 'posted')),
    variance DECIMAL(19,4) NOT NULL DEFAULT 0,
    notes TEXT,
    completed_at TIMESTAMPTZ,
    completed_by UUID,
    approved_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recon_sessions_bank ON reconciliation_sessions(bank_account_id);
CREATE INDEX idx_recon_sessions_status ON reconciliation_sessions(status);

CREATE TABLE reconciliation_matches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reconciliation_session_id UUID REFERENCES reconciliation_sessions(id),
    bank_transaction_id UUID NOT NULL REFERENCES bank_transactions(id),
    match_type VARCHAR(50) NOT NULL
        CHECK (match_type IN ('automatic', 'manual', 'suggested')),
    matched_entity_type VARCHAR(50) NOT NULL
        CHECK (matched_entity_type IN ('journal_entry_line', 'invoice', 'bill', 'customer_payment', 'vendor_payment')),
    matched_entity_id UUID NOT NULL,
    matched_amount DECIMAL(19,4) NOT NULL,
    confidence_score DECIMAL(3,2),
    is_partial BOOLEAN NOT NULL DEFAULT false,
    matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    matched_by UUID,
    notes TEXT
);

CREATE INDEX idx_recon_matches_session ON reconciliation_matches(reconciliation_session_id);
CREATE INDEX idx_recon_matches_bank_tx ON reconciliation_matches(bank_transaction_id);

-- ============================================================
-- FIXED ASSETS
-- ============================================================

CREATE TABLE asset_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    name VARCHAR(255) NOT NULL,
    parent_id UUID REFERENCES asset_categories(id),
    default_useful_life_years INTEGER,
    default_depreciation_method VARCHAR(50)
        CHECK (default_depreciation_method IN (
            'straight_line', 'declining_balance_150', 'declining_balance_200',
            'sum_of_years_digits', 'units_of_production', 'macrs'
        )),
    default_asset_account_id UUID REFERENCES accounts(id),
    default_depreciation_account_id UUID REFERENCES accounts(id),
    default_expense_account_id UUID REFERENCES accounts(id),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fixed_assets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    asset_number VARCHAR(50) NOT NULL,
    asset_name VARCHAR(255) NOT NULL,
    description TEXT,
    category_id UUID NOT NULL REFERENCES asset_categories(id),
    acquisition_date DATE NOT NULL,
    acquisition_cost DECIMAL(19,4) NOT NULL CHECK (acquisition_cost > 0),
    vendor_id UUID REFERENCES vendors(id),
    purchase_order VARCHAR(100),
    salvage_value DECIMAL(19,4) NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),
    useful_life_years INTEGER NOT NULL CHECK (useful_life_years > 0),
    useful_life_months INTEGER NOT NULL CHECK (useful_life_months > 0),
    depreciation_method VARCHAR(50) NOT NULL
        CHECK (depreciation_method IN (
            'straight_line', 'declining_balance_150', 'declining_balance_200',
            'sum_of_years_digits', 'units_of_production', 'macrs'
        )),
    book_depreciation_method VARCHAR(50),
    tax_depreciation_method VARCHAR(50),
    macrs_class VARCHAR(20),
    depreciation_start_date DATE NOT NULL,
    current_book_value DECIMAL(19,4) NOT NULL,
    accumulated_depreciation DECIMAL(19,4) NOT NULL DEFAULT 0,
    last_depreciation_date DATE,
    asset_account_id UUID NOT NULL REFERENCES accounts(id),
    accumulated_depreciation_account_id UUID NOT NULL REFERENCES accounts(id),
    depreciation_expense_account_id UUID NOT NULL REFERENCES accounts(id),
    serial_number VARCHAR(100),
    manufacturer VARCHAR(255),
    model VARCHAR(255),
    location VARCHAR(255),
    responsible_employee_id UUID,
    cost_center_id UUID,
    department_id UUID,
    status VARCHAR(50) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'disposed', 'fully_depreciated')),
    disposal_date DATE,
    disposal_amount DECIMAL(19,4),
    disposal_method VARCHAR(50),
    gain_loss_amount DECIMAL(19,4),
    tags JSONB DEFAULT '{}',
    notes TEXT,
    attachments JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL,
    UNIQUE(asset_number, entity_id),
    CHECK (acquisition_cost > salvage_value)
);

CREATE INDEX idx_fixed_assets_entity ON fixed_assets(entity_id);
CREATE INDEX idx_fixed_assets_category ON fixed_assets(category_id);
CREATE INDEX idx_fixed_assets_status ON fixed_assets(status);

CREATE TABLE depreciation_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asset_id UUID NOT NULL REFERENCES fixed_assets(id),
    fiscal_period_id UUID NOT NULL REFERENCES fiscal_periods(id),
    depreciation_date DATE NOT NULL,
    depreciation_expense DECIMAL(19,4) NOT NULL,
    accumulated_depreciation DECIMAL(19,4) NOT NULL,
    book_value DECIMAL(19,4) NOT NULL,
    schedule_type VARCHAR(50) NOT NULL DEFAULT 'book'
        CHECK (schedule_type IN ('book', 'tax', 'projected')),
    is_posted BOOLEAN NOT NULL DEFAULT false,
    journal_entry_id UUID REFERENCES journal_entries(id),
    calculation_metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(asset_id, fiscal_period_id, schedule_type)
);

CREATE INDEX idx_depreciation_asset ON depreciation_schedules(asset_id);
CREATE INDEX idx_depreciation_period ON depreciation_schedules(fiscal_period_id);

-- ============================================================
-- INVENTORY
-- ============================================================

CREATE TABLE inventory_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    item_code VARCHAR(50) NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    description TEXT,
    costing_method VARCHAR(50) NOT NULL
        CHECK (costing_method IN ('fifo', 'lifo', 'weighted_average', 'specific_identification')),
    current_quantity DECIMAL(19,4) NOT NULL DEFAULT 0,
    current_value DECIMAL(19,4) NOT NULL DEFAULT 0,
    average_unit_cost DECIMAL(19,4),
    inventory_account_id UUID NOT NULL REFERENCES accounts(id),
    cogs_account_id UUID NOT NULL REFERENCES accounts(id),
    revenue_account_id UUID NOT NULL REFERENCES accounts(id),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(item_code, entity_id)
);

CREATE INDEX idx_inventory_items_entity ON inventory_items(entity_id);

CREATE TABLE inventory_layers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_id UUID NOT NULL REFERENCES inventory_items(id),
    acquired_date DATE NOT NULL,
    quantity DECIMAL(19,4) NOT NULL CHECK (quantity > 0),
    remaining_quantity DECIMAL(19,4) NOT NULL CHECK (remaining_quantity >= 0),
    unit_cost DECIMAL(19,4) NOT NULL CHECK (unit_cost >= 0),
    total_cost DECIMAL(19,4) NOT NULL,
    reference_type VARCHAR(50),
    reference_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inventory_layers_item ON inventory_layers(item_id);
CREATE INDEX idx_inventory_layers_remaining ON inventory_layers(remaining_quantity) WHERE remaining_quantity > 0;

CREATE TABLE inventory_layer_consumption (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    layer_id UUID NOT NULL REFERENCES inventory_layers(id),
    item_id UUID NOT NULL REFERENCES inventory_items(id),
    quantity_consumed DECIMAL(19,4) NOT NULL CHECK (quantity_consumed > 0),
    unit_cost DECIMAL(19,4) NOT NULL,
    total_cost DECIMAL(19,4) NOT NULL,
    reference_type VARCHAR(50),
    reference_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_layer_consumption_layer ON inventory_layer_consumption(layer_id);
CREATE INDEX idx_layer_consumption_item ON inventory_layer_consumption(item_id);

-- ============================================================
-- WEBHOOKS
-- ============================================================

CREATE TABLE webhook_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    url TEXT NOT NULL,
    events TEXT[] NOT NULL,
    secret VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    retry_config JSONB NOT NULL DEFAULT '{"max_retries": 5, "retry_interval_seconds": 60}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhooks_tenant ON webhook_subscriptions(tenant_id);
CREATE INDEX idx_webhooks_active ON webhook_subscriptions(is_active);
CREATE INDEX idx_webhooks_events ON webhook_subscriptions USING GIN (events);

CREATE TABLE webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    webhook_id UUID NOT NULL REFERENCES webhook_subscriptions(id),
    event VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'success', 'failed')),
    http_status_code INTEGER,
    response_body TEXT,
    error_message TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ
);

CREATE INDEX idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status);
CREATE INDEX idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at) WHERE status = 'pending';
