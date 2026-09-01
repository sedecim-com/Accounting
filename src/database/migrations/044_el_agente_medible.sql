-- ============================================================
-- 044: EL AGENTE MEDIBLE — duración, corridas y eventos
--
-- «Medir antes de soltar» era doctrina sin instrumento: la única evidencia
-- que el panel podía ofrecer al decidir ingest_auto_post era un conteo de
-- aprobados/rechazados, y todo lo demás se evaporaba con el proceso — los
-- counts de la ingesta solo se IMPRIMÍAN, la duración de cada llamada al
-- modelo no se guardaba, y los eventos que cuentan la salud del agente
-- (sospecha de inyección, nudge de grounding, failover de proveedor) vivían
-- en stderr. A2 les da tabla:
--
--   · ai_usage.duration_ms — cuánto tardó CADA llamada al modelo. Nullable:
--     las filas anteriores a esta migración no lo saben y no se inventa.
--   · ai_ingest_runs — una fila por corrida de `mnemosine ingest`: los
--     counts por estatus que antes morían en la consola, los borradores
--     creados, y el consumo (tokens, costo estimado, duración) para que
--     «costo por borrador» sea una división y no una conjetura.
--   · ai_agent_events — sospecha / nudge / failover como filas con detalle,
--     no como advertencias fugaces. El delito menor que precede al mayor.
--
-- tenant_id NOT NULL en ambas tablas a propósito: las políticas de
-- aislamiento de rls-policies.sql se derivan del catálogo y cubren
-- automáticamente toda tabla que declare la columna (el patrón de la 021).
-- ============================================================

ALTER TABLE ai_usage
  ADD COLUMN duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0);

CREATE TABLE ai_ingest_runs (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    provider VARCHAR(60) NOT NULL,
    model VARCHAR(100) NOT NULL,
    files_total INTEGER NOT NULL,
    rules_count INTEGER NOT NULL DEFAULT 0,
    auto_post_count INTEGER NOT NULL DEFAULT 0,
    draft_count INTEGER NOT NULL DEFAULT 0,
    blocked_count INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    invalid_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    sospecha_count INTEGER NOT NULL DEFAULT 0,
    drafts_created INTEGER NOT NULL DEFAULT 0,
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    -- NULL = ningún modelo con precio conocido participó (misma semántica
    -- que ai_usage.estimated_cost_usd).
    estimated_cost_usd NUMERIC(12,6),
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    auto_post_enabled BOOLEAN NOT NULL DEFAULT false,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_ingest_runs_entity ON ai_ingest_runs(entity_id, created_at);

CREATE TABLE ai_agent_events (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    kind VARCHAR(30) NOT NULL CHECK (kind IN ('sospecha', 'nudge', 'failover')),
    provider VARCHAR(60),
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_agent_events_kind ON ai_agent_events(tenant_id, kind, created_at);
