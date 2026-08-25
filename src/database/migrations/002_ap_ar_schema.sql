-- ============================================================
-- Migration 002: Accounts Payable & Accounts Receivable
-- ============================================================

-- ============================================================
-- VENDORS (AP)
-- ============================================================

CREATE TABLE vendors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    vendor_number VARCHAR(50) NOT NULL,
    company_name VARCHAR(255) NOT NULL,
    contact_name VARCHAR(255),
    tax_id VARCHAR(50),
    tax_id_type VARCHAR(20) CHECK (tax_id_type IN ('rfc', 'ein', 'vat')),
    is_1099_vendor BOOLEAN NOT NULL DEFAULT false,
    email VARCHAR(255),
    phone VARCHAR(50),
    website VARCHAR(255),
    billing_address JSONB,
    shipping_address JSONB,
    payment_terms VARCHAR(100) NOT NULL DEFAULT 'Net 30',
    default_expense_account_id UUID REFERENCES accounts(id),
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    bank_account_number_encrypted TEXT,
    bank_routing_number_encrypted TEXT,
    bank_name VARCHAR(255),
    clabe_encrypted TEXT,
    auto_pay_enabled BOOLEAN NOT NULL DEFAULT false,
    credit_limit DECIMAL(19,4),
    is_active BOOLEAN NOT NULL DEFAULT true,
    tags JSONB DEFAULT '{}',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL,
    UNIQUE(vendor_number, entity_id)
);

CREATE INDEX idx_vendors_entity ON vendors(entity_id);
CREATE INDEX idx_vendors_active ON vendors(is_active);
CREATE INDEX idx_vendors_name ON vendors USING GIN (company_name gin_trgm_ops);

-- ============================================================
-- BILLS (AP)
-- ============================================================

CREATE TABLE bills (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    bill_number VARCHAR(50) NOT NULL,
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    vendor_invoice_number VARCHAR(100),
    subtotal DECIMAL(19,4) NOT NULL DEFAULT 0,
    tax_amount DECIMAL(19,4) NOT NULL DEFAULT 0,
    total_amount DECIMAL(19,4) NOT NULL DEFAULT 0,
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    exchange_rate DECIMAL(19,10) NOT NULL DEFAULT 1.0,
    bill_date DATE NOT NULL,
    due_date DATE NOT NULL,
    received_date DATE,
    status VARCHAR(50) NOT NULL DEFAULT 'draft'
        CHECK (status IN (
            'draft', 'pending_approval', 'approved', 'posted',
            'paid', 'partially_paid', 'void', 'cancelled'
        )),
    amount_paid DECIMAL(19,4) NOT NULL DEFAULT 0,
    amount_due DECIMAL(19,4) NOT NULL,
    last_payment_date DATE,
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    purchase_order_id UUID,
    journal_entry_id UUID REFERENCES journal_entries(id),
    description TEXT,
    memo TEXT,
    terms TEXT,
    attachments JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL,
    UNIQUE(bill_number, entity_id)
);

CREATE INDEX idx_bills_entity ON bills(entity_id);
CREATE INDEX idx_bills_vendor ON bills(vendor_id);
CREATE INDEX idx_bills_status ON bills(status);
CREATE INDEX idx_bills_due_date ON bills(due_date);

CREATE TABLE bill_lines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(id),
    item_id UUID,
    description TEXT,
    quantity DECIMAL(19,4) NOT NULL DEFAULT 1,
    unit_price DECIMAL(19,4) NOT NULL,
    line_amount DECIMAL(19,4) NOT NULL,
    tax_amount DECIMAL(19,4) NOT NULL DEFAULT 0,
    total_amount DECIMAL(19,4) NOT NULL,
    cost_center_id UUID,
    project_id UUID,
    tags JSONB DEFAULT '{}',
    UNIQUE(bill_id, line_number)
);

CREATE INDEX idx_bill_lines_bill ON bill_lines(bill_id);

-- ============================================================
-- VENDOR PAYMENTS (AP)
-- ============================================================

CREATE TABLE vendor_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    payment_number VARCHAR(50) NOT NULL,
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    payment_amount DECIMAL(19,4) NOT NULL CHECK (payment_amount > 0),
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    exchange_rate DECIMAL(19,10) NOT NULL DEFAULT 1.0,
    payment_method VARCHAR(50) NOT NULL
        CHECK (payment_method IN ('cash', 'check', 'ach', 'wire', 'spei', 'credit_card', 'other')),
    check_number VARCHAR(50),
    reference_number VARCHAR(100),
    bank_account_id UUID,
    payment_date DATE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'pending', 'processing', 'completed', 'failed', 'void')),
    journal_entry_id UUID REFERENCES journal_entries(id),
    memo TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL,
    UNIQUE(payment_number, entity_id)
);

CREATE INDEX idx_vendor_payments_entity ON vendor_payments(entity_id);
CREATE INDEX idx_vendor_payments_vendor ON vendor_payments(vendor_id);
CREATE INDEX idx_vendor_payments_status ON vendor_payments(status);

CREATE TABLE payment_applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_id UUID NOT NULL REFERENCES vendor_payments(id),
    bill_id UUID NOT NULL REFERENCES bills(id),
    amount_applied DECIMAL(19,4) NOT NULL CHECK (amount_applied > 0),
    discount_amount DECIMAL(19,4) DEFAULT 0,
    discount_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_applications_payment ON payment_applications(payment_id);
CREATE INDEX idx_payment_applications_bill ON payment_applications(bill_id);

-- ============================================================
-- CUSTOMERS (AR)
-- ============================================================

CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    customer_number VARCHAR(50) NOT NULL,
    company_name VARCHAR(255),
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    tax_id VARCHAR(50),
    tax_id_type VARCHAR(20) CHECK (tax_id_type IN ('rfc', 'ein', 'vat')),
    email VARCHAR(255),
    phone VARCHAR(50),
    website VARCHAR(255),
    billing_address JSONB,
    shipping_address JSONB,
    payment_terms VARCHAR(100) NOT NULL DEFAULT 'Net 30',
    credit_limit DECIMAL(19,4),
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    default_revenue_account_id UUID REFERENCES accounts(id),
    default_ar_account_id UUID REFERENCES accounts(id),
    dunning_profile_id UUID,
    is_active BOOLEAN NOT NULL DEFAULT true,
    credit_status VARCHAR(50) NOT NULL DEFAULT 'approved'
        CHECK (credit_status IN ('approved', 'on_hold', 'suspended')),
    tags JSONB DEFAULT '{}',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL,
    UNIQUE(customer_number, entity_id)
);

CREATE INDEX idx_customers_entity ON customers(entity_id);
CREATE INDEX idx_customers_active ON customers(is_active);
CREATE INDEX idx_customers_name ON customers USING GIN (company_name gin_trgm_ops);

-- ============================================================
-- INVOICES (AR)
-- ============================================================

CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    invoice_number VARCHAR(50) NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id),
    subtotal DECIMAL(19,4) NOT NULL DEFAULT 0,
    tax_amount DECIMAL(19,4) NOT NULL DEFAULT 0,
    total_amount DECIMAL(19,4) NOT NULL DEFAULT 0,
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    exchange_rate DECIMAL(19,10) NOT NULL DEFAULT 1.0,
    invoice_date DATE NOT NULL,
    due_date DATE NOT NULL,
    delivery_date DATE,
    status VARCHAR(50) NOT NULL DEFAULT 'draft'
        CHECK (status IN (
            'draft', 'pending', 'sent', 'viewed',
            'paid', 'partially_paid', 'overdue',
            'void', 'cancelled', 'uncollectible'
        )),
    amount_paid DECIMAL(19,4) NOT NULL DEFAULT 0,
    amount_due DECIMAL(19,4) NOT NULL,
    last_payment_date DATE,
    -- CFDI fields (Mexico)
    cfdi_uuid VARCHAR(50),
    cfdi_xml_url TEXT,
    cfdi_status VARCHAR(50) CHECK (cfdi_status IN ('pending', 'stamped', 'cancelled', 'failed')),
    pac_provider VARCHAR(50),
    stamped_at TIMESTAMPTZ,
    sales_order_id UUID,
    journal_entry_id UUID REFERENCES journal_entries(id),
    description TEXT,
    memo TEXT,
    terms TEXT,
    po_number VARCHAR(100),
    sent_at TIMESTAMPTZ,
    sent_to VARCHAR(255),
    pdf_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL,
    UNIQUE(invoice_number, entity_id)
);

CREATE INDEX idx_invoices_entity ON invoices(entity_id);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);
CREATE INDEX idx_invoices_cfdi ON invoices(cfdi_uuid);

CREATE TABLE invoice_lines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    item_id UUID,
    description TEXT,
    quantity DECIMAL(19,4) NOT NULL DEFAULT 1,
    unit_price DECIMAL(19,4) NOT NULL,
    revenue_account_id UUID NOT NULL REFERENCES accounts(id),
    tax_code VARCHAR(50),
    tax_rate DECIMAL(5,2),
    tax_amount DECIMAL(19,4) NOT NULL DEFAULT 0,
    line_amount DECIMAL(19,4) NOT NULL,
    total_amount DECIMAL(19,4) NOT NULL,
    cost_center_id UUID,
    project_id UUID,
    cfdi_product_code VARCHAR(50),
    cfdi_unit_code VARCHAR(50),
    UNIQUE(invoice_id, line_number)
);

CREATE INDEX idx_invoice_lines_invoice ON invoice_lines(invoice_id);

-- ============================================================
-- CUSTOMER PAYMENTS (AR)
-- ============================================================

CREATE TABLE customer_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    payment_number VARCHAR(50) NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id),
    payment_amount DECIMAL(19,4) NOT NULL CHECK (payment_amount > 0),
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    exchange_rate DECIMAL(19,10) NOT NULL DEFAULT 1.0,
    payment_method VARCHAR(50) NOT NULL
        CHECK (payment_method IN (
            'cash', 'check', 'credit_card', 'debit_card',
            'ach', 'wire', 'spei', 'stripe', 'paypal', 'other'
        )),
    card_last4 VARCHAR(4),
    check_number VARCHAR(50),
    reference_number VARCHAR(100),
    bank_account_id UUID,
    payment_date DATE NOT NULL,
    deposit_date DATE,
    status VARCHAR(50) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'pending', 'processing', 'completed', 'failed', 'void')),
    journal_entry_id UUID REFERENCES journal_entries(id),
    memo TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL,
    UNIQUE(payment_number, entity_id)
);

CREATE INDEX idx_customer_payments_entity ON customer_payments(entity_id);
CREATE INDEX idx_customer_payments_customer ON customer_payments(customer_id);
CREATE INDEX idx_customer_payments_status ON customer_payments(status);

CREATE TABLE payment_allocations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_id UUID NOT NULL REFERENCES customer_payments(id),
    invoice_id UUID NOT NULL REFERENCES invoices(id),
    amount_applied DECIMAL(19,4) NOT NULL CHECK (amount_applied > 0),
    discount_amount DECIMAL(19,4) DEFAULT 0,
    discount_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_allocations_payment ON payment_allocations(payment_id);
CREATE INDEX idx_payment_allocations_invoice ON payment_allocations(invoice_id);
