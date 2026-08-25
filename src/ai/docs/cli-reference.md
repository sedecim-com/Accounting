# CLI reference (auto-generated — do not edit by hand)

Regenerate with: `npx tsx scripts/generate-cli-reference.ts`.

This is the EXACT surface of the `mnemosine` binary: quote commands and
flags verbatim when guiding a human — never invent a flag that is not
listed here. When a flow needs several commands, give them in order.

Notes for the agent:
- The global option `-T, --tenant <uuid>` (or the `MNEMOSINE_TENANT` env
  var) scopes EVERY command under row-level security. It appears only on
  the root help below, but it works before any subcommand.
- Spanish aliases (shown as `name|alias`) are equivalent to the English
  names; use whichever matches the user's language.

## `mnemosine` (root)

```
Usage: mnemosine [options] [command]

AI accounting assistant — converse with your accounting from the terminal

Options:
  -V, --version                         output the version number
  -T, --tenant <uuid>                   Tenant to operate on (or
                                        MNEMOSINE_TENANT). Scopes EVERY query
                                        via RLS
  -h, --help                            display help for command

Commands:
  entities|entidades                    Lists the active legal entities
  providers|proveedores                 Lists the configured model providers
                                        (built-in + mnemosine.config.json)
  ask|pregunta [options] <question...>  Asks a single question and exits
  chat [options]                        Opens an interactive chat session
                                        (default)
  sessions|sesiones [options]           Lists recent chat sessions (resume one
                                        with: mnemosine chat --resume <id>)
  drafts|borradores [options]           Lists the journal entry drafts created
                                        by the AI
  review|revisar [options]              Reviews pending drafts: approve (creates
                                        and posts the journal entry) or reject
  ingest|ingesta [options] <files...>   Batch ingestion of CFDIs (XML): rules →
                                        AI classification → drafts (or auto-post
                                        by thresholds)
  lang|idioma [language]                Shows or sets the language of the
                                        AGENT's answers (CLI UI stays English;
                                        Spanish command aliases always work)
  onboard|alta [options]                Imports a client's accounting from an
                                        external system (chart of accounts +
                                        opening balances)
  outbox|envios [options]               Reviews and executes the operations
                                        queued for external accounting systems
  questions|dudas [options]             Manages the agent's pending questions:
                                        answer (saved as a precedent) or dismiss
  sat                                   SAT services (credentials and CFDI
                                        download)
  pending|pendientes [options]          What you need to do: work to resolve and
                                        policy decisions to define
  login|entrar [options]                Signs in with your identity provider
                                        (OIDC)
  logout|salir                          Deletes the stored credential
  whoami|quien                          Shows the active credential and its
                                        validity
  doctor [options]                      Diagnoses system health: DB, migrations,
                                        provider, credentials, isolation
  memory|memoria [options]              Firm precedents: what the AI learned and
                                        you control
  prompt-size|tamano-prompt [options]   Offline breakdown of the system prompt
                                        and tool schemas (no API calls)
  compact|compactar [options]           Dry-run compaction report for a session
                                        transcript (no API calls)
  approvals|aprobaciones                Graduated approval policies for staged
                                        writes (once / session / always)
  usage|uso [options]                   Token usage and estimated cost from the
                                        local ledger (no API calls)
  status|estado [options]               Health snapshot: config, live provider
                                        probes, database and RLS (redacted,
                                        shareable)
  jobs|tareas                           Persisted scheduled agent tasks (all
                                        output is reviewable drafts, never
                                        direct writes)
  init|configurar [options]             Guided setup: infrastructure, entity,
                                        users, AI provider, and your books
  close|cierre [options]                Month-end close: checks what is missing
                                        and closes the period
  help [command]                        display help for command
```

## `mnemosine entities` (alias: entidades)

```
Usage: mnemosine entities|entidades [options]

Lists the active legal entities

Options:
  -h, --help  display help for command
```

## `mnemosine providers` (alias: proveedores)

```
Usage: mnemosine providers|proveedores [options]

Lists the configured model providers (built-in + mnemosine.config.json)

Options:
  -h, --help  display help for command
```

## `mnemosine ask` (alias: pregunta)

```
Usage: mnemosine ask|pregunta [options] <question...>

Asks a single question and exits

Arguments:
  question                 The question for the assistant

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -p, --provider <name>    Model provider (see: mnemosine providers)
  -m, --model <model>      Override the profile model
  -h, --help               display help for command
```

