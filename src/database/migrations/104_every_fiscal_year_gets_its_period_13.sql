-- ============================================================
-- 104 · EVERY FISCAL YEAR GETS ITS PERIOD 13 (#304 · MNE-001-046)
--
-- The Anexo 24 closing balance (month 13) is read from a fiscal period with
-- period_number 13 of type 'adjustment' or 'closing', and no entity had one:
-- `year create` and the onboarding wizard built twelve regular months, so
-- `e-accounting balance generate --closing` refused for everyone. New years
-- are now born with it (fiscal-calendar-service.ts, ensureFiscalYear); this
-- file gives it to the years that already exist, with the same shape: the
-- last day of the year, 'adjustment', named in English, and 'future' only
-- when December is still 'future'.
--
-- WHICH YEARS. Only the ones not closed yet: status 'open', December not
-- hard closed or locked, and no closing entry anywhere in the year (a
-- December reopened after its close still carries one). A year that closed
-- in December has its closing entries in December; a period 13 added now
-- would be an empty month 13, which is exactly the file the SAT accepts and
-- that does not contain the close. Those years keep refusing `--closing`
-- with the message that says why.
--
-- IDEMPOTENT. NOT EXISTS plus ON CONFLICT on (fiscal_year_id, period_number):
-- a second run adds nothing.
--
-- UNDER RLS. fiscal_periods, fiscal_years and journal_entries are tenant
-- tables under FORCE ROW LEVEL SECURITY and migrate.ts runs with
-- row_security = off: a bare INSERT ... SELECT here fails with 42501. So the
-- sanctioned pattern of docs/migraciones.md: declare the opt-in and iterate
-- tenants. An entity whose tenant_id is not a row of `tenants` is not
-- reached, as no session of the application reaches it either.
-- ============================================================

SET LOCAL row_security = on;
DO $period13$
DECLARE
  t           record;
  added       bigint;
  added_total bigint := 0;
  tenants_hit bigint := 0;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    INSERT INTO fiscal_periods (
      entity_id, fiscal_year_id, period_number, period_name,
      start_date, end_date, period_type, status
    )
    SELECT fy.entity_id, fy.id, 13, 'Year-end adjustments ' || fy.year_number,
           fy.end_date, fy.end_date, 'adjustment',
           CASE WHEN december.status = 'future' THEN 'future' ELSE 'open' END
      FROM fiscal_years fy
      JOIN fiscal_periods december
        ON december.fiscal_year_id = fy.id
       AND december.end_date = fy.end_date
       AND december.period_number < 13
     WHERE fy.status = 'open'
       AND december.status NOT IN ('hard_close', 'locked')
       AND NOT EXISTS (SELECT 1 FROM fiscal_periods p
                        WHERE p.fiscal_year_id = fy.id AND p.period_number = 13)
       AND NOT EXISTS (SELECT 1 FROM journal_entries je
                         JOIN fiscal_periods p ON p.id = je.fiscal_period_id
                        WHERE p.fiscal_year_id = fy.id AND je.entry_type = 'closing')
    ON CONFLICT (fiscal_year_id, period_number) DO NOTHING;

    GET DIAGNOSTICS added = ROW_COUNT;
    IF added > 0 THEN
      added_total := added_total + added;
      tenants_hit := tenants_hit + 1;
    END IF;
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);

  RAISE NOTICE 'migration 104: added period 13 to % fiscal year(s) in % tenant(s)', added_total, tenants_hit;
END
$period13$;
