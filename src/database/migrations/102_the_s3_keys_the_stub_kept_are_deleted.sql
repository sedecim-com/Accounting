-- ============================================================
-- 102 · THE S3 KEYS THE STUB KEPT ARE DELETED (#370 · MNE-001-105)
--
-- The S3 adapter was a stub. `configure()` stored each tenant's accessKeyId
-- and secretAccessKey (encrypted) in integration_credentials, `healthCheck()`
-- answered healthy without calling AWS, and `upload()` wrote nothing. The same
-- change that retires the adapter deletes, here, every S3 credential it had
-- stored: nothing reads them any more, and a key nothing uses is only a risk.
--
-- SECURITY: this file never reads a secret. The rows are deleted, not
-- selected; nothing is decrypted; what it prints is counts.
--
-- UNDER RLS. integration_credentials and audit_log are tenant tables under
-- FORCE ROW LEVEL SECURITY, and migrate.ts runs with row_security = off: a
-- bare DELETE here fails with 42501 (before that floor, 040 "purged" zero rows
-- this way). So the sanctioned pattern of docs/migraciones.md: declare the
-- opt-in and iterate tenants.
--
-- AND IT CHECKS ITS OWN WORK. The loop only reaches rows whose tenant_id is a
-- row of `tenants`. A CHECK added to the table is validated by a scan that RLS
-- does not filter (tests/integration/migration-085-under-rls.int.spec.ts), so
-- a CHECK (provider <> 's3') that exists only for the length of that scan
-- proves no S3 row is left anywhere, or stops the migration saying what to do.
-- The schema does not change: the probe is dropped in the same breath.
--
-- WHAT IT CANNOT DELETE, AND SAYS SO. The audit middleware logged the body of
-- every successful PUT /v1/admin/integrations/s3 into audit_log.new_values,
-- and its redaction matches whole field names: `secretAccessKey` is not one.
-- audit_log is append-only even for this role (033), so those copies stay. The
-- migration counts them and raises a WARNING: those access keys have to be
-- deleted in AWS IAM, which no migration can do.
-- ============================================================

SET LOCAL row_security = on;
DO $purge$
DECLARE
  t             record;
  deleted       bigint;
  deleted_total bigint := 0;
  tenants_hit   bigint := 0;
  logged        bigint;
  logged_total  bigint := 0;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    DELETE FROM integration_credentials WHERE provider = 's3';
    GET DIAGNOSTICS deleted = ROW_COUNT;
    IF deleted > 0 THEN
      deleted_total := deleted_total + deleted;
      tenants_hit := tenants_hit + 1;
    END IF;

    SELECT count(*) INTO logged FROM audit_log WHERE new_values ? 'secretAccessKey';
    logged_total := logged_total + logged;
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);

  BEGIN
    ALTER TABLE integration_credentials
      ADD CONSTRAINT integration_credentials_no_s3_probe CHECK (provider <> 's3');
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'migration 102: integration_credentials still holds S3 credentials under a tenant_id that is not in tenants'
      USING HINT = 'As a superuser: DELETE FROM integration_credentials WHERE provider = ''s3''; then migrate again (#370).';
  END;
  ALTER TABLE integration_credentials DROP CONSTRAINT integration_credentials_no_s3_probe;

  RAISE NOTICE 'migration 102: deleted % stored S3 credential row(s) in % tenant(s)', deleted_total, tenants_hit;
  IF logged_total > 0 THEN
    RAISE WARNING 'migration 102: % audit_log row(s) keep an S3 access key as it was sent to PUT /v1/admin/integrations/s3', logged_total
      USING HINT = 'audit_log is append-only (033) and keeps them: delete those access keys in AWS IAM (#370).';
  END IF;
END
$purge$;
