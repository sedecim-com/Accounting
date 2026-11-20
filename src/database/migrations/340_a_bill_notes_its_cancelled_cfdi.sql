-- ============================================================
-- 340 · A BILL NOTES THAT THE SAT CANCELLED ITS CFDI (#643 · MNE-001-431)
--
-- When the SAT cancels a received CFDI, the mirror (xml_documents) and the
-- census (sat_cfdi_census) learn it, and the bill that carries its UUID did
-- not: bills had no column for it. cfdi_cancellation_noted_at is the moment
-- this system first learned that the SAT reports the bill's CFDI cancelled.
-- NULL means it has not learned that. It is not the SAT's own cancellation
-- date (only the census carries one) and it never reverts.
--
-- WHO WRITES IT. markBillCfdiCancelled (src/services/ap/
-- bill-cfdi-cancellation.ts), from every path that marks the mirror or the
-- census: the census marks, `cfdi status sync` and validateAndUpdate. This
-- file only fills it for the bills whose CFDI is already recorded cancelled.
--
-- NOTHING IS REVERSED. status, amount_due, the entry and the balance stay:
-- what the cancellation means for the books is the accountant's call.
--
-- CONTRACT: schema, compatible. One nullable column and one index. No column
-- changes type and no row is deleted.
--
-- UNDER RLS. bills, xml_documents, sat_cfdi_census and legal_entities are
-- under FORCE ROW LEVEL SECURITY and migrate.ts sets the row_security = off
-- floor, so the sanctioned pattern of docs/migraciones.md: the opt-in, and a
-- loop that sets the tenant. The explicit tenant_id keeps each pass on its own
-- tenant where RLS filters nothing: a superuser, which is how every CI job
-- migrates. rls-policies.sql does not change: its loop already covers bills
-- by entity_id. The backfill leaves updated_at alone: a migration is not an
-- edit of the bill.
--
-- IDEMPOTENT. Each step is IF NOT EXISTS, and a marked bill no longer matches
-- the backfill, so a second run writes nothing.
-- ============================================================

ALTER TABLE bills
    ADD COLUMN IF NOT EXISTS cfdi_cancellation_noted_at TIMESTAMPTZ;

COMMENT ON COLUMN bills.cfdi_cancellation_noted_at IS
    'When this system first learned that the SAT reports the CFDI this bill carries (cfdi_uuid) as cancelled; NULL if it has not. Written by markBillCfdiCancelled and by migration 340; never reverts, and changes no status, balance or entry (MNE-001-431).';

-- The bridge and the backfill match the UUID by lower(), because the mirror
-- and bills keep the XML's letter case and the census reads back lower case.
-- 037's index is on the raw value.
CREATE INDEX IF NOT EXISTS idx_bills_entity_cfdi_lower
    ON bills (entity_id, lower(cfdi_uuid)) WHERE cfdi_uuid IS NOT NULL;

SET LOCAL row_security = on;
DO $mark$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    UPDATE bills b
       SET cfdi_cancellation_noted_at = NOW()
      FROM legal_entities le
     WHERE le.id = b.entity_id AND le.tenant_id = t.id
       AND b.cfdi_uuid IS NOT NULL
       AND b.cfdi_cancellation_noted_at IS NULL
       AND (EXISTS (SELECT 1 FROM xml_documents x
                     WHERE x.entity_id = b.entity_id
                       AND lower(x.cfdi_uuid) = lower(b.cfdi_uuid)
                       AND x.sat_validation_status = 'cancelled')
         OR EXISTS (SELECT 1 FROM sat_cfdi_census c
                     WHERE c.entity_id = b.entity_id
                       AND c.cfdi_uuid::text = lower(b.cfdi_uuid)
                       AND c.sat_status = 'cancelled'));
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END
$mark$;
