-- ============================================================
-- 334 · AN ISSUED CFDI BORN 'bill' IS AN INVOICE (#670 · MNE-001-522)
--
-- Before MNE-001-025 (#392) every type I CFDI was pre-registered as 'bill',
-- with its issuer matched as a vendor and the firm's rules run on it. Since
-- then one the entity issued is born 'invoice' with no vendor match
-- (createPreRegistration, pre-registration-service.ts). Nothing re-typed the
-- stored rows, and no door takes one that still says 'bill': the bill path
-- ends at CFDI_ISSUED_BY_ENTITY, and the sale approval and `cfdi post` lock
-- only 'invoice' rows. With its month's SAT census loaded, such a CFDI stays
-- to post and can stop the close.
--
-- WHICH ROWS. An xml_cfdi pre-registration that says 'bill', is open ('draft',
-- 'ready' or 'error') with no bill, entry or result, and whose XML, joined by
-- xml_document_id and entity_id, was issued by its own entity: emisor_rfc
-- equal to legal_entities.tax_id under UPPER(TRIM()), the predicate of the
-- guard in insertarFacturaDePreRegistro. A received bill, a REP, a credit
-- note, a consumed or rejected row and a row with a result do not match and
-- are not touched. The entity is judged by today's RFC, as the guard does.
--
-- WHAT IT WRITES, so the row is as one born today: document_type 'invoice',
-- no vendor, confidence 0, method 'issued_by_entity', not a new vendor, no
-- suggested vendor data. The status, the error text, the processing mode, the
-- rules applied and the tags stay: both sale doors take 'draft', 'ready' and
-- 'error'. A row with a draft in review is re-typed too; left as 'bill' that
-- draft could never be approved. xml_documents is never written.
--
-- AN EXPENSE ACCOUNT IS CLEARED AND KEPT AS A REFERENCE (decision 4 of #670,
-- answered by the owner): a line or default account that is not revenue is
-- removed, so the line asks to be coded, and the line keeps the account it
-- held as previous_account_id, which `cfdi post` prints and never posts. The
-- block that does it says how.
--
-- NOTHING IS POSTED. Each re-typed row waits for `cfdi post` or for the
-- approval of its draft. A legacy row already 'completed' with a bill is a
-- sale booked as an expense: undoing it is a reversal a person decides, and
-- this file only counts those rows in its notice.
--
-- UNDER RLS. pre_registrations, xml_documents, accounts and audit_log are
-- under FORCE ROW LEVEL SECURITY and migrate.ts sets the row_security = off
-- floor, so the sanctioned pattern of docs/migraciones.md: the opt-in, and a
-- loop that sets the tenant. The explicit tenant_id keeps each pass on its own
-- tenant where RLS filters nothing: a superuser, which is how every CI job
-- migrates.
--
-- IT RECORDS EACH ROW. One audit_log row per re-typed pre-registration, built
-- from the UPDATE's own RETURNING, with what the row said before and this
-- file's name as the reason: what a later migration would need to restore it.
-- Under decision 4, old_values also holds the default and each cleared
-- {line_number, account_id}, and new_values each referenced_lines entry.
-- Its author is the tenant's system user, created the way ensureSystemUser
-- does if missing, and only in a tenant where a row changed.
--
-- IDEMPOTENT. A re-typed row no longer says 'bill', so a second run matches no
-- row and writes nothing.
-- ============================================================

SET LOCAL row_security = on;
DO $fix$
DECLARE
  t       record;
  changes jsonb;
  closed  bigint;
  author  uuid;
  audited bigint;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    WITH legacy AS (
      SELECT p.id, p.entity_id,
             (p.status IN ('draft', 'ready', 'error') AND p.bill_id IS NULL
              AND p.journal_entry_id IS NULL AND p.result_id IS NULL) AS open,
             jsonb_build_object(
               'document_type', p.document_type, 'vendor_id', p.vendor_id,
               'vendor_match_confidence', p.vendor_match_confidence, 'vendor_match_method', p.vendor_match_method,
               'is_new_vendor', p.is_new_vendor, 'suggested_vendor_data', p.suggested_vendor_data) AS old
        FROM pre_registrations p
        JOIN legal_entities le ON le.id = p.entity_id AND le.tenant_id = t.id
        JOIN xml_documents x ON x.id = p.xml_document_id AND x.entity_id = p.entity_id
       WHERE p.source_type = 'xml_cfdi' AND p.document_type = 'bill'
         AND UPPER(TRIM(x.emisor_rfc)) = UPPER(TRIM(le.tax_id))
    ), retyped AS (
      UPDATE pre_registrations p
         SET document_type = 'invoice', vendor_id = NULL, vendor_match_confidence = 0,
             vendor_match_method = 'issued_by_entity', is_new_vendor = false, suggested_vendor_data = NULL
        FROM legacy l
       WHERE p.id = l.id AND p.entity_id = l.entity_id AND l.open
         AND p.document_type = 'bill' AND p.status IN ('draft', 'ready', 'error')
         AND p.bill_id IS NULL AND p.journal_entry_id IS NULL AND p.result_id IS NULL
      RETURNING p.id, p.entity_id, l.old,
                jsonb_build_object(
                  'document_type', p.document_type, 'vendor_id', p.vendor_id,
                  'vendor_match_confidence', p.vendor_match_confidence, 'vendor_match_method', p.vendor_match_method,
                  'is_new_vendor', p.is_new_vendor, 'suggested_vendor_data', p.suggested_vendor_data) AS new
    )
    SELECT COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM retyped r), '[]'::jsonb),
           (SELECT count(*) FROM legacy WHERE NOT open)
      INTO changes, closed;

    IF closed > 0 THEN
      RAISE NOTICE 'migration 334: % pre-registration(s) of an issued CFDI left as bill in tenant %: consumed, rejected or not open',
        closed, t.id;
    END IF;
    CONTINUE WHEN jsonb_array_length(changes) = 0;

    -- ── DECISION 4 OF #670: CODING THAT CANNOT BE A SALE'S IS CLEARED, AND KEPT AS A REFERENCE ──
    -- The owner's answer of 19 Nov, «Limpiar y dejar referencia». A rule with
    -- set_account wrote its expense account on every line and as the default
    -- of these rows. `cfdi post` reads both as coding and refuses any account
    -- that is not revenue with a credit balance in the entity; this block
    -- applies that test to the rows re-typed above.
    --   · A line whose own account fails it loses account_id, so it asks to be
    --     coded, and keeps that account as previous_account_id.
    --   · The default, when it fails it, is nulled with its mapping method and
    --     confidence; a line with no account of its own took it, so that line
    --     keeps it as previous_account_id.
    --   · A revenue account, a revenue default and suggested_account_id stay.
    -- previous_account_id is a reference: `cfdi post` prints it beside the
    -- entry and no door reads it as coding, so it never posts. Each cleared
    -- value and each reference joins the row's record in `changes`.
    WITH target AS (
      SELECT p.id, p.entity_id, d.drop_default, l.kept, l.cleared, l.referenced,
             jsonb_build_object('default_account_id', p.default_account_id, 'account_mapping_method', p.account_mapping_method,
                                'account_mapping_confidence', p.account_mapping_confidence) AS was
        FROM pre_registrations p
        JOIN jsonb_to_recordset(changes) AS c(id uuid, entity_id uuid) ON c.id = p.id AND c.entity_id = p.entity_id
       CROSS JOIN LATERAL (
              SELECT (p.default_account_id IS NOT NULL AND NOT EXISTS (
                        SELECT 1 FROM accounts a
                         WHERE a.id = p.default_account_id AND a.entity_id = p.entity_id
                           AND a.account_type = 'revenue' AND a.normal_balance = 'credit')) AS drop_default) d
       CROSS JOIN LATERAL (
              SELECT jsonb_agg(CASE WHEN s.stray
                                    THEN (e.line - 'account_id') || jsonb_build_object('previous_account_id', e.line->'account_id')
                                    WHEN s.inherits
                                    THEN e.line || jsonb_build_object('previous_account_id', p.default_account_id)
                                    ELSE e.line END ORDER BY e.n) AS kept,
                     jsonb_agg(jsonb_build_object('line_number', e.line->'line_number', 'account_id', e.line->'account_id')
                               ORDER BY e.n) FILTER (WHERE s.stray) AS cleared,
                     jsonb_agg(jsonb_build_object('line_number', e.line->'line_number', 'previous_account_id',
                                                  CASE WHEN s.stray THEN e.line->'account_id' ELSE to_jsonb(p.default_account_id) END)
                               ORDER BY e.n) FILTER (WHERE s.stray OR s.inherits) AS referenced
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.lines) = 'array' THEN p.lines ELSE '[]'::jsonb END)
                     WITH ORDINALITY AS e(line, n)
               CROSS JOIN LATERAL (SELECT COALESCE(e.line->>'account_id', '') <> '' AS own) o
               CROSS JOIN LATERAL (
                      SELECT (o.own AND NOT EXISTS (
                                SELECT 1 FROM accounts a
                                 WHERE a.id::text = lower(e.line->>'account_id') AND a.entity_id = p.entity_id
                                   AND a.account_type = 'revenue' AND a.normal_balance = 'credit')) AS stray,
                             (NOT o.own AND d.drop_default) AS inherits) s) l
    ), cleaned AS (
      UPDATE pre_registrations p
         SET lines = CASE WHEN g.referenced IS NULL THEN p.lines ELSE g.kept END,
             default_account_id = CASE WHEN g.drop_default THEN NULL ELSE p.default_account_id END,
             account_mapping_method = CASE WHEN g.drop_default THEN NULL ELSE p.account_mapping_method END,
             account_mapping_confidence = CASE WHEN g.drop_default THEN NULL ELSE p.account_mapping_confidence END
        FROM target g
       WHERE p.id = g.id AND p.entity_id = g.entity_id
         AND p.document_type = 'invoice' AND p.status IN ('draft', 'ready', 'error')
         AND (g.drop_default OR g.referenced IS NOT NULL)
      RETURNING p.id,
                CASE WHEN g.drop_default THEN g.was ELSE '{}'::jsonb END
                  || CASE WHEN g.cleared IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cleared_lines', g.cleared) END AS old,
                CASE WHEN g.drop_default
                     THEN '{"default_account_id": null, "account_mapping_method": null, "account_mapping_confidence": null}'::jsonb
                     ELSE '{}'::jsonb END
                  || CASE WHEN g.cleared IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cleared_lines', '[]'::jsonb) END
                  || CASE WHEN g.referenced IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('referenced_lines', g.referenced) END AS new
    )
    SELECT jsonb_agg(CASE WHEN k.id IS NULL THEN c.item
                          ELSE c.item || jsonb_build_object('old', c.item->'old' || k.old, 'new', c.item->'new' || k.new) END)
      INTO changes
      FROM jsonb_array_elements(changes) AS c(item)
      LEFT JOIN cleaned k ON k.id = (c.item->>'id')::uuid;
    -- ── END OF DECISION 4 ──

    SELECT id INTO author FROM users WHERE tenant_id = t.id AND email = 'system@mnemosine.local';
    IF NOT FOUND THEN
      -- Not a login: the hash is random and no flow accepts this address.
      INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, is_active, roles)
      VALUES (t.id, 'system@mnemosine.local', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
              'Mnemosine', 'Setup', false, '["system"]'::jsonb)
      RETURNING id INTO author;
    END IF;

    INSERT INTO audit_log (user_id, tenant_id, action, entity_type, entity_id, legal_entity_id, old_values, new_values, reason)
    SELECT author, t.id, 'update', 'pre_registrations', f.id, f.entity_id, f.old, f.new,
           '334_an_issued_cfdi_born_bill_is_an_invoice.sql'
      FROM jsonb_to_recordset(changes) AS f(id uuid, entity_id uuid, old jsonb, new jsonb);
    GET DIAGNOSTICS audited = ROW_COUNT;
    IF audited <> jsonb_array_length(changes) THEN
      RAISE EXCEPTION 'migration 334: % pre-registration(s) re-typed and % audit row(s) written in one tenant',
        jsonb_array_length(changes), audited;
    END IF;
    RAISE NOTICE 'migration 334: % pre-registration(s) of an issued CFDI re-typed from bill to invoice in tenant %', audited, t.id;
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END
$fix$;
