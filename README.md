# mnemosine

> Spanish twin: [`README.es.md`](README.es.md) (it carries the `source_sha` of the English it translates).

> Double-entry accounting agent for accounting firms in Mexico, from the terminal · Tier-1 · Domain: accounting · Owner: @vic2099 · Card: [`catalog-info.yaml`](catalog-info.yaml)

An accounting agent you use from the terminal. It keeps double-entry books on
PostgreSQL —chart of accounts, journal entries, customers and vendors, banks,
periods, reports— with Mexican tax compliance (CFDI 4.0, the SAT catalogs, VAT
on a cash basis) inside the engine, not bolted on top of it.

What sets it apart is not that a model talks about accounting: it is **who may
write**. The AI never posts to the ledger and never touches an external system.
It proposes in two steps —`ai_drafts` for journal entries, `ai_external_ops`
for everything that goes out into the world (stamping, sending, paying)— and a
person approves. The approval is a record with integrity, not a flag; the
limits that govern it live in `src/ai/floor.ts` and are only combined with
`Math.min`, so no configuration, stored policy or future flag can raise them.

The repository is called `Accounting` and the package `accounting-core` because
of where it started: a REST server (and, until T14b, GraphQL as well). That
engine is still there and it is what the agent operates, but the product is the
CLI. The REST API (`/v1`) and the read-only web board (`mnemosine web`) are
still in the tree and may gain features again: the owner lifted their freeze on
2026-11-18 (PRD-003, D-04 amended).

