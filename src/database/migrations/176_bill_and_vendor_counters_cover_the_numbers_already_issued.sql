-- ============================================================
-- 176 · THE BILL AND VENDOR COUNTERS COVER THE NUMBERS ALREADY ISSUED (#432, MNE-001-399)
--
-- Migrations 043 and 048 seeded the annual counters once. Afterwards the
-- inbox kept writing bills with COUNT(*) + 1 (BILL-2026-00121 and the like),
-- and the three vendor writers (`vendor create`, the inbox, the opening-bills
-- migration) numbered with COUNT(*) + 1 and never touched `vendor_<year>`.
-- From this release all of them draw from entity_sequences, so the counters
-- must start at or above every number already issued, or the first draw
-- collides with UNIQUE(bill_number, entity_id) / UNIQUE(vendor_number, entity_id).
--
-- Same pattern as 048: one pass per tenant with app.current_tenant set (RLS),
-- GREATEST so a counter already ahead is never moved back, idempotent.
-- Numbers with another shape (a hand-set 'V-TEST-1') do not match the regex
-- and are ignored: they cannot collide with a generated one.
-- ============================================================

SET LOCAL row_security = on;
DO $reseed$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id,
           'bill_' || substring(bill_number from 6 for 4),
           max(split_part(bill_number, '-', 3)::bigint)
      FROM bills
     WHERE bill_number ~ '^BILL-\d{4}-\d+$'
     GROUP BY entity_id, substring(bill_number from 6 for 4)
    ON CONFLICT (entity_id, name)
    DO UPDATE SET value = GREATEST(entity_sequences.value, EXCLUDED.value);

    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id,
           'vendor_' || substring(vendor_number from 3 for 4),
           max(split_part(vendor_number, '-', 3)::bigint)
      FROM vendors
     WHERE vendor_number ~ '^V-\d{4}-\d+$'
     GROUP BY entity_id, substring(vendor_number from 3 for 4)
    ON CONFLICT (entity_id, name)
    DO UPDATE SET value = GREATEST(entity_sequences.value, EXCLUDED.value);
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END
$reseed$;