## `mnemosine chat`

```
Usage: mnemosine chat [options]

Opens an interactive chat session (default)

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -p, --provider <name>    Model provider (see: mnemosine providers)
  -m, --model <model>      Override the profile model
  --continue               Resume the latest session of this terminal/entity
                           (transcript continuity; the model context starts
                           fresh)
  --resume <id>            Resume a specific session by id (see: mnemosine
                           sessions)
  --no-banner              Suppress the startup banner (also:
                           MNEMOSINE_NO_BANNER=1)
  -h, --help               display help for command
```

## `mnemosine sessions` (alias: sesiones)

```
Usage: mnemosine sessions|sesiones [options]

Lists recent chat sessions (resume one with: mnemosine chat --resume <id>)

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -n, --limit <n>          Maximum number of sessions to show (default: 20)
  -h, --help               display help for command
```

## `mnemosine drafts` (alias: borradores)

```
Usage: mnemosine drafts|borradores [options]

Lists the journal entry drafts created by the AI

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -s, --status <status>    pending_review | approved | rejected
  -h, --help               display help for command
```

## `mnemosine review` (alias: revisar)

```
Usage: mnemosine review|revisar [options]

Reviews pending drafts: approve (creates and posts the journal entry) or reject

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -u, --user <email>       Reviewer email (default: first active user of the
                           tenant)
  -h, --help               display help for command
```

## `mnemosine ingest` (alias: ingesta)

```
Usage: mnemosine ingest|ingesta [options] <files...>

Batch ingestion of CFDIs (XML): rules → AI classification → drafts (or auto-post
by thresholds)

Arguments:
  files                    Paths to CFDI XML files

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -p, --provider <name>    Model provider (see: mnemosine providers)
  -m, --model <model>      Override the profile model
  -u, --user <email>       User the ingestion is attributed to (default: sole
                           active user)
  --auto-post              Enables threshold-based auto-posting (default:
                           everything stays as draft)
  --no-auto-post           Disables auto-posting even if the config has it
                           turned on
  --min-confidence <n>     Minimum confidence for auto-post (0-1)
  --max-amount <n>         Maximum auto-postable amount
  -h, --help               display help for command
```

## `mnemosine lang` (alias: idioma)

```
Usage: mnemosine lang|idioma [options] [language]

Shows or sets the language of the AGENT's answers (CLI UI stays English; Spanish
command aliases always work)

Arguments:
  language    'en' or 'es'; omit to show the current setting

Options:
  -h, --help  display help for command
```

## `mnemosine onboard` (alias: alta)

```
Usage: mnemosine onboard|alta [options]

Imports a client's accounting from an external system (chart of accounts +
opening balances)

Options:
  -p, --provider <name>     External system, e.g. contalink
  --cutoff <YYYY-MM-DD>     Cutoff date: opening balances are taken as of this
                            date
  --from <YYYY-MM-DD>       Start of the remote trial balance period (default:
                            January 1st of the cutoff year)
  -e, --entity <idOrName>   Target legal entity (id, RFC or name fragment)
  -u, --user <email>        Who runs it (default: sole active user of the
                            tenant)
  --balance-account <code>  Balancing account if the remote trial balance does
                            not sum to zero (e.g. 3200)
  --post                    Post the opening balance immediately (default: stays
                            as a draft for mnemosine review)
  --dry-run                 Only show the plan, without executing anything
  -h, --help                display help for command
```

## `mnemosine outbox` (alias: envios)

```
Usage: mnemosine outbox|envios [options]

Reviews and executes the operations queued for external accounting systems

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -u, --user <email>       Who executes (default: sole active user of the
                           tenant)
  -l, --list               Only list, without executing
  -h, --help               display help for command
```

## `mnemosine questions` (alias: dudas)

```
Usage: mnemosine questions|dudas [options]

Manages the agent's pending questions: answer (saved as a precedent) or dismiss

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -u, --user <email>       Who answers (default: sole active user of the tenant)
  -l, --list               Only list, without answering
  -h, --help               display help for command
```

## `mnemosine sat`

```
Usage: mnemosine sat [options] [command]

SAT services (credentials and CFDI download)

Options:
  -h, --help      display help for command

Commands:
  cred            Fiscal credentials (e.firma)
  help [command]  display help for command
```

### `mnemosine sat cred`

