# Connectivity: database hosting and model providers

## Where the database lives
`DATABASE_URL` points at Postgres 15 — the only version anything here runs
against (CI stands up `postgres:15`, `docker/docker-compose.yml` uses
`postgres:15-alpine`). Nothing in the schema demands 15 in particular, but no
other version is tested, so say "tested on 15", not a floor nobody checks.

`DATABASE_PROVIDER` names a preset, and the preset CONFIGURES NOTHING: its
declared TLS mode and CA are never read by the connection. Its only effect is
documentary — `doctor` prints the name and surfaces the preset's first
caveat. TLS still comes entirely from
`DATABASE_SSL_MODE` (or the host default below), and RDS / Cloud SQL still need
`DATABASE_SSL_CA` set by hand. A name that is not on the list is ignored in
silence. Presets: `local`, `self-hosted`, `neon`, `supabase`, `rds`, `cloudsql`,
`crunchy`.

Provider caveats you should surface when relevant:
- **neon** — the DEFAULT role has BYPASSRLS: tenant isolation is off until the
  human creates a non-privileged role and uses it in `DATABASE_URL`
  (`doctor` detects this).
- **supabase** — port 6543 is the transaction pooler: no session state, so no
  LISTEN/NOTIFY and no session-level `SET`. The APP is compatible with it —
  it pins the tenant with a transaction-local `set_config(…, true)` inside
  the transaction, which is also why the neon preset calls its `-pooler`
  endpoint fine — but MIGRATIONS need the direct port, 5432.
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
13 built-in profiles: `anthropic` (default), `hermes`, `hermes-agent`,
`ollama`, `openai`, `grok`, `minimax`, `qwen`, `gemini`, `nvidia`,
`openrouter`, `copilot`, `openclaw`. `mnemosine providers` lists them with notes.

- Selection precedence: `--provider` flag > `MNEMOSINE_PROVIDER` env >
  `default_provider` in config > `anthropic`.
