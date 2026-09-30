-- ============================================================
-- 163 · THE SAT CENSUS OF THE PERIOD (MNE-001-096 · #312)
--
-- What the SAT says exists for an entity: one row per CFDI UUID, loaded from
-- the metadata file (`~`-separated) or the ZIP of XML the firm downloads from
-- the SAT portal (`mnemosine ingest --kind metadata|zip`). MNE-001-119 reads
-- it against what was posted; the bulk-download service (#440) will feed the
-- same table through the same loader.
--
-- ── ONE ROW PER (ENTITY, UUID), NOT PER UUID ─────────────────────────────
--
-- An intercompany CFDI belongs to the census of BOTH entities: issued for one,
-- received for the other. `xml_documents.cfdi_uuid` is globally unique and
-- would collide there; this table does not repeat that.
--
-- ── A LOAD REFRESHES, A CANCELLATION STAYS ──────────────────────────────
--
-- Loading the same file twice changes nothing but `last_loaded_at`. The only
-- fact a later file can add is the SAT status: a CFDI cancelled at the SAT
-- cannot become current again, so once `cancelled` it stays `cancelled` even
-- if an older metadata file is loaded afterwards. A ZIP of XML says nothing
-- about status (NULL) and never overwrites what a metadata file said.
--
-- ── NO tenant_id COLUMN, ON PURPOSE ─────────────────────────────────────
--
-- Same shape as 059, 079 and 083: with `entity_id` alone the generic policy of
-- `rls-policies.sql` ties the row to the tenant through `legal_entities`.
-- ============================================================

CREATE TABLE sat_cfdi_census (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    cfdi_uuid UUID NOT NULL,

    -- Relative to the entity: issued when it is the issuer, received when it
    -- is the receiver. A row that names neither never gets here.
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('issued', 'received')),
    -- EfectoComprobante / TipoDeComprobante: I, E, T, N, P.
    cfdi_type CHAR(1) NOT NULL CHECK (cfdi_type IN ('I', 'E', 'T', 'N', 'P')),
    issuer_rfc VARCHAR(13) NOT NULL,
    receiver_rfc VARCHAR(13) NOT NULL,
    -- The CFDI's own wall-clock date (Mexico local time, as the SAT prints it).
    issued_at TIMESTAMP NOT NULL,
    amount NUMERIC(19, 6) NOT NULL,

    -- NULL when the source does not say (a ZIP of XML).
    sat_status VARCHAR(10) CHECK (sat_status IN ('current', 'cancelled')),
    cancelled_at TIMESTAMP,

    -- Where the row was first seen.
    source VARCHAR(10) NOT NULL CHECK (source IN ('metadata', 'xml')),
    first_loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (entity_id, cfdi_uuid)
);

CREATE INDEX idx_sat_cfdi_census_period ON sat_cfdi_census (entity_id, issued_at);
