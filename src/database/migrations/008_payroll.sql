-- ============================================================
-- Migration 008: Payroll Module (MX + USA)
-- Own subsystem — employees, pay runs, paychecks, tax engine,
-- direct deposit, tax form filings, benefits, garnishments.
-- ============================================================

-- ============================================================
-- EMPLOYEES
-- ============================================================

CREATE TABLE employees (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    employee_number VARCHAR(30) NOT NULL,

    -- Identity
    first_name VARCHAR(100) NOT NULL,
    middle_name VARCHAR(100),
    last_name VARCHAR(100) NOT NULL,
    second_last_name VARCHAR(100),           -- Maternal surname / apellido materno (MX)
    email VARCHAR(255),
    phone VARCHAR(30),
    date_of_birth DATE,
    gender VARCHAR(10),

    -- Employment
    hire_date DATE NOT NULL,
    termination_date DATE,
    termination_reason VARCHAR(50),          -- resignation, dismissal, retirement, end_of_contract
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'on_leave', 'terminated', 'suspended')),

    -- Country / jurisdiction
    country_code VARCHAR(2) NOT NULL CHECK (country_code IN ('MX', 'US')),

    -- MX fiscal identifiers
    rfc VARCHAR(13),                         -- Registro Federal de Contribuyentes
    curp VARCHAR(18),                        -- Clave Única de Registro de Población
    nss VARCHAR(11),                         -- Número de Seguridad Social (IMSS)
    infonavit_credit_number VARCHAR(20),
    infonavit_credit_type VARCHAR(10),       -- 'factor', 'vsm', 'pesos'
    infonavit_credit_value DECIMAL(10,4),    -- rate or amount
    sbc NUMERIC(14,4),                       -- Salario Base de Cotizacion / contribution base salary (daily)
    tipo_regimen_sat VARCHAR(3),             -- 02=Sueldos, 03=Jubilados, 04=Pensionados, 05=Asimilados, 09=Honorarios
    tipo_contrato_sat VARCHAR(3),            -- 01=Indeterminado, 02=Periodo de prueba, etc.
    tipo_jornada_sat VARCHAR(3),             -- 01=Diurna, 02=Nocturna, etc.
    riesgo_puesto VARCHAR(3),                -- 01-05 (IMSS work risk class)
    departamento VARCHAR(100),
    puesto VARCHAR(100),

    -- USA fiscal identifiers
    ssn_encrypted TEXT,                      -- AES-256 encrypted Social Security Number
    w4_data JSONB,                           -- Full W-4 2020+: filing_status, dependents_amount, other_income, deductions, extra_withholding, multiple_jobs, two_jobs_box
    work_state VARCHAR(2),                   -- State where work is performed
    residence_state VARCHAR(2),              -- State of residence (for reciprocity)
    work_city VARCHAR(50),                   -- For local taxes (NYC, Yonkers, Philly, SF)
    is_exempt_fit BOOLEAN DEFAULT false,     -- Federal income tax exempt
    is_exempt_fica BOOLEAN DEFAULT false,    -- Rare (students, certain visas)
    is_statutory_employee BOOLEAN DEFAULT false,

    -- Compensation
    pay_schedule_id UUID,                    -- FK below
    salary_type VARCHAR(20) NOT NULL DEFAULT 'salary'
        CHECK (salary_type IN ('salary', 'hourly', 'commission', 'contractor_1099')),
    annual_salary NUMERIC(14,2),
    hourly_rate NUMERIC(10,4),
    default_hours_per_period NUMERIC(6,2),
    currency_code VARCHAR(3) NOT NULL DEFAULT 'USD',

    -- Bank account for direct deposit (encrypted)
    bank_account_encrypted TEXT,             -- JSON: { routing, account, account_type } or { clabe }
    bank_name VARCHAR(100),

    -- Address
    address_line1 VARCHAR(255),
    address_line2 VARCHAR(100),
    city VARCHAR(100),
    state_province VARCHAR(50),
    postal_code VARCHAR(20),

    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID,

    UNIQUE(tenant_id, employee_number),
    CHECK (
        (country_code = 'MX' AND rfc IS NOT NULL)
        OR (country_code = 'US' AND ssn_encrypted IS NOT NULL)
    )
);

