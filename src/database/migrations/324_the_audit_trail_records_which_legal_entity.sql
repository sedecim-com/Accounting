-- MNE-001-324 (task MNE-001-287, issue #103): audit_log records the legal entity.
--
-- audit_log only carried the tenant. `invoice series check` explained a folio
-- gap with any DELETE audit row whose old_values.invoice_number matched, so a
-- draft deleted in entity B "explained" the same folio missing in entity A of
-- the same tenant (folios are per entity: INV-2026-0003 exists in both).
--
-- The column is nullable on purpose: tenant-level facts (users, the tenant
-- itself) belong to no entity, and rows written before this migration cannot
-- be backfilled (the table is append-only, migration 033, and the old rows do
-- not name the entity). A NULL never explains a gap: the check fails closed.
-- No foreign key: an append-only trail must not block, or be cascaded by, the
-- deletion of an entity.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS legal_entity_id UUID;

COMMENT ON COLUMN audit_log.legal_entity_id IS
  'Legal entity the audited fact belongs to; NULL for tenant-level facts and for rows older than migration 324.';

CREATE INDEX IF NOT EXISTS idx_audit_log_legal_entity
  ON audit_log (legal_entity_id, entity_type, action)
  WHERE legal_entity_id IS NOT NULL;
