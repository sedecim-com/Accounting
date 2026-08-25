-- ============================================================
-- 017: Fixes policy_decisions uniqueness
--
-- The UNIQUE (tenant_id, entity_id, key) does NOT prevent duplicates
-- when entity_id is NULL: in SQL NULL != NULL, so the constraint
-- simply does not apply to tenant-scoped policies — and every call
-- to seedPolicies() inserted another copy (10 → 20 → 30…).
--
-- Replaced by two partial unique indexes, which cover both cases.
-- ============================================================

-- Clean up duplicates keeping the oldest of each key. This
-- prefers the resolved one if it exists, so no definition is lost.
DELETE FROM policy_decisions p
USING policy_decisions q
WHERE p.tenant_id = q.tenant_id
  AND p.key = q.key
  AND p.entity_id IS NULL AND q.entity_id IS NULL
  AND (
    -- q wins: it is resolved and p is not
    (q.status = 'resolved' AND p.status != 'resolved')
    -- or both equally resolved and q is older
    OR ((q.status = 'resolved') = (p.status = 'resolved') AND q.created_at < p.created_at)
    -- stable tie-break by id
    OR ((q.status = 'resolved') = (p.status = 'resolved') AND q.created_at = p.created_at AND q.id < p.id)
  );

ALTER TABLE policy_decisions
  DROP CONSTRAINT IF EXISTS policy_decisions_tenant_id_entity_id_key_key;

-- Tenant scope (entity_id IS NULL): one row per key
CREATE UNIQUE INDEX uq_policy_tenant_scope
    ON policy_decisions (tenant_id, key)
    WHERE entity_id IS NULL;

-- Entity scope: one row per key and entity
CREATE UNIQUE INDEX uq_policy_entity_scope
    ON policy_decisions (tenant_id, entity_id, key)
    WHERE entity_id IS NOT NULL;