CREATE INDEX idx_employees_tenant ON employees(tenant_id, status);
CREATE INDEX idx_employees_entity ON employees(entity_id);
CREATE INDEX idx_employees_country ON employees(country_code);

-- Compensation history (salary changes audit)
CREATE TABLE employee_compensation_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    effective_date DATE NOT NULL,
    salary_type VARCHAR(20) NOT NULL,
    annual_salary NUMERIC(14,2),
    hourly_rate NUMERIC(10,4),
    reason VARCHAR(100),
    changed_by UUID,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_emp_comp_hist_employee ON employee_compensation_history(employee_id, effective_date DESC);

-- ============================================================
-- PAY SCHEDULES & PERIODS
-- ============================================================

CREATE TABLE pay_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    name VARCHAR(100) NOT NULL,
    frequency VARCHAR(20) NOT NULL
        CHECK (frequency IN ('weekly', 'biweekly', 'semimonthly', 'monthly', 'quincenal')),
    country_code VARCHAR(2) NOT NULL,
    period_end_day INTEGER,                  -- For semimonthly/monthly
    pay_day_offset INTEGER DEFAULT 0,        -- Days after period_end to pay
    first_period_start DATE NOT NULL,        -- Anchor date to generate periods
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE employees ADD CONSTRAINT fk_employee_pay_schedule
    FOREIGN KEY (pay_schedule_id) REFERENCES pay_schedules(id);

CREATE TABLE pay_periods (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    pay_schedule_id UUID NOT NULL REFERENCES pay_schedules(id),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    pay_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'calculated', 'approved', 'paid', 'closed')),
    tax_year INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(pay_schedule_id, period_start)
);

CREATE INDEX idx_pay_periods_tenant ON pay_periods(tenant_id, status, pay_date DESC);

-- ============================================================
-- PAY RUNS
-- ============================================================

CREATE TABLE pay_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    pay_period_id UUID NOT NULL REFERENCES pay_periods(id),
    run_type VARCHAR(20) NOT NULL DEFAULT 'regular'
        CHECK (run_type IN ('regular', 'bonus', 'correction', 'final', 'off_cycle')),
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'calculating', 'calculated', 'approved', 'paid', 'voided')),

    -- Totals (after calculation)
    total_gross NUMERIC(14,2) DEFAULT 0,
    total_pre_tax_deductions NUMERIC(14,2) DEFAULT 0,
    total_taxable_wages NUMERIC(14,2) DEFAULT 0,
    total_employee_taxes NUMERIC(14,2) DEFAULT 0,
    total_employer_taxes NUMERIC(14,2) DEFAULT 0,
    total_post_tax_deductions NUMERIC(14,2) DEFAULT 0,
    total_net_pay NUMERIC(14,2) DEFAULT 0,
    total_employer_cost NUMERIC(14,2) DEFAULT 0,
    employee_count INTEGER DEFAULT 0,

    -- GL integration
    journal_entry_id UUID REFERENCES journal_entries(id),

    -- Year-version for tax table lookups
    tax_year_used INTEGER NOT NULL,

    calculated_at TIMESTAMPTZ,
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    voided_at TIMESTAMPTZ,
    void_reason TEXT,

    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID
);

CREATE INDEX idx_pay_runs_tenant ON pay_runs(tenant_id, status);
CREATE INDEX idx_pay_runs_period ON pay_runs(pay_period_id);

-- ============================================================
-- PAYCHECKS (one per employee per pay run)
-- ============================================================

