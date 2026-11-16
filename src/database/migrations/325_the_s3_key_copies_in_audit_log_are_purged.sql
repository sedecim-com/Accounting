-- ============================================================
-- 325 · THE S3 KEY COPIES IN AUDIT_LOG ARE PURGED (#370 · MNE-001-389)
--
-- While the S3 stub was registered, every successful
-- PUT /v1/admin/integrations/s3 left its body in audit_log.new_values, and no
-- redaction covered `secretAccessKey` or `accessKeyId` then. 102 deleted the
-- keys the stub had stored and could only warn about these copies, because
-- 033 makes audit_log append-only even for its owner. On 2026-09-30 the owner
-- decided (MNE-001-146) to purge them with an explicit migration that records
-- itself, the one road 033 leaves open. This is that migration.
--
-- THE ONE SUSPENSION, AUTHORIZED ON #370 ON 2026-11-15. Only
-- audit_log_append_only is disabled (audit_log_no_truncate stays on), only
-- inside this file's transaction, and it is restored with ENABLE ALWAYS: the
-- seal of 058, tgenabled 'A', which doctor checks. A plain ENABLE would leave
-- 'O'. The trigger is never dropped, so its garantia-sellada comment stays.
-- The suspension, the purge, the record rows, the check and the restore are
-- one DO block, a single statement, so they stay atomic where psql runs this
-- file with no BEGIN, as the postgres image's initdb does: if anything in the
-- block fails, all of it rolls back, the DISABLE included, and it commits only
-- with the ENABLE ALWAYS applied, so no other session ever sees the trigger
-- off. The table comment after the block is a statement of its own. migrate.ts
-- runs the whole file in one transaction, and initdb's ON_ERROR_STOP stops
-- before the comment; only psql without ON_ERROR_STOP would still apply it
-- after a refusal. Writers to audit_log wait from the DISABLE to the COMMIT,
-- and readers too from the check on, which scans the whole table.
--
-- ONLY THE TWO KEY FIELDS, ONLY IN THOSE ROWS. The audit middleware stores
-- PUT as `update`, the first path segment its router sees (`s3`) as
-- entity_type, and the body as new_values; the adapter took both keys at the
-- top level. bucket, region and endpoint stay: none is a credential, and they
-- say which account was attached.
--
-- UNDER RLS. audit_log is under FORCE ROW LEVEL SECURITY and migrate.ts sets
-- the row_security = off floor, so the sanctioned pattern of
-- docs/migraciones.md: the opt-in, and a loop that sets the tenant. The
-- explicit tenant_id keeps each count right where RLS filters nothing: a
-- superuser, which is how every CI job migrates.
--
-- IT RECORDS ITSELF. Each tenant's trail gets one row, zero count included,
-- with this file's name, how many of its rows lost the keys and the two field
-- names as array values, never as keys, which the check below would refuse.
-- Its author is the tenant's system user, created the way ensureSystemUser
-- does if missing. npm run migrate prints no NOTICE: these rows are what an
-- operator reads.
--
-- AND IT CHECKS ITS OWN WORK, as 102 does. A CHECK is validated by a scan RLS
-- does not filter (tests/integration/migration-085-under-rls.int.spec.ts), so
-- a probe that lives only for that scan proves that no row, under any
-- tenant_id, keeps either name as a key of new_values or old_values at any
-- depth. A key left anywhere stops the migration with nothing changed:
-- removing it would mean suspending the trigger outside this migration, which
-- the authorization does not cover.
--
-- SECURITY: no value is selected, decrypted or printed; an error names the
-- places this purge does not reach, never what a key holds. Out of reach: old
-- row versions in the table's files until VACUUM FULL rewrites it, replicas,
-- base backups, WAL archives and dumps made before this ran. Only revoking
-- those keys, in AWS IAM or at the S3-compatible provider a row's endpoint
-- names, makes those copies worthless, and no migration can do that.
-- ============================================================

SET LOCAL row_security = on;
DO $purge$
DECLARE
  t      record;
  purged bigint;
  author uuid;
BEGIN
  ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only;

  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    UPDATE audit_log
       SET new_values = new_values - 'secretAccessKey' - 'accessKeyId'
     WHERE tenant_id = t.id
       AND action = 'update'
       AND entity_type = 's3'
       AND new_values ?| ARRAY['secretAccessKey', 'accessKeyId'];
    GET DIAGNOSTICS purged = ROW_COUNT;

    SELECT id INTO author FROM users WHERE tenant_id = t.id AND email = 'system@mnemosine.local';
    IF NOT FOUND THEN
      -- Not a login: the hash is random and no flow accepts this address.
      INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, is_active, roles)
      VALUES (t.id, 'system@mnemosine.local', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
              'Mnemosine', 'Setup', false, '["system"]'::jsonb)
      RETURNING id INTO author;
    END IF;

    INSERT INTO audit_log (user_id, tenant_id, action, entity_type, entity_id, legal_entity_id, new_values, reason)
    VALUES (author, t.id, 'update', 'audit_log', gen_random_uuid(), NULL,
            jsonb_build_object(
              'migration', '325_the_s3_key_copies_in_audit_log_are_purged.sql',
              'purged_rows', purged,
              'removed_fields', jsonb_build_array('secretAccessKey', 'accessKeyId')),
            'Migration 325 removed secretAccessKey and accessKeyId from this tenant''s '
            || 'PUT /v1/admin/integrations/s3 rows (purged_rows says how many, zero included), '
            || 'as the owner decided on 2026-09-30 (#370, MNE-001-146).');
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);

  BEGIN
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_no_s3_key_probe CHECK (NOT jsonb_path_exists(
      jsonb_build_array(old_values, new_values),
      'strict $.** ? (exists (@."secretAccessKey") || exists (@."accessKeyId"))'));
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'migration 325: audit_log still holds secretAccessKey or accessKeyId as a key this purge does not remove'
      USING DETAIL = 'It is in a row that is not a PUT /v1/admin/integrations/s3 update, below the top level of '
                     || 'new_values, in old_values, or under a tenant_id that is not in tenants. Nothing was changed.',
            HINT = 'Removing it means suspending audit_log_append_only outside this migration, which the '
                   || 'authorization on #370 does not cover: ask the owner there.';
  END;
  ALTER TABLE audit_log DROP CONSTRAINT audit_log_no_s3_key_probe;

  ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_append_only;
END
$purge$;

COMMENT ON TABLE audit_log IS
  'Audit trail: INSERT only. audit_log_append_only (033, sealed by 058) rejects UPDATE and DELETE, audit_log_no_truncate rejects TRUNCATE, and a wrong row is corrected by another row. One purge was made, by migration 325 (#370): with that trigger suspended only inside its own transaction, it removed the S3 access keys PUT /v1/admin/integrations/s3 had copied into new_values, and wrote a row that records it, with its count, into the trail of each tenant that existed when it ran.';
