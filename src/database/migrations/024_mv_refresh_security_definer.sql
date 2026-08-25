-- ============================================================
-- 024: refresh_materialized_views as SECURITY DEFINER
-- The trigger function was owned by the bootstrap superuser and
-- ran with the CALLER's privileges, but only the owner of a
-- materialized view may REFRESH it. Under the least-privilege
-- runtime role (mnemosine_app) every posting UPDATE therefore
-- died with "must be owner of materialized view mv_trial_balance".
-- Recreating it here makes the migration role (mnemosine_owner,
-- who owns both MVs) the function owner, and SECURITY DEFINER
-- runs the refresh with those rights regardless of caller.
-- search_path is pinned, as required for SECURITY DEFINER.
-- ============================================================

CREATE OR REPLACE FUNCTION refresh_materialized_views()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
    -- Only refresh on posting (avoid on every update)
    IF NEW.status = 'posted' AND (OLD IS NULL OR OLD.status != 'posted') THEN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_trial_balance;
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_account_balance_summary;
    END IF;
    RETURN NEW;
END;
$function$;
