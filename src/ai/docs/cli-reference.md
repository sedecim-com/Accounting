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
                                        (deprecated: use `mnemosine entity
                                        list`)
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
  entity|entidad                        Select and inspect the legal entity
                                        commands operate on
  payment|pago                          Vendor payments: record cash that
                                        already left the bank and settle the
                                        bill it pays
  receipt|cobro                         Customer collections: record cash
                                        received and recognize the IVA it was
                                        holding
  account|cuenta                        Chart of accounts: inspect, create and
                                        retire accounts
  entry|poliza                          Journal entries: draft, inspect,
                                        validate, post, reverse and void
  period|periodo                        Fiscal periods: what exists, what state
                                        it is in, and opening a future one
  year|ejercicio                        Fiscal years: the calendar an entity
                                        keeps its books in
  vendor|proveedor                      Vendor master: who we owe money to, on
                                        what terms, under which tax id
  bill|factura-proveedor                Vendor bills: capture, code, inspect and
                                        approve what we owe
  customer|cliente                      Customers: the AR master file, with the
                                        balance each one owes
  invoice|factura                       Customer invoices: draft, inspect, issue
                                        to the ledger and void (never stamped
                                        here)
  report|reporte                        Financial statements, trial balance,
                                        general ledger and ageing
  usage|uso [options]                   Token usage and estimated cost from the
                                        local ledger (no API calls)
  status|estado [options]               Health snapshot: config, live provider
                                        probes, database and RLS (redacted,
                                        shareable)
  jobs|tareas                           Persisted scheduled agent tasks (all
                                        output is reviewable drafts, never
                                        direct writes)
  skills|habilidades                    Firm skills: list, review staged
                                        changes, view content
  webhooks|ganchos                      Inbound webhook tokens: dedicated
                                        credentials that wake a restricted
                                        reader agent
  init|configurar [options]             Guided setup: infrastructure, entity,
                                        users, AI provider, and your books
  close|cierre [options]                Month-end close: checks what is missing
                                        and closes the period
  help [command]                        display help for command
```

## `mnemosine entities` (alias: entidades)

```
Usage: mnemosine entities|entidades [options]

Lists the active legal entities (deprecated: use `mnemosine entity list`)

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
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
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
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
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
  -y, --yes                 skip the confirmation prompt
  --idempotency-key <key>   client dedupe key; defaults to a hash of the payload
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
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
  --live                   perform the real external effect (default is the
                           sandbox endpoint)
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
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
  --live                   perform the real external effect (default is the
                           sandbox endpoint)
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
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
  --reason <text>          justification recorded in the audit trail (required)
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
  --reason <text>          justification recorded in the audit trail (required)
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
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command
```

## `mnemosine entity` (alias: entidad)

```
Usage: mnemosine entity|entidad [options] [command]

Select and inspect the legal entity commands operate on

Options:
  -h, --help                             display help for command

Commands:
  list|listar [options]                  List the active legal entities
  show|ver [options] [idOrName]          Show one entity — with no argument, the one commands would use, and why
  use|usar [options] <idOrName>          Pin the entity that later commands operate on
  create|crear [options] <name>          Create a legal entity with its chart of accounts, roles and payroll mapping
  archive|archivar [options] <idOrName>  Archive an entity (never deletes: its ledger has to survive)
  unset|limpiar                          Clear the pinned entity; commands go back to requiring --entity
  help [command]                         display help for command
```

### `mnemosine entity list` (alias: listar)

```
Usage: mnemosine entity list|listar [options]

List the active legal entities

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -h, --help                               display help for command
```

### `mnemosine entity show` (alias: ver)

```
Usage: mnemosine entity show|ver [options] [idOrName]

Show one entity — with no argument, the one commands would use, and why

Arguments:
  idOrName                                 entity to describe; omit for the active one

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -h, --help                               display help for command
```

### `mnemosine entity use` (alias: usar)

```
Usage: mnemosine entity use|usar [options] <idOrName>

Pin the entity that later commands operate on

Arguments:
  idOrName                 entity id, tax id, or a fragment of the name

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  -h, --help               display help for command
```

### `mnemosine entity create` (alias: crear)

```
Usage: mnemosine entity create|crear [options] <name>

Create a legal entity with its chart of accounts, roles and payroll mapping

