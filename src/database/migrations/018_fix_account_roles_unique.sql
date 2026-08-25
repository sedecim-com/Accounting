-- ============================================================
-- 018: Fixes account_roles uniqueness (same NULL trap as 017)
--
-- UNIQUE (entity_id, role, qualifier) does not prevent duplicates
-- when qualifier is NULL — and NULL is precisely the common case
-- (the role's default account). Every seed run re-inserted the
-- whole map.
--
-- Two partial unique indexes cover both cases: default role and
-- qualified role.
-- ============================================================

-- Deduplicate with ROW_NUMBER: a self-join with pairwise comparisons
-- leaves copies behind when several rows share created_at, which is
-- exactly what happens when a seed inserts them in one transaction.
DELETE FROM account_roles
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY entity_id, role, COALESCE(qualifier, '')
             ORDER BY created_at ASC, id ASC
           ) AS rn
    FROM account_roles
  ) ranked
  WHERE rn > 1
);

ALTER TABLE account_roles
  DROP CONSTRAINT IF EXISTS account_roles_entity_id_role_qualifier_key;

CREATE UNIQUE INDEX uq_account_roles_default
    ON account_roles (entity_id, role)
    WHERE qualifier IS NULL;

CREATE UNIQUE INDEX uq_account_roles_qualified
    ON account_roles (entity_id, role, qualifier)
    WHERE qualifier IS NOT NULL;