CREATE TABLE paychecks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    pay_run_id UUID NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES employees(id),
    check_number VARCHAR(30),

    -- Calculated amounts
    gross_earnings NUMERIC(14,2) NOT NULL DEFAULT 0,
    pre_tax_deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
    taxable_wages_fit NUMERIC(14,2) DEFAULT 0,       -- Federal taxable (USA)
    taxable_wages_fica NUMERIC(14,2) DEFAULT 0,      -- FICA taxable (USA)
    taxable_wages_futa NUMERIC(14,2) DEFAULT 0,      -- FUTA taxable (USA)
    taxable_wages_state NUMERIC(14,2) DEFAULT 0,
    taxable_wages_isr NUMERIC(14,2) DEFAULT 0,       -- ISR base (MX)
    taxable_wages_imss NUMERIC(14,2) DEFAULT 0,      -- IMSS SBC base (MX)

    -- Employee taxes (withheld)
    isr_withheld NUMERIC(14,2) DEFAULT 0,
    subsidio_empleo NUMERIC(14,2) DEFAULT 0,         -- MX: subsidy credit
    imss_employee NUMERIC(14,2) DEFAULT 0,
    infonavit_withheld NUMERIC(14,2) DEFAULT 0,
    fit_withheld NUMERIC(14,2) DEFAULT 0,
    fica_ss_withheld NUMERIC(14,2) DEFAULT 0,
    fica_medicare_withheld NUMERIC(14,2) DEFAULT 0,
    additional_medicare_withheld NUMERIC(14,2) DEFAULT 0,
    state_tax_withheld NUMERIC(14,2) DEFAULT 0,
    local_tax_withheld NUMERIC(14,2) DEFAULT 0,
    sdi_withheld NUMERIC(14,2) DEFAULT 0,            -- CA/NY/NJ State Disability

    -- Employer taxes
    imss_employer NUMERIC(14,2) DEFAULT 0,
    infonavit_employer NUMERIC(14,2) DEFAULT 0,
    fica_ss_employer NUMERIC(14,2) DEFAULT 0,
    fica_medicare_employer NUMERIC(14,2) DEFAULT 0,
    futa NUMERIC(14,2) DEFAULT 0,
    suta NUMERIC(14,2) DEFAULT 0,

    post_tax_deductions NUMERIC(14,2) DEFAULT 0,
    garnishments NUMERIC(14,2) DEFAULT 0,
    net_pay NUMERIC(14,2) NOT NULL DEFAULT 0,

    -- YTD snapshot at time of paycheck (for year-end form generation)
    ytd_snapshot JSONB NOT NULL DEFAULT '{}',

    -- MX CFDI Nómina
    cfdi_uuid UUID,
    cfdi_status VARCHAR(20),                          -- 'pending', 'stamped', 'cancelled'
    cfdi_xml_path TEXT,
    cfdi_provider VARCHAR(30),                        -- finkok, sw_sapien, edicom
    cfdi_stamped_at TIMESTAMPTZ,

    -- Payment
    payment_method VARCHAR(30) DEFAULT 'direct_deposit',   -- direct_deposit, check, cash
    direct_deposit_batch_id UUID,
    check_issued_at TIMESTAMPTZ,

    pdf_path TEXT,
    attestation_id UUID,                              -- optional blockchain attestation

    hours_worked NUMERIC(8,2),
    calculation_details JSONB,                        -- Full audit trail of how each number was calculated

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(pay_run_id, employee_id)
);

CREATE INDEX idx_paychecks_tenant ON paychecks(tenant_id);
CREATE INDEX idx_paychecks_employee ON paychecks(employee_id);
CREATE INDEX idx_paychecks_cfdi ON paychecks(cfdi_uuid) WHERE cfdi_uuid IS NOT NULL;