```
Usage: mnemosine sat cred [options] [command]

Fiscal credentials (e.firma)

Options:
  -h, --help                 display help for command

Commands:
  add|agregar [options]      Registers the e.firma of an entity (validates
                             locally before transmitting)
  status|estado [options]    Shows the entity credentials and their validity
  audit|auditoria [options]  Credential access history (who used it, when and
                             what for)
  revoke|revocar [options]   Revokes the credential and deletes the material
                             from the vault (irreversible)
  help [command]             display help for command
```

#### `mnemosine sat cred add` (alias: agregar)

```
Usage: mnemosine sat cred add|agregar [options]

Registers the e.firma of an entity (validates locally before transmitting)

Options:
  --cer <file>             SAT .cer certificate (DER)
  --key <file>             SAT .key private key (DER)
  -e, --entity <idOrName>  Legal entity
  -u, --user <email>       Who grants the consent
  --no-unattended          Forbid use without an operator present
  --max-diario <n>         Access limit per 24 h
  -h, --help               display help for command
```

#### `mnemosine sat cred status` (alias: estado)

```
Usage: mnemosine sat cred status|estado [options]

Shows the entity credentials and their validity

Options:
  -e, --entity <idOrName>  Legal entity
  -h, --help               display help for command
```

#### `mnemosine sat cred audit` (alias: auditoria)

```
Usage: mnemosine sat cred audit|auditoria [options]

Credential access history (who used it, when and what for)

Options:
  -e, --entity <idOrName>  Legal entity
  -n, --limit <n>          How many events to show (default: 30)
  -h, --help               display help for command
```

#### `mnemosine sat cred revoke` (alias: revocar)

```
Usage: mnemosine sat cred revoke|revocar [options]

Revokes the credential and deletes the material from the vault (irreversible)

Options:
  -e, --entity <idOrName>  Legal entity
  -u, --user <email>       Who revokes
  -h, --help               display help for command
```

## `mnemosine pending` (alias: pendientes)

```
Usage: mnemosine pending|pendientes [options] [command]

What you need to do: work to resolve and policy decisions to define

Options:
  -e, --entity <idOrName>                 Legal entity
  -v, --verbose                           Show impact, options and rationale of each default
  -a, --all                               Include definitions already resolved and dismissed
  -h, --help                              display help for command

Commands:
  define|definir [options] <key> [value]  Defines a pending decision (the value takes effect immediately)
  dismiss|descartar [options] <key>       Marks a definition as not applicable (leaves the agenda)
  reopen|reabrir [options] <key>          Reopens an already resolved definition (the policy changed)
```

### `mnemosine pending define` (alias: definir)

```
Usage: mnemosine pending define|definir [options] <key> [value]

Defines a pending decision (the value takes effect immediately)

Arguments:
  key                      Decision key (see: mnemosine pending)
  value                    Chosen value; if omitted, asked interactively

Options:
  -e, --entity <idOrName>  Legal entity
  -u, --user <email>       Who defines it
  -n, --note <text>        Note or rationale
  -h, --help               display help for command
```

### `mnemosine pending dismiss` (alias: descartar)

```
Usage: mnemosine pending dismiss|descartar [options] <key>

Marks a definition as not applicable (leaves the agenda)

Options:
  -e, --entity <idOrName>  Legal entity
  -u, --user <email>       Who dismisses it
  -n, --note <text>        Why it does not apply
  -h, --help               display help for command
```

### `mnemosine pending reopen` (alias: reabrir)

```
Usage: mnemosine pending reopen|reabrir [options] <key>

Reopens an already resolved definition (the policy changed)

Options:
  -e, --entity <idOrName>  Legal entity
  -h, --help               display help for command
```

## `mnemosine login` (alias: entrar)

```
Usage: mnemosine login|entrar [options]

Signs in with your identity provider (OIDC)

Options:
  --device    Use the device-code flow (SSH, server without a browser)
  -h, --help  display help for command
```

## `mnemosine logout` (alias: salir)

```
Usage: mnemosine logout|salir [options]

Deletes the stored credential

Options:
  -h, --help  display help for command
```

## `mnemosine whoami` (alias: quien)

```
Usage: mnemosine whoami|quien [options]

Shows the active credential and its validity

Options:
  -h, --help  display help for command
```

## `mnemosine doctor`

```
Usage: mnemosine doctor [options]

Diagnoses system health: DB, migrations, provider, credentials, isolation

Options:
  --json      JSON output for scripts
  -h, --help  display help for command
```

## `mnemosine memory` (alias: memoria)

