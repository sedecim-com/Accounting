# Identity, access and tenant isolation

## The access model (three principals)
- **Accountants** → REST API with OIDC: they sign in with the firm's identity
  provider (Google, Microsoft Entra, Okta, Auth0, Keycloak, Zitadel, Cognito…),
  zero database credentials. This is ~95% of usage.
- **Ingestion cron / automations** → API with a service-account user, narrow
  permissions.
- **Operator (CLI)** → direct Postgres connection as `mnemosine_app`, a
  least-privilege role (DML only, subject to row-level security, can never
  bypass it). Remote databases go through TLS or an SSH tunnel (see the
  `connectivity` topic).

## Tenant isolation (row-level security)
Every tenant-scoped table has a Postgres RLS policy enforced with FORCE (even
the table owner is filtered) and it FAILS CLOSED: with no tenant context the
database returns ZERO rows — it never errors, it just sees nothing. Four tables
are excluded on purpose: `users` and `sessions` (the authentication path has to
read them BEFORE it knows which tenant the caller belongs to), `tenants` (the
root of the hierarchy) and `migrations`. Context is set per command with the
global flag `-T, --tenant <uuid>` or the `MNEMOSINE_TENANT` env var; once an
entity is resolved, its tenant becomes the context automatically.

## Symptoms → what to tell the human
- **"No entities visible" / empty lists that should have data** → tenant
  context is missing. Fix: pass `--tenant <uuid>` or set `MNEMOSINE_TENANT`.
  With a single-tenant install, suggest exporting it in `.env`.
- **`permission denied for table …`** → the app role lost grants on a newly
  created table (happens if a migration ran under the wrong role). Fix: run
  `npm run migrate` — it re-applies RLS policies AND self-healing grants after
  every migration.
- **`doctor` warns the connected role has BYPASSRLS** → the CLI is connected
  as a superuser or a managed provider's default role (Neon does this).
  Isolation is OFF for that connection. Fix: connect `DATABASE_URL` as
  `mnemosine_app`.
- **review asks for `--user`** → nobody is signed in and the tenant has more
  than one active user, so reviewer attribution cannot be guessed. Every
  approval is an audit event (read it back with `mnemosine audit list`); ask
  WHO is approving and pass `--user <email>`.
- **`--user` rejected: "your session is X and --user says Y"** → the flag can
  RESTRICT but never SUBSTITUTE the authenticated subject. Naming yourself is
  accepted; naming anyone else is refused, because the fact would be attributed
  to someone who did not do it and the audit trail is append-only. To act as
  someone else, sign in as them.
- **a write fails asking for `mnemosine login`** → this deployment configured a
  provider (`AUTH_OIDC_ISSUER` + `AUTH_OIDC_AUDIENCE`), so attribution requires
  a live session: `--user` on its own is a claim, not an identity. An expired
  or foreign-issuer session fails the same way instead of quietly falling back
  to the flag. With NO provider configured the flag still works, and stderr
  says once per process that the attribution is DECLARED, not authenticated.

## Database roles
- `mnemosine_app` — what `DATABASE_URL` should use: SELECT/INSERT/UPDATE/DELETE
  only, no DDL, no ownership, NOBYPASSRLS. All CLI/API traffic.
- `mnemosine_owner` — schema owner, used ONLY by migrations via
  `MIGRATION_DATABASE_URL` (falls back to `DATABASE_URL` if unset).
