-- ============================================================
-- 345 · A CFDI LOOKUP IN ANY LETTER CASE PROBES AN INDEX (#853, MNE-001-723)
--
-- The mirror (xml_documents) and the classifier's trail (cfdi_classifications)
-- keep a CFDI's UUID as the XML carries it, and a person types it as the SAT
-- portal prints it, so the readers compare lower(cfdi_uuid) inside the entity
-- (MNE-001-680 for the mirror, MNE-001-724 for the trail). Each table's
-- unique index is on the raw value, (entity_id, cfdi_uuid) (046 and 015): it
-- serves entity_id and nothing else of that comparison, so a lookup fetches
-- every row of the entity and keeps one. These two indexes are on what the
-- readers compare, as 340 gave bills (idx_bills_entity_cfdi_lower), and the
-- same predicate becomes one probe with no change in the code.
--
-- NOT UNIQUE. Both tables let an entity hold two rows that differ only by
-- letter case, and the readers name both and pick none. A unique index would
-- first need a census of the twins deployed databases already hold: another
-- decision, not taken here.
--
-- NOT PARTIAL. cfdi_uuid is NOT NULL in both tables (005, 015), so there is
-- no row to leave out; bills' index is partial because a bill may carry no
-- CFDI.
--
-- NOT CONCURRENTLY. migrate.ts runs each file inside BEGIN/COMMIT, and
-- CREATE INDEX CONCURRENTLY cannot run in a transaction block. Each plain
-- build holds a SHARE lock on its table until the file commits: reads go on,
-- and an ingestion, a classification or a SAT status update waits for it.
-- On PostgreSQL 16 the two builds read 150,001 synthetic rows of each table
-- (117 MB and 73 MB) in 0.2 s each.
--
-- CONTRACT: schema, compatible. Additive: two indexes, no column, no
-- constraint. No row is read or written, so there is no row-level-security
-- opt-in; an index changes no policy and rls-policies.sql is untouched.
--
-- IDEMPOTENT. IF NOT EXISTS: a second run builds nothing.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_xml_documents_entity_cfdi_lower
    ON xml_documents (entity_id, lower(cfdi_uuid));

CREATE INDEX IF NOT EXISTS idx_cfdi_classifications_entity_cfdi_lower
    ON cfdi_classifications (entity_id, lower(cfdi_uuid));
