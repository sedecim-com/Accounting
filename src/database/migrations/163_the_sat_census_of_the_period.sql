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
-- Loading the same file twice changes nothing but `last_loaded_at` and
-- `last_load_id`. A metadata file is the SAT's own record, so it refreshes
-- the descriptive columns a ZIP of XML wrote first. The SAT status: a CFDI cancelled at the SAT
-- cannot become current again, so once `cancelled` it stays `cancelled` even
-- if an older metadata file is loaded afterwards. A ZIP of XML says nothing
-- about status (NULL) and never overwrites what a metadata file said.
--
-- ── EVERY TYPE IS KEPT; WHICH ONES COUNT IS THE PANEL'S ──────────────────
--
-- The census stores what the SAT says exists, all five types. Which of them
-- count toward completeness at close is the firm's judgement, the policy key
-- `census_cfdi_types` (I, E, P by default): filtering at load would make «the
-- SAT has no payroll CFDI» and «payroll was filtered out» the same row.
--
-- ── EACH LOAD IS RECORDED (sat_census_loads) ────────────────────────────
--
-- A census row says a CFDI exists; it cannot say that a month is complete.
-- The SAT hands out issued and received separately, so a firm that loaded
-- only August's «recibidos» has no issued rows, and without a record of the
-- load that reads as «the SAT says nothing was issued». Each file loaded
-- leaves one row: what it was (kind, name, SHA-256), what it covered as
-- observed (issued and received counts, first and last issue date), what it
-- rejected, and who loaded it. MNE-001-119 tells «not loaded» from «nothing
-- exists» by reading it.
--
-- ── NO tenant_id COLUMN, ON PURPOSE ─────────────────────────────────────
--
-- Same shape as 059, 079 and 083: with `entity_id` alone the generic policy of
-- `rls-policies.sql` ties the row to the tenant through `legal_entities`.
-- ============================================================

CREATE TABLE sat_census_loads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    source VARCHAR(10) NOT NULL CHECK (source IN ('metadata', 'xml')),
    -- The file as given: its base name (display only) and its SHA-256.
    file_name TEXT NOT NULL,
    file_sha256 CHAR(64) NOT NULL,
    -- What the file covered, as observed in its valid rows. An empty file
    -- leaves zeros and NULL dates: the load happened and saw nothing.
    issued_count INTEGER NOT NULL CHECK (issued_count >= 0),
    received_count INTEGER NOT NULL CHECK (received_count >= 0),
    first_issued_at TIMESTAMP,
    last_issued_at TIMESTAMP,
    -- Rows of another RFC, and rows that did not read.
    foreign_count INTEGER NOT NULL CHECK (foreign_count >= 0),
    invalid_count INTEGER NOT NULL CHECK (invalid_count >= 0),
    loaded_by UUID REFERENCES users(id),
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sat_census_loads_entity ON sat_census_loads (entity_id, loaded_at);

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
    -- The load that last stated this row.
    last_load_id UUID NOT NULL REFERENCES sat_census_loads(id),

    UNIQUE (entity_id, cfdi_uuid)
);

CREATE INDEX idx_sat_cfdi_census_period ON sat_cfdi_census (entity_id, issued_at);