- `mnemosine_auditor` — the read-only third principal, for an external auditor:
  SELECT across the schema, no INSERT/UPDATE/DELETE, NOBYPASSRLS. It is then cut
  back to what isolation actually reaches — tables with no tenant/entity column
  (`users`, `sessions`, `tenants`, `identities`…) are revoked except a named
  global-reference allow-list (`exchange_rates`, `tax_parameters`,
  `migrations`…), and so are materialized views, which a BYPASSRLS role
  refreshes and therefore hold every tenant at once. Who signed an entry is
  still readable: `audit_log` is tenant-scoped. NOLOGIN on purpose — it is a
  bundle of privileges, not an account: the operator issues one NOMINAL login
  per person (`CREATE ROLE auditoria_lopez LOGIN PASSWORD '…' IN ROLE
  mnemosine_auditor`) and revokes it when the review ends. A migration cannot
  create it (the migrator has no CREATEROLE, deliberately): run
  `psql "$SUPERUSER_URL" -f scripts/rol-auditor.sql` after provision-roles.sql,
  and again after migrations that add tables. `doctor` reports whether it exists
  and how it is bounded. Two things to say out loud: the auditor's session must
  `SET app.current_tenant = '<uuid>'` or it sees ZERO rows (that is the policy
  working, not a fault), and nothing ties the role to ONE tenant — that the
  auditor only looks at their own client is a term of the engagement today, not
  a guarantee of the schema.
- Provisioning is idempotent: `scripts/provision-roles.sql`; isolation can be
  proven any time with `scripts/verify-isolation.sh` (7 assertions, includes
  real cross-tenant read/write attempts).

## OIDC sign-in (CLI)
`mnemosine login` opens the browser (PKCE, loopback redirect);
`mnemosine login --device` prints a code to enter on another device (for SSH
or headless servers). `mnemosine whoami` says which provider the stored
credential comes from and how long it is still valid — it does NOT print your
email or subject; `mnemosine logout` clears it. Tokens live in the macOS
keychain (file with mode 0600 as fallback), never in config files. No refresh
exchange is implemented: when the token expires, sign in again (the CLI's
"renews itself" line is ahead of the code).

Configuration (in `.env`): `AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID`,
`AUTH_OIDC_AUDIENCE`. Everything else is discovered from the issuer's
`/.well-known/openid-configuration`. Two more, which are NOT provider trivia:
`AUTH_OIDC_PROVIDER` (default `oidc`) is the label identities are keyed under
in the `identities` table — changing it after people have signed in orphans
their links; `AUTH_OIDC_TENANT_ID` is the MNEMOSINE tenant uuid that everyone
arriving through this issuer belongs to (deployment configuration, never
decided by the token) — it is NOT an Entra/Azure tenant id. Authentication
counts as configured when ISSUER and AUDIENCE are both set: that is the switch
that makes a session mandatory for attribution.

## First login of a new person (JIT provisioning)
This happens on the REST API path, when a token from the provider arrives. The
user is auto-created and linked to their IdP identity — the link is keyed by
provider+subject, never by the email (which can change at the IdP), although an
existing user with that email in the tenant is ADOPTED instead of duplicated —
and it is created with ZERO accessible entities, zero roles and zero
permissions. The API answers 403 "authenticated but has no access to any
entity" until an administrator grants entities. That is by design, not an
error: tell the human to ask their admin for access.

The CLI does NOT provision. `mnemosine login` only stores the credential; if a
verified session has no user row in the tenant, the write fails with "your
session is verified but does not correspond to any active user of this tenant"
— an administrator has to create it there too.

## SAT credentials (Mexico)
e.firma handling has its own commands: `mnemosine sat cred add | status |
audit | revoke` (consent is recorded per user, with its version; `audit` shows
every use). Only the e.firma is supported: a CSD (digital seal) is rejected
upfront, and there is no CIEC path at all.

Never ask the human to paste keys or passwords into chat — point them to
`sat cred add`, which takes certificate and key as FILES (`--cer`, `--key`, in
DER) and asks for the key password with a hidden prompt.

Three things to say before proposing it: the real deposit into the vault is
opt-in with `--live` (without it the command validates and stores nothing); the
typed consent ("accept") is mandatory and `--yes` does NOT skip it; and the
agent may never invoke `sat cred add` or `sat cred revoke` — they are declared
`externo` and `irreversible`, and the risk kernel refuses agent access to both.
Use is capped twice: by the credential's own `max_daily_access` and by the
policy panel's `efirma_max_accesos_diarios`, whichever is stricter, and at the
cap `efirma_accion_anomalia` decides — only the literal `alertar` lets an
access through; any other value denies.
