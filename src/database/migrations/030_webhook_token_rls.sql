-- ============================================================
-- 030: HARDEN INBOUND WEBHOOK TOKEN LOOKUP & READ POLICY
--
-- Two fixes over migration 028 (already applied — 028 is not
-- edited; this migration supersedes the parts it needs to):
--
--   1. Hash-keyed verification (finding #16). verifyWebhookToken
--      no longer scans a name-only candidate window (the old
--      `ORDER BY created_at DESC LIMIT 25` let a cross-tenant
--      attacker who registered many same-named tokens shadow a
--      victim's token out of the window — a silent-drop DoS on
--      bank/SAT intake). It now selects the row by the presented
--      token's OWN sha256 hash, scoped to the routing name. This
--      index makes that lookup a direct, uniform hit.
--
--   2. Scope the pre-auth SELECT policy (finding #19). Migration
--      028's `webhook_token_auth ... USING (true)` exposed EVERY
--      tenant's token rows (hashes, names, entity map, created_by
--      emails) to ANY tenant-scoped query path — a cross-tenant
--      reconnaissance leak, since permissive policies OR-combine
--      with tenant_isolation. The permissive read is needed ONLY
--      by the pre-auth verification path, which runs with NO
--      tenant context set (the tenant is unknown until the token
--      matches). So the exception is narrowed to exactly that:
--      SELECT is permitted only when `app.current_tenant` is
--      unset. Authenticated connections (tenant GUC set) fall
--      back to tenant_isolation and can read only their own rows.
-- ============================================================

-- (1) Hash lookup index. Partial on enabled = true to match the query
-- (WHERE token_hash = $1 AND name = $2 AND enabled = true).
CREATE INDEX IF NOT EXISTS idx_ai_webhook_tokens_hash
    ON ai_webhook_tokens(token_hash)
    WHERE enabled = true;

-- (2) Replace the unconditional SELECT policy with one scoped to the
-- pre-auth path. current_setting(..., true) returns NULL when the GUC was
-- never set (missing_ok) and '' if it was reset — both mean "no tenant
-- context", i.e. the pre-auth verifyWebhookToken read. Any authenticated
-- connection has app.current_tenant set and is therefore governed solely by
-- the tenant_isolation policy (OR-combined), so it can no longer enumerate
-- other tenants' token rows through this exception.
DROP POLICY IF EXISTS webhook_token_auth ON ai_webhook_tokens;
CREATE POLICY webhook_token_auth ON ai_webhook_tokens
    FOR SELECT
    USING (
        current_setting('app.current_tenant', true) IS NULL
        OR current_setting('app.current_tenant', true) = ''
    );
