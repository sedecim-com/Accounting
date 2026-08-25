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
database returns ZERO rows — it never errors, it just sees nothing. Context is
set per command with the global flag `-T, --tenant <uuid>` or the
`MNEMOSINE_TENANT` env var; once an entity is resolved, its tenant becomes the
context automatically.

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
- **review asks for `--user`** → more than one active user exists in the
  tenant, so reviewer attribution cannot be guessed. Every approval is an
  audit event; ask WHO is approving and pass `--user <email>`.

## Database roles
- `mnemosine_app` — what `DATABASE_URL` should use: SELECT/INSERT/UPDATE/DELETE
  only, no DDL, no ownership, NOBYPASSRLS. All CLI/API traffic.
- `mnemosine_owner` — schema owner, used ONLY by migrations via
  `MIGRATION_DATABASE_URL` (falls back to `DATABASE_URL` if unset).
- Provisioning is idempotent: `scripts/provision-roles.sql`; isolation can be
  proven any time with `scripts/verify-isolation.sh` (6 assertions, includes
  real cross-tenant read/write attempts).

## OIDC sign-in (CLI)
`mnemosine login` opens the browser (PKCE, loopback redirect);
`mnemosine login --device` prints a code to enter on another device (for SSH
or headless servers). `mnemosine whoami` shows the current identity;
`mnemosine logout` clears it. Tokens live in the macOS keychain (file with
mode 0600 as fallback), never in config files.

Configuration (in `.env`): `AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID`,
`AUTH_OIDC_AUDIENCE` (+ `AUTH_OIDC_PROVIDER` / `AUTH_OIDC_TENANT_ID` for
provider-specific issuers). Everything else is discovered from the issuer's
`/.well-known/openid-configuration`.

## First login of a new person (JIT provisioning)
The first OIDC login auto-creates the user linked to their IdP identity
(keyed by provider+subject, never by email) — with ZERO accessible entities.
They will see "no access" until an administrator grants entities. That is by
design, not an error: tell the human to ask their admin for access.

## SAT credentials (Mexico)
e.firma/CIEC handling has its own commands: `mnemosine sat cred add | status |
audit | revoke` (consent is recorded per user; `audit` shows every use).
Never ask the human to paste keys or passwords into chat — point them to
`sat cred add`, which prompts securely.
