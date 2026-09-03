# Connectivity: database hosting and model providers

## Where the database lives
`DATABASE_URL` points at any Postgres 14+. `DATABASE_PROVIDER` names a preset,
and the preset CONFIGURES NOTHING: its declared TLS mode and CA are never read
by the connection. Its only effect is documentary — `doctor` prints the name
and surfaces the preset's first caveat. TLS still comes entirely from
`DATABASE_SSL_MODE` (or the host default below), and RDS / Cloud SQL still need
`DATABASE_SSL_CA` set by hand. A name that is not on the list is ignored in
silence. Presets: `local`, `self-hosted`, `neon`, `supabase`, `rds`, `cloudsql`,
`crunchy`.

Provider caveats you should surface when relevant:
- **neon** — the DEFAULT role has BYPASSRLS: tenant isolation is off until the
  human creates a non-privileged role and uses it in `DATABASE_URL`
  (`doctor` detects this).
- **supabase** — port 6543 is the transaction pooler (no LISTEN/NOTIFY, no
  prepared statements); use port 5432 (direct) for mnemosine.
- **rds** — needs the AWS RDS CA bundle (`DATABASE_SSL_CA`); Mexico (Central)
  region available; IAM tokens expire in 15 minutes (not recommended for
  long-lived pools).
- **cloudsql** — enabling pgaudit requires a database flag AND an instance
  restart (plan a maintenance window).

## TLS (`DATABASE_SSL_MODE`)
- `disable` — local only (default when the host is localhost).
- `require` — encrypts but verifies NOTHING (no identity check); mnemosine
  warns. Only acceptable as a stopgap.
- `verify-ca` — certificate chain verified, hostname not; the right mode
  through an SSH tunnel (the hostname is 127.0.0.1 there).
- `verify-full` — chain + hostname; the default for any remote host.

`DATABASE_SSL_CA` is a file path or an inline PEM (`-----BEGIN …`). Neon,
Supabase and Crunchy work with the system trust store; RDS and Cloud SQL need
their own CA bundle.

## Self-hosted on a VPS (SSH tunnel)
Set `DATABASE_SSH_HOST` (accepts `user@host` or an alias from
`~/.ssh/config`) and mnemosine opens a tunnel with the system `ssh` binary
before the first connection — agent, jump hosts and per-host config all work.
Optional: `DATABASE_SSH_PORT`, `DATABASE_SSH_KEY` (identity file),
`DATABASE_SSH_REMOTE_HOST` / `DATABASE_SSH_REMOTE_PORT` (where Postgres
listens AS SEEN FROM the VPS; defaults localhost:5432). Postgres never has to
expose 5432 to the internet. `DATABASE_URL`'s host/port are rewritten through
the tunnel automatically.

## Verifying a connection
`mnemosine doctor` is the one command to diagnose all of this: transport
(TLS mode vs host, tunnel), role privileges (BYPASSRLS detection), RLS
coverage, and provider-specific traps. Ask the human to run it and paste the
output when a connection problem is unclear.

## Model providers
12 built-in profiles: `anthropic` (default), `hermes`, `hermes-agent`,
`ollama`, `openai`, `grok`, `minimax`, `qwen`, `gemini`, `openrouter`,
`copilot`, `openclaw`. `mnemosine providers` lists them with notes.

- Selection precedence: `--provider` flag > `MNEMOSINE_PROVIDER` env >
  `default_provider` in config > `anthropic`.
- Config files: `./mnemosine.config.json` (project) or
  `~/.mnemosine/config.json` (user). API keys NEVER go in the config — it
  only names the env var (`api_key_env`), or a command that prints the
  credential (`api_key_cmd`, tried when the env var is empty). An invalid
  config fails loudly and is quarantined, never silently replaced by
  defaults.
- Inside chat, `/provider <name>` switches models by opening a NEW
  conversation: history is not portable across wire formats, so the current
  context is dropped.
- `hermes-agent` and `openclaw` run their OWN tools server-side: on those
  channels you have NO accounting tools — say so instead of citing figures.
- A profile may declare a `failover` chain (ordered list of other profiles),
  walked automatically on the eligible categories — auth, rate_limit, server,
  timeout, billing — and NEVER on a refusal, a context overflow, a caller
  abort or an unclassified error. It covers session setup and the FIRST turn
  only: once a session has completed one turn it stays on that provider for
  the rest of its life.

## Encryption at rest
`ENCRYPTION_KEY` (32-byte hex) encrypts secrets stored in OUR database:
external integration credentials, bank account numbers / CLABE / routing, and
employee bank and national-id data. The SAT e.firma is NOT one of them — it
lives in the secret vault (`VAULT_BACKEND`, with its own key), and this key
would not open it. Rotating `ENCRYPTION_KEY` invalidates already-encrypted
data — that is a deliberate human decision, never suggest it casually.
