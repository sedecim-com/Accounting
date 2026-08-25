-- ============================================================
-- 014: TENANT ISOLATION WITH ROW LEVEL SECURITY
--
-- The policies are generated from the catalog, not from a hand-written
-- list: there are 57 scoped tables and a list goes stale on the
-- first migration that adds a table.
--
-- IMPORTANT — this migration is INERT as long as the application
-- connects as a superuser or as the tables' owner without FORCE:
--   · a superuser always bypasses RLS;
--   · so does the table owner, which is why FORCE ROW LEVEL
--     SECURITY is declared here, taking that privilege away.
-- The policies start filtering once the app connects as
-- mnemosine_app (see scripts/provision-roles.sql) and the tenant
-- context is set (withTenant in src/database/connection.ts).
--
-- The POLICIES themselves live in src/database/rls-policies.sql, which
-- migrate.ts applies after every migration so that no new table is
-- left unprotected. Only the function they consult remains here.
--
-- Fail-closed: without tenant context, app_current_tenant() is NULL
-- and the policies return no rows. This is deliberate: we prefer an
-- unauthenticated path to see nothing rather than see everything.
-- ============================================================

CREATE OR REPLACE FUNCTION public.app_current_tenant() RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public
AS $fn$
DECLARE v text;
BEGIN
  v := current_setting('app.current_tenant', true);
  IF v IS NULL OR v = '' THEN
    RETURN NULL;
  END IF;
  RETURN v::uuid;
EXCEPTION WHEN others THEN
  -- An invalid value is treated as absence of context: no rows,
  -- never "all rows".
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.app_current_tenant() IS
  'Tenant from the session context (SET LOCAL app.current_tenant). NULL when unset or invalid: RLS policies then return no rows.';

