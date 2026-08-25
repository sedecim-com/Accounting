# mnemosine — AI accounting assistant (CLI)

Converse with your accounting from the terminal. The agent queries the chart
of accounts, customers, vendors, journal entries and reports through typed
tools — it never makes up figures. Since phase 2 it also **proposes journal
entries as drafts** (`ai_drafts`); the real ledger is only touched when a
human approves with `mnemosine review`, which posts via the accounting engine
with all its validations (open fiscal period, double entry, postable accounts).

## Requirements

- PostgreSQL running with the migrations applied (`npm run migrate`)
- `DATABASE_URL` in `.env`
- Credentials for the model provider you use (see **Providers** below)

## Model providers

mnemosine is model-agnostic: the harness (accounting tools + agentic loop +
CLI) is the same and the "brain" is swapped per profile. Built-in profiles
(`mnemosine providers` lists them with their status):

| Profile | Type | Endpoint | Credential |
|---|---|---|---|
| `anthropic` | native Anthropic | api.anthropic.com | `ANTHROPIC_API_KEY` |
| `hermes` | OpenAI-compatible | inference-api.nousresearch.com/v1 (Hermes-4-405B) | `NOUS_API_KEY` |
| `hermes-agent` | OpenAI-compatible | 127.0.0.1:8642/v1 (`hermes gateway`) | `HERMES_AGENT_KEY` |
| `ollama` | OpenAI-compatible | localhost:11434/v1 (local models) | none |
| `openai` | OpenAI-compatible | api.openai.com/v1 (`gpt-5.1`) | `OPENAI_API_KEY` |
| `grok` | OpenAI-compatible | api.x.ai/v1 (`grok-4`) | `XAI_API_KEY` |
| `minimax` | OpenAI-compatible | api.minimax.io/v1 (`MiniMax-M2`) | `MINIMAX_API_KEY` |
| `qwen` | OpenAI-compatible | dashscope-intl…/compatible-mode/v1 (`qwen3-max`) | `DASHSCOPE_API_KEY` |
| `gemini` | OpenAI-compatible | generativelanguage.googleapis.com/v1beta/openai (`gemini-2.5-pro`) | `GEMINI_API_KEY` |
| `openrouter` | OpenAI-compatible | openrouter.ai/api/v1 (`openrouter/auto`) | `OPENROUTER_API_KEY` |
| `copilot` | OpenAI-compatible | api.githubcopilot.com | `COPILOT_API_TOKEN` ⚠ OAuth token |
| `openclaw` | OpenAI-compatible | 127.0.0.1:18789/v1 (`openclaw:main`) | `OPENCLAW_GATEWAY_TOKEN` |

Any endpoint that speaks Chat Completions works (LM Studio, vLLM, Groq,
OpenAI…): add it to `mnemosine.config.json` at the project root
(or `~/.mnemosine/config.json`):

```json
{
  "default_provider": "ollama",
  "providers": {
    "ollama": { "type": "openai-compatible", "model": "gemma4:26b", "base_url": "http://localhost:11434/v1" },
    "groq":   { "type": "openai-compatible", "model": "llama-3.3-70b", "base_url": "https://api.groq.com/openai/v1", "api_key_env": "GROQ_API_KEY" }
  }
}
```

API keys **never** go in the config: the profile names the environment
variable (`api_key_env`) and you define it in `.env`. Standard precedence:
`--provider` > `MNEMOSINE_PROVIDER` > `default_provider` from the config > `anthropic`.
In the chat, `/proveedor hermes` switches models mid-session (new
conversation: history is not portable between formats).