- Config files: `./mnemosine.config.json` (project) or
  `~/.mnemosine/config.json` (user). API keys NEVER go in the config — it
  only names the env var (`api_key_env`), or a command that prints the
  credential (`api_key_cmd`, tried when the env var is empty). A helper in
  the person's own `~/.mnemosine/config.json` on an OpenAI-compatible profile
  is run again every five minutes and after a 401, so a one-hour `gcloud`
  token lasts the session. A helper in a shared project file runs only
  after the person running mnemosine approves that exact command, for that
  file and host, with `mnemosine providers approve <profile>` (#645); until
  then the profile stops with that command, and doctor and `mnemosine
  providers` say «not approved». Once approved it renews like their own. Tell
  them to read `providers.<profile>.api_key_cmd` in that file before
  approving, and never approve it for them. Say that it runs in the project
  folder with that folder's `./.env` in its environment, that a script of
  the project it names is approved by its content (an edit asks again), and
  that a command found through PATH or npx is approved by its name only.
  The approval also binds where the key goes, scheme included, as the SDK
  resolves it: an `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL` in `./.env`
  that moves it asks again. A project file that carries a
  credential written by hand (an auth header, a key in a command, a model or
  a base_url) is refused at load, naming the field: the fix is to move the
  secret to the person's own files. The person's own profiles stay available
  beneath a project file's. A project profile that would send a variable to
  a host its provider does not document stops, naming both, until the
  person approves that pair the same way. When the folder's `./.env` sets
  `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` or `ANTHROPIC_CONFIG_DIR`,
  readiness and doctor say it serves everyone in that folder. A helper that fails says the profile and its exit code or its 10 s limit,
  never its command or stderr: tell the person to run it themselves. Help
  them put helper profiles in their own user file, never in a shared project
  file, and say that «Sign in with ChatGPT» and a Codex login are not API
  credentials for mnemosine. An invalid
  config fails loudly and is quarantined, never silently replaced by
  defaults; the one writer that goes further is `mnemosine lang`, which on a
  USER file whose CONTENT is invalid (it does not parse, or the schema rejects
  it) keeps the quarantine copy, says where it went, and writes a clean one —
  so warn that the rest of that file (providers, tenant) goes with it. A
  failure to read or write a VALID file (a permission or disk error) is not
  that case: it is reported as the error it is and the file is left as it was. The config may also carry `tenant`, the LAST step of the
  tenant chain: `--tenant`/`-T` flag > `MNEMOSINE_TENANT` env > `tenant` in
  config. The flag wins; when it leaves an env value aside, the command says
  so.
- ONE key inverts the project-before-user order: `locale`. It is read from
  `~/.mnemosine/config.json` FIRST, because the language belongs to the human
  and not to the repository, so a committed project config cannot pin it —
  and that is why `mnemosine lang` writes there (`setUserLocale`) instead of
  where the other settings are written. Only `--locale` and the environment
  (`MNEMOSINE_LOCALE`, alias `MNEMOSINE_LANG`) outrank it, and `lang` says so
  out loud after writing. The legacy `language` key keeps its OLD order (the
  first file that exists wins entire, project before user) and is still read
  as a fallback below `locale`. `mnemosine lang --unset` (`unsetUserLocale`)
  removes `locale` and the legacy `language` from the USER file only, keeps
  every other key, and writes nothing when neither is there.
- A second key is read from `~/.mnemosine/config.json` ALONE: `jobs.run_due`,
  `"adopted"` or `"all"`, which due jobs `jobs run-due` runs on the
  credential of whoever runs it (#646). `adopted` runs only the jobs that
  operator adopted (`jobs adopt <id>`, kept in `~/.mnemosine/adopted-jobs.json`,
  never in the database) and lists the rest; `all` runs every due job; unset
  behaves as `all` and names on stderr the jobs it ran that were not adopted.
  In a project file the key is not read, and the tick says so.
- A third: `project_helpers`, `"approved"` (the default: a project file's
  helper runs once approved) or `"never"` (none runs).
- `models` (`{ "<profile>": "<model id>" }`) sets a profile's model without
  copying it, so a built-in keeps its declared window: `--model` >
  `models.<profile>` > the profile's `model`. A name that is no profile is
  refused. `init --section ai` writes `default_provider` and `models` to the
  file that wins, creating `~/.mnemosine/config.json` (never a project file)
  when none exists, and asks before writing a project file (default No, kept
  by `--yes`; on No the project file still decides in that folder). A key
  typed at init goes to `~/.mnemosine/.env` (600), never `./.env`; init
  removes an empty definition of that variable from `./.env`, which would
  hide it. `MNEMOSINE_PROVIDER` still outranks the saved default, and init
  says so.
- An openai-compatible profile may declare `reasoning_effort` (none, minimal,
  low, medium, high, xhigh, max); it is sent only then. The built-ins `grok`
  (`grok-4.3`) and `gemini` (`gemini-3.8-flash`) declare `low`; their model
  ids ship not verified live, as their notes say. A turn that spends
  the whole 8192-token output cap without text or a tool call fails with an
  error that says so: suggest a lower `reasoning_effort`, not a retry. Tool
  calls keep the provider's `extra_content` (Gemini 3's thought signature)
  and send it back unchanged.
- `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` and the lines of `OPENAI_CUSTOM_HEADERS`,
  which the `openai` SDK reads on its own, reach only OpenAI's hosts
  (`api.openai.com` and its regional ones); every other host gets the
  profile's own key and `headers`, nothing more. A profile whose
  `api_key_env` names an installation secret (`DATABASE_URL`,
  `ENCRYPTION_KEY`, `JWT_SECRET`…) is refused before anything is sent, and
  readiness says «not a provider credential»: tell the person to name the
  provider's own key variable instead.
- `nvidia` is NVIDIA's hosted catalog (`integrate.api.nvidia.com`), a
  trial that records what it receives: never a client's data. `ingest`,
  `jobs run-due` and init's import refuse any profile on that host; `chat`
  and `ask` use it only after its terms and a yes at a terminal, once per
  session; a failover walk never moves into it, and `doctor` warns while the
  default or a link of its chain is on it. When a refusal names it, suggest
  another provider or a self-hosted NIM, never a way around the guard.
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
