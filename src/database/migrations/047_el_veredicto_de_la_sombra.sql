-- ============================================================
-- 047: EL VEREDICTO DE LA SOMBRA — medir antes de soltar, con tabla
--
-- ingest_auto_post gana la opción 'shadow' (A4): las compuertas del
-- auto-posteo corren COMPLETAS y el veredicto se registra — «habría
-- posteado» o «no, y por esto» — pero nada toca el mayor. Cuando el
-- humano después aprueba o rechaza el borrador, el cruce
-- veredicto-vs-decisión es la CONCORDANCIA: la evidencia con la que
-- resolvePolicy acepta (o rechaza) encender 'on'. Convierte el
-- encendido en una decisión con historial, no con pálpito.
--
-- Un veredicto por borrador (UNIQUE): la sombra opina una vez, cuando
-- el documento se ingiere; reprocesos no reescriben la opinión.
-- tenant_id NOT NULL: las políticas de aislamiento derivadas del
-- catálogo cubren la tabla solas.
-- ============================================================

CREATE TABLE ai_shadow_verdicts (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    draft_id UUID NOT NULL REFERENCES ai_drafts(id) ON DELETE CASCADE,
    would_auto_post BOOLEAN NOT NULL,
    motivo TEXT NOT NULL,
    -- Los umbrales VIGENTES al opinar, con su fuente: un veredicto sin sus
    -- supuestos no se puede auditar meses después.
    thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (draft_id)
);

CREATE INDEX idx_ai_shadow_verdicts_entity ON ai_shadow_verdicts(entity_id, created_at);
