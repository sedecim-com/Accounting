-- ============================================================
-- 167 · THE SAT COUNTS IDENTICAL XML REQUESTS (#440 · MNE-001-142)
--
-- EFIRMA-2 1/2: the Descarga Masiva engine asks the SAT for a period's CFDI
-- (XML or metadata), follows the request and downloads its packages
-- (src/services/sat-download/descarga-masiva.ts).
--
-- `sat_download_requests` is one row per request the engine sends: its
-- parameters, the SAT's request id and the last state the SAT reported.
--
-- `sat_download_quota` is the guard. The SAT allows only a lifetime number
-- of XML requests with the same parameters (code 5002, «se agotó las
-- solicitudes de por vida»: FechaInicial, FechaFinal, RfcEmisor, RfcReceptor)
-- and the published rule is two. The counter lives HERE, under a UNIQUE key
-- and a CHECK, so the refusal comes from the database before any call — not
-- from a process's memory, which two operators or a restart would not share.
-- The engine reserves a slot with one upsert; the third one violates the
-- CHECK and the request never leaves. Metadata requests are not limited that
-- way, so the table only admits request_type 'CFDI'. The table is never
-- purged: the SAT's limit is for life.
--
-- The key is scoped by entity (invariant 4) and not by RFC alone: a UNIQUE
-- over RFC across tenants would let one tenant's upsert collide with a row
-- RLS hides from it.
-- ============================================================

CREATE TABLE sat_download_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    rfc VARCHAR(13) NOT NULL,
    direction VARCHAR(8) NOT NULL CHECK (direction IN ('issued', 'received')),
    request_type VARCHAR(8) NOT NULL CHECK (request_type IN ('CFDI', 'Metadata')),
    -- NOTE: the SAT's FechaInicial/FechaFinal are wall-clock datetimes with
    -- no zone, so they are stored as such.
    period_start TIMESTAMP NOT NULL,
    period_end TIMESTAMP NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'submitted'
        CHECK (status IN ('submitted', 'accepted', 'in_process', 'finished', 'no_data',
                          'error', 'rejected', 'expired', 'failed')),
    sat_request_id VARCHAR(64),
    sat_code VARCHAR(10),
    sat_message TEXT,
    error_key VARCHAR(80),
    cfdi_count INTEGER,
    package_ids TEXT[] NOT NULL DEFAULT '{}',
    actor VARCHAR(255) NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verified_at TIMESTAMPTZ,
    CHECK (period_start < period_end)
);

CREATE INDEX idx_sat_download_requests_entity ON sat_download_requests (entity_id, requested_at DESC);
CREATE UNIQUE INDEX uq_sat_download_requests_sat_id
    ON sat_download_requests (entity_id, sat_request_id) WHERE sat_request_id IS NOT NULL;

CREATE TABLE sat_download_quota (
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    rfc VARCHAR(13) NOT NULL,
    direction VARCHAR(8) NOT NULL CHECK (direction IN ('issued', 'received')),
    request_type VARCHAR(8) NOT NULL CHECK (request_type = 'CFDI'),
    period_start TIMESTAMP NOT NULL,
    period_end TIMESTAMP NOT NULL,
    requests_made SMALLINT NOT NULL DEFAULT 0 CHECK (requests_made BETWEEN 0 AND 2),
    first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_sat_download_quota
        UNIQUE (entity_id, rfc, direction, request_type, period_start, period_end)
);

COMMENT ON TABLE sat_download_quota IS
  'Lifetime count of identical XML requests sent to the SAT Descarga Masiva service (limit 2, code 5002). Never purged.';
