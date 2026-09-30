-- ============================================================
-- 310 · THE SAT PACKAGES ARE ARCHIVED BY BYTES (#440 · MNE-001-143)
--
-- EFIRMA-2 2/2: `mnemosine sat package download` keeps every ZIP exactly as
-- the SAT delivered it, with its SHA-256, BEFORE anything is read out of it.
-- A package expires at the SAT 72 hours after it is ready and cannot be asked
-- for again without spending the e.firma, so the bytes are the evidence and
-- the only copy: the census and the XML ingestion are derived from them, and
-- a second run (or a fixed parser) reads them from here instead of calling
-- the SAT.
--
-- One row per (entity, SAT package id). The downloader inserts with
-- ON CONFLICT DO NOTHING, so downloading the same package twice stores it
-- once and the stored bytes are never replaced. Scoped by entity and tenant
-- like 167 (invariant 4).
-- ============================================================

CREATE TABLE sat_download_packages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    request_id UUID NOT NULL REFERENCES sat_download_requests(id),
    package_id VARCHAR(100) NOT NULL,
    zip_content BYTEA NOT NULL,
    zip_sha256 CHAR(64) NOT NULL CHECK (zip_sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    archived_by VARCHAR(255) NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_sat_download_packages UNIQUE (entity_id, package_id)
);

CREATE INDEX idx_sat_download_packages_request ON sat_download_packages (request_id);

COMMENT ON TABLE sat_download_packages IS
  'SAT Descarga Masiva packages exactly as delivered (ZIP bytes + SHA-256). Expire at the SAT after 72 h: this is the only copy.';
