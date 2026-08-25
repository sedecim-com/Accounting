# Accounting Core - Technical Specification Document
## Version 1.0 | Confidential

---

## Document Control

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-04-11 | Engineering Team | Initial comprehensive specification |

**Reviewers Required:**
- [ ] Chief Technology Officer
- [ ] VP Engineering
- [ ] Lead Accountant/CPA
- [ ] Security Officer
- [ ] Compliance Officer

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Data Models](#3-data-models)
4. [Accounting Engine](#4-accounting-engine)
5. [API Specifications](#5-api-specifications)
6. [Functional Modules](#6-functional-modules)
7. [Integrations](#7-integrations)
8. [Security & Compliance](#8-security--compliance)
9. [Performance & Scalability](#9-performance--scalability)
10. [Implementation Roadmap](#10-implementation-roadmap)

---

## 1. Executive Summary

### 1.1 Purpose

This document provides comprehensive technical specifications for building a world-class accounting core system that serves as the foundation for a multi-country (USA/Mexico), multi-GAAP financial platform.

### 1.2 Core Objectives

- **Universal Accounting Model**: Support US GAAP, Mexican NIF, and future IFRS
- **API-First Design**: Every function accessible via REST and GraphQL APIs
- **Multi-Tenancy**: Isolated data per organization with entity hierarchy support
- **Real-Time Processing**: Immediate posting and reconciliation capabilities
- **Audit Compliance**: Complete immutable audit trails for all transactions
- **Extensibility**: Plugin architecture for third-party integrations

### 1.3 System Scope

**In Scope:**
- Double-entry accounting engine
- Chart of accounts management
- Journal entry processing
- Multi-entity consolidation
- Multi-currency support
- AP/AR automation
- Bank reconciliation
- Fixed assets & depreciation
- Inventory accounting
- Financial reporting
- Period close automation
- Tax compliance (Mexico SAT, US IRS)
- RESTful and GraphQL APIs
- Webhook system

**Out of Scope (Future Phases):**
- Payroll processing (separate module)
- CRM functionality
- Project management
- Manufacturing/MRP
- Point of Sale

### 1.4 Technology Stack

```
Frontend Layer:
├─ Next.js 14+ (React 18+)
├─ TypeScript 5+
├─ Tailwind CSS
└─ shadcn/ui components

Backend Layer:
├─ Node.js 20+ LTS
├─ Express.js / Fastify
├─ TypeScript 5+
└─ GraphQL (Apollo Server)

Data Layer:
├─ PostgreSQL 15+ (primary OLTP)
├─ TimescaleDB (time-series financial data)
├─ Redis 7+ (caching, queues)
└─ Elasticsearch 8+ (full-text search, analytics)

Message Queue:
├─ BullMQ (Redis-based)
└─ Future: Apache Kafka (event streaming)

Object Storage:
└─ AWS S3 / Google Cloud Storage (documents, XMLs)

Infrastructure:
├─ Docker + Kubernetes
├─ AWS / GCP (cloud provider)
├─ Terraform (IaC)
└─ GitHub Actions (CI/CD)

Monitoring:
├─ Datadog / New Relic
├─ Sentry (error tracking)
└─ Prometheus + Grafana (metrics)
```

---

## 2. System Architecture

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Client Applications                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   Web    │  │  Mobile  │  │   API    │  │ Partners │   │
│  │   App    │  │   App    │  │ Clients  │  │   Apps   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    API Gateway Layer                         │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Kong / AWS API Gateway / Custom Gateway             │  │
│  │  - Authentication / Authorization                     │  │
│  │  - Rate Limiting                                      │  │
│  │  - Request Routing                                    │  │
│  │  - Response Caching                                   │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                   Application Services                       │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Accounting │  │   Treasury   │  │   Reporting  │     │
│  │    Service   │  │   Service    │  │   Service    │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                  │                  │              │
│  ┌──────▼───────┐  ┌──────▼───────┐  ┌──────▼───────┐     │
│  │      AP      │  │  Banking     │  │  Integration │     │
│  │    Service   │  │  Service     │  │   Service    │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                  │                  │              │
│  ┌──────▼───────┐  ┌──────▼───────┐  ┌──────▼───────┐     │
│  │      AR      │  │   Assets     │  │   Webhook    │     │
│  │    Service   │  │   Service    │  │   Service    │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│                                                              │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    Data Access Layer                         │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  ORM / Query Builder (Prisma / TypeORM / Kysely)     │  │
│  │  - Connection Pooling                                 │  │
│  │  - Transaction Management                             │  │
│  │  - Query Optimization                                 │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                      Data Layer                              │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  PostgreSQL  │  │  TimescaleDB │  │    Redis     │     │
│  │   (OLTP)     │  │(Time-Series) │  │   (Cache)    │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │Elasticsearch │  │   AWS S3     │  │   BullMQ     │     │
│  │  (Search)    │  │ (Documents)  │  │  (Queues)    │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Multi-Tenancy Architecture

**Strategy: Schema-per-Tenant (PostgreSQL Schemas)**

```sql
-- Each tenant gets isolated schema
CREATE SCHEMA tenant_abc123;
CREATE SCHEMA tenant_xyz789;

-- Shared tables in public schema
CREATE TABLE public.tenants (
    id UUID PRIMARY KEY,
    name VARCHAR(255),
    schema_name VARCHAR(63) UNIQUE,
    status VARCHAR(50),
    created_at TIMESTAMPTZ
);

-- Tenant-specific tables in isolated schemas
CREATE TABLE tenant_abc123.accounts (
    id UUID PRIMARY KEY,
    code VARCHAR(50),
    name VARCHAR(255),
    ...
);
```

**Tenant Resolution Flow:**

```typescript
// Middleware extracts tenant from JWT/subdomain
app.use(async (req, res, next) => {
  const tenantId = extractTenantId(req);
  const tenant = await getTenant(tenantId);
  
  // Set schema for this request
  await setSearchPath(tenant.schema_name);
  req.tenant = tenant;
  next();
});

// All queries automatically scoped to tenant schema
const accounts = await db.query('SELECT * FROM accounts');
// Executes: SELECT * FROM tenant_abc123.accounts
```

**Benefits:**
- Strong data isolation (schema-level)
- Efficient for medium scale (up to 5,000 tenants per cluster)
- Easy backup/restore per tenant
- Good query performance (indexes not shared)

**Limitations:**
- Connection pool overhead
- Schema proliferation
- Migration complexity

**Migration Path:**
- 0-1,000 tenants: Schema-per-tenant
- 1,000-10,000 tenants: Cluster sharding (tenant ranges)
- 10,000+ tenants: Database-per-cluster with distributed routing

### 2.3 Entity Hierarchy Model

```typescript
interface Organization {
  id: string;
  name: string;
  type: 'holding' | 'operating';
  parent_id?: string; // null for top-level
  legal_entity_id?: string;
  functional_currency: string;
  tax_id: string;
  country_code: string;
}

interface LegalEntity {
  id: string;
  organization_id: string;
  legal_name: string;
  entity_type: 'corporation' | 'llc' | 'partnership' | 'sapi' | 'sa';
  tax_id: string;
  incorporation_country: string;
  accounting_standard: 'us_gaap' | 'mx_nif' | 'ifrs';
}

// Example hierarchy
const hierarchy = {
  organization: {
    id: 'org_123',
    name: 'Acme Holdings',
    entities: [
      {
        id: 'entity_us',
        name: 'Acme LLC',
        country: 'US',
        standard: 'us_gaap',
        cost_centers: ['sales', 'marketing', 'eng']
      },
      {
        id: 'entity_mx',
        name: 'Acme SAPI',
        country: 'MX',
        standard: 'mx_nif',
        cost_centers: ['operations', 'admin']
      }
    ]
  }
};
```

---

## 3. Data Models

### 3.1 Core Accounting Tables

#### 3.1.1 Chart of Accounts

```sql
CREATE TABLE accounts (
    -- Identity
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    
    -- Hierarchy
    parent_id UUID REFERENCES accounts(id),
    account_level INTEGER NOT NULL DEFAULT 1,
    full_code VARCHAR(255), -- Computed: parent_code.code
    
    -- Classification
    account_type VARCHAR(50) NOT NULL CHECK (account_type IN (
        'asset', 'liability', 'equity', 'revenue', 'expense', 
        'contra_asset', 'contra_liability', 'contra_equity'
    )),
    account_subtype VARCHAR(100), -- current_asset, fixed_asset, etc.
    
    -- Financial Statement Category
    fs_category VARCHAR(100) CHECK (fs_category IN (
        'current_assets', 'non_current_assets',
        'current_liabilities', 'long_term_liabilities',
        'equity', 'revenue', 'cogs', 'operating_expenses',
        'other_income', 'other_expenses', 'tax'
    )),
    
    -- Properties
    is_control_account BOOLEAN DEFAULT false,
    is_system_account BOOLEAN DEFAULT false,
    allow_manual_entries BOOLEAN DEFAULT true,
    require_subsidiary BOOLEAN DEFAULT false, -- Must use sub-accounts
    
    -- Multi-Entity
    entity_id UUID REFERENCES entities(id),
    
    -- Multi-Currency
    currency_code CHAR(3), -- null = functional currency
    
    -- Tax
    tax_line_id UUID, -- Mapping to tax forms
    
    -- Accounting Standards
    us_gaap_code VARCHAR(50),
    mx_nif_code VARCHAR(50),
    ifrs_code VARCHAR(50),
    
    -- Normal Balance
    normal_balance VARCHAR(10) CHECK (normal_balance IN ('debit', 'credit')),
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    is_header BOOLEAN DEFAULT false, -- Cannot post to headers
    
    -- Metadata
    description TEXT,
    tags JSONB, -- Flexible categorization
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    
    -- Constraints
    UNIQUE(code, entity_id),
    CHECK (is_header = false OR allow_manual_entries = false)
);

-- Indexes
CREATE INDEX idx_accounts_code ON accounts(code);
CREATE INDEX idx_accounts_parent ON accounts(parent_id);
CREATE INDEX idx_accounts_type ON accounts(account_type);
CREATE INDEX idx_accounts_entity ON accounts(entity_id);
CREATE INDEX idx_accounts_active ON accounts(is_active) WHERE is_active = true;
CREATE INDEX idx_accounts_tags ON accounts USING GIN(tags);

-- Computed column for full code path
CREATE OR REPLACE FUNCTION compute_account_full_code()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.parent_id IS NULL THEN
        NEW.full_code := NEW.code;
    ELSE
        SELECT full_code || '.' || NEW.code INTO NEW.full_code
        FROM accounts WHERE id = NEW.parent_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_account_full_code
BEFORE INSERT OR UPDATE ON accounts
FOR EACH ROW EXECUTE FUNCTION compute_account_full_code();
```

**Example Chart of Accounts:**

```sql
-- Assets
INSERT INTO accounts (code, name, account_type, fs_category, normal_balance, is_header) VALUES
('1000', 'Assets', 'asset', 'current_assets', 'debit', true),
('1100', 'Current Assets', 'asset', 'current_assets', 'debit', true),
('1110', 'Cash and Cash Equivalents', 'asset', 'current_assets', 'debit', true),
('1111', 'Checking Account - Chase', 'asset', 'current_assets', 'debit', false),
('1112', 'Savings Account', 'asset', 'current_assets', 'debit', false),
('1120', 'Accounts Receivable', 'asset', 'current_assets', 'debit', false),
('1130', 'Inventory', 'asset', 'current_assets', 'debit', false),

-- Liabilities
('2000', 'Liabilities', 'liability', 'current_liabilities', 'credit', true),
('2100', 'Current Liabilities', 'liability', 'current_liabilities', 'credit', true),
('2110', 'Accounts Payable', 'liability', 'current_liabilities', 'credit', false),
('2120', 'Accrued Expenses', 'liability', 'current_liabilities', 'credit', false),

-- Equity
('3000', 'Equity', 'equity', 'equity', 'credit', true),
('3100', 'Capital Stock', 'equity', 'equity', 'credit', false),
('3200', 'Retained Earnings', 'equity', 'equity', 'credit', false),

-- Revenue
('4000', 'Revenue', 'revenue', 'revenue', 'credit', true),
('4100', 'Sales Revenue', 'revenue', 'revenue', 'credit', false),
('4200', 'Service Revenue', 'revenue', 'revenue', 'credit', false),

-- Expenses
('5000', 'Cost of Goods Sold', 'expense', 'cogs', 'debit', true),
('5100', 'Direct Materials', 'expense', 'cogs', 'debit', false),
('6000', 'Operating Expenses', 'expense', 'operating_expenses', 'debit', true),
('6100', 'Salaries and Wages', 'expense', 'operating_expenses', 'debit', false),
('6200', 'Rent Expense', 'expense', 'operating_expenses', 'debit', false);
```

#### 3.1.2 Journal Entries

```sql
CREATE TABLE journal_entries (
    -- Identity
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_number VARCHAR(50) UNIQUE, -- Auto-generated: JE-2024-00001
    
    -- Classification
    entry_type VARCHAR(50) NOT NULL CHECK (entry_type IN (
        'standard', 'adjusting', 'closing', 'reversing', 'correction',
        'auto_invoice', 'auto_payment', 'auto_depreciation', 'auto_reconciliation'
    )),
    
    -- Relationships
    entity_id UUID NOT NULL REFERENCES entities(id),
    fiscal_period_id UUID NOT NULL REFERENCES fiscal_periods(id),
    
    -- Source Document
    source_type VARCHAR(50), -- invoice, bill, payment, manual
    source_id UUID, -- ID of source document
    reference VARCHAR(255), -- External reference number
    
    -- Dates
    entry_date DATE NOT NULL,
    posted_date TIMESTAMPTZ,
    
    -- Status
    status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft', 'pending_approval', 'approved', 'posted', 'void'
    )),
    
    -- Reversal
    is_reversal BOOLEAN DEFAULT false,
    reverses_entry_id UUID REFERENCES journal_entries(id),
    reversed_by_entry_id UUID REFERENCES journal_entries(id),
    
    -- Metadata
    description TEXT,
    notes TEXT,
    attachments JSONB, -- Array of S3 URLs
    
    -- Totals (computed from lines)
    total_debits DECIMAL(19,4),
    total_credits DECIMAL(19,4),
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    posted_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    
    -- Constraints
    CHECK (status != 'posted' OR (total_debits = total_credits AND total_debits > 0)),
    CHECK (status != 'posted' OR posted_date IS NOT NULL)
);

CREATE TABLE journal_entry_lines (
    -- Identity
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    
    -- Account
    account_id UUID NOT NULL REFERENCES accounts(id),
    
    -- Amount
    debit_amount DECIMAL(19,4),
    credit_amount DECIMAL(19,4),
    
    -- Dimensions (for reporting)
    cost_center_id UUID REFERENCES cost_centers(id),
    department_id UUID REFERENCES departments(id),
    project_id UUID REFERENCES projects(id),
    class_id UUID REFERENCES classes(id),
    
    -- Multi-Currency
    currency_code CHAR(3), -- null = functional currency
    foreign_debit DECIMAL(19,4),
    foreign_credit DECIMAL(19,4),
    exchange_rate DECIMAL(19,10),
    
    -- Reconciliation
    is_reconciled BOOLEAN DEFAULT false,
    reconciled_at TIMESTAMPTZ,
    reconciliation_id UUID,
    
    -- Metadata
    description TEXT,
    tags JSONB,
    
    -- Constraints
    UNIQUE(journal_entry_id, line_number),
    CHECK ((debit_amount IS NULL) != (credit_amount IS NULL)), -- XOR: exactly one must be set
    CHECK (debit_amount > 0 OR credit_amount > 0),
    CHECK (
        (currency_code IS NULL AND foreign_debit IS NULL AND foreign_credit IS NULL) OR
        (currency_code IS NOT NULL AND exchange_rate IS NOT NULL)
    )
);

-- Indexes
CREATE INDEX idx_je_entity ON journal_entries(entity_id);
CREATE INDEX idx_je_period ON journal_entries(fiscal_period_id);
CREATE INDEX idx_je_status ON journal_entries(status);
CREATE INDEX idx_je_date ON journal_entries(entry_date);
CREATE INDEX idx_je_source ON journal_entries(source_type, source_id);

CREATE INDEX idx_jel_entry ON journal_entry_lines(journal_entry_id);
CREATE INDEX idx_jel_account ON journal_entry_lines(account_id);
CREATE INDEX idx_jel_reconciled ON journal_entry_lines(is_reconciled) WHERE is_reconciled = false;

-- Trigger to update totals on journal_entries
CREATE OR REPLACE FUNCTION update_journal_entry_totals()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE journal_entries SET
        total_debits = (
            SELECT COALESCE(SUM(debit_amount), 0)
            FROM journal_entry_lines
            WHERE journal_entry_id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id)
        ),
        total_credits = (
            SELECT COALESCE(SUM(credit_amount), 0)
            FROM journal_entry_lines
            WHERE journal_entry_id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id)
        )
    WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_je_totals
AFTER INSERT OR UPDATE OR DELETE ON journal_entry_lines
FOR EACH ROW EXECUTE FUNCTION update_journal_entry_totals();
```

#### 3.1.3 Transactions (Higher-Level Abstraction)

```sql
-- Transactions are business events that generate journal entries
CREATE TABLE transactions (
    -- Identity
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_number VARCHAR(50) UNIQUE,
    
    -- Type
    transaction_type VARCHAR(50) NOT NULL CHECK (transaction_type IN (
        'invoice', 'bill', 'payment_received', 'payment_made',
        'expense', 'deposit', 'transfer', 'adjustment'
    )),
    
    -- Relationships
    entity_id UUID NOT NULL REFERENCES entities(id),
    customer_id UUID REFERENCES customers(id),
    vendor_id UUID REFERENCES vendors(id),
    
    -- Amounts
    amount DECIMAL(19,4) NOT NULL,
    currency_code CHAR(3) NOT NULL,
    exchange_rate DECIMAL(19,10),
    functional_amount DECIMAL(19,4), -- Amount in functional currency
    
    -- Dates
    transaction_date DATE NOT NULL,
    due_date DATE,
    
    -- Status
    status VARCHAR(50) NOT NULL CHECK (status IN (
        'draft', 'pending', 'approved', 'posted', 'paid', 'partially_paid', 
        'void', 'cancelled'
    )),
    
    -- Payment Tracking
    amount_paid DECIMAL(19,4) DEFAULT 0,
    amount_due DECIMAL(19,4),
    
    -- Journal Entry Link
    journal_entry_id UUID REFERENCES journal_entries(id),
    
    -- Metadata
    description TEXT,
    memo TEXT,
    reference VARCHAR(255),
    terms VARCHAR(100), -- Payment terms: "Net 30"
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

-- Indexes
CREATE INDEX idx_txn_entity ON transactions(entity_id);
CREATE INDEX idx_txn_customer ON transactions(customer_id);
CREATE INDEX idx_txn_vendor ON transactions(vendor_id);
CREATE INDEX idx_txn_type ON transactions(transaction_type);
CREATE INDEX idx_txn_status ON transactions(status);
CREATE INDEX idx_txn_date ON transactions(transaction_date);
```

#### 3.1.4 Fiscal Periods

```sql
CREATE TABLE fiscal_years (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id),
    year_number INTEGER NOT NULL, -- 2024
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_calendar_year BOOLEAN DEFAULT true,
    status VARCHAR(50) DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    
    UNIQUE(entity_id, year_number),
    CHECK (end_date > start_date)
);

CREATE TABLE fiscal_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fiscal_year_id UUID NOT NULL REFERENCES fiscal_years(id),
    entity_id UUID NOT NULL REFERENCES entities(id),
    
    -- Period Definition
    period_number INTEGER NOT NULL, -- 1-12 (or 13 for year-end)
    period_name VARCHAR(50) NOT NULL, -- "January 2024", "Q1 2024", "Period 13 (Adjustments)"
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    
    -- Type
    period_type VARCHAR(50) DEFAULT 'regular' CHECK (period_type IN (
        'regular', 'adjustment', 'closing'
    )),
    
    -- Status
    status VARCHAR(50) DEFAULT 'open' CHECK (status IN (
        'future', 'open', 'soft_close', 'hard_close', 'locked'
    )),
    
    -- Close Process
    soft_close_date TIMESTAMPTZ,
    hard_close_date TIMESTAMPTZ,
    closed_by UUID REFERENCES users(id),
    
    -- Checklist
    close_checklist JSONB, -- Tasks required before close
    
    UNIQUE(fiscal_year_id, period_number),
    CHECK (end_date > start_date)
);

-- Indexes
CREATE INDEX idx_fy_entity ON fiscal_years(entity_id);
CREATE INDEX idx_fp_year ON fiscal_periods(fiscal_year_id);
CREATE INDEX idx_fp_entity ON fiscal_periods(entity_id);
CREATE INDEX idx_fp_status ON fiscal_periods(status);
CREATE INDEX idx_fp_dates ON fiscal_periods(start_date, end_date);
```

#### 3.1.5 Exchange Rates

```sql
CREATE TABLE exchange_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Currency Pair
    from_currency CHAR(3) NOT NULL,
    to_currency CHAR(3) NOT NULL,
    
    -- Rate
    rate DECIMAL(19,10) NOT NULL, -- 1 from_currency = X to_currency
    inverse_rate DECIMAL(19,10), -- Computed: 1/rate
    
    -- Effective Date
    effective_date DATE NOT NULL,
    effective_until DATE, -- null = current
    
    -- Source
    source VARCHAR(100) NOT NULL CHECK (source IN (
        'manual', 'banco_mexico', 'ecb', 'fed', 'xe', 'openexchangerates'
    )),
    source_metadata JSONB,
    
    -- Type
    rate_type VARCHAR(50) DEFAULT 'spot' CHECK (rate_type IN (
        'spot', 'average', 'budget', 'historical'
    )),
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    
    UNIQUE(from_currency, to_currency, effective_date, rate_type)
);

CREATE INDEX idx_exrate_pair ON exchange_rates(from_currency, to_currency);
CREATE INDEX idx_exrate_date ON exchange_rates(effective_date);
CREATE INDEX idx_exrate_current ON exchange_rates(effective_until) WHERE effective_until IS NULL;

-- Function to get exchange rate for a specific date
CREATE OR REPLACE FUNCTION get_exchange_rate(
    p_from_currency CHAR(3),
    p_to_currency CHAR(3),
    p_date DATE,
    p_rate_type VARCHAR(50) DEFAULT 'spot'
) RETURNS DECIMAL(19,10) AS $$
DECLARE
    v_rate DECIMAL(19,10);
BEGIN
    -- Same currency
    IF p_from_currency = p_to_currency THEN
        RETURN 1.0;
    END IF;
    
    -- Direct rate
    SELECT rate INTO v_rate
    FROM exchange_rates
    WHERE from_currency = p_from_currency
      AND to_currency = p_to_currency
      AND effective_date <= p_date
      AND rate_type = p_rate_type
      AND (effective_until IS NULL OR effective_until >= p_date)
    ORDER BY effective_date DESC
    LIMIT 1;
    
    IF v_rate IS NOT NULL THEN
        RETURN v_rate;
    END IF;
    
    -- Inverse rate
    SELECT 1.0 / rate INTO v_rate
    FROM exchange_rates
    WHERE from_currency = p_to_currency
      AND to_currency = p_from_currency
      AND effective_date <= p_date
      AND rate_type = p_rate_type
      AND (effective_until IS NULL OR effective_until >= p_date)
    ORDER BY effective_date DESC
    LIMIT 1;
    
    IF v_rate IS NOT NULL THEN
        RETURN v_rate;
    END IF;
    
    -- Cross rate via USD (if needed)
    -- Not implemented here for brevity
    
    RAISE EXCEPTION 'Exchange rate not found for % to % on %', 
        p_from_currency, p_to_currency, p_date;
END;
$$ LANGUAGE plpgsql STABLE;
```

### 3.2 Accounts Payable (AP) Schema

```sql
CREATE TABLE vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id),
    
    -- Identification
    vendor_number VARCHAR(50) UNIQUE,
    company_name VARCHAR(255) NOT NULL,
    contact_name VARCHAR(255),
    
    -- Tax
    tax_id VARCHAR(50), -- RFC in Mexico, EIN in USA
    tax_id_type VARCHAR(20), -- 'rfc', 'ein', 'vat'
    is_1099_vendor BOOLEAN DEFAULT false, -- USA 1099 reporting
    
    -- Contact
    email VARCHAR(255),
    phone VARCHAR(50),
    website VARCHAR(255),
    
    -- Address
    billing_address JSONB,
    shipping_address JSONB,
    
    -- Terms
    payment_terms VARCHAR(100) DEFAULT 'Net 30',
    default_expense_account_id UUID REFERENCES accounts(id),
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    
    -- Banking (encrypted)
    bank_account_number_encrypted TEXT,
    bank_routing_number_encrypted TEXT,
    bank_name VARCHAR(255),
    clabe_encrypted TEXT, -- Mexico interbank key
    
    -- Settings
    auto_pay_enabled BOOLEAN DEFAULT false,
    credit_limit DECIMAL(19,4),
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    
    -- Metadata
    tags JSONB,
    notes TEXT,
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE bills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id),
    
    -- Identification
    bill_number VARCHAR(50) UNIQUE,
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    vendor_invoice_number VARCHAR(100), -- Vendor's own invoice #
    
    -- Amounts
    subtotal DECIMAL(19,4) NOT NULL,
    tax_amount DECIMAL(19,4) DEFAULT 0,
    total_amount DECIMAL(19,4) NOT NULL,
    currency_code CHAR(3) NOT NULL,
    exchange_rate DECIMAL(19,10),
    
    -- Dates
    bill_date DATE NOT NULL,
    due_date DATE NOT NULL,
    received_date DATE,
    
    -- Status
    status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft', 'pending_approval', 'approved', 'posted', 
        'paid', 'partially_paid', 'void', 'cancelled'
    )),
    
    -- Payment
    amount_paid DECIMAL(19,4) DEFAULT 0,
    amount_due DECIMAL(19,4),
    last_payment_date DATE,
    
    -- Approval
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    
    -- Relationships
    purchase_order_id UUID, -- Link to PO if exists
    journal_entry_id UUID REFERENCES journal_entries(id),
    
    -- Metadata
    description TEXT,
    memo TEXT,
    terms VARCHAR(100),
    
    -- Attachments
    attachments JSONB, -- S3 URLs for scanned invoices
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

CREATE TABLE bill_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    
    -- Account
    account_id UUID NOT NULL REFERENCES accounts(id),
    
    -- Item (optional)
    item_id UUID REFERENCES items(id),
    description TEXT NOT NULL,
    quantity DECIMAL(19,4) DEFAULT 1,
    unit_price DECIMAL(19,4) NOT NULL,
    
    -- Amount
    line_amount DECIMAL(19,4) NOT NULL,
    tax_amount DECIMAL(19,4) DEFAULT 0,
    total_amount DECIMAL(19,4) NOT NULL,
    
    -- Dimensions
    cost_center_id UUID REFERENCES cost_centers(id),
    project_id UUID REFERENCES projects(id),
    
    -- Metadata
    tags JSONB,
    
    UNIQUE(bill_id, line_number)
);

CREATE TABLE vendor_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id),
    
    -- Identification
    payment_number VARCHAR(50) UNIQUE,
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    
    -- Amount
    payment_amount DECIMAL(19,4) NOT NULL,
    currency_code CHAR(3) NOT NULL,
    
    -- Payment Method
    payment_method VARCHAR(50) NOT NULL CHECK (payment_method IN (
        'check', 'ach', 'wire', 'spei', 'cash', 'credit_card', 'other'
    )),
    check_number VARCHAR(50),
    reference_number VARCHAR(100),
    
    -- Bank Account
    bank_account_id UUID REFERENCES bank_accounts(id),
    
    -- Date
    payment_date DATE NOT NULL,
    
    -- Status
    status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft', 'pending', 'processing', 'completed', 'failed', 'void'
    )),
    
    -- Relationships
    journal_entry_id UUID REFERENCES journal_entries(id),
    
    -- Metadata
    memo TEXT,
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

CREATE TABLE payment_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES vendor_payments(id),
    bill_id UUID NOT NULL REFERENCES bills(id),
    
    -- Amount applied to this specific bill
    amount_applied DECIMAL(19,4) NOT NULL,
    
    -- Discount
    discount_amount DECIMAL(19,4) DEFAULT 0,
    discount_reason TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_vendors_entity ON vendors(entity_id);
CREATE INDEX idx_vendors_active ON vendors(is_active) WHERE is_active = true;

CREATE INDEX idx_bills_entity ON bills(entity_id);
CREATE INDEX idx_bills_vendor ON bills(vendor_id);
CREATE INDEX idx_bills_status ON bills(status);
CREATE INDEX idx_bills_due_date ON bills(due_date);
CREATE INDEX idx_bills_unpaid ON bills(status) WHERE status IN ('approved', 'posted', 'partially_paid');

CREATE INDEX idx_bill_lines_bill ON bill_lines(bill_id);
CREATE INDEX idx_bill_lines_account ON bill_lines(account_id);

CREATE INDEX idx_vendor_payments_entity ON vendor_payments(entity_id);
CREATE INDEX idx_vendor_payments_vendor ON vendor_payments(vendor_id);
CREATE INDEX idx_vendor_payments_date ON vendor_payments(payment_date);

CREATE INDEX idx_payment_apps_payment ON payment_applications(payment_id);
CREATE INDEX idx_payment_apps_bill ON payment_applications(bill_id);
```

### 3.3 Accounts Receivable (AR) Schema

```sql
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id),
    
    -- Identification
    customer_number VARCHAR(50) UNIQUE,
    company_name VARCHAR(255),
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    
    -- Tax
    tax_id VARCHAR(50),
    tax_id_type VARCHAR(20),
    
    -- Contact
    email VARCHAR(255),
    phone VARCHAR(50),
    website VARCHAR(255),
    
    -- Address
    billing_address JSONB,
    shipping_address JSONB,
    
    -- Terms
    payment_terms VARCHAR(100) DEFAULT 'Net 30',
    credit_limit DECIMAL(19,4),
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    
    -- AR Settings
    default_revenue_account_id UUID REFERENCES accounts(id),
    default_ar_account_id UUID REFERENCES accounts(id),
    
    -- Collections
    dunning_profile_id UUID, -- How aggressively to collect
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    credit_status VARCHAR(50) DEFAULT 'approved' CHECK (credit_status IN (
        'approved', 'on_hold', 'suspended'
    )),
    
    -- Metadata
    tags JSONB,
    notes TEXT,
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id),
    
    -- Identification
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id),
    
    -- Amounts
    subtotal DECIMAL(19,4) NOT NULL,
    tax_amount DECIMAL(19,4) DEFAULT 0,
    total_amount DECIMAL(19,4) NOT NULL,
    currency_code CHAR(3) NOT NULL,
    exchange_rate DECIMAL(19,10),
    
    -- Dates
    invoice_date DATE NOT NULL,
    due_date DATE NOT NULL,
    delivery_date DATE,
    
    -- Status
    status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft', 'pending', 'sent', 'viewed', 'paid', 'partially_paid',
        'overdue', 'void', 'cancelled', 'uncollectible'
    )),
    
    -- Payment
    amount_paid DECIMAL(19,4) DEFAULT 0,
    amount_due DECIMAL(19,4),
    last_payment_date DATE,
    
    -- Tax Compliance (Mexico CFDI)
    cfdi_uuid VARCHAR(50) UNIQUE, -- SAT UUID after timbrado
    cfdi_xml_url TEXT, -- S3 URL
    cfdi_status VARCHAR(50) CHECK (cfdi_status IN (
        'pending', 'stamped', 'cancelled', 'failed'
    )),
    pac_provider VARCHAR(50), -- finkok, dicom, etc.
    stamped_at TIMESTAMPTZ,
    
    -- Relationships
    sales_order_id UUID,
    journal_entry_id UUID REFERENCES journal_entries(id),
    
    -- Metadata
    description TEXT,
    memo TEXT,
    terms VARCHAR(100),
    po_number VARCHAR(100), -- Customer's PO number
    
    -- Delivery
    sent_at TIMESTAMPTZ,
    sent_to VARCHAR(255),
    
    -- Attachments
    pdf_url TEXT,
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

CREATE TABLE invoice_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    
    -- Item
    item_id UUID REFERENCES items(id),
    description TEXT NOT NULL,
    quantity DECIMAL(19,4) DEFAULT 1,
    unit_price DECIMAL(19,4) NOT NULL,
    
    -- Account
    revenue_account_id UUID NOT NULL REFERENCES accounts(id),
    
    -- Tax
    tax_code VARCHAR(50),
    tax_rate DECIMAL(5,4),
    tax_amount DECIMAL(19,4) DEFAULT 0,
    
    -- Amount
    line_amount DECIMAL(19,4) NOT NULL,
    total_amount DECIMAL(19,4) NOT NULL,
    
    -- Dimensions
    cost_center_id UUID REFERENCES cost_centers(id),
    project_id UUID REFERENCES projects(id),
    
    -- CFDI (Mexico specific)
    cfdi_product_code VARCHAR(50), -- SAT product/service code
    cfdi_unit_code VARCHAR(50), -- SAT unit of measure code
    
    UNIQUE(invoice_id, line_number)
);

CREATE TABLE customer_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id),
    
    -- Identification
    payment_number VARCHAR(50) UNIQUE,
    customer_id UUID NOT NULL REFERENCES customers(id),
    
    -- Amount
    payment_amount DECIMAL(19,4) NOT NULL,
    currency_code CHAR(3) NOT NULL,
    exchange_rate DECIMAL(19,10),
    
    -- Payment Method
    payment_method VARCHAR(50) NOT NULL CHECK (payment_method IN (
        'cash', 'check', 'credit_card', 'debit_card', 'ach', 'wire',
        'stripe', 'paypal', 'other'
    )),
    reference_number VARCHAR(100),
    
    -- Card/Check Details
    card_last4 VARCHAR(4),
    check_number VARCHAR(50),
    
    -- Bank Account (deposit to)
    bank_account_id UUID REFERENCES bank_accounts(id),
    
    -- Date
    payment_date DATE NOT NULL,
    deposit_date DATE,
    
    -- Status
    status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft', 'pending', 'cleared', 'void', 'failed'
    )),
    
    -- Unapplied amount (if payment > invoices)
    unapplied_amount DECIMAL(19,4) DEFAULT 0,
    
    -- Relationships
    journal_entry_id UUID REFERENCES journal_entries(id),
    
    -- Metadata
    memo TEXT,
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

CREATE TABLE payment_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES customer_payments(id),
    invoice_id UUID NOT NULL REFERENCES invoices(id),
    
    -- Amount applied to this invoice
    amount_applied DECIMAL(19,4) NOT NULL,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_customers_entity ON customers(entity_id);
CREATE INDEX idx_customers_active ON customers(is_active) WHERE is_active = true;

CREATE INDEX idx_invoices_entity ON invoices(entity_id);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);
CREATE INDEX idx_invoices_unpaid ON invoices(status) WHERE status IN ('sent', 'viewed', 'partially_paid', 'overdue');
CREATE INDEX idx_invoices_cfdi ON invoices(cfdi_uuid) WHERE cfdi_uuid IS NOT NULL;

CREATE INDEX idx_invoice_lines_invoice ON invoice_lines(invoice_id);
CREATE INDEX idx_invoice_lines_account ON invoice_lines(revenue_account_id);

CREATE INDEX idx_customer_payments_entity ON customer_payments(entity_id);
CREATE INDEX idx_customer_payments_customer ON customer_payments(customer_id);
CREATE INDEX idx_customer_payments_date ON customer_payments(payment_date);

CREATE INDEX idx_payment_allocs_payment ON payment_allocations(payment_id);
CREATE INDEX idx_payment_allocs_invoice ON payment_allocations(invoice_id);
```

### 3.4 Bank Reconciliation Schema

```sql
CREATE TABLE bank_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id),
    
    -- Identification
    account_name VARCHAR(255) NOT NULL,
    account_number_encrypted TEXT NOT NULL,
    account_number_last4 VARCHAR(4),
    routing_number_encrypted TEXT,
    
    -- Bank
    bank_name VARCHAR(255),
    bank_branch VARCHAR(255),
    swift_code VARCHAR(20),
    iban VARCHAR(50),
    clabe VARCHAR(18), -- Mexico
    
    -- GL Account Link
    gl_account_id UUID NOT NULL REFERENCES accounts(id),
    
    -- Currency
    currency_code CHAR(3) NOT NULL,
    
    -- Integration
    plaid_account_id VARCHAR(255),
    fintoc_account_id VARCHAR(255),
    belvo_account_id VARCHAR(255),
    
    -- Settings
    auto_import_enabled BOOLEAN DEFAULT false,
    import_frequency VARCHAR(50), -- 'hourly', 'daily', 'weekly'
    
    -- Balance Tracking
    current_balance DECIMAL(19,4),
    available_balance DECIMAL(19,4),
    last_synced_at TIMESTAMPTZ,
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    
    -- Metadata
    notes TEXT,
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE bank_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
    
    -- Bank Data
    bank_transaction_id VARCHAR(255), -- Bank's own ID
    transaction_date DATE NOT NULL,
    posted_date DATE,
    
    -- Amount
    amount DECIMAL(19,4) NOT NULL,
    transaction_type VARCHAR(50) CHECK (transaction_type IN (
        'debit', 'credit', 'fee', 'interest', 'adjustment'
    )),
    
    -- Description
    description TEXT,
    merchant_name VARCHAR(255),
    category VARCHAR(100), -- Bank's category
    
    -- Metadata from bank
    raw_data JSONB, -- Original transaction data
    
    -- Reconciliation
    is_matched BOOLEAN DEFAULT false,
    matched_at TIMESTAMPTZ,
    matched_by UUID REFERENCES users(id),
    confidence_score DECIMAL(3,2), -- ML matching confidence 0.00-1.00
    
    -- Import
    imported_at TIMESTAMPTZ DEFAULT NOW(),
    import_batch_id UUID,
    
    UNIQUE(bank_account_id, bank_transaction_id)
);

CREATE TABLE reconciliation_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_transaction_id UUID REFERENCES bank_transactions(id),
    
    -- Can match to multiple types
    journal_entry_line_id UUID REFERENCES journal_entry_lines(id),
    invoice_id UUID REFERENCES invoices(id),
    bill_id UUID REFERENCES bills(id),
    payment_id UUID, -- customer_payments or vendor_payments
    
    -- Match metadata
    match_type VARCHAR(50) CHECK (match_type IN (
        'automatic', 'manual', 'suggested'
    )),
    match_confidence DECIMAL(3,2),
    
    -- Amount (if partial match)
    matched_amount DECIMAL(19,4),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    
    -- At least one foreign key must be set
    CHECK (
        journal_entry_line_id IS NOT NULL OR
        invoice_id IS NOT NULL OR
        bill_id IS NOT NULL OR
        payment_id IS NOT NULL
    )
);

CREATE TABLE reconciliation_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
    
    -- Period
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    
    -- Balances
    beginning_balance DECIMAL(19,4),
    ending_balance_per_bank DECIMAL(19,4),
    ending_balance_per_books DECIMAL(19,4),
    
    -- Reconciling Items
    outstanding_checks DECIMAL(19,4) DEFAULT 0,
    deposits_in_transit DECIMAL(19,4) DEFAULT 0,
    bank_charges DECIMAL(19,4) DEFAULT 0,
    bank_interest DECIMAL(19,4) DEFAULT 0,
    other_adjustments DECIMAL(19,4) DEFAULT 0,
    
    -- Status
    status VARCHAR(50) DEFAULT 'in_progress' CHECK (status IN (
        'in_progress', 'balanced', 'approved', 'posted'
    )),
    
    -- Variance
    variance DECIMAL(19,4), -- Should be 0 when balanced
    
    -- Metadata
    notes TEXT,
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    completed_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id)
);

-- Indexes
CREATE INDEX idx_bank_accounts_entity ON bank_accounts(entity_id);
CREATE INDEX idx_bank_accounts_gl ON bank_accounts(gl_account_id);
CREATE INDEX idx_bank_accounts_active ON bank_accounts(is_active) WHERE is_active = true;

CREATE INDEX idx_bank_txn_account ON bank_transactions(bank_account_id);
CREATE INDEX idx_bank_txn_date ON bank_transactions(transaction_date);
CREATE INDEX idx_bank_txn_unmatched ON bank_transactions(is_matched) WHERE is_matched = false;

CREATE INDEX idx_recon_matches_bank_txn ON reconciliation_matches(bank_transaction_id);
CREATE INDEX idx_recon_matches_jel ON reconciliation_matches(journal_entry_line_id);

CREATE INDEX idx_recon_sessions_account ON reconciliation_sessions(bank_account_id);
CREATE INDEX idx_recon_sessions_status ON reconciliation_sessions(status);
```

### 3.5 Fixed Assets Schema

```sql
CREATE TABLE asset_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    parent_id UUID REFERENCES asset_categories(id),
    
    -- Default GL Accounts
    asset_account_id UUID REFERENCES accounts(id),
    accumulated_depreciation_account_id UUID REFERENCES accounts(id),
    depreciation_expense_account_id UUID REFERENCES accounts(id),
    
    -- Default Depreciation Settings
    default_useful_life_years INTEGER,
    default_depreciation_method VARCHAR(50),
    
    is_active BOOLEAN DEFAULT true
);

CREATE TABLE fixed_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id),
    
    -- Identification
    asset_number VARCHAR(50) UNIQUE NOT NULL,
    asset_name VARCHAR(255) NOT NULL,
    description TEXT,
    category_id UUID REFERENCES asset_categories(id),
    
    -- Acquisition
    acquisition_date DATE NOT NULL,
    acquisition_cost DECIMAL(19,4) NOT NULL,
    vendor_id UUID REFERENCES vendors(id),
    purchase_order VARCHAR(100),
    
    -- Depreciation
    salvage_value DECIMAL(19,4) DEFAULT 0,
    useful_life_years INTEGER NOT NULL,
    useful_life_months INTEGER, -- Computed: years * 12
    
    depreciation_method VARCHAR(50) NOT NULL CHECK (depreciation_method IN (
        'straight_line', 'declining_balance_150', 'declining_balance_200',
        'sum_of_years_digits', 'units_of_production', 'macrs'
    )),
    
    -- Book vs Tax Depreciation
    book_depreciation_method VARCHAR(50),
    tax_depreciation_method VARCHAR(50),
    macrs_class VARCHAR(20), -- USA tax: 3-year, 5-year, 7-year, etc.
    
    -- Depreciation Start
    depreciation_start_date DATE NOT NULL,
    
    -- Current Status
    current_book_value DECIMAL(19,4),
    accumulated_depreciation DECIMAL(19,4) DEFAULT 0,
    last_depreciation_date DATE,
    
    -- GL Accounts
    asset_account_id UUID NOT NULL REFERENCES accounts(id),
    accumulated_depreciation_account_id UUID NOT NULL REFERENCES accounts(id),
    depreciation_expense_account_id UUID NOT NULL REFERENCES accounts(id),
    
    -- Physical Details
    serial_number VARCHAR(100),
    manufacturer VARCHAR(255),
    model VARCHAR(255),
    location VARCHAR(255),
    responsible_employee_id UUID,
    
    -- Dimensions
    cost_center_id UUID REFERENCES cost_centers(id),
    department_id UUID REFERENCES departments(id),
    
    -- Status
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN (
        'active', 'inactive', 'disposed', 'fully_depreciated'
    )),
    
    -- Disposal
    disposal_date DATE,
    disposal_amount DECIMAL(19,4),
    disposal_method VARCHAR(50), -- sale, scrap, trade, donation
    gain_loss_amount DECIMAL(19,4),
    
    -- Metadata
    tags JSONB,
    notes TEXT,
    attachments JSONB, -- Photos, documents
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

CREATE TABLE depreciation_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID NOT NULL REFERENCES fixed_assets(id),
    
    -- Period
    fiscal_period_id UUID REFERENCES fiscal_periods(id),
    depreciation_date DATE NOT NULL,
    
    -- Amounts
    depreciation_expense DECIMAL(19,4) NOT NULL,
    accumulated_depreciation DECIMAL(19,4) NOT NULL,
    book_value DECIMAL(19,4) NOT NULL,
    
    -- Type
    schedule_type VARCHAR(50) CHECK (schedule_type IN (
        'book', 'tax', 'projected'
    )),
    
    -- Status
    is_posted BOOLEAN DEFAULT false,
    journal_entry_id UUID REFERENCES journal_entries(id),
    
    -- Calculation metadata
    calculation_metadata JSONB,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(asset_id, fiscal_period_id, schedule_type)
);

-- Indexes
CREATE INDEX idx_assets_entity ON fixed_assets(entity_id);
CREATE INDEX idx_assets_category ON fixed_assets(category_id);
CREATE INDEX idx_assets_status ON fixed_assets(status);
CREATE INDEX idx_assets_location ON fixed_assets(location);

CREATE INDEX idx_depr_schedule_asset ON depreciation_schedules(asset_id);
CREATE INDEX idx_depr_schedule_period ON depreciation_schedules(fiscal_period_id);
CREATE INDEX idx_depr_schedule_unposted ON depreciation_schedules(is_posted) WHERE is_posted = false;
```

---

## 4. Accounting Engine

### 4.1 Double-Entry Validation Rules

```typescript
/**
 * Core Accounting Rules Engine
 */

interface ValidationRule {
  name: string;
  validate: (entry: JournalEntry) => ValidationResult;
}

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

// Rule 1: Debits must equal Credits
const balanceRule: ValidationRule = {
  name: 'balance_check',
  validate: (entry) => {
    const totalDebits = entry.lines
      .filter(l => l.debit_amount)
      .reduce((sum, l) => sum + l.debit_amount, 0);
    
    const totalCredits = entry.lines
      .filter(l => l.credit_amount)
      .reduce((sum, l) => sum + l.credit_amount, 0);
    
    const diff = Math.abs(totalDebits - totalCredits);
    const tolerance = 0.01; // 1 cent tolerance
    
    if (diff > tolerance) {
      return {
        isValid: false,
        errors: [`Debits (${totalDebits}) must equal Credits (${totalCredits}). Difference: ${diff}`],
        warnings: []
      };
    }
    
    return { isValid: true, errors: [], warnings: [] };
  }
};

// Rule 2: Each line must have exactly one of debit or credit
const lineAmountRule: ValidationRule = {
  name: 'line_amount_check',
  validate: (entry) => {
    const errors: string[] = [];
    
    entry.lines.forEach((line, idx) => {
      const hasDebit = line.debit_amount !== null && line.debit_amount > 0;
      const hasCredit = line.credit_amount !== null && line.credit_amount > 0;
      
      if (hasDebit && hasCredit) {
        errors.push(`Line ${idx + 1}: Cannot have both debit and credit`);
      }
      
      if (!hasDebit && !hasCredit) {
        errors.push(`Line ${idx + 1}: Must have either debit or credit`);
      }
      
      if (hasDebit && line.debit_amount <= 0) {
        errors.push(`Line ${idx + 1}: Debit must be positive`);
      }
      
      if (hasCredit && line.credit_amount <= 0) {
        errors.push(`Line ${idx + 1}: Credit must be positive`);
      }
    });
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings: []
    };
  }
};

// Rule 3: Account type consistency
const accountTypeRule: ValidationRule = {
  name: 'account_type_check',
  validate: async (entry) => {
    const warnings: string[] = [];
    
    for (const line of entry.lines) {
      const account = await getAccount(line.account_id);
      
      // Assets/Expenses normally have debit balances
      if (['asset', 'expense'].includes(account.account_type)) {
        if (line.credit_amount && !line.debit_amount) {
          warnings.push(
            `Line ${line.line_number}: Crediting ${account.account_type} account "${account.name}" ` +
            `(normally has debit balance). This may reduce the account.`
          );
        }
      }
      
      // Liabilities/Equity/Revenue normally have credit balances
      if (['liability', 'equity', 'revenue'].includes(account.account_type)) {
        if (line.debit_amount && !line.credit_amount) {
          warnings.push(
            `Line ${line.line_number}: Debiting ${account.account_type} account "${account.name}" ` +
            `(normally has credit balance). This may reduce the account.`
          );
        }
      }
    }
    
    return {
      isValid: true, // Warnings don't block posting
      errors: [],
      warnings
    };
  }
};

// Rule 4: Period must be open
const periodStatusRule: ValidationRule = {
  name: 'period_status_check',
  validate: async (entry) => {
    const period = await getFiscalPeriod(entry.fiscal_period_id);
    
    if (period.status === 'hard_close' || period.status === 'locked') {
      return {
        isValid: false,
        errors: [`Cannot post to ${period.status} period ${period.period_name}`],
        warnings: []
      };
    }
    
    if (period.status === 'soft_close') {
      return {
        isValid: true,
        errors: [],
        warnings: [`Period ${period.period_name} is soft closed. Review may be required.`]
      };
    }
    
    return { isValid: true, errors: [], warnings: [] };
  }
};

// Rule 5: Account must allow manual entries
const accountPermissionRule: ValidationRule = {
  name: 'account_permission_check',
  validate: async (entry) => {
    const errors: string[] = [];
    
    for (const line of entry.lines) {
      const account = await getAccount(line.account_id);
      
      if (!account.allow_manual_entries && entry.entry_type === 'standard') {
        errors.push(
          `Line ${line.line_number}: Account "${account.name}" does not allow manual entries`
        );
      }
      
      if (account.is_header) {
        errors.push(
          `Line ${line.line_number}: Cannot post to header account "${account.name}"`
        );
      }
      
      if (!account.is_active) {
        errors.push(
          `Line ${line.line_number}: Account "${account.name}" is inactive`
        );
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings: []
    };
  }
};

// Rule 6: Multi-currency validation
const currencyRule: ValidationRule = {
  name: 'currency_check',
  validate: (entry) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    entry.lines.forEach((line, idx) => {
      if (line.currency_code) {
        // Foreign currency line
        if (!line.exchange_rate) {
          errors.push(`Line ${idx + 1}: Exchange rate required for foreign currency`);
        }
        
        if (!line.foreign_debit && !line.foreign_credit) {
          errors.push(`Line ${idx + 1}: Foreign amount required when currency specified`);
        }
        
        // Validate conversion
        if (line.foreign_debit && line.debit_amount) {
          const expectedFunctional = line.foreign_debit * line.exchange_rate;
          const diff = Math.abs(expectedFunctional - line.debit_amount);
          
          if (diff > 0.01) {
            warnings.push(
              `Line ${idx + 1}: Currency conversion mismatch. ` +
              `Expected ${expectedFunctional}, got ${line.debit_amount}`
            );
          }
        }
      }
    });
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
};

/**
 * Master Validation Engine
 */
export async function validateJournalEntry(
  entry: JournalEntry
): Promise<ValidationResult> {
  const rules: ValidationRule[] = [
    balanceRule,
    lineAmountRule,
    accountTypeRule,
    periodStatusRule,
    accountPermissionRule,
    currencyRule
  ];
  
  const results = await Promise.all(
    rules.map(rule => rule.validate(entry))
  );
  
  const allErrors = results.flatMap(r => r.errors);
  const allWarnings = results.flatMap(r => r.warnings);
  
  return {
    isValid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings
  };
}
```

### 4.2 Automatic Posting Rules

```typescript
/**
 * Automatic Journal Entry Generation
 */

interface PostingRule {
  trigger: TransactionType;
  generateEntries: (transaction: Transaction) => JournalEntryLine[];
}

// Invoice posting rule
const invoicePostingRule: PostingRule = {
  trigger: 'invoice',
  generateEntries: (invoice: Invoice) => {
    const lines: JournalEntryLine[] = [];
    
    // Debit: Accounts Receivable
    lines.push({
      line_number: 1,
      account_id: invoice.customer.default_ar_account_id,
      debit_amount: invoice.total_amount,
      credit_amount: null,
      description: `Invoice ${invoice.invoice_number} - ${invoice.customer.company_name}`
    });
    
    // Credit: Revenue (per line item)
    invoice.lines.forEach((line, idx) => {
      lines.push({
        line_number: idx + 2,
        account_id: line.revenue_account_id,
        debit_amount: null,
        credit_amount: line.line_amount,
        description: line.description,
        project_id: line.project_id,
        cost_center_id: line.cost_center_id
      });
      
      // Tax line if applicable
      if (line.tax_amount > 0) {
        lines.push({
          line_number: idx + 100, // Offset to avoid conflicts
          account_id: TAX_PAYABLE_ACCOUNT_ID,
          debit_amount: null,
          credit_amount: line.tax_amount,
          description: `Tax on ${line.description}`
        });
      }
    });
    
    return lines;
  }
};

// Bill posting rule
const billPostingRule: PostingRule = {
  trigger: 'bill',
  generateEntries: (bill: Bill) => {
    const lines: JournalEntryLine[] = [];
    
    // Credit: Accounts Payable
    lines.push({
      line_number: 1,
      account_id: ACCOUNTS_PAYABLE_ID,
      debit_amount: null,
      credit_amount: bill.total_amount,
      description: `Bill ${bill.vendor_invoice_number} - ${bill.vendor.company_name}`
    });
    
    // Debit: Expense accounts (per line item)
    bill.lines.forEach((line, idx) => {
      lines.push({
        line_number: idx + 2,
        account_id: line.account_id,
        debit_amount: line.line_amount,
        credit_amount: null,
        description: line.description,
        cost_center_id: line.cost_center_id,
        project_id: line.project_id
      });
      
      // Tax line
      if (line.tax_amount > 0) {
        lines.push({
          line_number: idx + 100,
          account_id: TAX_RECEIVABLE_ACCOUNT_ID, // IVA acreditable
          debit_amount: line.tax_amount,
          credit_amount: null,
          description: `Tax on ${line.description}`
        });
      }
    });
    
    return lines;
  }
};

// Customer payment posting rule
const customerPaymentRule: PostingRule = {
  trigger: 'payment_received',
  generateEntries: (payment: CustomerPayment) => {
    const lines: JournalEntryLine[] = [];
    
    // Debit: Cash/Bank
    lines.push({
      line_number: 1,
      account_id: payment.bank_account.gl_account_id,
      debit_amount: payment.payment_amount,
      credit_amount: null,
      description: `Payment from ${payment.customer.company_name}`
    });
    
    // Credit: Accounts Receivable (per invoice)
    payment.allocations.forEach((allocation, idx) => {
      lines.push({
        line_number: idx + 2,
        account_id: payment.customer.default_ar_account_id,
        debit_amount: null,
        credit_amount: allocation.amount_applied,
        description: `Payment for Invoice ${allocation.invoice.invoice_number}`
      });
    });
    
    // Unapplied amount goes to Unapplied Cash account
    if (payment.unapplied_amount > 0) {
      lines.push({
        line_number: 100,
        account_id: UNAPPLIED_CASH_ACCOUNT_ID,
        debit_amount: null,
        credit_amount: payment.unapplied_amount,
        description: 'Unapplied payment amount'
      });
    }
    
    return lines;
  }
};

// Vendor payment posting rule
const vendorPaymentRule: PostingRule = {
  trigger: 'payment_made',
  generateEntries: (payment: VendorPayment) => {
    const lines: JournalEntryLine[] = [];
    
    // Credit: Cash/Bank
    lines.push({
      line_number: 1,
      account_id: payment.bank_account.gl_account_id,
      debit_amount: null,
      credit_amount: payment.payment_amount,
      description: `Payment to ${payment.vendor.company_name}`
    });
    
    // Debit: Accounts Payable (per bill)
    payment.applications.forEach((app, idx) => {
      lines.push({
        line_number: idx + 2,
        account_id: ACCOUNTS_PAYABLE_ID,
        debit_amount: app.amount_applied,
        credit_amount: null,
        description: `Payment for Bill ${app.bill.vendor_invoice_number}`
      });
      
      // Early payment discount
      if (app.discount_amount > 0) {
        lines.push({
          line_number: idx + 100,
          account_id: PURCHASE_DISCOUNT_ACCOUNT_ID,
          debit_amount: null,
          credit_amount: app.discount_amount,
          description: `Early payment discount - ${app.discount_reason}`
        });
      }
    });
    
    return lines;
  }
};

// Depreciation posting rule
const depreciationRule: PostingRule = {
  trigger: 'depreciation',
  generateEntries: (schedule: DepreciationSchedule) => {
    const asset = schedule.asset;
    
    return [
      {
        line_number: 1,
        account_id: asset.depreciation_expense_account_id,
        debit_amount: schedule.depreciation_expense,
        credit_amount: null,
        description: `Depreciation - ${asset.asset_name}`,
        cost_center_id: asset.cost_center_id,
        department_id: asset.department_id
      },
      {
        line_number: 2,
        account_id: asset.accumulated_depreciation_account_id,
        debit_amount: null,
        credit_amount: schedule.depreciation_expense,
        description: `Accumulated Depreciation - ${asset.asset_name}`
      }
    ];
  }
};

/**
 * Posting Engine
 */
export async function postTransaction(
  transaction: Transaction
): Promise<JournalEntry> {
  // Find applicable posting rule
  const rule = POSTING_RULES.find(r => r.trigger === transaction.transaction_type);
  
  if (!rule) {
    throw new Error(`No posting rule found for transaction type: ${transaction.transaction_type}`);
  }
  
  // Generate lines
  const lines = rule.generateEntries(transaction);
  
  // Create journal entry
  const entry: JournalEntry = {
    id: generateUUID(),
    entry_number: await generateEntryNumber(transaction.entity_id),
    entry_type: `auto_${transaction.transaction_type}`,
    entity_id: transaction.entity_id,
    fiscal_period_id: await getCurrentPeriod(transaction.entity_id, transaction.transaction_date),
    entry_date: transaction.transaction_date,
    status: 'draft',
    source_type: transaction.transaction_type,
    source_id: transaction.id,
    description: transaction.description,
    lines: lines
  };
  
  // Validate
  const validation = await validateJournalEntry(entry);
  if (!validation.isValid) {
    throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
  }
  
  // Save entry
  await saveJournalEntry(entry);
  
  // Auto-post if configured
  if (shouldAutoPost(transaction.transaction_type)) {
    await postJournalEntry(entry.id);
  }
  
  return entry;
}

async function postJournalEntry(entryId: string): Promise<void> {
  const entry = await getJournalEntry(entryId);
  
  // Final validation
  const validation = await validateJournalEntry(entry);
  if (!validation.isValid) {
    throw new Error(`Cannot post: ${validation.errors.join(', ')}`);
  }
  
  // Update status
  entry.status = 'posted';
  entry.posted_date = new Date();
  entry.posted_by = getCurrentUser().id;
  
  // Save
  await updateJournalEntry(entry);
  
  // Update account balances (materialized view or denormalized table)
  await updateAccountBalances(entry);
  
  // Emit event
  await emitEvent('journal_entry.posted', entry);
}
```

### 4.3 Period Close Process

```typescript
/**
 * Period Close Automation
 */

interface PeriodCloseChecklist {
  task: string;
  completed: boolean;
  completed_by?: string;
  completed_at?: Date;
  required: boolean;
}

interface PeriodCloseStatus {
  can_close: boolean;
  blocking_issues: string[];
  warnings: string[];
  checklist: PeriodCloseChecklist[];
}

async function getPeriodCloseStatus(
  periodId: string
): Promise<PeriodCloseStatus> {
  const period = await getFiscalPeriod(periodId);
  const entity = await getEntity(period.entity_id);
  
  const checklist: PeriodCloseChecklist[] = [];
  const blocking_issues: string[] = [];
  const warnings: string[] = [];
  
  // Check 1: All transactions posted
  const draftTransactions = await db.query(`
    SELECT COUNT(*) as count
    FROM journal_entries
    WHERE fiscal_period_id = $1
      AND status IN ('draft', 'pending_approval')
  `, [periodId]);
  
  const hasUnpostedEntries = draftTransactions.rows[0].count > 0;
  checklist.push({
    task: 'All journal entries posted',
    completed: !hasUnpostedEntries,
    required: true
  });
  
  if (hasUnpostedEntries) {
    blocking_issues.push(`${draftTransactions.rows[0].count} unposted journal entries`);
  }
  
  // Check 2: Bank reconciliations complete
  const bankAccounts = await getBankAccounts(entity.id);
  for (const account of bankAccounts) {
    const recon = await db.query(`
      SELECT *
      FROM reconciliation_sessions
      WHERE bank_account_id = $1
        AND start_date <= $2
        AND end_date >= $3
        AND status = 'approved'
    `, [account.id, period.start_date, period.end_date]);
    
    const isReconciled = recon.rows.length > 0;
    checklist.push({
      task: `Bank reconciliation: ${account.account_name}`,
      completed: isReconciled,
      required: true
    });
    
    if (!isReconciled) {
      blocking_issues.push(`Bank account "${account.account_name}" not reconciled`);
    }
  }
  
  // Check 3: All invoices reviewed
  const unpaidInvoices = await db.query(`
    SELECT COUNT(*) as count
    FROM invoices
    WHERE entity_id = $1
      AND invoice_date >= $2
      AND invoice_date <= $3
      AND status IN ('draft', 'pending')
  `, [entity.id, period.start_date, period.end_date]);
  
  if (unpaidInvoices.rows[0].count > 0) {
    warnings.push(`${unpaidInvoices.rows[0].count} draft/pending invoices`);
  }
  
  // Check 4: Depreciation calculated
  const assets = await getActiveAssets(entity.id);
  const depreciationSchedules = await db.query(`
    SELECT COUNT(*) as count
    FROM depreciation_schedules
    WHERE fiscal_period_id = $1
      AND is_posted = true
  `, [periodId]);
  
  const depreciationComplete = depreciationSchedules.rows[0].count === assets.length;
  checklist.push({
    task: 'Depreciation calculated and posted',
    completed: depreciationComplete,
    required: true
  });
  
  if (!depreciationComplete) {
    blocking_issues.push('Depreciation not calculated for all assets');
  }
  
  // Check 5: Accruals recorded
  checklist.push({
    task: 'Accrued revenue recorded',
    completed: false, // Manual check
    required: false
  });
  
  checklist.push({
    task: 'Accrued expenses recorded',
    completed: false, // Manual check
    required: false
  });
  
  // Check 6: Intercompany reconciliation
  if (entity.has_subsidiaries) {
    checklist.push({
      task: 'Intercompany accounts reconciled',
      completed: false, // Manual check
      required: true
    });
  }
  
  // Check 7: Trial balance review
  const trialBalance = await generateTrialBalance(entity.id, periodId);
  const isBalanced = Math.abs(trialBalance.total_debits - trialBalance.total_credits) < 0.01;
  
  checklist.push({
    task: 'Trial balance balanced',
    completed: isBalanced,
    required: true
  });
  
  if (!isBalanced) {
    blocking_issues.push('Trial balance out of balance');
  }
  
  return {
    can_close: blocking_issues.length === 0,
    blocking_issues,
    warnings,
    checklist
  };
}

async function softClosePeriod(
  periodId: string,
  userId: string
): Promise<void> {
  const status = await getPeriodCloseStatus(periodId);
  
  if (!status.can_close) {
    throw new Error(
      `Cannot close period: ${status.blocking_issues.join(', ')}`
    );
  }
  
  // Update period status
  await db.query(`
    UPDATE fiscal_periods
    SET status = 'soft_close',
        soft_close_date = NOW(),
        closed_by = $2
    WHERE id = $1
  `, [periodId, userId]);
  
  // Log event
  await auditLog({
    entity_type: 'fiscal_period',
    entity_id: periodId,
    action: 'soft_close',
    user_id: userId,
    metadata: { checklist: status.checklist }
  });
  
  // Emit event
  await emitEvent('period.soft_closed', { period_id: periodId });
}

async function hardClosePeriod(
  periodId: string,
  userId: string
): Promise<void> {
  const period = await getFiscalPeriod(periodId);
  
  if (period.status !== 'soft_close') {
    throw new Error('Period must be soft closed before hard close');
  }
  
  // Perform closing entries
  await generateClosingEntries(periodId);
  
  // Update period status
  await db.query(`
    UPDATE fiscal_periods
    SET status = 'hard_close',
        hard_close_date = NOW()
    WHERE id = $1
  `, [periodId]);
  
  // Lock all journal entries in this period
  await db.query(`
    UPDATE journal_entries
    SET status = 'posted'
    WHERE fiscal_period_id = $1
      AND status != 'void'
  `, [periodId]);
  
  // Generate snapshots for reporting
  await snapshotAccountBalances(periodId);
  
  // Emit event
  await emitEvent('period.hard_closed', { period_id: periodId });
}

async function generateClosingEntries(periodId: string): Promise<void> {
  const period = await getFiscalPeriod(periodId);
  
  // Only for year-end
  if (period.period_type !== 'closing') {
    return;
  }
  
  // Close revenue accounts to Income Summary
  const revenues = await db.query(`
    SELECT account_id, SUM(credit_amount) - SUM(debit_amount) as balance
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    JOIN accounts a ON a.id = jel.account_id
    WHERE je.fiscal_period_id IN (
      SELECT id FROM fiscal_periods
      WHERE fiscal_year_id = $1
    )
      AND a.account_type = 'revenue'
      AND je.status = 'posted'
    GROUP BY account_id
    HAVING SUM(credit_amount) - SUM(debit_amount) != 0
  `, [period.fiscal_year_id]);
  
  const revenueBatch = 'reverse revenue',
   await revenues.forEach((closing line);
  
  // ... (Continue similar pattern for expenses, then Income Summary to Retained Earnings)
}
```

This document continues... Would you like me to continue with the remaining sections (API Specifications, Functional Modules, Security, etc.)?