-- Paycheck line items (earnings breakdown)
CREATE TABLE paycheck_earnings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    paycheck_id UUID NOT NULL REFERENCES paychecks(id) ON DELETE CASCADE,
    earning_type VARCHAR(30) NOT NULL,               -- salary, hourly, overtime, bonus, commission, tips, pto, holiday, aguinaldo, prima_vacacional
    hours NUMERIC(8,2),
    rate NUMERIC(10,4),
    amount NUMERIC(14,2) NOT NULL,
    is_taxable_fit BOOLEAN DEFAULT true,
    is_taxable_state BOOLEAN DEFAULT true,
    is_taxable_fica BOOLEAN DEFAULT true,
    is_taxable_futa BOOLEAN DEFAULT true,
    is_taxable_isr BOOLEAN DEFAULT true,
    is_taxable_imss BOOLEAN DEFAULT true,
    is_supplemental BOOLEAN DEFAULT false,           -- Bonuses taxed at supplemental rate (USA)
    cfdi_clave_sat VARCHAR(10),                      -- SAT earnings catalog / percepciones (001-049)
    description VARCHAR(200)
);

CREATE INDEX idx_paycheck_earnings_paycheck ON paycheck_earnings(paycheck_id);

-- Paycheck deductions (non-tax)
CREATE TABLE paycheck_deductions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    paycheck_id UUID NOT NULL REFERENCES paychecks(id) ON DELETE CASCADE,
    deduction_type VARCHAR(40) NOT NULL,             -- 401k, roth_401k, hsa, fsa_medical, fsa_dependent, health_insurance, dental, vision, life_insurance, garnishment_child_support, garnishment_tax_levy, garnishment_creditor, loan_repayment, pension_alimenticia, aportacion_voluntaria
    is_pre_tax BOOLEAN NOT NULL DEFAULT false,
    is_employer_contribution BOOLEAN NOT NULL DEFAULT false,
    amount NUMERIC(14,2) NOT NULL,
    benefit_plan_id UUID,                            -- FK below
    garnishment_id UUID,                             -- FK below
    cfdi_clave_sat VARCHAR(10),                      -- SAT deductions catalog / deducciones
    description VARCHAR(200)
);

CREATE INDEX idx_paycheck_deductions_paycheck ON paycheck_deductions(paycheck_id);

-- Paycheck taxes (full breakdown per jurisdiction)
CREATE TABLE paycheck_taxes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    paycheck_id UUID NOT NULL REFERENCES paychecks(id) ON DELETE CASCADE,
    tax_type VARCHAR(40) NOT NULL,                   -- fit, fica_ss, fica_medicare, additional_medicare, futa, suta, sit, local, sdi, isr, imss_ivcm, imss_em, imss_rt, imss_gmp, imss_prestaciones, infonavit, subsidio_empleo
    jurisdiction VARCHAR(20) NOT NULL,               -- US-FEDERAL, US-CA, US-NYC, MX
    employee_employer CHAR(2) NOT NULL CHECK (employee_employer IN ('EE', 'ER')),
    taxable_wages NUMERIC(14,2) NOT NULL,
    rate NUMERIC(8,6),
    tax_amount NUMERIC(14,2) NOT NULL,
    is_credit BOOLEAN DEFAULT false,                  -- e.g. subsidio al empleo, state credits
    calculation_notes TEXT
);

CREATE INDEX idx_paycheck_taxes_paycheck ON paycheck_taxes(paycheck_id);
CREATE INDEX idx_paycheck_taxes_type ON paycheck_taxes(tax_type, jurisdiction);

-- ============================================================
-- EMPLOYER TAX LIABILITIES (deposit schedule)
-- ============================================================

CREATE TABLE employer_tax_liabilities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    pay_run_id UUID REFERENCES pay_runs(id),
    tax_type VARCHAR(40) NOT NULL,                   -- 941_federal, futa, suta_ca, isr, imss, infonavit, sit_ny, etc.
    jurisdiction VARCHAR(20) NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    amount NUMERIC(14,2) NOT NULL,
    due_date DATE NOT NULL,
    deposit_frequency VARCHAR(20),                   -- monthly, semi_weekly, next_day, quarterly, annual
    deposited_at TIMESTAMPTZ,
    deposit_reference VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'deposited', 'late', 'waived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_employer_tax_liab_due ON employer_tax_liabilities(tenant_id, due_date, status);

