-- ============================================================
-- Migration 005: XML Ingestion & Pre-Registration System
-- ============================================================

-- ============================================================
-- XML DOCUMENTS (Raw CFDI storage)
-- ============================================================

CREATE TABLE xml_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),

    -- Document Identification
    document_type VARCHAR(50) NOT NULL CHECK (document_type IN (
        'cfdi_ingreso', 'cfdi_egreso', 'cfdi_traslado',
        'cfdi_nomina', 'cfdi_pago', 'cfdi_retencion', 'other'
    )),

    -- CFDI Core
    cfdi_uuid VARCHAR(50) UNIQUE NOT NULL,
    cfdi_version VARCHAR(10) NOT NULL,
    cfdi_serie VARCHAR(25),
    cfdi_folio VARCHAR(40),

    -- Dates
    cfdi_fecha TIMESTAMPTZ NOT NULL,
    cfdi_fecha_timbrado TIMESTAMPTZ,

    -- Parties
    emisor_rfc VARCHAR(13) NOT NULL,
    emisor_nombre VARCHAR(300),
    emisor_regimen_fiscal VARCHAR(10),

    receptor_rfc VARCHAR(13) NOT NULL,
    receptor_nombre VARCHAR(300),
    receptor_uso_cfdi VARCHAR(10),
    receptor_regimen_fiscal VARCHAR(10),
    receptor_domicilio_fiscal VARCHAR(10),

    -- Amounts
    subtotal DECIMAL(19,4) NOT NULL,
    descuento DECIMAL(19,4) DEFAULT 0,
    total DECIMAL(19,4) NOT NULL,
    moneda CHAR(3) NOT NULL DEFAULT 'MXN',
    tipo_cambio DECIMAL(19,10) DEFAULT 1,

    -- Tax Summary
    total_impuestos_trasladados DECIMAL(19,4) DEFAULT 0,
    total_impuestos_retenidos DECIMAL(19,4) DEFAULT 0,
    total_iva_16 DECIMAL(19,4) DEFAULT 0,
    total_iva_8 DECIMAL(19,4) DEFAULT 0,
    total_iva_0 DECIMAL(19,4) DEFAULT 0,
    total_isr_retenido DECIMAL(19,4) DEFAULT 0,
    total_iva_retenido DECIMAL(19,4) DEFAULT 0,

    -- Payment
    forma_pago VARCHAR(10),
    metodo_pago VARCHAR(10),
    condiciones_pago VARCHAR(1000),

    -- Raw
    xml_content TEXT NOT NULL,
    xml_hash VARCHAR(64) NOT NULL,

    -- Storage
    xml_s3_url TEXT,
    pdf_s3_url TEXT,

    -- SAT Validation
    sat_validation_status VARCHAR(50) CHECK (sat_validation_status IN (
        'pending', 'valid', 'cancelled', 'not_found', 'error'
    )),
    sat_validated_at TIMESTAMPTZ,
    sat_estado VARCHAR(50),
    sat_efecto_cancelacion VARCHAR(50),
    sat_fecha_cancelacion TIMESTAMPTZ,

    -- Import Metadata
    import_source VARCHAR(50) NOT NULL CHECK (import_source IN (
        'manual_upload', 'email', 'api', 'sftp', 'sat_download'
    )),
    import_batch_id UUID,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    imported_by UUID,

    -- Processing Status
    processing_status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (processing_status IN (
        'pending', 'validating', 'ready', 'processing',
        'completed', 'rejected', 'error'
    )),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_xml_docs_entity ON xml_documents(entity_id);
CREATE INDEX idx_xml_docs_emisor ON xml_documents(emisor_rfc);
CREATE INDEX idx_xml_docs_receptor ON xml_documents(receptor_rfc);
CREATE INDEX idx_xml_docs_fecha ON xml_documents(cfdi_fecha);
CREATE INDEX idx_xml_docs_status ON xml_documents(processing_status);
CREATE INDEX idx_xml_docs_hash ON xml_documents(xml_hash);

-- ============================================================
-- XML DOCUMENT LINES (Conceptos)
-- ============================================================

