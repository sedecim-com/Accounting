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
-- once, and the database itself refuses to replace or delete the stored
-- bytes (a BEFORE UPDATE/DELETE trigger, the pattern of 033 and 035), to
-- store bytes whose size differs from size_bytes, or to file a package under
-- a request of another tenant or entity. Scoped by entity and tenant like
-- 167 (invariant 4).
-- ============================================================

-- The request a package hangs from must be the same tenant's and entity's.
ALTER TABLE sat_download_requests
    ADD CONSTRAINT uq_sat_download_requests_scope UNIQUE (id, tenant_id, entity_id);

CREATE TABLE sat_download_packages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    request_id UUID NOT NULL,
    package_id VARCHAR(100) NOT NULL,
    zip_content BYTEA NOT NULL,
    zip_sha256 CHAR(64) NOT NULL CHECK (zip_sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    CONSTRAINT ck_sat_download_packages_size CHECK (size_bytes = octet_length(zip_content)),
    archived_by VARCHAR(255) NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_sat_download_packages UNIQUE (entity_id, package_id),
    CONSTRAINT fk_sat_download_packages_request FOREIGN KEY (request_id, tenant_id, entity_id)
        REFERENCES sat_download_requests (id, tenant_id, entity_id)
);

CREATE INDEX idx_sat_download_packages_request ON sat_download_packages (request_id);

COMMENT ON TABLE sat_download_packages IS
  'SAT Descarga Masiva packages exactly as delivered (ZIP bytes + SHA-256). Expire at the SAT after 72 h: this is the only copy.';

-- The bytes are the only copy of a package that expires at the SAT, so they
-- are evidence: no UPDATE and no DELETE, for anyone, the schema owner included.
CREATE OR REPLACE FUNCTION public.sat_download_packages_keep_bytes() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RAISE EXCEPTION
    'sat_download_packages is append-only: % refused. The archived bytes are the evidence of what the SAT delivered.',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;

DROP TRIGGER IF EXISTS sat_download_packages_append_only ON public.sat_download_packages;
CREATE TRIGGER sat_download_packages_append_only
  BEFORE UPDATE OR DELETE ON public.sat_download_packages
  FOR EACH ROW
  EXECUTE FUNCTION public.sat_download_packages_keep_bytes();

-- A TRUNCATE does not fire a FOR EACH ROW trigger.
DROP TRIGGER IF EXISTS sat_download_packages_no_truncate ON public.sat_download_packages;
CREATE TRIGGER sat_download_packages_no_truncate
  BEFORE TRUNCATE ON public.sat_download_packages
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.sat_download_packages_keep_bytes();
