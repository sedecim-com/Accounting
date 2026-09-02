-- ============================================================
-- 049 · COBRAR (F03)
--
-- Cuatro piezas, una fase:
--
-- 1. LAS NOTAS DE CRÉDITO EXISTEN. Hasta hoy el sistema podía facturar y
--    cobrar pero no devolver: no había tabla, y el plan de póliza de la
--    taxonomía CFDI (egreso_emitido_nota_credito) apuntaba a un documento
--    que no se podía crear. La nota vive como documento propio con folio
--    (CN), se postea al emitir (DR devoluciones + DR IVA / CR CxC) y se
--    aplica a facturas SIN asiento adicional: el mayor se movió al emitir,
--    la aplicación reparte ese crédito en el auxiliar.
--
-- 2. EL COBRO A CUENTA. payment_allocations gana las columnas que vuelven
--    la aplicación un EVENTO con historia: el IVA que liberó (para poder
--    desaplicarla exacta) y su desaplicación (quién, cuándo, por qué) —
--    desaplicar no borra la fila, la clausura. El CHECK de amount_applied
--    sigue en > 0 a propósito: la historia se cuenta con columnas, no con
--    filas negativas.
--
-- 3. EL COBRO DEVUELTO. customer_payments admite 'reversed': un cheque que
--    rebota no es 'void' (nunca debió existir) — ocurrió y se deshizo, y
--    ese matiz es exactamente lo que un auditor pregunta. reversed_at
--    completa el rastro junto al audit_log.
--
-- 4. EL PERFIL FISCAL DEL CLIENTE. Régimen, CP y UsoCFDI: los tres datos
--    sin los cuales un CFDI 4.0 nominativo es incancelable de origen
--    (el SAT rechaza el timbrado si no casan con el padrón). Vivían en
--    ninguna parte; facturar sin ellos es facturar a ciegas.
-- ============================================================

CREATE TABLE credit_notes (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    credit_note_number VARCHAR(50) NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id),
    -- La factura de origen, cuando vive en el sistema. Puede ser NULL: una
    -- nota sobre una factura pre-mnemosine se liga por relates_to_uuid.
    invoice_id UUID REFERENCES invoices(id),
    -- UUID del CFDI original (TipoRelacion 01/03) cuando la factura no está
    -- en el sistema o cuando se quiere el lazo fiscal explícito.
    relates_to_uuid VARCHAR(36),
    type VARCHAR(20) NOT NULL
        CHECK (type IN ('devolucion', 'descuento', 'correccion', 'anticipo')),
    credit_date DATE NOT NULL,
    subtotal DECIMAL(19,4) NOT NULL,
    tax_amount DECIMAL(19,4) NOT NULL DEFAULT 0,
    total_amount DECIMAL(19,4) NOT NULL CHECK (total_amount > 0),
    amount_applied DECIMAL(19,4) NOT NULL DEFAULT 0,
    currency_code CHAR(3) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'issued', 'applied', 'void')),
    journal_entry_id UUID REFERENCES journal_entries(id),
    -- El CFDI tipo E de la propia nota, cuando el timbrado exista (§5).
    cfdi_uuid VARCHAR(36),
    reason TEXT,
    memo TEXT,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (credit_note_number, entity_id)
);

CREATE INDEX idx_credit_notes_entity_status ON credit_notes(entity_id, status);
CREATE INDEX idx_credit_notes_customer ON credit_notes(customer_id);
CREATE INDEX idx_credit_notes_invoice ON credit_notes(invoice_id) WHERE invoice_id IS NOT NULL;

CREATE TABLE credit_note_applications (
    id UUID PRIMARY KEY,
    credit_note_id UUID NOT NULL REFERENCES credit_notes(id),
    invoice_id UUID NOT NULL REFERENCES invoices(id),
    amount_applied DECIMAL(19,4) NOT NULL CHECK (amount_applied > 0),
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credit_note_applications_note ON credit_note_applications(credit_note_id);
CREATE INDEX idx_credit_note_applications_invoice ON credit_note_applications(invoice_id);

-- La aplicación de un cobro como evento con historia: el IVA que liberó
-- (guardado al aplicar, para desaplicar EXACTO y no re-derivarlo bajo otro
-- contexto) y su clausura. Una fila con unapplied_at es historia, no estado.
ALTER TABLE payment_allocations
    ADD COLUMN iva_reclass_amount DECIMAL(19,4),
    ADD COLUMN unapplied_at TIMESTAMPTZ,
    ADD COLUMN unapplied_by UUID,
    ADD COLUMN unapply_reason TEXT;

-- 'reversed': el cobro ocurrió y rebotó (NSF). Distinto de 'void' — que
-- nunca debió existir — y ese matiz es lo que el auditor pregunta.
ALTER TABLE customer_payments
    DROP CONSTRAINT customer_payments_status_check;
ALTER TABLE customer_payments
    ADD CONSTRAINT customer_payments_status_check
        CHECK (status IN ('draft', 'pending', 'processing', 'completed', 'failed', 'void', 'reversed'));
ALTER TABLE customer_payments
    ADD COLUMN reversed_at TIMESTAMPTZ;

-- El perfil fiscal que el CFDI 4.0 exige que case con el padrón del SAT:
-- régimen (c_RegimenFiscal, '601'...), CP del domicilio fiscal y UsoCFDI
-- (c_UsoCFDI, 'G03'...). Los catálogos viven en código (sat-catalogs.ts) y
-- la validación en el servicio: un CHECK duro aquí obligaría a una
-- migración cada vez que el SAT publica un código nuevo.
ALTER TABLE customers
    ADD COLUMN tax_regime VARCHAR(3),
    ADD COLUMN tax_postal_code VARCHAR(5),
    ADD COLUMN uso_cfdi VARCHAR(4);