CREATE TABLE xml_document_lines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    xml_document_id UUID NOT NULL REFERENCES xml_documents(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,

    -- Product/Service
    clave_prod_serv VARCHAR(10) NOT NULL,
    clave_unidad VARCHAR(10) NOT NULL,
    unidad VARCHAR(50),
    no_identificacion VARCHAR(100),
    descripcion TEXT NOT NULL,

    -- Amounts
    cantidad DECIMAL(19,6) NOT NULL,
    valor_unitario DECIMAL(19,6) NOT NULL,
    importe DECIMAL(19,4) NOT NULL,
    descuento DECIMAL(19,4) DEFAULT 0,

    -- Taxes
    impuestos JSONB,
    objeto_imp VARCHAR(10),

    -- Suggestions
    suggested_account_id UUID REFERENCES accounts(id),
    suggested_cost_center_id UUID,

    UNIQUE(xml_document_id, line_number)
);

CREATE INDEX idx_xml_lines_doc ON xml_document_lines(xml_document_id);
CREATE INDEX idx_xml_lines_clave ON xml_document_lines(clave_prod_serv);

-- ============================================================
-- PRE-REGISTRATIONS (Staging)
-- ============================================================

CREATE TABLE pre_registrations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),

    -- Source
    xml_document_id UUID REFERENCES xml_documents(id),
    source_type VARCHAR(50) NOT NULL CHECK (source_type IN (
        'xml_cfdi', 'manual', 'api', 'recurring', 'import'
    )),

    -- Document Type
    document_type VARCHAR(50) NOT NULL CHECK (document_type IN (
        'bill', 'expense', 'invoice', 'credit_note', 'payment', 'journal_entry'
    )),

    -- Vendor/Customer Matching
    vendor_id UUID REFERENCES vendors(id),
    customer_id UUID REFERENCES customers(id),
    vendor_match_confidence DECIMAL(3,2),
    vendor_match_method VARCHAR(50),
    is_new_vendor BOOLEAN DEFAULT false,
    suggested_vendor_data JSONB,

    -- Header
    external_reference VARCHAR(100),
    document_date DATE NOT NULL,
    due_date DATE,
    currency_code CHAR(3) NOT NULL DEFAULT 'MXN',
    exchange_rate DECIMAL(19,10) DEFAULT 1,

    -- Amounts
    subtotal DECIMAL(19,4) NOT NULL,
    tax_amount DECIMAL(19,4) DEFAULT 0,
    total_amount DECIMAL(19,4) NOT NULL,
    tax_breakdown JSONB,

    -- Lines (denormalized)
    lines JSONB NOT NULL,

    -- Account Mapping
    default_account_id UUID REFERENCES accounts(id),
    account_mapping_confidence DECIMAL(3,2),
    account_mapping_method VARCHAR(50),

    -- Processing Mode
    processing_mode VARCHAR(50) NOT NULL DEFAULT 'manual' CHECK (processing_mode IN (
        'auto', 'batch', 'manual', 'hold'
    )),

    -- Scheduling
    scheduled_batch_id UUID,
    scheduled_process_date DATE,
    batch_priority INTEGER DEFAULT 5,

    -- Validation
    validation_status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (validation_status IN (
        'pending', 'valid', 'warnings', 'invalid', 'needs_review'
    )),
    validation_errors JSONB,
    validation_warnings JSONB,
    validated_at TIMESTAMPTZ,
    validated_by UUID,

    -- Rules Applied
    rules_applied JSONB,

    -- Approval
    requires_approval BOOLEAN DEFAULT false,
    approval_status VARCHAR(50) CHECK (approval_status IN (
        'not_required', 'pending', 'approved', 'rejected'
    )),
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    approval_notes TEXT,

    -- Status
    status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft', 'validating', 'ready', 'queued', 'processing',
        'completed', 'rejected', 'error', 'duplicate'
    )),

    -- Result
    result_type VARCHAR(50),
    result_id UUID,
    journal_entry_id UUID REFERENCES journal_entries(id),
    bill_id UUID REFERENCES bills(id),

    -- Error Handling
    error_message TEXT,
    error_details JSONB,
    retry_count INTEGER DEFAULT 0,
    last_retry_at TIMESTAMPTZ,

    -- Metadata
    notes TEXT,
    tags JSONB,
    custom_fields JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID,
    processed_at TIMESTAMPTZ,
    processed_by UUID
);