**Inference providers vs. agents**: `openai`, `grok`, `minimax`, `qwen`,
`openrouter` and `hermes` (Nous Portal) do standard function calling — the
accounting tools work in full. In contrast, `hermes-agent` and `openclaw`
talk to an **agent** running locally ([Hermes Agent](https://hermes-agent.nousresearch.com/docs/)
via `hermes gateway` on :8642; [OpenClaw](https://docs.openclaw.ai/gateway/openai-http-api)
via its gateway on :18789, which additionally requires enabling
`gateway.http.endpoints.chatCompletions.enabled=true`): those agents run
*their own* tools server-side and do not return tool calls to the client, so
through those channels mnemosine is a generic chat/agent without access to
your accounting data. `copilot` is special: its token comes from GitHub's
OAuth flow (it is short-lived and renews), not from a permanent API key.

### Subscriptions via OAuth (ChatGPT/Codex, xAI Grok…)

Subscriptions do not give API keys — they give **OAuth tokens**. Two ways to
leverage them from mnemosine:

1. **Credential helper (`api_key_cmd`)** — the `git credential`/`aws
   credential_process` pattern: the profile runs a command that prints the
   token (only if the environment variable is not defined). Useful for
   reusing already-logged-in OAuth sessions or vaults:

   ```json
   {
     "providers": {
       "openai-sub": {
         "type": "openai-compatible", "model": "gpt-5.1",
         "base_url": "http://localhost:4000/v1",
         "api_key_cmd": "jq -r '.tokens.access_token' ~/.codex/auth.json"
       },
       "con-1password": {
         "type": "openai-compatible", "model": "grok-4",
         "base_url": "https://api.x.ai/v1",
         "api_key_env": "XAI_API_KEY",
         "api_key_cmd": "op read op://vault/xai/credential"
       }
     }
   }
   ```

   HEADS UP: the backend of OpenAI's subscription (Codex) speaks the
   Responses API and Grok's is proprietary — the token only works directly if
   you point it at a chat-completions **bridge** (LiteLLM, codex→openai
   proxies), hence the local `base_url` in the example.

2. **Hermes Agent as OAuth broker (recommended)** — Hermes already implements
   the device-flow for ChatGPT/Codex, xAI, etc. (the "Connected" ones in its
   panel) and exposes everything through its API server. mnemosine's
   `hermes-agent` profile already talks to it: connect the subscription in
   Hermes and use it from here without touching anything.

## Usage

```bash
# List available legal entities
npm run mnemosine -- entities

# See model providers and their status
npm run mnemosine -- providers

# Use a specific provider (e.g. a local model)
npm run mnemosine -- ask "which account do I use for banks?" --provider ollama --model gemma4:26b
npm run mnemosine -- chat --provider hermes

# Interactive chat (default). If there is a single active entity, it is used alone.
npm run mnemosine
npm run mnemosine -- chat --entity "Acme MX"

# Single question (one-shot)
npm run mnemosine -- ask "which customers owe me and since when?" --entity acme

# Review drafts proposed by the AI (approving posts the real journal entry)
npm run mnemosine -- review            # [a]pprove  [r]eject  [s]kip  [q]uit
npm run mnemosine -- review --user admin@demo.com   # attribute to another reviewer

# List drafts and their status
npm run mnemosine -- drafts
npm run mnemosine -- drafts --status rejected

# Agent questions: answer (they become precedents) or dismiss
npm run mnemosine -- dudas
npm run mnemosine -- dudas --list

# Batch ingestion of CFDIs (XML) — rules → AI → drafts/auto-post
npm run mnemosine -- ingest facturas/*.xml
npm run mnemosine -- ingest facturas/*.xml --auto-post --min-confidence 0.9 --max-amount 5000

# Onboarding: import a client's accounting from Contalink
npm run mnemosine -- onboard --provider contalink --cutoff 2026-08-31 --dry-run
npm run mnemosine -- onboard --provider contalink --cutoff 2026-08-31 --balance-account 3200 --post

# Outbox: execute/reject queued writes to external systems (Contalink…)
npm run mnemosine -- outbox
npm run mnemosine -- outbox --list
```

Inside the chat: `/nueva` restarts the conversation, `/ayuda` shows examples,
`/salir` exits.

## Draft flow (phase 2)

1. In the chat you ask e.g. *"record August rent, 10,000 + VAT"*.
2. The agent verifies accounts (`search_accounts`), consults precedents
   (`search_journal_entries`) and creates a **draft** with `draft_journal_entry`
   — validated (double entry, existing and postable accounts) but WITHOUT
   touching the ledger. It reports its confidence and reasoning.
3. `mnemosine review` shows each draft (lines, debits/credits, confidence,
   reasoning). On approval, the real journal entry is created and posted via
   `createJournalEntry` (`source_type='ai_draft'` for traceability); on
   rejection, the reason is stored in `review_notes` and the agent sees it in
   `list_drafts` as feedback.

## What it can do today (phase 1 — read)

| Tool | Answers |
|---|---|
| `search_accounts` | "which account do I use for rent?" |
| `search_customers` / `search_vendors` | "do we have vendor X registered?" |
| `search_journal_entries` | "how did we record rent last month?" (precedents) |
| `get_journal_entry` | detail of a journal entry with its lines |
| `get_trial_balance` | trial balance, does it balance? |
| `get_balance_sheet` | balance sheet as of a date |
| `get_income_statement` | income statement for a period |
| `get_aged_receivables` / `get_aged_payables` | AR / AP aging |
| `get_general_ledger` | general ledger detail of an account |

All queries are scoped to the session's entity (`entity_id`) and use SQL
parameters — the model does not execute free-form SQL.

## Architecture

```
src/cli/mnemosine.ts      CLI (commander): entities | ask | chat
src/ai/agent.ts          Agentic loop (SDK's BetaToolRunner, streaming)
src/ai/system-prompt.ts  Prompt with the chart of accounts (prompt-cached)
src/ai/context.ts        Legal entity resolution (--entity)
src/ai/tools/            Read tools (Zod v4 + betaZodTool)
```

- Model: `claude-opus-5` with adaptive thinking (override with `--model`).
- The stable block of the system prompt (role + chart of accounts) carries
  `cache_control: ephemeral`: subsequent turns of the session read from the
  cache (~90% less input cost).
- The conversation history persists across turns within the session; it
  includes tool results so the agent does not re-query.

## Questions and precedents (phase 3)

When a question blocks the agent (uncertain account, new vendor, ambiguous
treatment), its mandatory flow is:

1. **`search_precedents`** — checks whether the firm already resolved that
   question before.
2. If there is no precedent, **`ask_user`**:
   - **In chat**: the question appears inline (with numbered options if there
     are any); your answer reaches the agent immediately and is saved as a
     precedent.
   - **In `ask`/batch**: the question stays `pending` in `ai_questions`; the
     agent continues without making up data and tells you what got blocked.
3. **`mnemosine questions`** — interactive queue to answer or dismiss pending
   ones. Each answer becomes a precedent (the most recent one wins), and the
   agent cross-checks them against the chart of accounts before using them.

## Batch ingestion of CFDIs (phase 4)

`mnemosine ingest` processes XML invoices in three layers, in order of confidence:

1. **Deterministic rules** — the existing pipeline registers the XML (dedupe by
   UUID/hash), matches the vendor and applies the firm's `processing_rules`.
   If a rule auto-processes (e.g. small amounts), the AI does not even run.
2. **AI** — whatever the rules do not resolve goes to the agent: it consults
   precedents and previous journal entries of the issuer, distinguishes
   PUE/PPD (banks vs. vendors) and creates a **draft** with its confidence and
   reasoning.
3. **Auto-post thresholds** — off by default (everything stays as a draft).
   With `--auto-post`, the harness approves and posts only if ALL of these
   hold: confidence ≥ minimum, amount ≤ cap and the vendor is already
   registered. The rest falls to `mnemosine review`; the questions, to
   `mnemosine questions`.

Thresholds configurable in `mnemosine.config.json`:

```json
{
  "ingest": {
    "auto_post": false,
    "auto_post_min_confidence": 0.95,
    "auto_post_max_amount": 10000
  }
}
```

(the `--auto-post`, `--min-confidence` and `--max-amount` flags override them
per run). Each auto-post is audited in `ai_drafts.review_notes` and the
journal entry carries `source_type='ai_draft'`.

## System documentation for the AI (`src/ai/docs/`)

The agent knows the WHOLE system by progressive disclosure: an index of 9
topics lives in the system prompt (cached) and the `read_docs` tool loads the
module the task needs (contabilidad, cxc, cxp, bancos, mexico-cfdi, nomina,
reportes, mnemosine, sistema). Each doc separates **what the AI does with its
tools** from **what the human does** (exact CLI command or REST endpoint), so
it can operate whatever is automatable and guide everything else precisely.
To extend: add the `.md` in `src/ai/docs/` and register it in
`DOC_TOPICS` (`src/ai/tools/docs-tools.ts`).

## SAT fiscal credentials (e.firma)

The SAT bulk CFDI download **only accepts the e.firma (FIEL)** — the CSD is
rejected by the service. Since the e.firma has the same legal validity as a
handwritten signature, its custody was designed with three layers:

**1. The material never lives in Postgres.** It goes to a dedicated vault; the
`fiscal_credentials` table stores only the reference and the metadata operable
without decrypting (RFC, serial, validity). A database dump contains no
e.firma.

```bash
VAULT_BACKEND=aws-secrets-manager   # production
VAULT_BACKEND=local-dev             # development (refuses to start in production)
```

**2. A single decryption path, always audited.** `withCredential()` is the
only function that decrypts: it validates policies, writes to the access log
(`fiscal_credential_access_log`, append-only) and zeroizes the material in
`finally` — even if the callback fails. There is no function that *returns*
the material: it can only be used inside the callback.

**3. Per-credential policies.** `unattended_access` decides whether the
scheduler can decrypt without an operator present; `max_daily_access` caps how
many times per 24 h. When the limit is reached, access is denied **and
recorded** — an anomalous access pattern is the main compromise signal once
encryption at rest is already done right.

```bash
# Registration: validates locally (type, RFC vs entity, validity, key pair and
# password) BEFORE transmitting, and asks for explicit informed consent
npm run mnemosine -- sat cred add --cer efirma.cer --key efirma.key
npm run mnemosine -- sat cred add --cer e.cer --key e.key --no-unattended --max-diario 4

npm run mnemosine -- sat cred status    # validity, policy, last use, vault health
npm run mnemosine -- sat cred audit     # who decrypted, when, what for, outcome
npm run mnemosine -- sat cred revoke    # cryptographic deletion from the vault
```

**Technical notes that were hard-won**: the SAT keys come in PKCS#8 encrypted
with `PBE-SHA1-3DES`, which OpenSSL 3 treats as legacy — Node's native
`crypto` fails with *"digital envelope routines::unsupported"*. And
`X509Certificate.keyUsage` returns `undefined` in Node 22, so it cannot be
used to distinguish an e.firma from a CSD. Both are solved with `node-forge`
(pure JS, no dependency on the OpenSSL provider).

**Cost to consider**: AWS Secrets Manager charges $0.40 per secret/month, i.e.
linear in the number of entities (100 clients = $40/month; 10,000 =
$4,000/month). The `SecretVault` interface is designed for adding a
`kms-envelope` backend (a single key for everyone, ~$1/month) when volume
justifies it: migrating is a script, not a rewrite.

## External accounting systems (Contalink)

mnemosine acquires and synchronizes accounting from other systems via API
(first: [Contalink](https://apidocs.contalink.com)). Credentials:
`CONTALINK_API_KEY` in `.env` (+ optional `CONTALINK_BASE_URL`).

- **Direct reads** (`external_pull`): remote trial balance, account balance,
  fiscal documents registered over there.
- **Deterministic diff** (`external_diff_trial_balance`): remote vs local per
  account with 0.01 tolerance — the tool for migrations and parallel
  operation; the AI interprets deltas and proposes adjustments.
- **Writes through the outbox** (`external_push`): create/edit journal entries
  in the external system, upload XML, bank movements, reconciliations — they
  stay `pending` in `ai_external_ops` and a human executes them with
  `mnemosine outbox` (atomic claim against double execution; `failed` stores
  the provider's error).

To add another system (CONTPAQi, Aspel, QuickBooks…): implement
`IExternalAccountingAdapter` and register it in
`src/services/integrations/accounting/registry.ts`.

## Next phases

- ~~**Phase 2**: `draft_journal_entry` + `ai_drafts` table + `mnemosine review`~~ ✔
- ~~**Phase 3**: `ask_user` (question resolution) + precedents~~ ✔
- ~~**Phase 4**: batch CFDI ingestion with auto-post thresholds~~ ✔

## Identity and isolation (phase 0)

Three principals, two Postgres roles. Accountants have no database
credential: they come in through the API with their identity provider.

```bash
# Provision the roles once (superuser)
psql "$SUPERUSER_URL" -v app_pw="$APP_PW" -v owner_pw="$OWNER_PW" \
  -f scripts/provision-roles.sql

# Check that the isolation actually works (5 assertions)
SUPERUSER_URL=... MNEMOSINE_APP_PASSWORD=... ./scripts/verify-isolation.sh
```

With `DATABASE_URL` pointing at `mnemosine_app`, every query is scoped by RLS
and the tenant must be indicated:

```bash
npm run mnemosine -- entities --tenant <uuid>
MNEMOSINE_TENANT=<uuid> npm run mnemosine -- chat
```

Without a tenant nothing is visible — that is deliberate. An adoption gap
shows up as "I see nothing", never as a leak.

### Login with your identity provider

```bash
npm run mnemosine -- login            # browser (PKCE + loopback)
npm run mnemosine -- login --device   # SSH or a server without a browser
npm run mnemosine -- whoami
npm run mnemosine -- logout
```

Declaring `AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID` and `AUTH_OIDC_AUDIENCE`
is enough: the rest is read from the provider's
`/.well-known/openid-configuration`, so the same block works for Google
Workspace, Entra ID, Okta, Auth0, Keycloak, Zitadel or Cognito. SAML goes
behind an IdP that translates it; it is not implemented here.

The first login creates the user **with no access to any entity**: an
administrator grants `accessible_entities`, and that is audited. The IdP says
who you are; the application says what you can touch.

## Language

Two independent surfaces:

- **Agent answers** — `mnemosine lang es|en` (alias: `idioma`), default `es`.
  Resolution order: `MNEMOSINE_LANG` env var > `language` in
  `mnemosine.config.json` > `es`. An invalid env value is ignored with a
  warning; `lang <x>` warns when the env var will keep overriding it. Takes
  effect on the next session. `lang` needs no database.
- **CLI chrome** — always English (canonical command names, flags, help and
  runtime output). The complete Spanish surface is provided by aliases, which
  always work regardless of `lang`: every command has one where the word
  differs (`entidades`, `proveedores`, `pregunta`, `sesiones`, `borradores`,
  `revisar`, `ingesta`, `idioma`, `alta`, `envios`, `dudas`, `pendientes`,
  `entrar`, `salir`, `quien`, `memoria`, `configurar`, `cierre`,
  `tamano-prompt`), including subcommands (`memory teach|enseña`,
  `correct|corrige`, `retire|retira`, `restore|restaura`; `pending
  define|definir`, `dismiss|descartar`, `reopen|reabrir`; `sat cred
  add|agregar`, `status|estado`, `audit|auditoria`, `revoke|revocar`;
  `init --section identity|identidad`…) and the chat REPL (`/help|/ayuda`,
  `/new|/nueva`, `/exit|/salir`, `/provider|/proveedor`,
  `/pending|/pendientes`). Yes/no prompts display `[y/N]` and also accept
  `s`/`si`/`sí`. Pinned by `tests/cli/bilingual-matrix.spec.ts`.