**Where it is going.** The goal the owner set is a complete accounting system,
multi-jurisdiction, operated from the CLI and native to AI, with an accounting
core, payroll calculation modules and compliance with the NIF and IFRS (NIIF)
standards. Today it is closer to the first line of this file than to that
goal: Mexico is the complete jurisdiction, the United States is partial, and
IFRS is knowledge of the agent, not behavior of the engine. What is missing,
measured, is in [`docs/SCOPE.md`](docs/SCOPE.md) («El objetivo», the goal); the
first milestone, in [`docs/MVP.md`](docs/MVP.md); what is planned, in
[PRD-003](docs/prd/PRD-003-producto-completo.md), still under review; its
decisions D-01 to D-10, which this file cites, were answered by the owner on
2026-11-17 in [#603](https://github.com/sedecim-com/Accounting/issues/603).

---

## How it fits in the platform

It is one of the repositories of the Sedecim platform ([ADR-0002](docs/adr/0002-platform-coordination.md)).

- **It neither receives from nor delivers to** any other Sedecim repository today.
- **Its counterparts are external:** the accountant, the SAT and the IMSS (through the taxpayer), Contalink, PACs and model providers.
- **It coexists with `accounting-manager`,** which books in Contalink the commissions that Grupo Promessa pays its agents. It is not a variant of this repository: another user, another ledger and another approval rule. The boundary: a single writer per Contalink company, identified by RFC ([ADR-0004](docs/adr/0004-coexistence-with-accounting-manager.md)).

Detail in [`docs/platform/inventory.md`](docs/platform/inventory.md), and the maturity level in [`docs/platform/maturity.md`](docs/platform/maturity.md).

---

## Where it stands

This project does not publish a hand-written status table. The question is put
to the code:

```bash
npm run plan:status
```

That command evaluates executable criteria (`src/plan/criteria/`) against the
tree and decides the state of each work package. It answers how many packages
have all their criteria green, and for the rest it prints the exact reason for
their red. CI runs `plan:status --exigir=...` over the ones already closed: it
is a ratchet against regression, not a report. A package that turns out to be a
false green is **reopened** in the same commit that removes it from that list,
with its reason.

The same goes for the CLI surface: the number of commands is counted by
`npm run catalogo:estado` over the binary's tree and written into
[`docs/cli-command-catalog.md`](docs/cli-command-catalog.md); CI checks that
the block is up to date.

This file carries no figures on purpose: a figure written by hand expires as
soon as someone pushes. Those two commands give them, and what has already been
delivered, with its PR and its date, is in [`docs/HISTORY.md`](docs/HISTORY.md).

### What is not yet what it seems

It is said here because finding it out by reading the code would be worse:

- **The blockchain attestation is simulated.** Every chain adapter declares
  `simulado = true` (`src/services/blockchain/chain-adapters.ts`,
  `zkverify-client.ts`): there is no transaction on any network. That is why
  public verification is **off by default** —it is switched on with
  `PUBLIC_VERIFICATION_ENABLED=true`— and, even when on, every endpoint refuses
  to serve a simulated row. It is not part of the goal: PRD-003 (D-04) retires
  it, together with the simulated payment adapters.
- **Stamping with a PAC cannot be used in production.** Of the four adapters,
  three (Finkok, Edicom, SW Sapien) declare themselves simulated and a lock
  keeps them from stamping outside the sandbox; only Sovos/Reachcore declares
  `simulado = false`. Stamping and cancelling are outside the MVP and are v1.0
  scope ([`docs/MVP.md`](docs/MVP.md) §1,
  [#105](https://github.com/sedecim-com/Accounting/issues/105)): there is
  already a contract with Sovos, and the owner asked for several providers,
  each with the key its administrator adds. Meanwhile, the client issues the
  CFDI in their own system and they are ingested here.
- **With the SAT it downloads and seals; it does not file.** Bulk download of
  CFDI with the e.firma exists (`mnemosine sat download`), and the census is
  read against what has been booked. Filing the electronic accounting, the DIOT
  and the tax returns is still manual, on the portal.
- **Multi-jurisdiction is not yet a property of the engine.** The code knows
  two countries (`JurisdictionCode = 'MX' | 'US'`) and the per-country package
  of [`docs/jurisdicciones.md`](docs/jurisdicciones.md) does not exist as a
  boundary.
- **IFRS is knowledge of the agent, not behavior**, and the NIF live inside the
  engines, without a module of their own. What is missing from each is in
  `docs/SCOPE.md`, «El objetivo».
- **United States payroll is partial**: there are calculators registered for
  the 50 states and the District of Columbia, and only five have seeded
  parameters (PRD-003, D-03).
- **GraphQL was retired** ([#101](https://github.com/sedecim-com/Accounting/issues/101)).
  It was a second door into the same engine, switched off behind a flag and
  without a single consumer. The only HTTP API is REST `/v1`.
- **Seven REST handlers are retired** and throw `NotImplementedError` instead
  of pretending they did something.
- **There is no MCP server** (PRD-003, D-07). An external agent operates the
  CLI like any other program: `--json`, exit codes and `--dry-run`.
- **The backup exists, but scheduling it is up to you.** `mnemosine backup`
  creates, lists, verifies by rehearsing the restore, and restores; it also
  exports one tenant or one entity, which is an export and not a restorable
  backup. It matters more than in other systems: since migration 041 the ledger
  is physically immutable and `audit_log` is append-only, so a data error
  **cannot be repaired by hand**.

---

## Quick start

**Requirements:** Node ≥ 22.12 (`engines` demands it), PostgreSQL 15. Redis is
optional (cache and rate limiter; the CLI does not need it).

```bash
git clone https://github.com/sedecim-com/Accounting.git
cd Accounting
npm ci
scripts/setup.sh     # development .env, Postgres, database, roles and migrations
npm run seed         # optional: demo tenant, entity, chart of accounts and periods
```

`scripts/setup.sh` is idempotent and never rewrites a `.env` that already
exists. It uses the Postgres that answers at `TEST_ADMIN_DATABASE_URL`; if none
does and Docker is there, it starts one with the CI version. The devcontainer
(`.devcontainer/`) runs it when it is created. The manual steps, and what each
variable means, are in [`docs/MVP.md`](docs/MVP.md) §7 and in `.env.example`.
`JWT_SECRET` and `ENCRYPTION_KEY` may be empty in development: startup
**refuses** to run with the development values under `NODE_ENV=production`.

The binary is not installed as a global command: it is invoked through npm.

```bash
npm run mnemosine -- init      # wizard: infrastructure, entity, users, AI provider
npm run mnemosine -- doctor    # database, migrations, provider, credentials, isolation
npm run mnemosine -- chat      # the conversational session
```

With RLS active, every command needs to know which tenant it works on: set
`MNEMOSINE_TENANT` in `.env` or pass `-T <uuid>`.

Help and messages come out in Spanish or in English: `--locale es-MX|en-US`, or
`MNEMOSINE_LOCALE`. `mnemosine --help` states the full precedence.

The first real cycle is short:

```bash
npm run mnemosine -- ingest facturas/*.xml   # CFDI → rules → classification → DRAFTS
npm run mnemosine -- drafts                  # what the AI proposed
npm run mnemosine -- review                  # approve (really posts) or reject
npm run mnemosine -- report trial-balance show   # and see the effect
```

The exact reference of commands and flags —generated from the program itself,
never by hand— is in [`src/ai/docs/cli-reference.md`](src/ai/docs/cli-reference.md).

---

## The model provider

mnemosine is not wedded to one provider. There are two session engines:
Anthropic's native one (`MnemosineAgent`, with prompt caching and reasoning
blocks) and an OpenAI-compatible adapter (`OpenAiCompatSession`) that serves
everything else. The built-in profiles (`BUILTIN_PROFILES`, in
`src/ai/providers/config.ts`) are thirteen: anthropic, openai, gemini, grok,
nvidia, qwen, minimax, openrouter, copilot and hermes, plus three local ones:
`ollama`, `hermes-agent` and `openclaw`. `nvidia` is NVIDIA's hosted trial,
which records what it receives: never for client data. They are added or
redefined in `mnemosine.config.json`.

The provider credential belongs to each user: they put it in their own
environment. There is no shared key, and none lives in the repository.

**It works with local models and without an API key.** The `ollama` profile is
built in: `MNEMOSINE_PROVIDER=ollama` is enough, or a `mnemosine.config.json`
at the root (it is not versioned: it is in `.gitignore`) that makes it the
default and names a model you have installed:

```json
{
  "default_provider": "ollama",
  "providers": {
    "ollama": {
      "type": "openai-compatible",
      "model": "llama3.1",
      "base_url": "http://localhost:11434/v1"
    }
  }
}
```

The local model must support *tool calling*: without tools the agent can
converse, but it cannot query the ledger or leave a draft.

**Secrets never go in the configuration file.** The profile only *names* where
the credential comes from: `api_key_env` (an environment variable) or
`api_key_cmd` (a command that prints it — a secrets manager, or the token of a
subscription already signed in). The schema is strict and fails loudly on an
unknown key: a mistyped `api_key_evn` would fall back to the defaults, which is
the worst failure mode for a file that governs credentials.

Precedence: `--provider` > `MNEMOSINE_PROVIDER` > `default_provider` >
`anthropic`. `npm run mnemosine -- providers` lists what is configured;
`status` probes which one really answers.

Two warnings the catalog itself carries in writing: `hermes-agent` and
`openclaw` run **their own** tools on the server side and do not return the
calls to the client — over that channel the accounting tools are not invoked.

---

## Architecture

Five layers, from the outside in:

1. **CLI (`src/cli/`)** — commander commands over a shared kernel
   (`src/cli/kernel/`) that enforces what cuts across them: a risk declaration
   per command, a confirmation gate on mutations, entity scope, output format
   and exit codes.
2. **Agent (`src/ai/`)** — session, system prompt, tools, history compaction,
   the firm's memory (precedents the user can correct and delete), the firm's
   *skills* with progressive disclosure, scheduled jobs, inbound webhooks and a
   per-call usage and cost ledger.
3. **Two-step writes** — `draft-service` (journal entries) and
   `external-service` (outbox towards external systems), plus `approval-policy`
   and the immovable floor of `floor.ts`.
4. **Services (`src/services/`)** — the engine: accounting and posting, period
   close, AP/AR, payments, banks, assets, MX/US payroll, CFDI ingestion,
   reports, the fiscal credentials vault, audit.
5. **Database (`src/database/`)** — the migrations (only added, an applied one
   is never edited) and the RLS policies, which are reapplied after every
   migration.

Every physical write to the ledger goes through a single module
(`services/accounting/posting.ts`). An approved draft takes no shortcut: it
creates the entry through `createJournalEntry`, with all the engine's
validations.

The REST API (`/v1`) is still alive and audited, and may gain routes again
since the owner amended D-04 on 2026-11-18; the CLI and the API share services.
Unattended jobs —ingestion, scheduled tasks— run with a **named** tool surface,
not the full one, and without the conversational safety net: nobody is watching
the corrective turn.

---

## Isolation between tenants

It is not a `WHERE` in TypeScript. It is PostgreSQL *row-level security*:

- The application connects as `mnemosine_app`, a role **subject to RLS** that
  can only do DML and owns nothing. `mnemosine_owner` owns the schema and is
  used only by `npm run migrate`. Both are created with
  `scripts/provision-roles.sql`, which is not a migration because roles are
  cluster-level objects.
- The context is opened with `enterTenant` in the CLI, or with `withTenant`,
  and each connection already checked out gets
  `set_config('app.current_tenant', …, true)` — parametrized, because the
  tenant comes from data.
- `src/database/rls-policies.sql` is **idempotent and re-run after every
  migration**. The reason is a scar: a hardening migration protects what exists
  when it runs, and `ai_external_ops` was born nine minutes later, without a
  policy and silently.
- Crossing the entity boundary returns **404, always**. A 403 would confirm
  that the resource exists.
- CI has a separate job for this, and it connects as `mnemosine_app` on
  purpose: running as superuser, RLS filters nothing and a missing policy would
  never be detected.

`src/config/index.ts` refuses to start in production with the development
secrets, and startup checks that the role does not bypass RLS.

---

## Mexican tax

It is the part that cannot be improvised, and the reason the engine is our own:

- **CFDI 4.0**: parser, SAT catalogs, validation, accounting taxonomy and a
  posting plan per voucher. What a third party wrote —the XML— comes in
  wrapped as untrusted: it is data, never instruction.
- **VAT on a cash basis** (LIVA art. 1-B and art. 5 fr. III). The `MetodoPago`
  decides: with **PUE** the VAT is due or creditable on issue; with **PPD** it
  is not, and it is parked in *IVA trasladado no cobrado* (VAT charged, not
  collected) / *IVA pendiente de acreditar* (VAT pending credit) until the
  payment complement (REP) arrives, which moves it to the effective accounts.
  Linking the REP to the original document and the reclassification exist as
  engine and as command.
- **e.firma and CSD** in an encrypted vault, with an access log; the material
  is not read outside `withCredential`.
- **Stamping** routed between PACs with failover — with the simulation
  limitation stated above.
- **Mexican NIF** and IFRS/NIIF live as knowledge the agent can consult in
  `src/ai/docs/`, not as prose in the prompt: the session pays context only for
  what it opens.

## Two jurisdictions, one engine

The system starts with Mexico and the United States and aims at more
countries. Today the semantics are Mexican almost everywhere, and the United
States has federal and state payroll (FIT, FICA, FUTA, SUTA, 941/940/W-2)
—with parameters seeded for five states and tables still to be corrected— and
little else. The verified inventory of which engine exists for each country
—with its gaps named and its `file:line`— is in
[`docs/investigacion/2026-09-06-normas-y-motores/motores-inventario.md`](docs/investigacion/2026-09-06-normas-y-motores/motores-inventario.md).

The design rule that orders internationalization is one: **the law is not
decided and judgment is not legislated.** What the law sets (rates, caps,
tables, UMA) goes to a table with an effective date and an official source;
what the firm decides (depreciation basis, where the result goes) goes to the
policy panel with its reader; each country is a configurable package over the
same engine. The design of the panel per jurisdiction —and why today's knows
nothing of countries— is in [`docs/jurisdicciones.md`](docs/jurisdicciones.md).

---

## Tests

```bash
npm run typecheck        # tsc --noEmit over src/
npm run typecheck:tests
npm test                 # unit
npm run test:integration # against a real Postgres
```

Everything CI runs, in a single command: `scripts/verify.sh` (see `AGENTS.md`, «Comandos»).

The integration suite creates and destroys an ephemeral database per run, so it
asks for `TEST_ADMIN_DATABASE_URL` (a role with `CREATE DATABASE`) and refuses
to start without it. It runs serially on purpose: several tests count rows.

`npm run lint` is no longer an ornament: it runs ESLint 10 with type
information (`eslint.config.mjs`) over `src/`, `tests/` and `scripts/`, and CI
requires it. Errors break the build; warnings carry a ratchet (the
`--max-warnings` of the `lint` script in `package.json`, frozen at what was
measured) so that they can only go down.

---

## How to contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md): the workflow, the house invariants and
why commit messages explain the *why* and not the diff are there.

In short: one PR per idea, from a branch of your own and against `develop` (the
flow is `feature → develop → release → main`,
[ADR-0008](docs/adr/0008-develop-release-branches.md)), with CI green: Tipos
(types), Pruebas unitarias (unit tests), Integración contra Postgres
(integration against Postgres), Aislamiento por inquilino (tenant isolation),
Estado del plan (plan status) and Commit subjects. The gate is CI: there are no
required approvals and no required review by another model (Witness stopped
being a requirement on 2026-11-15); the human review each issue asks for is set
by `docs/ROUTING.md`. The full cycle —plan, issue, PR, CI— is in
[`docs/PROCESS.md`](docs/PROCESS.md). If your change closes a package of the
plan, add it to the `--exigir` list of `.github/workflows/ci.yml` in the same
commit; if it reopens one, remove it right there and say why.

Code, comments and commit messages are **born in English** (epic
[#141](https://github.com/sedecim-com/Accounting/issues/141)). What the user
reads —the CLI help, the messages, the documentation— goes in English first and
in Spanish, or another language, after it (the owner's decision of
2026-11-15); the rule and what is left to translate are in
[`docs/language.md`](docs/language.md). No emoji, no `feat:` or `chore:`.

## Security

If you found a vulnerability, **do not open an issue or a PR with the fix**: a
public diff is the disclosure. The private channel and the priorities are in
[SECURITY.md](SECURITY.md).

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). No CLA is needed:
section 5 of the license itself covers contributions.

## More documentation

The **[repository wiki](https://github.com/sedecim-com/Accounting/wiki)** is
the long site: how it works inside and why it was decided that way. This README
answers what it is and how to start; the wiki answers everything else
—architecture, the agent's autonomy model, tenant isolation, Mexican tax with
worked numbers, the glossary for those who are not accountants, and
troubleshooting—. Its source lives in [`docs/wiki/`](docs/wiki/) and is
published from there.

Inside the repository:

- **The framework's doors:** [`AGENTS.md`](AGENTS.md) for agents, [`docs/SCOPE.md`](docs/SCOPE.md), [`docs/MVP.md`](docs/MVP.md),
  [`docs/REPO_MAP.md`](docs/REPO_MAP.md),
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/RUNBOOK.md`](docs/RUNBOOK.md), the decisions in
  [`docs/adr/`](docs/adr/README.md) and the cycle of a new development in [`docs/prd/`](docs/prd/README.md).
- [`docs/cli-command-catalog.md`](docs/cli-command-catalog.md) — the command
  surface aimed at, checked row by row against the backend, with the generated
  count.
- [`src/ai/docs/cli-reference.md`](src/ai/docs/cli-reference.md) — today's
  exact surface, generated from the binary.
- [`docs/migraciones.md`](docs/migraciones.md) — numbering, ranges and the four
  historical duplicates that cannot be renumbered.
- [`docs/pac-proveedores.md`](docs/pac-proveedores.md) — stamping providers.
- [`docs/plan-catalogo.md`](docs/plan-catalogo.md) — «Doce sprints o sesenta»
  (twelve sprints or sixty): the per-row cost model and the ordering by flows.
- [`docs/plan-cierre-brechas.md`](docs/plan-cierre-brechas.md) — the inherited
  guarantees, settled item by item.
- [`docs/jurisdicciones.md`](docs/jurisdicciones.md) — jurisdiction as a
  dimension: the governing design of the per-country configuration panel.
- [`docs/investigacion/2026-09-06-normas-y-motores/`](docs/investigacion/2026-09-06-normas-y-motores/)
  — the research on standards and engines: the verified inventory of engines by
  jurisdiction, and the official sources for US GAAP, IFRS/NIIF, NIF and the
  tax rules of Mexico and the United States.
- [`docs/investigacion/2026-09-02-mejores-practicas/`](docs/investigacion/2026-09-02-mejores-practicas/)
  — the research on connectors and direction: PACs, AI providers, onboarding,
  graphical board, messaging channels and the experimental architecture of
  public/private accounts. Every link verified with fetch; the dead ones are
  said. In the wiki: five «Hacia dónde va» (where it is going) pages derived
  from it.
- [`docs/auditorias/`](docs/auditorias/) — the adversarial audits. The August
  one opened with seven lenses; the September one went up to twelve, and every
  major finding went through a skeptic tasked with refuting it.