```
Usage: mnemosine memory|memoria [options] [command]

Firm precedents: what the AI learned and you control

Options:
  -e, --entity <idOrName>                    Legal entity
  -t, --tenant <id>                          Tenant
  -b, --search <text>                        Filter by text
  --all                                      Include retired ones
  --json                                     JSON output
  -h, --help                                 display help for command

Commands:
  teach|enseña [options] <rule> <criterion>  Seeds a firm criterion without waiting for the AI to ask
  correct|corrige [options] <id> <answer>    Changes the answer of a precedent (the previous one stays in the history)
  retire|retira [options] <id>               The AI stops using this precedent (not deleted: the history remains)
  restore|restaura <id>                      Reactivates a retired precedent
```

### `mnemosine memory teach` (alias: enseña, ensena)

```
Usage: mnemosine memory teach|enseña [options] <rule> <criterion>

Seeds a firm criterion without waiting for the AI to ask

Arguments:
  rule                The situation, e.g. "Telmex invoices"
  criterion           What to do, e.g. "they go to 6130 Utilities"

Options:
  -u, --user <email>  Who teaches it
  --topic <slug>      Topic for grouping precedents
  -h, --help          display help for command
```

### `mnemosine memory correct` (alias: corrige)

```
Usage: mnemosine memory correct|corrige [options] <id> <answer>

Changes the answer of a precedent (the previous one stays in the history)

Arguments:
  id                  Precedent id
  answer              The correct answer

Options:
  -u, --user <email>  Who corrects
  -h, --help          display help for command
```

### `mnemosine memory retire` (alias: retira)

```
Usage: mnemosine memory retire|retira [options] <id>

The AI stops using this precedent (not deleted: the history remains)

Arguments:
  id                  Precedent id

Options:
  -u, --user <email>  Who retires it
  -h, --help          display help for command
```

### `mnemosine memory restore` (alias: restaura)

```
Usage: mnemosine memory restore|restaura [options] <id>

Reactivates a retired precedent

Arguments:
  id          Precedent id

Options:
  -h, --help  display help for command
```

## `mnemosine prompt-size` (alias: tamano-prompt)

```
Usage: mnemosine prompt-size|tamano-prompt [options]

Offline breakdown of the system prompt and tool schemas (no API calls)

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  --json                   JSON output
  -h, --help               display help for command
```

## `mnemosine compact` (alias: compactar)

```
Usage: mnemosine compact|compactar [options]

Dry-run compaction report for a session transcript (no API calls)

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  -s, --session <id>       Session id (default: the most recent session)
  --keep <tokens>          Recent tail to keep intact, in tokens (default:
                           "20000")
  --json                   JSON output
  -h, --help               display help for command
```

## `mnemosine approvals` (alias: aprobaciones)

```
Usage: mnemosine approvals|aprobaciones [options] [command]

Graduated approval policies for staged writes (once / session / always)

Options:
  -h, --help             display help for command

Commands:
  list [options]         List approval policies of the entity
  grant [options]        Grant a pattern-based approval policy (conservative
                         matching; the floor always wins)
  revoke [options] <id>  Revoke an active approval policy
  help [command]         display help for command
```

### `mnemosine approvals list`

```
Usage: mnemosine approvals list [options]

List approval policies of the entity

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  --scope <scope>          Filter by scope (draft | external_op)
  --all                    Include revoked policies
  --json                   JSON output
  -h, --help               display help for command
```

### `mnemosine approvals grant`

```
Usage: mnemosine approvals grant [options]

Grant a pattern-based approval policy (conservative matching; the floor always
wins)

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  --scope <scope>          Scope of the policy (draft | external_op)
  --mode <mode>            Policy mode (once | session | always)
  --kind <kind>            Match field: candidate kind. For drafts this is the
                           draft payload's "kind" (or "entry_type") field,
                           falling back to "journal_entry" when absent — kinds
                           in use today: journal_entry (default), payroll
  --max-amount <amount>    Match field: maximum amount authorized (numeric
                           string)
  --provider <provider>    Match field: external provider (e.g. contalink)
  --operation <operation>  Match field: external operation (e.g. create_policy)
  --session <id>           Granting session id (required for --mode session)
  -u, --user <email>       Granting user (required when the tenant has several
                           active users)
  -h, --help               display help for command
```

### `mnemosine approvals revoke`

```
Usage: mnemosine approvals revoke [options] <id>

Revoke an active approval policy

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  -h, --help               display help for command
```

