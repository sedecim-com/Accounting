-- ============================================================
-- 328 · A CFDI BILL HEADER HOLDS VAT ALONE (#691 · MNE-001-554)
--
-- Until MNE-001-488 both doors that make a bill from a received CFDI copied
-- pre_registrations.tax_amount, the XML's total of transferred taxes, to
-- bills.tax_amount. On a CFDI with IEPS that is VAT plus IEPS, and every
-- reader takes the column as VAT: the payment's release, the short payment,
-- the REP's cross-check and the DIOT. The writers are fixed; this corrects the
-- headers they already stored.
--
-- WHICH BILLS. A bill linked by bill_id to an xml_cfdi pre-registration of its
-- own entity whose stored summary lists at least one transfer that is not VAT
-- (002), and whose header still equals that pre-registration's tax_amount: the
-- figure the old writer left. A header somebody edited, a VAT-only CFDI, a
-- bill with no pre-registration and a pre-registration with no summary do not
-- match and are not touched. The new header is the sum of the 002 transfers,
-- read from the same JSON as billHeaderVat (pre-registration-service.ts): the
-- parser stores the key as a number, so it is padded to three digits, and each
-- amount is rounded to cents before it is added.
--
-- NO ENTRY IS POSTED. A payment made before this ran released VAT pro rata of
-- the old header; that excess stays in the ledger, where the IVA workpaper's
-- tie-out shows it. Dating its correction is an accounting choice this
-- migration does not make.
--
-- UNDER RLS. bills, pre_registrations and audit_log are under FORCE ROW LEVEL
-- SECURITY and migrate.ts sets the row_security = off floor, so the sanctioned
-- pattern of docs/migraciones.md: the opt-in, and a loop that sets the tenant.
-- The explicit tenant_id keeps each pass on its own tenant where RLS filters
-- nothing: a superuser, which is how every CI job migrates.
--
-- IT RECORDS EACH BILL. One audit_log row per changed bill, built from the
-- UPDATE's own RETURNING, with the old and the new figure and this file's name
-- as the reason: what a later migration would need to restore a header. Its
-- author is the tenant's system user, created the way ensureSystemUser does if
-- missing, and only in a tenant where a bill changed.
--
-- IDEMPOTENT. Once a header is the 002 sum it no longer equals the
-- pre-registration's total, so a second run matches no row and writes nothing.
-- ============================================================

SET LOCAL row_security = on;
DO $fix$
DECLARE
  t       record;
  changes jsonb;
  author  uuid;
  audited bigint;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    WITH candidate AS (
      -- One pre-registration per bill, the oldest, as the REP linkage reads it.
      SELECT DISTINCT ON (p.bill_id) p.bill_id, p.entity_id, p.tax_amount AS stored, s.vat
        FROM pre_registrations p
        JOIN legal_entities le ON le.id = p.entity_id AND le.tenant_id = t.id
       CROSS JOIN LATERAL (
              SELECT COALESCE(SUM(round(COALESCE((x->>'importe')::numeric, 0), 2))
                                FILTER (WHERE lpad(COALESCE(x->>'impuesto', ''), 3, '0') = '002'), 0) AS vat,
                     count(*) FILTER (WHERE lpad(COALESCE(x->>'impuesto', ''), 3, '0') <> '002') AS other
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.tax_breakdown->'traslados') = 'array'
                                               THEN p.tax_breakdown->'traslados' ELSE '[]'::jsonb END) x) s
       WHERE p.source_type = 'xml_cfdi' AND p.bill_id IS NOT NULL AND s.other > 0
       ORDER BY p.bill_id, p.created_at, p.id
    ), fixed AS (
      UPDATE bills b
         SET tax_amount = c.vat
        FROM candidate c
       WHERE b.id = c.bill_id
         AND b.entity_id = c.entity_id
         AND b.tax_amount = c.stored
         AND b.tax_amount <> c.vat
      RETURNING b.id, b.entity_id, c.stored::numeric(19,4)::text AS was, b.tax_amount::text AS now
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(fixed)), '[]'::jsonb) INTO changes FROM fixed;

    CONTINUE WHEN jsonb_array_length(changes) = 0;

    SELECT id INTO author FROM users WHERE tenant_id = t.id AND email = 'system@mnemosine.local';
    IF NOT FOUND THEN
      -- Not a login: the hash is random and no flow accepts this address.
      INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, is_active, roles)
      VALUES (t.id, 'system@mnemosine.local', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
              'Mnemosine', 'Setup', false, '["system"]'::jsonb)
      RETURNING id INTO author;
    END IF;

    INSERT INTO audit_log (user_id, tenant_id, action, entity_type, entity_id, legal_entity_id, old_values, new_values, reason)
    SELECT author, t.id, 'update', 'bill', f.id, f.entity_id,
           jsonb_build_object('tax_amount', f.was), jsonb_build_object('tax_amount', f.now),
           '328_a_cfdi_bill_header_holds_vat_alone.sql'
      FROM jsonb_to_recordset(changes) AS f(id uuid, entity_id uuid, was text, now text);
    GET DIAGNOSTICS audited = ROW_COUNT;
    IF audited <> jsonb_array_length(changes) THEN
      RAISE EXCEPTION 'migration 328: % bill header(s) changed and % audit row(s) written in one tenant',
        jsonb_array_length(changes), audited;
    END IF;
    RAISE NOTICE 'migration 328: % bill header(s) corrected in tenant %', audited, t.id;
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END
$fix$;

COMMENT ON COLUMN bills.tax_amount IS
  'CONTRACT: the VAT of the bill. For a bill made from a received CFDI it is the CFDI''s VAT (Impuesto 002) alone, never IEPS or another transferred tax (MNE-001-488; headers stored before it were corrected by migration 328). The payment''s VAT release, the short payment, the REP cross-check and the DIOT read it as VAT.';
