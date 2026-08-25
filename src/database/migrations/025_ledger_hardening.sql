-- ============================================================
-- 025: LEDGER HARDENING
-- (1) entity_sequences: atomic per-entity document numbering.
--     COUNT(*)-based numbering collided under concurrency on
--     UNIQUE(entry_number, entity_id). The UPSERT row-lock
--     serializes increments per (entity, name).
--     Seeded with GREATEST(row count, max numeric suffix) so new
--     numbers never collide with historical ones even where rows
--     were deleted.
-- (2) entry_type CHECK gains 'auto_bill' (vendor bills now post
--     to the GL with their own type instead of borrowing auto_invoice).
-- (3) Partial unique index: one journal entry per source document
--     for the AR/AP wiring (invoice/bill/customer_payment/vendor_payment).
--     Backstop behind the journal_entry_id guard on the documents.
-- ============================================================

CREATE TABLE IF NOT EXISTS entity_sequences (
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    name VARCHAR(50) NOT NULL,
    value BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (entity_id, name)
);

-- Seeding must run PER TENANT: these source tables are under FORCE ROW
-- LEVEL SECURITY, so a plain SELECT here (owner, no tenant context) reads
-- ZERO rows and silently seeds nothing — numbering would then restart at 1
-- and collide with existing document numbers. The tenants table is excluded
-- from RLS, so the loop can enumerate it.
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

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_entry_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_entry_type_check
    CHECK (entry_type IN (
        'standard', 'adjusting', 'closing', 'reversing', 'correction',
        'auto_invoice', 'auto_bill', 'auto_payment', 'auto_depreciation', 'auto_reconciliation',
        'payroll'
    ));

CREATE UNIQUE INDEX IF NOT EXISTS uq_je_document_source
    ON journal_entries (entity_id, source_type, source_id)
    WHERE source_type IN ('invoice', 'bill', 'customer_payment', 'vendor_payment');
