-- ============================================================
-- 015: ACCOUNTING ROLES PER ENTITY
-- The CFDI taxonomy expresses entries using abstract ROLES
-- ('iva_pendiente_acreditar'); this table grounds them to each
-- entity's concrete chart of accounts. Without it, the taxonomy would
-- have hardcoded account codes and be useless for another chart.
-- ============================================================

CREATE TABLE account_roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    role VARCHAR(60) NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(id),

    -- A role can have per-context variants (e.g. 'gasto' depending on
    -- the vendor or the product key). NULL = the role's default.
    qualifier VARCHAR(120),

    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (entity_id, role, qualifier)
);

CREATE INDEX idx_account_roles_entity ON account_roles(entity_id, role);
CREATE INDEX idx_account_roles_tenant ON account_roles(tenant_id);

-- ============================================================
-- CFDI CLASSIFICATION
-- Leaves a trail of WHY an XML was recorded the way it was:
-- which taxonomy case applied, which decisions were made and
-- who made them. This is the traceability an audit demands.
-- ============================================================

CREATE TABLE cfdi_classifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    xml_document_id UUID REFERENCES xml_documents(id),

    cfdi_uuid VARCHAR(36) NOT NULL,
    tipo_comprobante VARCHAR(2) NOT NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('emitido','recibido','ajeno')),
    case_id VARCHAR(60) NOT NULL,

    -- Normalized facts the decision was based on (audit)
    facts JSONB NOT NULL,
    -- Pending or resolved decisions: [{id, answer, answered_by, question_id}]
    decisions JSONB NOT NULL DEFAULT '[]',

    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','ready','blocked','posted','skipped')),
    blocked_reason TEXT,

    journal_entry_id UUID REFERENCES journal_entries(id),
    ai_draft_id UUID REFERENCES ai_drafts(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (entity_id, cfdi_uuid)
);

CREATE INDEX idx_cfdi_class_status ON cfdi_classifications(entity_id, status);
CREATE INDEX idx_cfdi_class_case ON cfdi_classifications(case_id);
