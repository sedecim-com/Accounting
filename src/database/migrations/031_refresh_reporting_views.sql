-- ============================================================
-- 031: refresh_reporting_views(), a CALLABLE refresh
-- ============================================================
-- refresh_materialized_views() (004:87, hardened in 024) returns TRIGGER,
-- so the only thing that can invoke it is the trigger on journal_entries,
-- and that fires on exactly one transition: an entry becoming 'posted'.
-- Every other path that changes what the views should say — a migration,
-- a bulk load, a restore, a status change that is not a posting — leaves
-- them stale with no signal at all.
--
-- Exposing that as `mnemosine report view sync` needs a function the
-- application role can CALL. It also needs SECURITY DEFINER: the views are
-- owned by mnemosine_owner and only an owner may REFRESH one, so a direct
-- REFRESH from mnemosine_app dies with
--   must be owner of materialized view mv_trial_balance
-- which is the same wall migration 024 hit from inside the trigger.
--
-- The view names arrive as data, so they are checked against a hardcoded
-- allowlist before being interpolated: a SECURITY DEFINER function that
-- concatenates caller-supplied identifiers is a privilege-escalation bug,
-- not a convenience. search_path is pinned for the same reason.

CREATE OR REPLACE FUNCTION refresh_reporting_views(
    p_views TEXT[] DEFAULT ARRAY['mv_trial_balance', 'mv_account_balance_summary'],
    p_concurrently BOOLEAN DEFAULT TRUE
)
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    allowed   CONSTANT TEXT[] := ARRAY['mv_trial_balance', 'mv_account_balance_summary'];
    v_name    TEXT;
    v_done    TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF p_views IS NULL OR array_length(p_views, 1) IS NULL THEN
        p_views := allowed;
    END IF;

    FOREACH v_name IN ARRAY p_views LOOP
        IF NOT (v_name = ANY (allowed)) THEN
            RAISE EXCEPTION 'refresh_reporting_views: % is not a refreshable reporting view (allowed: %)',
                v_name, array_to_string(allowed, ', ');
        END IF;

        IF p_concurrently THEN
            EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY %I', v_name);
        ELSE
            EXECUTE format('REFRESH MATERIALIZED VIEW %I', v_name);
        END IF;

        v_done := v_done || v_name;
    END LOOP;

    RETURN v_done;
END;
$function$;

-- Least privilege: nobody by default, the application role explicitly.
REVOKE ALL ON FUNCTION refresh_reporting_views(TEXT[], BOOLEAN) FROM PUBLIC;

DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnemosine_app') THEN
        GRANT EXECUTE ON FUNCTION refresh_reporting_views(TEXT[], BOOLEAN) TO mnemosine_app;
    END IF;
END
$grant$;
