-- ============================================================
-- 145 · EVERY TENANT LIVES IN THE PUBLIC SCHEMA (#326 · MNE-001-085)
--
-- 001 drew tenants.schema_name as UNIQUE for a schema-per-tenant model that
-- was never built: isolation is row-level security on the shared `public`
-- schema (014, rls-policies.sql), and nothing in src/ reads schema_name.
-- `entity create`'s implicit first tenant and the demo seed (seed.ts) both
-- store 'public', which is the truth — and the UNIQUE made that truth
-- impossible to write a second time, so a second firm on one installation
-- needed hand-written SQL with an invented schema name. The fixtures that
-- write `plan_<suffix>` / `it_<suffix>` values invented unique names only to get past
-- this UNIQUE.
--
-- Dropping the UNIQUE lets `tenant create` store the real value for every
-- firm. Loosening only: no row is read or rewritten, existing values stay.
-- ============================================================

ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_schema_name_key;

COMMENT ON COLUMN public.tenants.schema_name IS
  'Postgres schema holding the tenant''s rows. ''public'' under the shared-schema RLS model; not unique, because every tenant shares it.';
