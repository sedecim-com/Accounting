-- ============================================================
-- 015: EXTERNAL IDENTITIES (OIDC)
--
-- A user can sign in through several providers. The key is
-- (provider, subject), NEVER the email: the provider's 'sub' is
-- stable and the email changes. Keying by email would break the
-- link — and with it the attribution of every old journal entry —
-- on a domain or last-name change.
--
-- The IdP says WHO you are. Authorization (tenant, accessible
-- entities, permissions) keeps living in `users`: journal_entries
-- .created_by is a foreign key to users, and the audit trail
-- has to resolve to a local record.
-- ============================================================

CREATE TABLE public.identities (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    provider    VARCHAR(50)  NOT NULL,   -- google | entra | okta | local | service
    subject     VARCHAR(255) NOT NULL,   -- the IdP's 'sub'
    issuer      VARCHAR(255),            -- iss, to tell IdP tenants apart
    email       VARCHAR(255),            -- informational; can change
    email_verified BOOLEAN NOT NULL DEFAULT false,
    last_login_at  TIMESTAMPTZ,
    linked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, subject)
);

CREATE INDEX idx_identities_user ON public.identities(user_id);
CREATE INDEX idx_identities_email ON public.identities(email);

-- Service accounts: the ingest cron is not a person, and an auditor
-- must be able to tell "posted by policy" from "approved by someone".
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_service_account BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.is_service_account IS
  'true = machine credential (cron, CI). Journal entries it creates must be read as automatic, not as approved by a person.';