CREATE INDEX idx_prereg_entity ON pre_registrations(entity_id);
CREATE INDEX idx_prereg_status ON pre_registrations(status);
CREATE INDEX idx_prereg_mode ON pre_registrations(processing_mode);
CREATE INDEX idx_prereg_xml ON pre_registrations(xml_document_id);
CREATE INDEX idx_prereg_vendor ON pre_registrations(vendor_id);
CREATE INDEX idx_prereg_date ON pre_registrations(document_date);
CREATE INDEX idx_prereg_validation ON pre_registrations(validation_status);
CREATE INDEX idx_prereg_batch ON pre_registrations(scheduled_batch_id);
CREATE INDEX idx_prereg_scheduled ON pre_registrations(scheduled_process_date)
    WHERE processing_mode = 'batch' AND status = 'ready';

-- ============================================================
-- PROCESSING RULES
-- ============================================================

CREATE TABLE processing_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),

    rule_name VARCHAR(255) NOT NULL,
    rule_code VARCHAR(50),
    description TEXT,

    rule_type VARCHAR(50) NOT NULL CHECK (rule_type IN (
        'account_mapping', 'cost_center_mapping', 'vendor_matching',
        'approval_routing', 'processing_mode', 'validation',
        'transformation', 'rejection'
    )),

    priority INTEGER NOT NULL DEFAULT 100,

    conditions JSONB NOT NULL,
    actions JSONB NOT NULL,

    applies_to_document_types VARCHAR(50)[],
    applies_to_vendors UUID[],

    is_active BOOLEAN NOT NULL DEFAULT true,

    is_learned BOOLEAN DEFAULT false,
    learning_source VARCHAR(50),
    confidence_score DECIMAL(3,2),

    times_matched INTEGER DEFAULT 0,
    last_matched_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID,

    UNIQUE(entity_id, rule_code)
);

CREATE INDEX idx_rules_entity ON processing_rules(entity_id);
CREATE INDEX idx_rules_type ON processing_rules(rule_type);
CREATE INDEX idx_rules_active ON processing_rules(is_active) WHERE is_active = true;
CREATE INDEX idx_rules_priority ON processing_rules(priority);

-- ============================================================
-- PROCESSING BATCHES
-- ============================================================

CREATE TABLE processing_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),

    batch_number VARCHAR(50) UNIQUE,
    batch_name VARCHAR(255),
    description TEXT,

    scheduled_date DATE,
    scheduled_time TIME,
    recurrence_rule VARCHAR(100),

    include_filters JSONB,

    auto_post BOOLEAN DEFAULT false,
    notify_on_complete BOOLEAN DEFAULT true,
    notify_emails VARCHAR(255)[],

    status VARCHAR(50) NOT NULL DEFAULT 'scheduled' CHECK (status IN (
        'draft', 'scheduled', 'running',
        'completed', 'completed_with_errors',
        'failed', 'cancelled'
    )),

    total_items INTEGER DEFAULT 0,
    processed_items INTEGER DEFAULT 0,
    successful_items INTEGER DEFAULT 0,
    failed_items INTEGER DEFAULT 0,

    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    results_summary JSONB,
    error_log JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID,
    executed_by UUID
);

CREATE INDEX idx_batches_entity ON processing_batches(entity_id);
CREATE INDEX idx_batches_status ON processing_batches(status);
CREATE INDEX idx_batches_scheduled ON processing_batches(scheduled_date, scheduled_time)
    WHERE status = 'scheduled';

-- ============================================================
-- SAT CODE MAPPINGS (for account suggestions)
-- ============================================================

CREATE TABLE sat_code_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    sat_code VARCHAR(20),
    sat_code_prefix VARCHAR(20),
    account_id UUID NOT NULL REFERENCES accounts(id),
    cost_center_id UUID,
    confidence DECIMAL(3,2) DEFAULT 0.8,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID,
    CHECK (sat_code IS NOT NULL OR sat_code_prefix IS NOT NULL)
);

CREATE INDEX idx_sat_mappings_entity ON sat_code_mappings(entity_id);
CREATE INDEX idx_sat_mappings_code ON sat_code_mappings(sat_code);
CREATE INDEX idx_sat_mappings_prefix ON sat_code_mappings(sat_code_prefix);