Arguments:
  name                     legal name of the company

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --tax-id <id>            RFC (Mexico) or EIN (USA)
  --country <code>         MX or USA (default: "MX")
  --currency <code>        functional currency (defaults to the country's)
  --chart <strategy>       auto | siempre | nunca — whether to seed the base
                           chart (default: "auto")
  --json                   JSON output
  -h, --help               display help for command
```

### `mnemosine entity archive` (alias: archivar)

```
Usage: mnemosine entity archive|archivar [options] <idOrName>

Archive an entity (never deletes: its ledger has to survive)

Arguments:
  idOrName                 entity to archive

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command
```

### `mnemosine entity unset` (alias: limpiar)

```
Usage: mnemosine entity unset|limpiar [options]

Clear the pinned entity; commands go back to requiring --entity

Options:
  -h, --help  display help for command
```

## `mnemosine payment` (alias: pago)

```
Usage: mnemosine payment|pago [options] [command]

Vendor payments: record cash that already left the bank and settle the bill it
pays

Options:
  -h, --help                     display help for command

Commands:
  create|crear [options] <bill>  Record a payment made against a bill and
                                 recognize the IVA it was holding
  help [command]                 display help for command
```

### `mnemosine payment create` (alias: crear)

```
Usage: mnemosine payment create|crear [options] <bill>

Record a payment made against a bill and recognize the IVA it was holding

Arguments:
  bill                     bill number, vendor invoice number or id

Options:
  --amount <amount>        amount, in the document currency
  --date <date>            value date (YYYY-MM-DD); defaults to today
  --method <method>        cash, check, ach, wire, spei, credit_card or other
                           (default: "spei")
  --bank <account>         bank account id; without it the entity's `banco` role
                           is used
  --json                   JSON output
  --discount <amount>      early-payment discount taken
  --memo <text>            note stored with the payment
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
  -h, --help               display help for command
```

## `mnemosine receipt` (alias: cobro)

```
Usage: mnemosine receipt|cobro [options] [command]

Customer collections: record cash received and recognize the IVA it was holding

Options:
  -h, --help                            display help for command

Commands:
  record|registrar [options] <invoice>  Record cash received against an invoice
                                        and recognize the IVA it was holding
  help [command]                        display help for command
```

### `mnemosine receipt record` (alias: registrar)

```
Usage: mnemosine receipt record|registrar [options] <invoice>

Record cash received against an invoice and recognize the IVA it was holding

Arguments:
  invoice                  invoice number or id

Options:
  --amount <amount>        amount, in the document currency
  --date <date>            value date (YYYY-MM-DD); defaults to today
  --method <method>        cash, check, ach, wire, spei, credit_card or other
                           (default: "spei")
  --bank <account>         bank account id; without it the entity's `banco` role
                           is used
  --json                   JSON output
  --reference <text>       bank reference or transfer number
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
  -h, --help               display help for command
```

## `mnemosine account` (alias: cuenta)

```
Usage: mnemosine account|cuenta [options] [command]

Chart of accounts: inspect, create and retire accounts

Options:
  -h, --help                              display help for command

Commands:
  list|listar [options] [search]          List accounts, filtered by type, state, parent or free text
  show|ver [options] <code>               Show one account with its parent, flags and lifetime activity
  create|crear [options] <code> <name>    Create an account
  edit|editar [options] <code>            Change an account name, description, subtype or statement caption
  deactivate|desactivar [options] <code>  Retire an account (never deletes it; postings keep their history)
  restore|restaurar [options] <code>      Put a retired account back in service
  help [command]                          display help for command
```

### `mnemosine account list` (alias: listar)

```
Usage: mnemosine account list|listar [options] [search]

List accounts, filtered by type, state, parent or free text

Arguments:
  search                                   match against code or name

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --type <type>                            account type: asset, liability, equity, revenue, expense, contra_asset, contra_liability, contra_equity
  --parent <code>                          only children of this account code
  --inactive                               show inactive accounts instead of active ones
  -h, --help                               display help for command
```

### `mnemosine account show` (alias: ver)

```
Usage: mnemosine account show|ver [options] <code>

Show one account with its parent, flags and lifetime activity

Arguments:
  code                                     account code or id

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --no-balance                             skip the lifetime activity lookup
  -h, --help                               display help for command
```

### `mnemosine account create` (alias: crear)

```
Usage: mnemosine account create|crear [options] <code> <name>

Create an account

Arguments:
  code                     account code, unique within the entity
  name                     account name

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --type <type>            account type: asset, liability, equity, revenue,
                           expense, contra_asset, contra_liability,
                           contra_equity
  --normal-balance <side>  debit or credit (defaults from the type)
  --parent <code>          parent account code
  --currency <code>        restrict the account to one currency (3 letters)
  --subtype <name>         account subtype
  --fs-category <name>     financial-statement caption
  --description <text>     description
  --header                 a grouping node: it accepts no manual entries
  --json                   JSON output
  -h, --help               display help for command
```

### `mnemosine account edit` (alias: editar)

```
Usage: mnemosine account edit|editar [options] <code>

Change an account name, description, subtype or statement caption

Arguments:
  code                     account code or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --name <text>            new name
  --description <text>     new description
  --subtype <name>         new subtype
  --fs-category <name>     new financial-statement caption
  -h, --help               display help for command
```

### `mnemosine account deactivate` (alias: desactivar)

```
Usage: mnemosine account deactivate|desactivar [options] <code>

Retire an account (never deletes it; postings keep their history)

Arguments:
  code                     account code or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --force                  override a blocking validation (closed period, lock
                           date, duplicate); requires --reason
  --reason <text>          justification, required with --force
  -h, --help               display help for command
```

### `mnemosine account restore` (alias: restaurar)

```
Usage: mnemosine account restore|restaurar [options] <code>

Put a retired account back in service

Arguments:
  code                     account code or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  -h, --help               display help for command
```

## `mnemosine entry` (alias: poliza, asiento)

```
Usage: mnemosine entry|poliza [options] [command]

Journal entries: draft, inspect, validate, post, reverse and void

Options:
  -h, --help                            display help for command

Commands:
  list|listar [options] [search]        Search journal entries by text, account,
                                        date, amount, state, type or source
  show|ver [options] <number>           Show one entry with its lines, totals,
                                        period and linked reversal
  create|crear [options]                Create a journal entry — ALWAYS a draft;
                                        posting is a separate human step
  check|verificar [options]             Run the seven NIF validation rules over
                                        an entry or a document; writes nothing
  post|contabilizar [options] <number>  Post ONE entry to the ledger: validates
                                        the seven rules, then moves balances
  reverse|reversar [options] <number>   Create the linked posted mirror of an
                                        entry (NIF B-1: correct by reversal)
  void|anular [options] <number>        Annul an entry: a draft is marked void,
                                        a posted one gets its linked mirror
  help [command]                        display help for command
```

### `mnemosine entry list` (alias: listar)

```
Usage: mnemosine entry list|listar [options] [search]

Search journal entries by text, account, date, amount, state, type or source

Arguments:
  search                                   text to match in the description or reference

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --period <expr>                          period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06
  --since <date>                           inclusive lower bound (YYYY-MM-DD)
  --until <date>                           inclusive upper bound (YYYY-MM-DD)
  --as-of <date>                           valuation/balance date (YYYY-MM-DD)
  --date-basis <document|posting|value>    which date the filters apply to (default: "posting")
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --type <type...>                         entry type (repeatable)
  --source <name>                          origin subledger: invoice, bill, payroll, manual…
  --account <code>                         only entries with a line on this account
  --min-amount <amount>                    minimum total debits
  --max-amount <amount>                    maximum total debits
  -h, --help                               display help for command
```

### `mnemosine entry show` (alias: ver)

```
Usage: mnemosine entry show|ver [options] <number>

Show one entry with its lines, totals, period and linked reversal

Arguments:
  number                                   entry number (JE-2026-00042) or id

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --no-lines                               header only, without the lines
  -h, --help                               display help for command
```

### `mnemosine entry create` (alias: crear)

```
Usage: mnemosine entry create|crear [options]

Create a journal entry — ALWAYS a draft; posting is a separate human step

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --line <spec...>         a line as
                           <account>:<debit|credit>:<amount>[:description];
                           repeat for each line
  --file <path>            JSON document with date, type, description and lines
  --date <date>            entry date (YYYY-MM-DD); defaults to today
  --type <type>            entry type: standard, adjusting, correction (default:
                           standard)
  --description <text>     what the entry records
  --reference <text>       external reference (document, folio, memo)
  --dry-run                validate and show the entry that would be drafted;
                           write nothing
  --json                   JSON output
  -h, --help               display help for command
```

### `mnemosine entry check` (alias: verificar)

```
Usage: mnemosine entry check|verificar [options]

Run the seven NIF validation rules over an entry or a document; writes nothing

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --strict                                 treat warnings as blocking (exit 4)
  --entry <number>                         an existing entry, by number or id
  --file <path>                            a JSON entry document that does not exist yet
  -h, --help                               display help for command
```

### `mnemosine entry post` (alias: contabilizar)

```
Usage: mnemosine entry post|contabilizar [options] <number>

Post ONE entry to the ledger: validates the seven rules, then moves balances

Arguments:
  number                   entry number or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
  -h, --help               display help for command
```

### `mnemosine entry reverse` (alias: reversar)

```
Usage: mnemosine entry reverse|reversar [options] <number>

Create the linked posted mirror of an entry (NIF B-1: correct by reversal)

Arguments:
  number                   the POSTED entry to reverse

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --date <date>            date of the mirror entry (YYYY-MM-DD); defaults to
                           today
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command
```

### `mnemosine entry void` (alias: anular)

```
Usage: mnemosine entry void|anular [options] <number>

Annul an entry: a draft is marked void, a posted one gets its linked mirror

Arguments:
  number                   entry number or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command
```

## `mnemosine period` (alias: periodo)

```
Usage: mnemosine period|periodo [options] [command]

Fiscal periods: what exists, what state it is in, and opening a future one

Options:
  -h, --help                   display help for command

Commands:
  list|listar [options]        List every period with its state, dates and
                               overdue mark
  show|ver [options] <name>    Show a period: state, who closed it, the
                               checklist it closed with, its entries
  open|abrir [options] <name>  Open a future period so work can be captured in
                               it
  help [command]               display help for command
```

### `mnemosine period list` (alias: listar)

```
Usage: mnemosine period list|listar [options]

List every period with its state, dates and overdue mark

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --year <year>                            only periods of this fiscal year
  -h, --help                               display help for command
```

### `mnemosine period show` (alias: ver)

```
Usage: mnemosine period show|ver [options] <name>

Show a period: state, who closed it, the checklist it closed with, its entries

Arguments:
  name                                     period name, YYYY-MM, or id

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -h, --help                               display help for command
```

### `mnemosine period open` (alias: abrir)

```
Usage: mnemosine period open|abrir [options] <name>

Open a future period so work can be captured in it

Arguments:
  name                     period name, YYYY-MM, or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --reason <text>          why it is being opened; recorded in the audit trail
  --dry-run                show the transition without performing it
  -h, --help               display help for command
```

## `mnemosine year` (alias: ejercicio)

```
Usage: mnemosine year|ejercicio [options] [command]

Fiscal years: the calendar an entity keeps its books in

Options:
  -h, --help                     display help for command

Commands:
  list|listar [options]          List the fiscal years of the entity with their
                                 state and close progress
  show|ver [options] <year>      Show a fiscal year with each of its periods and
                                 their states
  create|crear [options] <year>  Create a fiscal year and its twelve monthly
                                 periods
  help [command]                 display help for command
```

### `mnemosine year list` (alias: listar)

```
Usage: mnemosine year list|listar [options]

List the fiscal years of the entity with their state and close progress

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -h, --help                               display help for command
```

### `mnemosine year show` (alias: ver)

```
Usage: mnemosine year show|ver [options] <year>

Show a fiscal year with each of its periods and their states

Arguments:
  year                                     four-digit year, e.g. 2026

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -h, --help                               display help for command
```

### `mnemosine year create` (alias: crear)

```
Usage: mnemosine year create|crear [options] <year>

Create a fiscal year and its twelve monthly periods

Arguments:
  year                     four-digit year, e.g. 2027

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --dry-run                show the calendar that would be created; write
                           nothing
  --json                   JSON output
  -h, --help               display help for command
```

## `mnemosine vendor` (alias: proveedor)

```
Usage: mnemosine vendor|proveedor [options] [command]

Vendor master: who we owe money to, on what terms, under which tax id

Options:
  -h, --help                      display help for command

Commands:
  list|listar [options] [search]  List vendors, filtered by state, 1099 flag or
                                  a missing tax id
  show|ver [options] <vendor>     Show one vendor: identity, terms, currency and
                                  flags
  create|crear [options] <name>   Register a vendor with its tax id, terms,
                                  currency and default expense account
  edit|editar [options] <vendor>  Change the non-banking, non-fiscal details of
                                  a vendor, leaving an audit row
  terms|terminos                  Payment terms
  help [command]                  display help for command
```

### `mnemosine vendor list` (alias: listar)

```
Usage: mnemosine vendor list|listar [options] [search]

List vendors, filtered by state, 1099 flag or a missing tax id

Arguments:
  search                                   match against company name or vendor number

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --inactive                               show archived vendors instead of active ones
  --1099                                   only vendors flagged for a US information return
  --no-tax-id                              only vendors with no tax id on file (the DIOT/1099 blockers)
  -h, --help                               display help for command
```

### `mnemosine vendor show` (alias: ver)

```
Usage: mnemosine vendor show|ver [options] <vendor>

Show one vendor: identity, terms, currency and flags

Arguments:
  vendor                                   vendor number, name or id

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --include <parts>                        extra sections, comma-separated: activity
  -h, --help                               display help for command
```

### `mnemosine vendor create` (alias: crear)

```
Usage: mnemosine vendor create|crear [options] <name>

Register a vendor with its tax id, terms, currency and default expense account

Arguments:
  name                      company name

Options:
  -e, --entity <idOrName>   legal entity to operate on (defaults to the active
                            one)
  -t, --tenant <id>         tenant (firm) whose data to scope to
  -u, --user <email>        acting user, for attribution and permissions
  --tax-id <id>             RFC (Mexico), EIN (USA) or VAT number
  --tax-id-type <type>      rfc | ein | vat (defaults from the entity's country)
  --contact <name>          contact person
  --email <address>         contact email
  --phone <number>          contact phone
  --terms <text>            payment terms: "Net 30", "2/10 Net 30", "Due on
                            receipt" (default: "Net 30")
  --currency <code>         3-letter ISO code (defaults to the entity's
                            functional currency)
  --default-account <code>  default expense account, by code
  --1099                    flag the vendor for a US information return
  --json                    JSON output
  -h, --help                display help for command
```

### `mnemosine vendor edit` (alias: editar)

```
Usage: mnemosine vendor edit|editar [options] <vendor>

Change the non-banking, non-fiscal details of a vendor, leaving an audit row

Arguments:
  vendor                   vendor number, name or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --name <text>            new company name
  --contact <name>         new contact person
  --email <address>        new email
  --phone <number>         new phone
  --notes <text>           replace the notes
  --reason <text>          why the change was made; recorded in the audit trail
  -h, --help               display help for command
```

### `mnemosine vendor terms` (alias: terminos)

```
Usage: mnemosine vendor terms|terminos [options] [command]

Payment terms

Options:
  -h, --help                    display help for command

Commands:
  set|fijar [options] <vendor>  Set payment terms and settlement currency,
                                validated so a due date can be computed
  help [command]                display help for command
```

#### `mnemosine vendor terms set` (alias: fijar)

```
Usage: mnemosine vendor terms set|fijar [options] <vendor>

Set payment terms and settlement currency, validated so a due date can be
computed

Arguments:
  vendor                   vendor number, name or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --terms <text>           "Net 30", "2/10 Net 30", "Due on receipt"
  --currency <code>        3-letter ISO code
  --reason <text>          why the change was made; recorded in the audit trail
  -h, --help               display help for command
```

## `mnemosine bill` (alias: factura-proveedor)

```
Usage: mnemosine bill|factura-proveedor [options] [command]

Vendor bills: capture, code, inspect and approve what we owe

Options:
  -h, --help                        display help for command

Commands:
  list|listar [options] [search]    List vendor bills by vendor, state, document
                                    date, posting date or due date
  show|ver [options] <bill>         Show one bill with its lines, its journal
                                    entry and its source CFDI
  create|crear [options] [vendor]   Capture a vendor bill with its lines and
                                    their account coding
  line|linea                        Line coding
  approve|aprobar [options] <bill>  Approve a bill and recognize the liability
                                    in the ledger (DR expense + IVA / CR
                                    payables)
  help [command]                    display help for command
```

### `mnemosine bill list` (alias: listar)

```
Usage: mnemosine bill list|listar [options] [search]

List vendor bills by vendor, state, document date, posting date or due date

Arguments:
  search                                   match against bill number, the vendor invoice number or the vendor name

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --period <expr>                          period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06
  --since <date>                           inclusive lower bound (YYYY-MM-DD)
  --until <date>                           inclusive upper bound (YYYY-MM-DD)
  --as-of <date>                           valuation/balance date (YYYY-MM-DD)
  --date-basis <document|posting|value>    which date the filters apply to (default: "document")
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --vendor <ref>                           only this vendor (number, name or id)
  --due-before <date>                      only bills falling due on or before this date (YYYY-MM-DD)
  --open                                   only bills that still owe money (excludes paid, void and cancelled)
  -h, --help                               display help for command
```

### `mnemosine bill show` (alias: ver)

```
Usage: mnemosine bill show|ver [options] <bill>

Show one bill with its lines, its journal entry and its source CFDI

Arguments:
  bill                                     bill number, vendor invoice number or id

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --no-lines                               header only
  --journal                                include the journal entry approval produced
  --cfdi                                   include the CFDI this bill came from, when it came from one
  -h, --help                               display help for command
```

### `mnemosine bill create` (alias: crear)

```
Usage: mnemosine bill create|crear [options] [vendor]

Capture a vendor bill with its lines and their account coding

Arguments:
  vendor                          vendor number, name or id

Options:
  -e, --entity <idOrName>         legal entity to operate on (defaults to the
                                  active one)
  -t, --tenant <id>               tenant (firm) whose data to scope to
  -u, --user <email>              acting user, for attribution and permissions
  --vendor <ref>                  vendor number, name or id (same as the
                                  positional argument)
  --vendor-invoice-number <text>  the vendor's own invoice number or folio
  --bill-date <date>              document date (YYYY-MM-DD); defaults to today
  --due-date <date>               due date (YYYY-MM-DD); defaults to the
                                  vendor's terms
  --line <spec...>                one line, repeatable:
                                  "account=…,qty=…,quantity=…,price=…,unit-price=…".
                                  Account is a code from the chart
  --currency <code>               3-letter ISO code; defaults to the vendor's
                                  currency
  --terms <text>                  payment terms recorded on the bill; defaults
                                  to the vendor terms
  --description <text>            what this bill is for
  --from-file <path>              read the bill as JSON instead: { lines: [...],
                                  ... }
  --json                          JSON output
  -h, --help                      display help for command
```

### `mnemosine bill line` (alias: linea)

```
Usage: mnemosine bill line|linea [options] [command]

Line coding

Options:
  -h, --help                  display help for command

Commands:
  set|fijar [options] <bill>  Re-code one line of a bill that has not been
                              approved yet
  help [command]              display help for command
```

#### `mnemosine bill line set` (alias: fijar)

```
Usage: mnemosine bill line set|fijar [options] <bill>

Re-code one line of a bill that has not been approved yet

Arguments:
  bill                     bill number, vendor invoice number or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --line <n>               line number to change
  --account <code>         expense account, by code
  --cost-center <id>       cost center id
  --project <id>           project id
  --description <text>     line description
  -h, --help               display help for command
```

### `mnemosine bill approve` (alias: aprobar)

```
Usage: mnemosine bill approve|aprobar [options] <bill>

Approve a bill and recognize the liability in the ledger (DR expense + IVA / CR
payables)

Arguments:
  bill                     bill number, vendor invoice number or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
  -h, --help               display help for command
```

## `mnemosine customer` (alias: cliente)

```
Usage: mnemosine customer|cliente [options] [command]

Customers: the AR master file, with the balance each one owes

Options:
  -h, --help                         display help for command

Commands:
  list|listar [options] [query]      List customers with terms, credit state and
                                     the balance they owe
  show|ver [options] <ref>           Show one customer: profile, tax id, credit,
                                     balance and open documents
  create|crear [options]             Register a customer with its tax id,
                                     payment terms and currency
  edit|editar [options] <ref>        Change commercial and contact data; never
                                     the tax profile or credit
  archive|archivar [options] <ref>   Deactivate a customer; refused while they
                                     still owe something
  restore|restaurar [options] <ref>  Put an archived customer back in service
  help [command]                     display help for command
```

### `mnemosine customer list` (alias: listar)

```
Usage: mnemosine customer list|listar [options] [query]

List customers with terms, credit state and the balance they owe

Arguments:
  query                                    text to match in the customer name or number

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --overdue                                only customers with something past due
  --balance-gt <amount>                    only customers owing more than this
  --inactive                               show archived customers instead of active ones
  -h, --help                               display help for command
```

### `mnemosine customer show` (alias: ver)

```
Usage: mnemosine customer show|ver [options] <ref>

Show one customer: profile, tax id, credit, balance and open documents

Arguments:
  ref                                      customer number, name or id

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --period <expr>                          period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06
  --since <date>                           inclusive lower bound (YYYY-MM-DD)
  --until <date>                           inclusive upper bound (YYYY-MM-DD)
  --as-of <date>                           valuation/balance date (YYYY-MM-DD)
  --date-basis <document|posting|value>    which date the filters apply to (default: "posting")
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -h, --help                               display help for command
```

### `mnemosine customer create` (alias: crear)

```
Usage: mnemosine customer create|crear [options]

Register a customer with its tax id, payment terms and currency

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --name <text>            company name
  --first-name <text>      given name, for an individual
  --last-name <text>       family name, for an individual
  --tax-id <id>            RFC (MX), EIN (US) or VAT number
  --tax-id-type <type>     one of: rfc, ein, vat; inferred from the entity's
                           country
  --email <address>        billing contact email
  --phone <number>         contact phone
  --terms <text>           payment terms, e.g. "Net 30"
  --currency <code>        billing currency (3 letters)
  --json                   JSON output
  -h, --help               display help for command
```

### `mnemosine customer edit` (alias: editar)

```
Usage: mnemosine customer edit|editar [options] <ref>

Change commercial and contact data; never the tax profile or credit

Arguments:
  ref                      customer number, name or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --name <text>            new company name
  --first-name <text>      new given name
  --last-name <text>       new family name
  --email <address>        new billing email
  --phone <number>         new phone
  --terms <text>           new payment terms
  --notes <text>           free notes stored on the customer
  --reason <text>          justification recorded in the audit trail
  -h, --help               display help for command
```

### `mnemosine customer archive` (alias: archivar)

```
Usage: mnemosine customer archive|archivar [options] <ref>

Deactivate a customer; refused while they still owe something

Arguments:
  ref                      customer number, name or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --force                  override a blocking validation (closed period, lock
                           date, duplicate); requires --reason
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command
```

### `mnemosine customer restore` (alias: restaurar)

```
Usage: mnemosine customer restore|restaurar [options] <ref>

Put an archived customer back in service

Arguments:
  ref                      customer number, name or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --reason <text>          justification recorded in the audit trail
  -h, --help               display help for command
```

## `mnemosine invoice` (alias: factura)

```
Usage: mnemosine invoice|factura [options] [command]

Customer invoices: draft, inspect, issue to the ledger and void (never stamped
here)

Options:
  -h, --help                      display help for command

Commands:
  list|listar [options] [search]  List invoices by customer, state, period or
                                  days past due
  show|ver [options] <ref>        Show one invoice with its lines, the cash
                                  applied and its ledger entry
  create|crear [options]          Create a DRAFT invoice from scratch: a local
                                  document, neither posted nor stamped
  issue|emitir [options] <ref>    Issue an invoice: post DR receivable / CR
                                  revenue / CR VAT. Does not stamp or send
  void|anular [options] <ref>     Void a local invoice and reverse its ledger
                                  entry; refuses a stamped or paid one
  series|serie                    Folio series: the counters this entity draws
                                  document numbers from
  help [command]                  display help for command
```

### `mnemosine invoice list` (alias: listar)

```
Usage: mnemosine invoice list|listar [options] [search]

List invoices by customer, state, period or days past due

Arguments:
  search                                   text to match in the invoice number or the customer name

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --period <expr>                          period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06
  --since <date>                           inclusive lower bound (YYYY-MM-DD)
  --until <date>                           inclusive upper bound (YYYY-MM-DD)
  --as-of <date>                           valuation/balance date (YYYY-MM-DD)
  --date-basis <document|posting|value>    which date the filters apply to (default: "posting")
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --customer <ref>                         only this customer (number, name or id)
  --overdue-days <n>                       only open invoices at least this many days past due
  -h, --help                               display help for command
```

### `mnemosine invoice show` (alias: ver)

```
Usage: mnemosine invoice show|ver [options] <ref>

Show one invoice with its lines, the cash applied and its ledger entry

Arguments:
  ref                                      invoice number (INV-2026-00042) or id

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -h, --help                               display help for command
```

### `mnemosine invoice create` (alias: crear)

```
Usage: mnemosine invoice create|crear [options]

Create a DRAFT invoice from scratch: a local document, neither posted nor
stamped

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --customer <ref>         customer number, name or id
  --line <spec...>         a line:
                           "account=4100;qty=2;price=1500;tax=16;description=…"
  --from-file <path>       JSON array of lines instead of repeated --line
  --date <date>            invoice date (YYYY-MM-DD); defaults to today
  --due-date <date>        due date; defaults to the customer's payment terms
  --currency <code>        billing currency; defaults to the customer's
  --terms <text>           payment terms printed on the document
  --memo <text>            memo
  --po-number <text>       the customer purchase order this bills against
  --json                   JSON output
  -h, --help               display help for command
```

### `mnemosine invoice issue` (alias: emitir)

```
Usage: mnemosine invoice issue|emitir [options] <ref>

Issue an invoice: post DR receivable / CR revenue / CR VAT. Does not stamp or
send

Arguments:
  ref                      invoice number or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
  -h, --help               display help for command
```

### `mnemosine invoice void` (alias: anular)

```
Usage: mnemosine invoice void|anular [options] <ref>

Void a local invoice and reverse its ledger entry; refuses a stamped or paid one

Arguments:
  ref                      invoice number or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command
```

### `mnemosine invoice series` (alias: serie)

```
Usage: mnemosine invoice series|serie [options] [command]

Folio series: the counters this entity draws document numbers from

Options:
  -h, --help             display help for command

Commands:
  list|listar [options]  List the folio counters, the last number issued and the
                         next one
  help [command]         display help for command
```

#### `mnemosine invoice series list` (alias: listar)

```
Usage: mnemosine invoice series list|listar [options]

List the folio counters, the last number issued and the next one

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -h, --help                               display help for command
```

## `mnemosine report` (alias: reporte)

```
Usage: mnemosine report|reporte [options] [command]

Financial statements, trial balance, general ledger and ageing

Options:
  -h, --help                         display help for command

Commands:
  trial-balance|balanza              Trial balance
  balance-sheet|balance              Balance sheet
  income-statement|resultados        Income statement
  general-ledger|mayor               General ledger detail
  aged-receivable|antiguedad-cobrar  Aged receivables
  aged-payable|antiguedad-pagar      Aged payables
  view|vista                         The reporting materialized views
                                     (mv_trial_balance,
                                     mv_account_balance_summary)
  help [command]                     display help for command
```

### `mnemosine report trial-balance` (alias: balanza)

```
Usage: mnemosine report trial-balance|balanza [options] [command]

Trial balance

Options:
  -h, --help          display help for command

Commands:
  show|ver [options]  Debits, credits and ending balance by account, with the
                      footing
  help [command]      display help for command
```

#### `mnemosine report trial-balance show` (alias: ver)

```
Usage: mnemosine report trial-balance show|ver [options]

Debits, credits and ending balance by account, with the footing

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --period <expr>                          period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06
  --since <date>                           inclusive lower bound (YYYY-MM-DD)
  --until <date>                           inclusive upper bound (YYYY-MM-DD)
  --as-of <date>                           valuation/balance date (YYYY-MM-DD)
  --date-basis <document|posting|value>    which date the filters apply to (default: "posting")
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --level <n>                              roll up to at most this account level (default: every level)
  --exclude-zero                           omit accounts whose ending balance is exactly zero
  -h, --help                               display help for command
```

### `mnemosine report balance-sheet` (alias: balance)

```
Usage: mnemosine report balance-sheet|balance [options] [command]

Balance sheet

Options:
  -h, --help          display help for command

Commands:
  show|ver [options]  Assets, liabilities and equity at a cutoff date, in
                      natural sign
  help [command]      display help for command
```

#### `mnemosine report balance-sheet show` (alias: ver)

```
Usage: mnemosine report balance-sheet show|ver [options]

Assets, liabilities and equity at a cutoff date, in natural sign

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --period <expr>                          period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06
  --since <date>                           inclusive lower bound (YYYY-MM-DD)
  --until <date>                           inclusive upper bound (YYYY-MM-DD)
  --as-of <date>                           valuation/balance date (YYYY-MM-DD)
  --date-basis <document|posting|value>    which date the filters apply to (default: "posting")
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -h, --help                               display help for command
```

### `mnemosine report income-statement` (alias: resultados)

```
Usage: mnemosine report income-statement|resultados [options] [command]

Income statement

Options:
  -h, --help          display help for command

Commands:
  show|ver [options]  Revenue, expenses and net income for a period
  help [command]      display help for command
```

#### `mnemosine report income-statement show` (alias: ver)

```
Usage: mnemosine report income-statement show|ver [options]

Revenue, expenses and net income for a period

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --period <expr>                          period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06
  --since <date>                           inclusive lower bound (YYYY-MM-DD)
  --until <date>                           inclusive upper bound (YYYY-MM-DD)
  --as-of <date>                           valuation/balance date (YYYY-MM-DD)
  --date-basis <document|posting|value>    which date the filters apply to (default: "posting")
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -h, --help                               display help for command
```

### `mnemosine report general-ledger` (alias: mayor)

```
Usage: mnemosine report general-ledger|mayor [options] [command]

General ledger detail

Options:
  -h, --help          display help for command

Commands:
  show|ver [options]  Posted movements line by line, filterable by account and
                      date
  help [command]      display help for command
```

#### `mnemosine report general-ledger show` (alias: ver)

```
Usage: mnemosine report general-ledger show|ver [options]

Posted movements line by line, filterable by account and date

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --period <expr>                          period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06
  --since <date>                           inclusive lower bound (YYYY-MM-DD)
  --until <date>                           inclusive upper bound (YYYY-MM-DD)
  --as-of <date>                           valuation/balance date (YYYY-MM-DD)
  --date-basis <document|posting|value>    which date the filters apply to (default: "posting")
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --account <code>                         restrict to one account (code or id)
  -h, --help                               display help for command
```

### `mnemosine report aged-receivable` (alias: antiguedad-cobrar)

```
Usage: mnemosine report aged-receivable|antiguedad-cobrar [options] [command]

Aged receivables

Options:
  -h, --help          display help for command

Commands:
  show|ver [options]  Open customer invoices by age bucket, with the amount
                      still due
  help [command]      display help for command
```

#### `mnemosine report aged-receivable show` (alias: ver)

```
Usage: mnemosine report aged-receivable show|ver [options]

Open customer invoices by age bucket, with the amount still due

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --period <expr>                          period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06
  --since <date>                           inclusive lower bound (YYYY-MM-DD)
  --until <date>                           inclusive upper bound (YYYY-MM-DD)
  --as-of <date>                           valuation/balance date (YYYY-MM-DD)
  --date-basis <document|posting|value>    which date the filters apply to (default: "posting")
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -h, --help                               display help for command
```

### `mnemosine report aged-payable` (alias: antiguedad-pagar)

```
Usage: mnemosine report aged-payable|antiguedad-pagar [options] [command]

Aged payables

Options:
  -h, --help          display help for command

Commands:
  show|ver [options]  Open vendor bills by age bucket, with the amount still due
  help [command]      display help for command
```

#### `mnemosine report aged-payable show` (alias: ver)

```
Usage: mnemosine report aged-payable show|ver [options]

Open vendor bills by age bucket, with the amount still due

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --period <expr>                          period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06
  --since <date>                           inclusive lower bound (YYYY-MM-DD)
  --until <date>                           inclusive upper bound (YYYY-MM-DD)
  --as-of <date>                           valuation/balance date (YYYY-MM-DD)
  --date-basis <document|posting|value>    which date the filters apply to (default: "posting")
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -h, --help                               display help for command
```

### `mnemosine report view` (alias: vista)

```
Usage: mnemosine report view|vista [options] [command]

The reporting materialized views (mv_trial_balance, mv_account_balance_summary)

Options:
  -h, --help                  display help for command

Commands:
  show|ver [options]          Whether each reporting view still agrees with the
                              ledger, and by how much
  sync|sincronizar [options]  Rebuild the reporting materialized views from the
                              ledger (firm-wide)
  help [command]              display help for command
```

#### `mnemosine report view show` (alias: ver)

```
Usage: mnemosine report view show|ver [options]

Whether each reporting view still agrees with the ledger, and by how much

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -s, --status <state...>                  filter by lifecycle state (repeatable)
  -a, --all                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -h, --help                               display help for command
```

#### `mnemosine report view sync` (alias: sincronizar)

```
Usage: mnemosine report view sync|sincronizar [options]

Rebuild the reporting materialized views from the ledger (firm-wide)

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --view <name...>                         which views to rebuild (default: all of mv_trial_balance, mv_account_balance_summary)
  --no-concurrently                        rebuild with an exclusive lock; needed only for a never-populated view
  -h, --help                               display help for command
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
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
  --live                   perform the real external effect (default is the
                           sandbox endpoint)
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

## `mnemosine skills` (alias: habilidades)

```
Usage: mnemosine skills|habilidades [options] [command]

Firm skills: list, review staged changes, view content

Options:
  -h, --help        display help for command

Commands:
  list [options]    Visible skills and how many staged changes await review
  drafts [options]  Review staged skill changes: diff + trust-scan report,
                    approve or reject
  view <name>       Print one skill's SKILL.md
  help [command]    display help for command
```

### `mnemosine skills list`

```
Usage: mnemosine skills list [options]

Visible skills and how many staged changes await review

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  --json                   JSON output
  -h, --help               display help for command
```

### `mnemosine skills drafts`

```
Usage: mnemosine skills drafts [options]

Review staged skill changes: diff + trust-scan report, approve or reject

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  -u, --user <email>       Reviewer
  --accept-risk            Allow approving drafts the trust scanner flagged
                           (recorded in the audit trail)
  --override-drift         Approve even if the skill file drifted from the draft
                           diff base (recorded in the audit trail)
  --json                   List pending drafts as JSON (no interactive review)
  -h, --help               display help for command
```

### `mnemosine skills view`

```
Usage: mnemosine skills view [options] <name>

Print one skill's SKILL.md

Arguments:
  name        Skill name

Options:
  -h, --help  display help for command
```

## `mnemosine webhooks` (alias: ganchos)

```
Usage: mnemosine webhooks|ganchos [options] [command]

Inbound webhook tokens: dedicated credentials that wake a restricted reader
agent

Options:
  -h, --help                           display help for command

Commands:
  create|crear [options] <name>        Create a webhook token (the raw token is
                                       shown ONCE and never stored)
  list|listar [options]                List webhook tokens (names and usage —
                                       never token values)
  disable|desactivar [options] <name>  Disable a webhook token (deliveries with
                                       it start failing with 401)
  deliveries|entregas [options]        Recent inbound deliveries: status, drafts
                                       created and suspicion flags
  help [command]                       display help for command
```

### `mnemosine webhooks create` (alias: crear)

```
Usage: mnemosine webhooks create|crear [options] <name>

Create a webhook token (the raw token is shown ONCE and never stored)

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  --source <kind>          Source kind: bank_notification, sat_mailbox, generic
                           (default: "generic")
  -h, --help               display help for command
```

### `mnemosine webhooks list` (alias: listar)

```
Usage: mnemosine webhooks list|listar [options]

List webhook tokens (names and usage — never token values)

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  --json                   JSON output
  -h, --help               display help for command
```

### `mnemosine webhooks disable` (alias: desactivar)

```
Usage: mnemosine webhooks disable|desactivar [options] <name>

Disable a webhook token (deliveries with it start failing with 401)

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  -h, --help               display help for command
```

### `mnemosine webhooks deliveries` (alias: entregas)

```
Usage: mnemosine webhooks deliveries|entregas [options]

Recent inbound deliveries: status, drafts created and suspicion flags

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  -n, --limit <n>          Rows to show (1-200) (default: "20")
  --json                   JSON output
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
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key; defaults to a hash of the payload
  -h, --help               display help for command
```