-- ============================================================
-- TAX TABLES (versioned by year)
-- ============================================================

CREATE TABLE tax_tables (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    jurisdiction VARCHAR(20) NOT NULL,               -- US-FEDERAL, US-CA, MX, US-NYC
    tax_type VARCHAR(40) NOT NULL,                   -- fit, isr, state_income, fica, futa, suta, imss, infonavit, sdi
    tax_year INTEGER NOT NULL,
    filing_status VARCHAR(30),                        -- single, married_jointly, head_of_household, null for MX
    pay_frequency VARCHAR(20),                        -- weekly, biweekly, semimonthly, monthly, quincenal, annual
    bracket_order INTEGER NOT NULL,                   -- Order within table
    bracket_low NUMERIC(14,4),
    bracket_high NUMERIC(14,4),                       -- NULL = unlimited
    rate NUMERIC(10,8) NOT NULL,                      -- Marginal rate
    base_tax NUMERIC(14,4) DEFAULT 0,                 -- Fixed amount at bracket_low
    data JSONB DEFAULT '{}',                          -- Extra params: standard_deduction, personal_exemption, etc.
    effective_from DATE NOT NULL,
    effective_to DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tax_tables_lookup ON tax_tables(jurisdiction, tax_type, tax_year, filing_status, pay_frequency, bracket_order);

-- Single-row params per jurisdiction/year (caps, rates, thresholds)
CREATE TABLE tax_parameters (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    jurisdiction VARCHAR(20) NOT NULL,
    tax_year INTEGER NOT NULL,
    params JSONB NOT NULL,                            -- { ss_wage_base: 168600, medicare_rate: 0.0145, futa_cap: 7000, uma_daily: 113.14, ... }
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(jurisdiction, tax_year)
);

-- ============================================================
-- BENEFITS
-- ============================================================

CREATE TABLE benefits_plans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    plan_type VARCHAR(30) NOT NULL,                   -- 401k, roth_401k, hsa, fsa_medical, fsa_dependent, health, dental, vision, life, std, ltd, commuter
    name VARCHAR(100) NOT NULL,
    provider VARCHAR(100),
    is_pre_tax BOOLEAN NOT NULL,
    employer_match_formula JSONB,                    -- { type: 'percent_of_contribution', match_rate: 1.0, cap_pct: 0.04 }
    contribution_limit_annual NUMERIC(12,2),         -- e.g. 401k 2026 ~$23,500 + catchup
    catchup_limit_annual NUMERIC(12,2),              -- e.g. 401k catchup $7,500 age 50+
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}'
);

CREATE TABLE employee_benefit_elections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    benefit_plan_id UUID NOT NULL REFERENCES benefits_plans(id),
    effective_date DATE NOT NULL,
    end_date DATE,
    employee_contribution_type VARCHAR(20) NOT NULL, -- percent, fixed_amount
    employee_contribution_value NUMERIC(12,4) NOT NULL,
    employer_contribution_value NUMERIC(12,4),       -- override plan default if set
    is_active BOOLEAN DEFAULT true
);

CREATE INDEX idx_emp_benefits_active ON employee_benefit_elections(employee_id) WHERE is_active;

ALTER TABLE paycheck_deductions ADD CONSTRAINT fk_paycheck_deduction_plan
    FOREIGN KEY (benefit_plan_id) REFERENCES benefits_plans(id);

-- ============================================================
-- GARNISHMENTS
-- ============================================================

