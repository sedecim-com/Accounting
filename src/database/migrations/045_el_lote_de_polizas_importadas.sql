-- ============================================================
-- 045: EL LOTE DE PÓLIZAS IMPORTADAS — staging con batch_id
--
-- `mnemosine entry import <file>` PREPARA un archivo de pólizas y
-- devuelve un batch_id SIN tocar el mayor — ni siquiera journal_entries
-- en borrador. Es la única semántica segura para una carga masiva: lo
-- importado se mira, se valida y se aplica DESPUÉS, por la familia
-- `batch` (check/post/reverse), con sus propias compuertas. Un import
-- que creara borradores directos convertiría un archivo de terceros en
-- quinientas filas de cola de revisión sin paso intermedio.
--
-- payload guarda la póliza NORMALIZADA por el parser del layout
-- (fecha, descripción, referencia, líneas con código de cuenta); las
-- filas ilegibles se quedan con su parse_error en vez de perderse: un
-- lote que traga 498 de 500 en silencio es una conciliación futura.
--
-- tenant_id NOT NULL: las políticas de aislamiento derivadas del
-- catálogo (rls-policies.sql) cubren ambas tablas solas.
-- ============================================================

CREATE TABLE journal_entry_import_batches (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    layout VARCHAR(20) NOT NULL,
    file_name TEXT,
    file_hash VARCHAR(64) NOT NULL,
    rows_total INTEGER NOT NULL,
    rows_invalid INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'staged'
        CHECK (status IN ('staged', 'checked', 'posted', 'discarded')),
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_je_import_batches_entity ON journal_entry_import_batches(entity_id, created_at);

CREATE TABLE journal_entry_import_rows (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    batch_id UUID NOT NULL REFERENCES journal_entry_import_batches(id) ON DELETE CASCADE,
    row_number INTEGER NOT NULL,
    payload JSONB NOT NULL,
    parse_error TEXT,
    UNIQUE (batch_id, row_number)
);