## `mnemosine usage` (alias: uso)

```
Usage: mnemosine usage|uso [options]

Token usage and estimated cost from the local ledger (no API calls)

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  --since <window>         Window: Nd (e.g. 7d, 30d) or YYYY-MM-DD
  --by <dimension>         Group by: model, provider, day, session (default:
                           "model")
  --json                   JSON output
  -h, --help               display help for command
```

## `mnemosine status` (alias: estado)

```
Usage: mnemosine status|estado [options]

Health snapshot: config, live provider probes, database and RLS (redacted,
shareable)

Options:
  --all              Probe every configured profile, not only the active
                     failover chain
  -t, --tenant <id>  Tenant (for the RLS-active check)
  --json             JSON output (same redacted structure, for support tickets)
  --strict           Also exit 1 when any provider probe fails or is skipped (by
                     default only database unreachability fails the command)
  -h, --help         display help for command
```

## `mnemosine jobs` (alias: tareas)

```
Usage: mnemosine jobs|tareas [options] [command]

Persisted scheduled agent tasks (all output is reviewable drafts, never direct
writes)

Options:
  -h, --help                 display help for command

Commands:
  list [options]             List the scheduled jobs of this entity
  create [options]           Create a scheduled job
  enable [options] <jobId>   Enable a job (resets its failure counter and
                             recomputes the next run)
  disable [options] <jobId>  Disable a job (it stays configured; runs stop)
  run-due [options]          Tick entry point: claim and run every due job (call
                             this from cron/launchd)
  history [options]          Execution log (most recent first)
  help [command]             display help for command
```

### `mnemosine jobs list`

```
Usage: mnemosine jobs list [options]

List the scheduled jobs of this entity

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  -h, --help               display help for command
```

### `mnemosine jobs create`

```
Usage: mnemosine jobs create [options]

Create a scheduled job

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  --name <name>            Job name (unique per entity)
  --kind <kind>            Job kind: close_verification | cfdi_reconciliation |
                           ar_reminders
  --schedule <cron>        5-field cron expression, e.g. "0 2 * * *" (nightly at
                           02:00)
  --max-failures <n>       Auto-disable after N consecutive failures (default 3)
  --user <email>           Who creates the job (audit)
  -h, --help               display help for command
```

### `mnemosine jobs enable`

```
Usage: mnemosine jobs enable [options] <jobId>

Enable a job (resets its failure counter and recomputes the next run)

Arguments:
  jobId                    Job id

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  -h, --help               display help for command
```

### `mnemosine jobs disable`

```
Usage: mnemosine jobs disable [options] <jobId>

Disable a job (it stays configured; runs stop)

Arguments:
  jobId                    Job id

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  -h, --help               display help for command
```

### `mnemosine jobs run-due`

```
Usage: mnemosine jobs run-due [options]

Tick entry point: claim and run every due job (call this from cron/launchd)

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  -h, --help               display help for command
```

### `mnemosine jobs history`

```
Usage: mnemosine jobs history [options]

Execution log (most recent first)

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  --job <jobId>            Only this job
  --limit <n>              Rows to show (default 20)
  -h, --help               display help for command
```

## `mnemosine init` (alias: configurar)

```
Usage: mnemosine init|configurar [options]

Guided setup: infrastructure, entity, users, AI provider, and your books

Options:
  --status               Only show the status, configure nothing
  --section <id>         Configure a single section
                         (infra|identity|users|ai|policies|import)
  -y, --yes              Non-interactive: use defaults and flags, ask nothing
  -t, --tenant <id>      Tenant
  --entity <name>        Name of the legal entity to create
  --rfc <rfc>            RFC/EIN of the entity
  --country <country>    MX | USA
  --currency <currency>  Functional currency
  --provider <name>      Default AI provider
  --model <model>        Provider model
  -u, --user <email>     Email of the user to create
  -h, --help             display help for command
```

## `mnemosine close` (alias: cierre)

```
Usage: mnemosine close|cierre [options]

Month-end close: checks what is missing and closes the period

Options:
  -e, --entity <idOrName>  Legal entity
  -t, --tenant <id>        Tenant
  -u, --user <email>       Who performs the close
  -p, --period <name>      Period to close (default: the oldest open one)
  -l, --list               List closable periods and exit
  --check                  Only check readiness, never close
  --hard                   Hard close (irreversible) instead of soft close
  --json                   JSON output for scripts
  -h, --help               display help for command
```