CREATE TABLE garnishments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    garnishment_type VARCHAR(30) NOT NULL,           -- child_support, tax_levy_federal, tax_levy_state, creditor, student_loan, pension_alimenticia
    priority INTEGER NOT NULL DEFAULT 100,           -- Lower = higher priority (child support first)
    amount_type VARCHAR(20) NOT NULL,                -- fixed, percent_disposable, percent_gross
    amount_value NUMERIC(14,4) NOT NULL,
    max_withholding_pct NUMERIC(5,2),                -- e.g. CCPA 50-65%
    case_number VARCHAR(50),
    issuing_authority VARCHAR(200),
    payee_name VARCHAR(200),
    payee_address TEXT,
    payee_bank_account_encrypted TEXT,
    start_date DATE NOT NULL,
    end_date DATE,
    total_owed NUMERIC(14,2),
    total_paid NUMERIC(14,2) DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_garnishments_active ON garnishments(employee_id, priority) WHERE is_active;

ALTER TABLE paycheck_deductions ADD CONSTRAINT fk_paycheck_deduction_garnishment
    FOREIGN KEY (garnishment_id) REFERENCES garnishments(id);

-- ============================================================
-- DIRECT DEPOSIT BATCHES
-- ============================================================

CREATE TABLE direct_deposit_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    pay_run_id UUID NOT NULL REFERENCES pay_runs(id),
    rail VARCHAR(20) NOT NULL CHECK (rail IN ('ach_nacha', 'spei', 'check', 'wire')),
    file_path TEXT,
    file_sha256 VARCHAR(64),
    total_amount NUMERIC(14,2) NOT NULL,
    entry_count INTEGER NOT NULL,
    effective_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'submitted', 'settled', 'rejected', 'returned')),
    submitted_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    bank_confirmation VARCHAR(100),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dd_batches_tenant ON direct_deposit_batches(tenant_id, status);

ALTER TABLE paychecks ADD CONSTRAINT fk_paycheck_dd_batch
    FOREIGN KEY (direct_deposit_batch_id) REFERENCES direct_deposit_batches(id);

-- ============================================================
-- TAX FORM FILINGS (W-2, 941, 940, SUA, CFDI Nómina, etc.)
-- ============================================================

CREATE TABLE tax_form_filings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    form_type VARCHAR(30) NOT NULL,                  -- w2, w3, 941, 940, 1099_nec, sua, cfdi_nomina_annual, constancia_mx
    tax_year INTEGER NOT NULL,
    period VARCHAR(10),                               -- 'Q1', 'Q2', '01' (month), null for annual
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'ready', 'filed', 'accepted', 'rejected', 'amended')),
    filed_at TIMESTAMPTZ,
    confirmation_number VARCHAR(100),
    xml_path TEXT,
    pdf_path TEXT,
    data JSONB NOT NULL DEFAULT '{}',                -- Full form data for re-rendering / audit
    employee_id UUID REFERENCES employees(id),       -- NULL for employer-level (941/940/SUA); set for W-2/1099
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tax_filings_tenant ON tax_form_filings(tenant_id, form_type, tax_year);
CREATE INDEX idx_tax_filings_employee ON tax_form_filings(employee_id) WHERE employee_id IS NOT NULL;

-- ============================================================
-- PAYROLL GL ACCOUNT MAPPING (per entity)
-- Maps payroll semantic buckets to actual GL account IDs
-- ============================================================

CREATE TABLE payroll_account_mapping (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    bucket VARCHAR(50) NOT NULL,                     -- wages_expense, payroll_tax_expense, benefits_expense, cash_payroll, isr_payable, imss_payable, infonavit_payable, fit_payable, fica_payable, futa_payable, suta_payable, state_tax_payable, local_tax_payable, 401k_payable, garnishment_payable
    account_id UUID NOT NULL REFERENCES accounts(id),
    UNIQUE(tenant_id, entity_id, bucket)
);

CREATE INDEX idx_payroll_acct_map ON payroll_account_mapping(entity_id);
