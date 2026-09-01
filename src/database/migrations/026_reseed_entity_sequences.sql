-- ============================================================
-- 026: re-seed entity_sequences, TENANT-AWARE
-- 025's seed ran as the schema owner with no tenant context and
-- FORCE RLS filtered every source row: it seeded nothing.
-- ============================================================

-- Seeding must run PER TENANT: these source tables are under FORCE ROW
-- LEVEL SECURITY, so a plain SELECT here (owner, no tenant context) reads
-- ZERO rows and silently seeds nothing — numbering would then restart at 1
-- and collide with existing document numbers. The tenants table is excluded
-- from RLS, so the loop can enumerate it.
--
-- El opt-in: migrate.ts corre la sesión con row_security=off, que convierte
-- el filtrado silencioso en error 42501. Este bucle SÍ maneja RLS a
-- propósito (GUC por inquilino), así que lo declara; SET LOCAL muere con la
-- transacción de esta migración.
SET LOCAL row_security = on;
DO $seed$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id, 'journal_entry',
           GREATEST(COUNT(*), COALESCE(MAX(NULLIF(substring(entry_number from '([0-9]+)$'), '')::bigint), 0))
    FROM journal_entries GROUP BY entity_id
    ON CONFLICT (entity_id, name) DO NOTHING;

    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id, 'invoice',
           GREATEST(COUNT(*), COALESCE(MAX(NULLIF(substring(invoice_number from '([0-9]+)$'), '')::bigint), 0))
    FROM invoices GROUP BY entity_id
    ON CONFLICT (entity_id, name) DO NOTHING;

    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id, 'bill',
           GREATEST(COUNT(*), COALESCE(MAX(NULLIF(substring(bill_number from '([0-9]+)$'), '')::bigint), 0))
    FROM bills GROUP BY entity_id
    ON CONFLICT (entity_id, name) DO NOTHING;

    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id, 'customer_payment',
           GREATEST(COUNT(*), COALESCE(MAX(NULLIF(substring(payment_number from '([0-9]+)$'), '')::bigint), 0))
    FROM customer_payments GROUP BY entity_id
    ON CONFLICT (entity_id, name) DO NOTHING;

    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id, 'vendor_payment',
           GREATEST(COUNT(*), COALESCE(MAX(NULLIF(substring(payment_number from '([0-9]+)$'), '')::bigint), 0))
    FROM vendor_payments GROUP BY entity_id
    ON CONFLICT (entity_id, name) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END
$seed$;
