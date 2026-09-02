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
  outbox|envio [options]                Operations queued for external
                                        accounting systems: list, review and
                                        execute
  question|duda [options]               The agent's pending questions: list,
                                        answer (saved as a precedent) or dismiss
  sat                                   SAT services (e.firma credentials; the
                                        CFDI bulk download is not built yet)
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
  receipt|cobro                         Customer collections: record cash, apply
                                        on-account balance, unapply, and reverse
                                        bounced checks
  credit-note|nota-credito              Credit notes: returns, discounts and
                                        corrections against the receivable
                                        (never stamped here)
  ar|cxc                                Receivables controls: reconcile the
                                        subledger against the control account,
                                        run named diagnostics
  ap|cxp                                Payables controls: reconcile the vendor
                                        subledger against the control account
  bank|banco                            Bank accounts and bank statements:
                                        master data and imported statements
  backup|respaldo                       Logical backups of the whole
                                        installation (create, list, verify by
                                        rehearsing the restore, restore) and
                                        per-tenant logical exports (export)
  report|reporte                        Financial statements, trial balance,
                                        general ledger and ageing
  ledger|mayor                          The general ledger itself: integrity
                                        checks, stale drafts, auxiliaries and
                                        balances
  cfdi                                  The CFDI mirror: list, inspect, SAT
                                        status and the classifier trail
  rep                                   Payment receipts (REP): what is missing
                                        one, and the parked ones to retry
  ai|ia                                 Métricas y calibración del agente
                                        contable
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
  completion|completado [shell]         Print a shell completion script (bash,
                                        zsh) on stdout
  help [command]                        display help for command
```

## `mnemosine entities` (alias: entidades)

```
Usage: mnemosine entities|entidades [options]

Lists the active legal entities (deprecated: use `mnemosine entity list`)

Options:
  -h, --help  display help for command

Examples:
  # The active legal entities of this tenant (`entity list` supersedes this).
  mnemosine entities
```

## `mnemosine providers` (alias: proveedores)

```
Usage: mnemosine providers|proveedores [options]

Lists the configured model providers (built-in + mnemosine.config.json)

Options:
  -h, --help  display help for command

Examples:
  # Which model providers are configured, and whether their API key is present.
  mnemosine providers
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

Examples:
  # One question, one answer, no interactive session.
  mnemosine ask "Cuanto IVA acreditable acumule en julio"
  # Ask about one client, on a named provider.
  mnemosine ask "Saldo de la cuenta 1111 al cierre de julio" --entity "Molinos del Bajio" --provider anthropic
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

Examples:
  # Open a session against the entity you last worked on.
  mnemosine chat
  # Pick up the transcript of this terminal's last session.
  mnemosine chat --continue
  # Resume one session by id (list them with `mnemosine sessions`).
  mnemosine chat --resume 6f1b0c2e-6d3a-4a8e-9a4c-2a3b4c5d6e7f
```

## `mnemosine sessions` (alias: sesiones)

```
Usage: mnemosine sessions|sesiones [options]

Lists recent chat sessions (resume one with: mnemosine chat --resume <id>)

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -n, --limit <n>          Maximum number of sessions to show (default: 20)
  -h, --help               display help for command

Examples:
  # The most recent chat sessions of the active entity.
  mnemosine sessions
  # The last five, for one client.
  mnemosine sessions --entity "Molinos del Bajio" --limit 5
```

## `mnemosine drafts` (alias: borradores)

```
Usage: mnemosine drafts|borradores [options]

Lists the journal entry drafts created by the AI

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -s, --status <status>    pending_review | approved | rejected
  -h, --help               display help for command

Examples:
  # Every draft the AI created that nobody has looked at yet.
  mnemosine drafts --status pending_review
  # The rejected ones, for a named entity.
  mnemosine drafts --status rejected --entity "Molinos del Bajio SA de CV"
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
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # Walk the pending drafts one by one; approving POSTS to the ledger.
  mnemosine review
  # See what would be posted without moving a balance.
  mnemosine review --dry-run
  # Attribute the review to a named reviewer and skip the prompt.
  mnemosine review --user contador@despacho.mx --yes
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
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # Read a month of received CFDIs; everything lands as a draft to review.
  mnemosine ingest ./cfdi/julio/*.xml
  # See what it would classify, writing nothing and posting nothing.
  mnemosine ingest ./cfdi/julio/PCE180412TF4_A4471.xml --dry-run
  # Turn auto-posting OFF for this run, even if the firm's panel allows it.
  mnemosine ingest ./cfdi/julio/*.xml --no-auto-post --user contador@despacho.mx
  # Confirm the auto-posting the panel already authorized, with your own ceiling.
  mnemosine ingest ./cfdi/julio/*.xml --auto-post --min-confidence 0.95 --max-amount 20000
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

Examples:
  # Which language the agent answers in right now.
  mnemosine lang
  # Make it answer in Spanish. The CLI interface stays English either way.
  mnemosine lang es
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
  --idempotency-key <key>   client dedupe key, stored on success: a retry with
                            the same key and payload returns the recorded result
  -h, --help                display help for command

Examples:
  # Plan the import from the client's current system, writing nothing.
  mnemosine onboard --provider contalink --cutoff 2026-06-30 --dry-run
  # Bring in the chart and the opening balances; they wait as a draft.
  mnemosine onboard --provider contalink --cutoff 2026-06-30 --entity "Molinos del Bajio"
  # Post the opening entry now, balancing the remainder to prior-year results.
  mnemosine onboard --provider contalink --cutoff 2026-06-30 --balance-account 3200 --post --yes
```

## `mnemosine outbox` (alias: envio, envios)

```
Usage: mnemosine outbox|envio [options] [command]

Operations queued for external accounting systems: list, review and execute

Options:
  -e, --entity <idOrName>         Legal entity (id, RFC or name fragment)
  -u, --user <email>              Who executes (default: sole active user of the
                                  tenant)
  -l, --list                      Only list, without executing (deprecated: use
                                  `outbox list`)
  -h, --help                      display help for command

Commands:
  list|listar [options]           List queued external operations (default:
                                  pending)
  run|ejecutar [options] [id...]  Execute queued operations against the client's
                                  external system (the real effect requires
                                  --live)
```

### `mnemosine outbox list` (alias: listar)

```
Usage: mnemosine outbox list|listar [options]

List queued external operations (default: pending)

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

Examples:
  # The operations queued for the client's external system.
  mnemosine outbox list
  # Everything that failed, as JSON to attach to a ticket.
  mnemosine outbox list --status failed --json
```

### `mnemosine outbox run` (alias: ejecutar)

```
Usage: mnemosine outbox run|ejecutar [options] [id...]

Execute queued operations against the client's external system (the real effect
requires --live)

Arguments:
  id                       operation ids to execute; omit to review the whole
                           queue interactively

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -u, --user <email>       Who executes (default: sole active user of the
                           tenant)
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  --live                   perform the real external effect (default is the
                           sandbox endpoint)
  -h, --help               display help for command

Examples:
  # Work the queue interactively; nothing reaches the client's system yet.
  mnemosine outbox run --dry-run
  # Execute two operations FOR REAL against the client's system.
  mnemosine outbox run 3f2a9c14-8b0e-4d55-9c31-77a0d2f4b8e6 8a1c5d90-2b47-4e6f-b0d3-91e2a7c4f5b6 --live --yes
```

## `mnemosine question` (alias: duda, questions, dudas)

```
Usage: mnemosine question|duda [options] [command]

The agent's pending questions: list, answer (saved as a precedent) or dismiss

Options:
  -e, --entity <idOrName>                      Legal entity (id, RFC or name fragment)
  -u, --user <email>                           Who answers (default: sole active user of the tenant)
  -l, --list                                   Only list, without answering (deprecated: use `question list`)
  -h, --help                                   display help for command

Commands:
  list|listar [options]                        List the agent's questions (default: pending)
  answer|responder [options] [id] [answer...]  Answer a question (the answer is saved as a precedent), or work the pending queue
```

### `mnemosine question list` (alias: listar)

```
Usage: mnemosine question list|listar [options]

List the agent's questions (default: pending)

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

Examples:
  # The questions the agent is waiting on.
  mnemosine question list
  # The ones already answered, as CSV for the file.
  mnemosine question list --status answered --format csv
```

### `mnemosine question answer` (alias: responder)

```
Usage: mnemosine question answer|responder [options] [id] [answer...]

Answer a question (the answer is saved as a precedent), or work the pending
queue

Arguments:
  id                       question id; omit to answer the pending queue
                           interactively
  answer                   the answer text, or the number of an option (requires
                           <id>)

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -u, --user <email>       Who answers (default: sole active user of the tenant)
  -h, --help               display help for command

Examples:
  # Work the pending queue one question at a time.
  mnemosine question answer
  # Answer one by id; the answer is stored as a precedent.
  mnemosine question answer 5d2e7a10-93cf-4b62-8a71-0c4e6f8b2d19 "Va a gastos: mantenimiento menor, no capitaliza"
  # Pick option 2 of the ones the question offers.
  mnemosine question answer 5d2e7a10-93cf-4b62-8a71-0c4e6f8b2d19 2
```

## `mnemosine sat`

```
Usage: mnemosine sat [options] [command]

SAT services (e.firma credentials; the CFDI bulk download is not built yet)

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
                             locally; storing in the vault requires --live)
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

Registers the e.firma of an entity (validates locally; storing in the vault
requires --live)

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
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
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
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command
```

## `mnemosine pending` (alias: pendientes)

```
Usage: mnemosine pending|pendientes [options] [command]

What you need to do: work to resolve and policy decisions to define

Options:
  -e, --entity <idOrName>                 Legal entity
  -v, --verbose                           Explain each decision: why I ask, what I do, what skipping costs, and what your own data says
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

Examples:
  # Sign in with a browser.
  mnemosine login
  # On a server reached over SSH, with no browser to open.
  mnemosine login --device
```

## `mnemosine logout` (alias: salir)

```
Usage: mnemosine logout|salir [options]

Deletes the stored credential

Options:
  -h, --help  display help for command

Examples:
  # Delete the credential stored on this machine.
  mnemosine logout
```

## `mnemosine whoami` (alias: quien)

```
Usage: mnemosine whoami|quien [options]

Shows the active credential and its validity

Options:
  -h, --help  display help for command

Examples:
  # Which credential is active, and how long it is good for.
  mnemosine whoami
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
  --session <id>           Session id (default: the most recent session)
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
  -h, --help                         display help for command

Commands:
  create|crear [options] <bill>      Record a payment made against a bill and
                                     recognize the IVA it was holding
  apply|aplicar [options] <payment>  Apply an existing payment to specific
                                     bills: partial, with discount, or
                                     short-paid
  help [command]                     display help for command
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
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # Record a transfer that already left the bank, against one approved bill.
  mnemosine payment create BILL-2026-00007 --amount 16820.00 --date 2026-07-31 --method spei
  # Pay early and take the discount the terms allow: 820.00 of liability that no cash extinguishes.
  mnemosine payment create BILL-2026-00007 --amount 16000.00 --discount 820.00 --memo "Pronto pago 2/10 Net 30"
  # See the effect on the bill and on the ledger, writing nothing.
  mnemosine payment create BILL-2026-00007 --amount 16820.00 --dry-run
```

### `mnemosine payment apply` (alias: aplicar)

```
Usage: mnemosine payment apply|aplicar [options] <payment>

Apply an existing payment to specific bills: partial, with discount, or
short-paid

Arguments:
  payment                    payment number or id whose on-account balance is to
                             be applied

Options:
  --bill <ref...>            bill to apply to; repeat it, paired in order with
                             --amount
  --amount <amount...>       amount applied to the bill in the same position
  --discount <amount...>     early-payment discount for the bill in the same
                             position
  --mode <mode>              partial (leave the rest open) or residual (close it
                             short) (default: "partial")
  --short-pay-reason <text>  why the unpaid balance is being written off;
                             required by --mode residual
  --json                     JSON output
  -e, --entity <idOrName>    legal entity to operate on (defaults to the active
                             one)
  -t, --tenant <id>          tenant (firm) whose data to scope to
  -u, --user <email>         acting user, for attribution and permissions
  --dry-run                  compute and show the full effect; write nothing and
                             call nothing external
  -y, --yes                  skip the confirmation prompt
  --idempotency-key <key>    client dedupe key, stored on success: a retry with
                             the same key and payload returns the recorded
                             result
  -h, --help                 display help for command

Examples:
  # Split one transfer across two open bills. --bill and --amount pair up IN ORDER.
  mnemosine payment apply VPMT-2026-00019 --bill BILL-2026-00007 --amount 12000.00 --bill BILL-2026-00011 --amount 8500.00
  # Apply less than the balance and leave the bill open for the rest.
  mnemosine payment apply VPMT-2026-00019 --bill BILL-2026-00007 --amount 9000.00 --mode partial
  # Close a bill short: what is unpaid stops being owed, so it needs a written reason.
  mnemosine payment apply VPMT-2026-00019 --bill BILL-2026-00007 --amount 15900.00 --mode residual --short-pay-reason "Nota de credito que el proveedor nunca emitio"
```

## `mnemosine account` (alias: cuenta)

```
Usage: mnemosine account|cuenta [options] [command]

Chart of accounts: inspect, create and retire accounts

Options:
  -h, --help                             display help for command

Commands:
  list|listar [options] [search]         List accounts, filtered by type, state, parent or free text
  show|ver [options] <code>              Show one account with its parent, flags and lifetime activity
  create|crear [options] <code> <name>   Create an account
  edit|editar [options] <code>           Change an account name, description, subtype or statement caption
  archive|archivar [options] <code>      Retire an account from active use (never deletes; requires zero balance unless --force)
  set|fijar [options] <code> <pairs...>  Set the governance flags of an account (who may post to it, and how)
  balance|saldo                          Balances of one account, decomposed by fiscal period
  role|rol                               Semantic account roles (cxc, banco, iva_acreditable…) that automatic posting reads
  map|mapeo                              Statutory mappings per account: SAT agrupador (Anexo 24), US tax line, IFRS
  restore|restaurar [options] <code>     Put a retired account back in service
  help [command]                         display help for command
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

Examples:
  # Every active expense account.
  mnemosine account list --type expense
  # The children of Caja y Bancos (1110), which is where bank accounts hang.
  mnemosine account list --parent 1110
  # Retired accounts only, as CSV.
  mnemosine account list --inactive --format csv
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

Examples:
  # One account with its parent, its governance flags and its lifetime activity.
  mnemosine account show 1130
  # Skip the balance lookup, which is the slow part.
  mnemosine account show 1130 --no-balance
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

Examples:
  # A new expense account hanging off Gastos de Administracion (6100).
  mnemosine account create 6150 "Mantenimiento de oficina" --type expense --parent 6100
  # A grouping node: --header means it accepts no manual entries.
  mnemosine account create 1250 "Activo Intangible" --type asset --parent 1200 --header
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

Examples:
  # Rename an account. Its code, its type and its normal balance do not change here.
  mnemosine account edit 6150 --name "Mantenimiento y conservacion"
  # Move it to another financial-statement caption.
  mnemosine account edit 6150 --fs-category operating_expenses --subtype operating_expense
```

### `mnemosine account archive` (alias: archivar, deactivate, desactivar)

```
Usage: mnemosine account archive|archivar [options] <code>

Retire an account from active use (never deletes; requires zero balance unless
--force)

Arguments:
  code                     account code or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --force                  override a blocking validation (closed period, lock
                           date, duplicate); requires --reason
  --dry-run                run the checks and report, without writing
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command

Examples:
  # Retire an account. It is an undo verb, so --reason is required and audited.
  mnemosine account archive 6150 --reason "Sustituida por 6151 en el catalogo del despacho"
  # Run the checks and report first; --dry-run needs no reason because it writes nothing.
  mnemosine account archive 6150 --dry-run
```

### `mnemosine account set` (alias: fijar)

```
Usage: mnemosine account set|fijar [options] <code> <pairs...>

Set the governance flags of an account (who may post to it, and how)

Arguments:
  code                     account code or id
  pairs                    key=value: allow-manual, header, control-account,
                           require-subsidiary, currency

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --dry-run                validate and report, without writing
  -h, --help               display help for command

Examples:
  # Make receivables a control account whose detail lives in the subledger.
  mnemosine account set 1120 control-account=true require-subsidiary=true
  # Restrict the dollar bank account to USD, validating before writing.
  mnemosine account set 1112 currency=USD --dry-run
```

### `mnemosine account balance` (alias: saldo)

```
Usage: mnemosine account balance|saldo [options] [command]

Balances of one account, decomposed by fiscal period

Options:
  -h, --help                 display help for command

Commands:
  show|ver [options] <code>  Beginning, debits, credits and ending by period,
                             with the period status
  help [command]             display help for command
```

#### `mnemosine account balance show` (alias: ver)

```
Usage: mnemosine account balance show|ver [options] <code>

Beginning, debits, credits and ending by period, with the period status

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
  --period <name>                          only the periods whose name matches
  --as-of <date>                           only the period containing this date (YYYY-MM-DD)
  -h, --help                               display help for command

Examples:
  # The bank account period by period: beginning, debits, credits, ending.
  mnemosine account balance show 1111
  # Only the period that contains a date.
  mnemosine account balance show 1111 --as-of 2026-07-31
```

### `mnemosine account role` (alias: rol)

```
Usage: mnemosine account role|rol [options] [command]

Semantic account roles (cxc, banco, iva_acreditable…) that automatic posting
reads

Options:
  -h, --help                         display help for command

Commands:
  list|listar [options]              Each role and the account it points to,
                                     default and qualified variants
  set|fijar [options] <role> <code>  Repoint a role to another account, or
                                     create a qualified variant
  seed|sembrar [options]             Create the missing base accounts and map
                                     every unmapped role (never overwrites a
                                     manual choice)
  help [command]                     display help for command
```

#### `mnemosine account role list` (alias: listar)

```
Usage: mnemosine account role list|listar [options]

Each role and the account it points to, default and qualified variants

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
  --role <name>                            only this role
  --qualifier <q>                          only this qualified variant
  -h, --help                               display help for command

Examples:
  # Every semantic role and the account automatic posting will use for it.
  mnemosine account role list
  # Just the creditable-VAT role.
  mnemosine account role list --role iva_acreditable
```

#### `mnemosine account role set` (alias: fijar)

```
Usage: mnemosine account role set|fijar [options] <role> <code>

Repoint a role to another account, or create a qualified variant

Arguments:
  role                     one of: activo_fijo, anticipo_clientes,
                           anticipo_proveedores, banco, cxc, cxp… (see role
                           list)
  code                     account code the role should point to

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --qualifier <q>          per-context variant (NULL = the default mapping)
  --note <text>            why this role points here
  --dry-run                validate and report, without writing
  -h, --help               display help for command

Examples:
  # Repoint the creditable-VAT role at another account.
  mnemosine account role set iva_acreditable 1130 --note "Catalogo del despacho"
  # Validate the change without writing it.
  mnemosine account role set banco 1111 --dry-run
```

#### `mnemosine account role seed` (alias: sembrar)

```
Usage: mnemosine account role seed|sembrar [options]

Create the missing base accounts and map every unmapped role (never overwrites a
manual choice)

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  -h, --help               display help for command

Examples:
  # Create the base accounts that are missing and map every UNMAPPED role.
  # It never overwrites a role someone pointed by hand.
  mnemosine account role seed
  # Do it on a named entity instead of the active one.
  mnemosine account role seed --entity "Molinos del Bajio SA de CV"
```

### `mnemosine account map` (alias: mapeo)

```
Usage: mnemosine account map|mapeo [options] [command]

Statutory mappings per account: SAT agrupador (Anexo 24), US tax line, IFRS

Options:
  -h, --help                        display help for command

Commands:
  set|fijar [options] <code>        Map the account to a statutory scheme value
  list|listar [options]             Every active account with its statutory
                                    mappings
  import|importar [options] <file>  Bulk-load a statutory scheme from CSV — the
                                    heaviest setup task of a Mexican firm
  check|verificar [options]         Coverage gate before the Anexo 24 catalog
                                    XML: which top accounts still lack a mapping
  help [command]                    display help for command
```

#### `mnemosine account map set` (alias: fijar)

```
Usage: mnemosine account map set|fijar [options] <code>

Map the account to a statutory scheme value

Arguments:
  code                     account code or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --scheme <name>          scheme: sat-agrupador, us-tax-line, ifrs
  --value <v>              the code in that scheme; empty clears the mapping
  --year <y>               catalog year (not supported yet: the versioned
                           c_CodAgrup catalog does not exist)
  --dry-run                validate and report, without writing
  -h, --help               display help for command

Examples:
  # Give the creditable-VAT account its SAT agrupador code (Anexo 24).
  mnemosine account map set 1130 --scheme sat-agrupador --value 118.01
  # Clear a mapping: an empty --value.
  mnemosine account map set 1130 --scheme sat-agrupador --value ""
```

#### `mnemosine account map list` (alias: listar)

```
Usage: mnemosine account map list|listar [options]

Every active account with its statutory mappings

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
  --scheme <name>                          project only this scheme
  -h, --help                               display help for command

Examples:
  # Every active account with its statutory mappings.
  mnemosine account map list
  # Only the SAT agrupador column, as CSV.
  mnemosine account map list --scheme sat-agrupador --format csv
```

#### `mnemosine account map import` (alias: importar)

```
Usage: mnemosine account map import|importar [options] <file>

Bulk-load a statutory scheme from CSV — the heaviest setup task of a Mexican
firm

Arguments:
  file                     CSV: code,valor (una cuenta por línea; separador coma
                           o punto y coma)

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --scheme <name>          scheme: sat-agrupador, us-tax-line, ifrs
  --dry-run                parse and resolve everything, write nothing
  --idempotency-key <key>  replay-safe key: the same key with the same file
                           returns the first result
  -h, --help               display help for command

Examples:
  # Parse the CSV (one "code,value" per line) and resolve every account; write nothing.
  mnemosine account map import ./agrupador.csv --scheme sat-agrupador --dry-run
  # Load it for real, replay-safe: the same key and file return the first result.
  mnemosine account map import ./agrupador.csv --scheme sat-agrupador --idempotency-key agrupador-2026
```

#### `mnemosine account map check` (alias: verificar)

```
Usage: mnemosine account map check|verificar [options]

Coverage gate before the Anexo 24 catalog XML: which top accounts still lack a
mapping

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --strict                                 treat warnings as blocking (exit 4)
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --check <names>                          named checks to run (available: coverage; empty lists them) (default: "coverage")
  --scheme <name>                          scheme to verify (default: "sat-agrupador")
  --level <n>                              deepest account level required to be mapped (default: "2")
  -h, --help                               display help for command

Examples:
  # The coverage gate before any Anexo 24 catalog XML: what still lacks a code.
  mnemosine account map check --scheme sat-agrupador --level 2
  # Same, but exit 4 on any gap so CI can block on it.
  mnemosine account map check --scheme sat-agrupador --level 3 --strict
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

Examples:
  # Put a retired account back in service.
  mnemosine account restore 6150
  # Do it on a named entity instead of the active one.
  mnemosine account restore 6150 --entity "Molinos del Bajio SA de CV"
```

## `mnemosine entry` (alias: poliza, asiento)

```
Usage: mnemosine entry|poliza [options] [command]

Journal entries: draft, inspect, validate, post, reverse and void

Options:
  -h, --help                                display help for command

Commands:
  list|listar [options] [search]            Search journal entries by text, account, date, amount, state, type or source
  show|ver [options] <number>               Show one entry with its lines, totals, period and linked reversal
  create|crear [options]                    Create a journal entry — ALWAYS a draft; posting is a separate human step
  check|verificar [options]                 Run the seven NIF validation rules over an entry or a document; writes nothing
  line|renglon                              Ledger lines: from an account balance down to the entries behind it
  preview|previsualizar [options] <number>  The exact account_balances delta this entry would produce, without touching anything
  edit|editar [options] <number>            Edit a DRAFT entry: description, reference, note, date or full line replacement
  export|exportar [options]                 Entries WITH their lines, flat, for audit or migration — no page cap
  import|importar [options] <file>          Stage a file of entries into a batch (returns a batch_id); NEVER touches the ledger
  post|contabilizar [options] <number>      Post ONE entry to the ledger: validates the seven rules, then moves balances
  reverse|reversar [options] <number>       Create the linked posted mirror of an entry (NIF B-1: correct by reversal)
  void|anular [options] <number>            Annul an entry: a draft is marked void, a posted one gets its linked mirror
  help [command]                            display help for command
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

Examples:
  # Every posted entry that touched payables (2110) in July 2026.
  mnemosine entry list --period 2026-07 --account 2110 --status posted
  # July's bill postings over 50,000 MXN, as CSV for the auditor.
  mnemosine entry list --source bill --period 2026-07 --min-amount 50000 --format csv
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

Examples:
  # The entry with its lines, totals and period.
  mnemosine entry show JE-2026-00042
  # Header only, as JSON, for a script.
  mnemosine entry show JE-2026-00042 --no-lines --json
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

Examples:
  # Accrue July office rent: 45,000.00 charged to 6120, owed on 2110.
  # Each --line is <account>:<debit|credit>:<amount> — <account> is the CODE
  # from the chart of accounts, and the amount carries no thousands separator.
  mnemosine entry create --date 2026-07-31 --type adjusting --description "Renta de oficina julio 2026" --line "6120:debit:45000.00" --line "2110:credit:45000.00"
  # Reclassify a misposted expense. A fourth field is the line's own text.
  mnemosine entry create --type correction --description "Reclasificacion de energia electrica" --line "6130:debit:8700.50:CFE julio" --line "6100:credit:8700.50:Sale de gastos de administracion"
  # See exactly what would be drafted, writing nothing.
  mnemosine entry create --description "Honorarios cobrados en efectivo" --line "1110:debit:12000.00" --line "4200:credit:12000.00" --dry-run
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

Examples:
  # Run the seven NIF rules over a draft that already exists.
  mnemosine entry check --entry JE-2026-00042
  # Validate a document that has not been created yet; warnings block (exit 4).
  mnemosine entry check --file ./polizas/ajuste-julio.json --strict
```

### `mnemosine entry line` (alias: renglon)

```
Usage: mnemosine entry line|renglon [options] [command]

Ledger lines: from an account balance down to the entries behind it

Options:
  -h, --help                    display help for command

Commands:
  list|listar [options] <code>  Posted lines of one account, each with the entry
                                it belongs to
  help [command]                display help for command
```

#### `mnemosine entry line list` (alias: listar)

```
Usage: mnemosine entry line list|listar [options] <code>

Posted lines of one account, each with the entry it belongs to

Arguments:
  code                                     account code

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

Examples:
  # Every posted line on the peso bank account during July 2026.
  # This leaf filters by DATE RANGE; --period is not the flag it reads.
  mnemosine entry line list 1111 --since 2026-07-01 --until 2026-07-31
  # The receivables control account over a quarter, newest 50 rows.
  mnemosine entry line list 1120 --since 2026-07-01 --until 2026-09-30 --limit 50
```

### `mnemosine entry preview` (alias: previsualizar)

```
Usage: mnemosine entry preview|previsualizar [options] <number>

The exact account_balances delta this entry would produce, without touching
anything

Arguments:
  number                                   entry number or id

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

Examples:
  # The exact account_balances delta this draft would produce, before posting.
  mnemosine entry preview JE-2026-00042
  # The same, as JSON, to diff two candidate drafts in a script.
  mnemosine entry preview JE-2026-00042 --json
```

### `mnemosine entry edit` (alias: editar)

```
Usage: mnemosine entry edit|editar [options] <number>

Edit a DRAFT entry: description, reference, note, date or full line replacement

Arguments:
  number                   entry number or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --description <text>     new description
  --reference <text>       new external reference
  --note <text>            new note
  --date <date>            new entry date (YYYY-MM-DD)
  --line <spec...>         replace ALL lines:
                           <account>:<debit|credit>:<amount>[:description]
  --file <path>            JSON document whose date/description/reference/lines
                           replace the draft
  -h, --help               display help for command

Examples:
  # Correct the description and the external reference of a draft.
  mnemosine entry edit JE-2026-00042 --description "Renta de oficina julio 2026" --reference "Contrato ARR-2024-11"
  # Replace ALL the lines: what you pass IS the entry, not an addition to it.
  mnemosine entry edit JE-2026-00042 --line "6120:debit:46500.00" --line "2110:credit:46500.00"
```

### `mnemosine entry export` (alias: exportar)

```
Usage: mnemosine entry export|exportar [options]

Entries WITH their lines, flat, for audit or migration — no page cap

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

Examples:
  # Every entry of July 2026 with its lines, flat, for the auditor.
  mnemosine entry export --period 2026-07 --format csv --output polizas-2026-07.csv
  # A date range as NDJSON, one line per row, to pipe into another tool.
  mnemosine entry export --since 2026-07-01 --until 2026-07-31 --format ndjson
```

### `mnemosine entry import` (alias: importar)

```
Usage: mnemosine entry import|importar [options] <file>

Stage a file of entries into a batch (returns a batch_id); NEVER touches the
ledger

Arguments:
  file                     file of journal entries to stage

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --layout <name>          file layout: csv, ndjson
                           (contpaqi/aspel/iif/sat-polizas: aún sin parser)
                           (default: "csv")
  --dry-run                parse and report, stage nothing
  --idempotency-key <key>  replay-safe key: the same key with the same file
                           returns the first batch
  -h, --help               display help for command

Examples:
  # Read the file and report what it holds; stage nothing.
  mnemosine entry import ./polizas-julio.csv --dry-run
  # Stage it into a batch. Replaying the same key and file returns that batch.
  mnemosine entry import ./polizas-julio.csv --layout csv --idempotency-key cierre-julio-2026
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
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # Post one draft to the ledger, after the confirmation prompt.
  mnemosine entry post JE-2026-00042
  # Validate and show the effect without moving a balance.
  mnemosine entry post JE-2026-00042 --dry-run
  # Unattended, replay-safe: the same key returns the first run's result.
  mnemosine entry post JE-2026-00042 --yes --idempotency-key cierre-julio-2026-je42
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
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command

Examples:
  # NIF B-1: correct a posted entry by its mirror, dated today. --reason is required.
  mnemosine entry reverse JE-2026-00042 --reason "Cuenta de gasto equivocada"
  # Date the mirror into the period being closed instead of today.
  mnemosine entry reverse JE-2026-00042 --date 2026-07-31 --reason "Reclasificacion del cierre de julio"
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
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command

Examples:
  # A DRAFT is simply marked void.
  mnemosine entry void JE-2026-00043 --reason "Capturada por duplicado"
  # A POSTED one gets its linked mirror instead; --dry-run says which of the two happens.
  mnemosine entry void JE-2026-00042 --dry-run
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

Examples:
  # Every period of the entity with its state.
  mnemosine period list
  # One fiscal year only, as CSV.
  mnemosine period list --year 2026 --format csv
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

Examples:
  # By the name the calendar minted.
  mnemosine period show "July 2026"
  # By year and month, which resolves to the same period.
  mnemosine period show 2026-07
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

Examples:
  # Open a future period so work can be captured in it.
  mnemosine period open "January 2027" --reason "Se anticipa la facturacion de enero"
  # See the transition without performing it.
  mnemosine period open 2027-01 --dry-run
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

Examples:
  # Every fiscal year with its state and close progress.
  mnemosine year list
  # As JSON, for a script.
  mnemosine year list --json
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

Examples:
  # One fiscal year with each of its twelve periods and their states.
  mnemosine year show 2026
  # The same as CSV.
  mnemosine year show 2026 --format csv
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

Examples:
  # Create a fiscal year and its twelve monthly periods.
  mnemosine year create 2027
  # See the calendar it would create, writing nothing.
  mnemosine year create 2027 --dry-run
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

Examples:
  # Vendors with no tax id on file — the DIOT and 1099 blockers.
  mnemosine vendor list --no-tax-id
  # Archived vendors, as CSV.
  mnemosine vendor list --inactive --format csv
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

Examples:
  # Identity, terms, currency and flags.
  mnemosine vendor show "Papeleria del Centro"
  # Add the activity section.
  mnemosine vendor show "Papeleria del Centro" --include activity
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

Examples:
  # A Mexican vendor, with its RFC, terms and default expense account.
  mnemosine vendor create "Papeleria del Centro SA de CV" --tax-id PCE180412TF4 --terms "Net 30" --currency MXN --default-account 6100
  # A US vendor flagged for an information return.
  mnemosine vendor create "Northwind Supplies LLC" --tax-id 47-1234567 --tax-id-type ein --currency USD --1099
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

Examples:
  # Contact data, with the reason that lands in the audit row.
  mnemosine vendor edit "Papeleria del Centro" --email cobranza@papeleriadelcentro.mx --reason "Aviso de cambio del proveedor"
  # Change who to talk to and how to reach them.
  mnemosine vendor edit "Papeleria del Centro" --contact "Laura Zepeda" --phone "5555123344"
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

Examples:
  # Early-payment terms a due date can actually be computed from.
  mnemosine vendor terms set "Papeleria del Centro" --terms "2/10 Net 30" --reason "Renegociacion de julio"
  # Settle in dollars from now on.
  mnemosine vendor terms set "Northwind Supplies LLC" --terms "Net 45" --currency USD --reason "Contrato 2026"
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
  inbox|bandeja                     CFDI inbox: pre-registrations waiting to
                                    become vendor bills
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

Examples:
  # Everything still owed to one vendor.
  mnemosine bill list --vendor "Papeleria del Centro" --open
  # What falls due on or before the 15th and is already approved.
  mnemosine bill list --due-before 2026-07-15 --status approved --limit 20
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

Examples:
  # The bill with its lines and their account coding.
  mnemosine bill show BILL-2026-00007
  # Add the journal entry the approval produced and the CFDI it came from.
  mnemosine bill show BILL-2026-00007 --journal --cfdi
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
                                  "account=5100,qty=1,price=1000,tax-amount=160".
                                  See the key list below
  --currency <code>               3-letter ISO code; defaults to the vendor's
                                  currency
  --terms <text>                  payment terms recorded on the bill; defaults
                                  to the vendor terms
  --description <text>            what this bill is for
  --from-file <path>              read the bill as JSON instead: { lines: [...],
                                  ... }
  --json                          JSON output
  -h, --help                      display help for command

Keys accepted in --line (key=value, comma-separated):
  account      chart account code the line is coded to (required)
  qty          quantity; defaults to 1
  quantity     same as qty
  price        unit price before tax (required)
  unit-price   same as price
  tax-amount   IVA of the line as an AMOUNT in the bill currency — NOT a rate
  tax          same as tax-amount: an AMOUNT, never a rate (invoice's tax= IS a rate)
  description  free text for the line
  cost-center  cost center id
  project      project id


Examples:
  # One line, coded to administrative expense, with 2,000.00 of IVA.
  # Inside --line the pairs are separated by COMMAS (invoice uses ";", entry ":").
  mnemosine bill create "Papeleria del Centro" --vendor-invoice-number A-4471 --bill-date 2026-07-08 --line "account=6100,qty=1,price=12500.00,tax-amount=2000.00,description=Papeleria de oficina"
  # Two lines, one of them capital equipment; the due date comes from the vendor terms.
  mnemosine bill create --vendor "Papeleria del Centro" --description "Compras de julio" --line "account=6100,price=8600.00,tax-amount=1376.00" --line "account=1220,qty=2,price=15900.00,tax-amount=5088.00"
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

Examples:
  # Re-code line 2 to utilities; only a bill that is not approved yet accepts this.
  mnemosine bill line set BILL-2026-00007 --line 2 --account 6130
  # Re-code it and fix its text in the same call.
  mnemosine bill line set BILL-2026-00007 --line 2 --account 6130 --description "Energia electrica de la bodega"
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
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # Recognize the liability in the ledger: DR expense + IVA / CR payables.
  mnemosine bill approve BILL-2026-00007
  # Show the entry it would post, writing nothing.
  mnemosine bill approve BILL-2026-00007 --dry-run
```

### `mnemosine bill inbox` (alias: bandeja)

```
Usage: mnemosine bill inbox|bandeja [options] [command]

CFDI inbox: pre-registrations waiting to become vendor bills

Options:
  -h, --help                   display help for command

Commands:
  list|listar [options]        The CFDI queue: what arrived, whose it is, and
                               what is holding it up
  run|ejecutar [options] [id]  Turn pre-registrations into vendor bills, or
                               approve, reject and schedule them in bulk
  help [command]               display help for command
```

#### `mnemosine bill inbox list` (alias: listar)

```
Usage: mnemosine bill inbox list|listar [options]

The CFDI queue: what arrived, whose it is, and what is holding it up

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
  --processing-mode <mode>                 how it is meant to be processed: auto, batch, manual, hold
  --requires-approval                      only the ones held for a prior approval
  --vendor <ref>                           only this vendor (number, name or id)
  -h, --help                               display help for command

Examples:
  # What arrived as CFDI and is ready to become a bill.
  mnemosine bill inbox list --status ready
  # Only what is held waiting for a prior approval, for one vendor.
  mnemosine bill inbox list --requires-approval --vendor "Papeleria del Centro"
```

#### `mnemosine bill inbox run` (alias: ejecutar)

```
Usage: mnemosine bill inbox run|ejecutar [options] [id]

Turn pre-registrations into vendor bills, or approve, reject and schedule them
in bulk

Arguments:
  id                                           one pre-registration, by id

Options:
  -e, --entity <idOrName>                      legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                            tenant (firm) whose data to scope to
  -u, --user <email>                           acting user, for attribution and permissions
  --action <process|approve|reject|set-batch>  what to do with the selection (default: "process")
  --bulk                                       act on everything --query selects, instead of a single id
  --query <expr>                               selection for --bulk, comma-separated key=value: status, mode, requires-approval, vendor, since, until, search
  --batch <ref>                                processing batch to schedule into; required by --action set-batch
  --allow-new-vendor                           authorize creating the CFDI issuer as a vendor when the catalog does not have it; without it, those are refused
  --reason <text>                              why it is rejected; required by --action reject
  --note <text>                                annotation stored with the approval
  --dry-run                                    compute and show the full effect; write nothing
  -y, --yes                                    skip the confirmation prompt
  --idempotency-key <key>                      client dedupe key, stored on success: a retry with the same key and payload returns the recorded result
  --json                                       JSON output
  -h, --help                                   display help for command

Examples:
  # Turn one pre-registration into a vendor bill.
  mnemosine bill inbox run 6f2b0d24-9b8a-4c1e-8f4d-2a7c1e5b3d90
  # Approve in bulk what --query selects, after seeing the whole effect first.
  mnemosine bill inbox run --bulk --query "status=ready,mode=batch" --action approve --dry-run
  # Reject one, with the reason that lands in the audit trail.
  mnemosine bill inbox run 6f2b0d24-9b8a-4c1e-8f4d-2a7c1e5b3d90 --action reject --reason "CFDI de otro contribuyente"
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
  tax|fiscal                         The fiscal profile CFDI 4.0 stamps against:
                                     RFC, regime, postal code, UsoCFDI
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

Examples:
  # Customers with something past due.
  mnemosine customer list --overdue
  # Those owing more than 100,000, as CSV.
  mnemosine customer list --balance-gt 100000 --format csv
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

Examples:
  # Profile, tax id, credit, balance and open documents.
  mnemosine customer show "Grupo Alameda"
  # The balance as it stood at the close date. A date RANGE belongs to invoice list.
  mnemosine customer show "Grupo Alameda" --as-of 2026-07-31
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

Examples:
  # A company: RFC of a persona moral (3 letters), terms and billing currency.
  mnemosine customer create --name "Grupo Alameda SA de CV" --tax-id GAL150623QK8 --terms "Net 30" --currency MXN --email cobranza@grupoalameda.mx
  # An individual: given and family name, and a persona fisica RFC (4 letters).
  mnemosine customer create --first-name "Maria" --last-name "Robledo Cruz" --tax-id ROCM850214J78 --tax-id-type rfc
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

Examples:
  # Commercial and contact data. The tax profile is NOT edited here.
  mnemosine customer edit "Grupo Alameda" --email pagos@grupoalameda.mx --terms "Net 45" --reason "Convenio comercial 2026"
  # Leave a note on the customer file.
  mnemosine customer edit "Grupo Alameda" --notes "Exige orden de compra en cada factura"
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

Examples:
  # Deactivate a customer. It is an undo verb, so --reason is required.
  mnemosine customer archive "Grupo Alameda" --reason "Cliente inactivo desde 2025"
  # Archive one that still shows a balance: --force overrides the check, never the reason.
  mnemosine customer archive "Grupo Alameda" --force --reason "Saldo incobrable ya castigado"
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

Examples:
  # Put an archived customer back in service.
  mnemosine customer restore "Grupo Alameda"
  # With the justification that lands in the audit trail.
  mnemosine customer restore "Grupo Alameda" --reason "Reactivado con contrato 2026"
```

### `mnemosine customer tax` (alias: fiscal)

```
Usage: mnemosine customer tax|fiscal [options] [command]

The fiscal profile CFDI 4.0 stamps against: RFC, regime, postal code, UsoCFDI

Options:
  -h, --help                 display help for command

Commands:
  show|ver [options] <ref>   Show the fiscal profile and what is missing before
                             this customer can be stamped
  set|fijar [options] <ref>  Set RFC, regime, postal code or UsoCFDI, validated
                             against the SAT catalogs before writing
  list|listar [options]      The pre-billing control: customers whose fiscal
                             profile is incomplete or malformed
  help [command]             display help for command
```

#### `mnemosine customer tax show` (alias: ver)

```
Usage: mnemosine customer tax show|ver [options] <ref>

Show the fiscal profile and what is missing before this customer can be stamped

Arguments:
  ref                                      customer number, name or id

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

Examples:
  # The fiscal profile, and what is missing before this customer can be stamped.
  mnemosine customer tax show "Grupo Alameda"
  # As JSON, for a pre-billing gate.
  mnemosine customer tax show "Grupo Alameda" --json
```

#### `mnemosine customer tax set` (alias: fijar)

```
Usage: mnemosine customer tax set|fijar [options] <ref>

Set RFC, regime, postal code or UsoCFDI, validated against the SAT catalogs
before writing

Arguments:
  ref                      customer number, name or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --rfc <rfc>              the RFC (form-validated: AAAA######XXX)
  --tax-regime <code>      c_RegimenFiscal code: 601, 612, 626…
  --postal-code <cp>       fiscal address postal code (5 digits)
  --uso-cfdi <code>        default c_UsoCFDI: G01, G03, P01…
  --reason <text>          justification recorded in the audit trail
  --json                   JSON output
  -h, --help               display help for command

Examples:
  # The four fields CFDI 4.0 stamps against, validated against the SAT catalogs.
  mnemosine customer tax set "Grupo Alameda" --rfc GAL150623QK8 --tax-regime 601 --postal-code 06600 --uso-cfdi G03 --reason "Constancia de situacion fiscal de julio"
  # Only the default UsoCFDI.
  mnemosine customer tax set "Grupo Alameda" --uso-cfdi G01 --reason "Solicitud del cliente"
```

#### `mnemosine customer tax list` (alias: listar)

```
Usage: mnemosine customer tax list|listar [options]

The pre-billing control: customers whose fiscal profile is incomplete or
malformed

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
  --missing                                only customers that could NOT be stamped today
  -h, --help                               display help for command

Examples:
  # The whole pre-billing control, as CSV.
  mnemosine customer tax list --format csv
  # Only the customers that could NOT be stamped today.
  mnemosine customer tax list --missing
```

## `mnemosine invoice` (alias: factura)

```
Usage: mnemosine invoice|factura [options] [command]

Customer invoices: draft, inspect, issue to the ledger and void (never stamped
here)

Options:
  -h, --help                       display help for command

Commands:
  list|listar [options] [search]   List invoices by customer, state, period or
                                   days past due
  show|ver [options] <ref>         Show one invoice with its lines, the cash
                                   applied and its ledger entry
  create|crear [options]           Create a DRAFT invoice from scratch: a local
                                   document, neither posted nor stamped
  issue|emitir [options] <ref>     Issue an invoice: post DR receivable / CR
                                   revenue / CR VAT. Does not stamp or send
  void|anular [options] <ref>      Void a local invoice and reverse its ledger
                                   entry; refuses a stamped or paid one
  edit|editar [options] <ref>      Edit a DRAFT invoice: dates, memo or its
                                   lines (issued ones are voided or credited,
                                   never edited)
  delete|eliminar [options] <ref>  Delete a DRAFT that never touched the ledger;
                                   its folio stays as a documented gap
  series|serie                     Folio series: the counters this entity draws
                                   document numbers from
  help [command]                   display help for command
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

Examples:
  # Open invoices of one customer that are at least 30 days past due.
  mnemosine invoice list --customer "Grupo Alameda" --overdue-days 30
  # Everything sent in July 2026, as CSV.
  mnemosine invoice list --period 2026-07 --status sent --format csv
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

Examples:
  # The invoice with its lines, the cash applied and its ledger entry.
  mnemosine invoice show INV-2026-00042
  # As JSON, for a script that reads amount_due.
  mnemosine invoice show INV-2026-00042 --json
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
                           "account=4100;qty=2;price=1500;tax=16;description=…".
                           Here tax= is a RATE in % (16 means 16%), not an
                           amount — unlike bill, where it is the amount
  --from-file <path>       JSON array of lines instead of repeated --line
  --date <date>            invoice date (YYYY-MM-DD); defaults to today
  --due-date <date>        due date; defaults to the customer's payment terms
  --currency <code>        billing currency; defaults to the customer's
  --terms <text>           payment terms printed on the document
  --memo <text>            memo
  --po-number <text>       the customer purchase order this bills against
  --json                   JSON output
  -h, --help               display help for command

Examples:
  # One service line at 16% IVA. Inside --line the pairs are separated by
  # SEMICOLONS, and tax= is a RATE in percent — 16 means 16%, not 16 pesos.
  mnemosine invoice create --customer "Grupo Alameda" --date 2026-07-15 --line "account=4200;qty=1;price=85000.00;tax=16;description=Servicios contables julio"
  # Goods and services on one document, against the customer's purchase order.
  mnemosine invoice create --customer "Grupo Alameda" --po-number OC-2026-118 --line "account=4100;qty=10;price=1250.00;tax=16" --line "account=4200;qty=1;price=32000.00;tax=16"
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
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # Post DR receivable / CR revenue / CR IVA. It does not stamp and does not send.
  mnemosine invoice issue INV-2026-00042
  # See the entry it would post, writing nothing.
  mnemosine invoice issue INV-2026-00042 --dry-run
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
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command

Examples:
  # Void a local invoice and reverse its ledger entry. --reason is required.
  mnemosine invoice void INV-2026-00042 --reason "Emitida al cliente equivocado"
  # See what would be reversed before deciding.
  mnemosine invoice void INV-2026-00042 --dry-run
```

### `mnemosine invoice edit` (alias: editar)

```
Usage: mnemosine invoice edit|editar [options] <ref>

Edit a DRAFT invoice: dates, memo or its lines (issued ones are voided or
credited, never edited)

Arguments:
  ref                      invoice number or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --line <spec...>         REPLACE all lines:
                           "account=4100;qty=2;price=1500;tax=16;…"
                           (repeatable). Here tax= is a RATE in %, not an amount
  --from-file <path>       JSON array of lines instead of repeated --line
  --date <date>            new invoice date (YYYY-MM-DD)
  --due-date <date>        new due date
  --memo <text>            new memo
  --po-number <text>       new purchase order reference
  --json                   JSON output
  -h, --help               display help for command

Examples:
  # Move the due date of a DRAFT and correct its memo.
  mnemosine invoice edit INV-2026-00043 --due-date 2026-08-30 --memo "Vence a 45 dias por convenio"
  # Replace ALL the lines of the draft: what you pass IS the invoice.
  mnemosine invoice edit INV-2026-00043 --line "account=4200;qty=1;price=92000.00;tax=16"
```

### `mnemosine invoice delete` (alias: eliminar)

```
Usage: mnemosine invoice delete|eliminar [options] <ref>

Delete a DRAFT that never touched the ledger; its folio stays as a documented
gap

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
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command

Examples:
  # Delete a DRAFT that never reached the ledger; the folio stays as an explained gap.
  mnemosine invoice delete INV-2026-00043 --reason "Capturada por duplicado"
  # See the gap it would leave, writing nothing.
  mnemosine invoice delete INV-2026-00043 --dry-run
```

### `mnemosine invoice series` (alias: serie)

```
Usage: mnemosine invoice series|serie [options] [command]

Folio series: the counters this entity draws document numbers from

Options:
  -h, --help                 display help for command

Commands:
  list|listar [options]      List the folio counters, the last number issued and
                             the next one
  check|verificar [options]  Report gaps in the invoice folio series; a gap with
                             an audit trail is explained, one without is a
                             finding
  help [command]             display help for command
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

Examples:
  # Each folio counter, the last number issued and the next one.
  mnemosine invoice series list
  # The same, as JSON, for the numbering audit.
  mnemosine invoice series list --json
```

#### `mnemosine invoice series check` (alias: verificar)

```
Usage: mnemosine invoice series check|verificar [options]

Report gaps in the invoice folio series; a gap with an audit trail is explained,
one without is a finding

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --year <year>                            only this fiscal year of the series
  --strict                                 exit 4 even when every gap is explained
  -h, --help                               display help for command

Examples:
  # Report the gaps in the folio series; an explained gap is not a finding.
  mnemosine invoice series check
  # Only fiscal 2026, and fail (exit 4) even when every gap is explained.
  mnemosine invoice series check --year 2026 --strict
```

## `mnemosine receipt` (alias: cobro)

```
Usage: mnemosine receipt|cobro [options] [command]

Customer collections: record cash, apply on-account balance, unapply, and
reverse bounced checks

Options:
  -h, --help                            display help for command

Commands:
  record|registrar [options] <invoice>  Record cash received against an invoice
                                        and recognize the IVA it was holding
  show|ver [options] <ref>              Show one collection: its applications
                                        (live and history), REP status and
                                        ledger entry
  list|listar [options]                 List collections by customer, date,
                                        application state or missing REP
  apply|aplicar [options] <ref>         Apply the on-account balance of a
                                        collection to one or more invoices
                                        (releases PPD IVA)
  unapply|desaplicar [options] <ref>    Unapply a collection from an invoice as
                                        a NEW event: reopens it and re-parks the
                                        PPD IVA
  reverse|reversar [options] <ref>      Reverse a bounced collection (NSF):
                                        mirrors every entry, reopens invoices,
                                        re-parks IVA
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
  --reference <text>       bank reference or transfer number
  --on-account             let the amount exceed the invoice due; the excess
                           stays on account (anticipo)
  --json                   JSON output
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # Cash received against one invoice; this releases the PPD IVA it was holding.
  mnemosine receipt record INV-2026-00042 --amount 98600.00 --date 2026-07-31 --method spei --reference "SPEI 0123456789"
  # Take more than the invoice owes; the excess stays on account as an anticipo.
  mnemosine receipt record INV-2026-00042 --amount 120000.00 --on-account
  # See the entry it would post, writing nothing.
  mnemosine receipt record INV-2026-00042 --amount 98600.00 --dry-run
```

### `mnemosine receipt show` (alias: ver)

```
Usage: mnemosine receipt show|ver [options] <ref>

Show one collection: its applications (live and history), REP status and ledger
entry

Arguments:
  ref                                      payment number (PMT-2026-00042) or id

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

Examples:
  # One collection: its applications, live and historic, its REP and its entry.
  mnemosine receipt show PMT-2026-00042
  # As JSON, for a script that reads the unapplied remainder.
  mnemosine receipt show PMT-2026-00042 --json
```

### `mnemosine receipt list` (alias: listar)

```
Usage: mnemosine receipt list|listar [options]

List collections by customer, date, application state or missing REP

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
  --unapplied                              only collections with an on-account remainder
  --needs-rep                              only completed collections with no REP linked
  -h, --help                               display help for command

Examples:
  # Collections from one customer during July 2026.
  mnemosine receipt list --customer "Grupo Alameda" --since 2026-07-01 --until 2026-07-31
  # Cash still sitting on account, and completed collections with no REP linked.
  mnemosine receipt list --unapplied --needs-rep
```

### `mnemosine receipt apply` (alias: aplicar)

```
Usage: mnemosine receipt apply|aplicar [options] <ref>

Apply the on-account balance of a collection to one or more invoices (releases
PPD IVA)

Arguments:
  ref                      payment number or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --invoice <spec...>      invoice with amount: "INV-2026-00042:2500"
                           (repeatable), or a bare ref with --amount
  --amount <amount>        amount for a single --invoice without an inline
                           amount
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # Apply an on-account balance to two invoices, each amount after the colon.
  mnemosine receipt apply PMT-2026-00042 --invoice "INV-2026-00042:2500.00" --invoice "INV-2026-00051:1800.00"
  # A single invoice, with the amount as its own flag.
  mnemosine receipt apply PMT-2026-00042 --invoice INV-2026-00042 --amount 2500.00
```

### `mnemosine receipt unapply` (alias: desaplicar)

```
Usage: mnemosine receipt unapply|desaplicar [options] <ref>

Unapply a collection from an invoice as a NEW event: reopens it and re-parks the
PPD IVA

Arguments:
  ref                      payment number or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --invoice <ref>          the invoice to unapply from
  --reason <text>          why: it lands in the audit trail and the ledger
                           description
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # A NEW event, not an erasure: it reopens the invoice and re-parks the PPD IVA.
  mnemosine receipt unapply PMT-2026-00042 --invoice INV-2026-00042 --reason "Aplicada a la factura equivocada"
  # See what would be reopened before doing it.
  mnemosine receipt unapply PMT-2026-00042 --invoice INV-2026-00042 --reason "Revision del cobro de julio" --dry-run
```

### `mnemosine receipt reverse` (alias: reversar)

```
Usage: mnemosine receipt reverse|reversar [options] <ref>

Reverse a bounced collection (NSF): mirrors every entry, reopens invoices,
re-parks IVA

Arguments:
  ref                      payment number or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --fee <amount>           bank fee charged for the return (not yet supported:
                           needs a fee role account)
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command

Examples:
  # A bounced collection (NSF): mirrors every entry, reopens invoices, re-parks IVA.
  mnemosine receipt reverse PMT-2026-00042 --reason "Devuelto por fondos insuficientes"
  # See the mirror it would post, writing nothing.
  mnemosine receipt reverse PMT-2026-00042 --dry-run
```

## `mnemosine credit-note` (alias: nota-credito)

```
Usage: mnemosine credit-note|nota-credito [options] [command]

Credit notes: returns, discounts and corrections against the receivable (never
stamped here)

Options:
  -h, --help                     display help for command

Commands:
  create|crear [options]         Create a DRAFT credit note, linked to its
                                 invoice (fiscal tie) or standalone with an
                                 explicit customer
  show|ver [options] <ref>       Show one credit note with its applications,
                                 available balance and ledger entry
  list|listar [options]          List credit notes by customer, type, state or
                                 unapplied balance
  issue|emitir [options] <ref>   Issue the note: post DR returns + DR VAT / CR
                                 receivable. Does not stamp
  apply|aplicar [options] <ref>  Apply an issued note to invoices; what is not
                                 applied stays as customer credit
  help [command]                 display help for command
```

### `mnemosine credit-note create` (alias: crear)

```
Usage: mnemosine credit-note create|crear [options]

Create a DRAFT credit note, linked to its invoice (fiscal tie) or standalone
with an explicit customer

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --type <type>            one of: devolucion, descuento, correccion, anticipo
  --amount <amount>        subtotal of the credit, before tax
  --tax <amount>           tax (IVA) portion of the credit (default: "0")
  --invoice <ref>          the invoice this note credits (recommended: it drives
                           the IVA side)
  --customer <ref>         customer, when there is no linked invoice
  --relates-to <uuid>      UUID of the original CFDI, when the invoice is not in
                           the system
  --date <date>            credit date (YYYY-MM-DD); defaults to today
  --memo <text>            memo
  --json                   JSON output
  -h, --help               display help for command

Examples:
  # A return tied to its invoice: the link is what drives the IVA side.
  mnemosine credit-note create --type devolucion --invoice INV-2026-00042 --amount 5000.00 --tax 800.00 --memo "Devolucion de 4 piezas"
  # A discount when the original invoice is not in the system, only its CFDI.
  mnemosine credit-note create --type descuento --customer "Grupo Alameda" --amount 2500.00 --tax 400.00 --relates-to 3F2504E0-4F89-11D3-9A0C-0305E82C3301
```

### `mnemosine credit-note show` (alias: ver)

```
Usage: mnemosine credit-note show|ver [options] <ref>

Show one credit note with its applications, available balance and ledger entry

Arguments:
  ref                                      credit note number (CN-2026-00042) or id

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

Examples:
  # One note with its applications, its available balance and its ledger entry.
  mnemosine credit-note show CN-2026-00007
  # As JSON, for a script that reads the balance left to apply.
  mnemosine credit-note show CN-2026-00007 --json
```

### `mnemosine credit-note list` (alias: listar)

```
Usage: mnemosine credit-note list|listar [options]

List credit notes by customer, type, state or unapplied balance

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
  --type <type>                            only this type: devolucion, descuento, correccion, anticipo
  --open                                   only issued notes with balance left to apply (the live customer credit)
  -h, --help                               display help for command

Examples:
  # Issued notes with credit left to apply — the live customer credit.
  mnemosine credit-note list --open
  # Returns only, for one customer.
  mnemosine credit-note list --type devolucion --customer "Grupo Alameda"
```

### `mnemosine credit-note issue` (alias: emitir)

```
Usage: mnemosine credit-note issue|emitir [options] <ref>

Issue the note: post DR returns + DR VAT / CR receivable. Does not stamp

Arguments:
  ref                      credit note number or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # Post DR returns + DR IVA / CR receivable. It does not stamp.
  mnemosine credit-note issue CN-2026-00007
  # See the entry it would post, writing nothing.
  mnemosine credit-note issue CN-2026-00007 --dry-run
```

### `mnemosine credit-note apply` (alias: aplicar)

```
Usage: mnemosine credit-note apply|aplicar [options] <ref>

Apply an issued note to invoices; what is not applied stays as customer credit

Arguments:
  ref                      credit note number or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --invoice <spec...>      invoice with amount: "INV-2026-00042:2500"
                           (repeatable), or a bare ref with --amount
  --amount <amount>        amount for a single --invoice without an inline
                           amount
  --dry-run                run the real path and roll back
  --json                   JSON output
  -h, --help               display help for command

Examples:
  # Apply an issued note to one invoice; what is left stays as customer credit.
  mnemosine credit-note apply CN-2026-00007 --invoice "INV-2026-00042:5800.00"
  # Two invoices at once, run for real and rolled back, to check the arithmetic.
  mnemosine credit-note apply CN-2026-00007 --invoice "INV-2026-00042:3000.00" --invoice "INV-2026-00051:2800.00" --dry-run
```

## `mnemosine ar` (alias: cxc)

```
Usage: mnemosine ar|cxc [options] [command]

Receivables controls: reconcile the subledger against the control account, run
named diagnostics

Options:
  -h, --help                     display help for command

Commands:
  reconcile|conciliar [options]  Subledger (open invoices − unapplied credit
                                 notes) vs the cxc control account, naming
                                 manual entries
  check|verificar [options]      Named receivables diagnostics; `--check` with
                                 no value lists them, `--check a,b` selects
  help [command]                 display help for command
```

### `mnemosine ar reconcile` (alias: conciliar)

```
Usage: mnemosine ar reconcile|conciliar [options]

Subledger (open invoices − unapplied credit notes) vs the cxc control account,
naming manual entries

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --strict                                 exit 4 on any delta, however small the list of suspects
  -h, --help                               display help for command

Examples:
  # The subledger against the cxc control account, naming the manual entries.
  mnemosine ar reconcile
  # Exit 4 on any delta, however small, so CI can block on it.
  mnemosine ar reconcile --strict
```

### `mnemosine ar check` (alias: verificar)

```
Usage: mnemosine ar check|verificar [options]

Named receivables diagnostics; `--check` with no value lists them, `--check a,b`
selects

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --check [names]                          comma-separated diagnostics to run; bare --check lists the battery
  --strict                                 exit 4 on warnings too, not only blocking findings
  -h, --help                               display help for command

Examples:
  # List the diagnostics this battery can run, and run none of them.
  mnemosine ar check --check
  # Run two of them, failing on warnings too.
  mnemosine ar check --check duplicate-invoice,stale-unapplied-cash --strict
```

## `mnemosine ap` (alias: cxp)

```
Usage: mnemosine ap|cxp [options] [command]

Payables controls: reconcile the vendor subledger against the control account

Options:
  -h, --help                     display help for command

Commands:
  reconcile|conciliar [options]  Vendor subledger (open bills) vs the cxp
                                 control account, naming the reconciling items
  help [command]                 display help for command
```

### `mnemosine ap reconcile` (alias: conciliar)

```
Usage: mnemosine ap reconcile|conciliar [options]

Vendor subledger (open bills) vs the cxp control account, naming the reconciling
items

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
  --as-of <date>                           cut-off for both sides of the reconciliation (YYYY-MM-DD; defaults to today)
  --explain                                spell out every reconciling item in prose, not just the table
  -h, --help                               display help for command

Examples:
  # The vendor subledger against the cxp control account, as of today.
  mnemosine ap reconcile
  # At the close date, spelling out every reconciling item in prose.
  mnemosine ap reconcile --as-of 2026-07-31 --explain
  # Exit 4 on any delta, for CI.
  mnemosine ap reconcile --as-of 2026-07-31 --strict
```

## `mnemosine bank` (alias: banco)

```
Usage: mnemosine bank|banco [options] [command]

Bank accounts and bank statements: master data and imported statements

Options:
  -h, --help                display help for command

Commands:
  account|cuenta            Bank accounts as master data: identifiers, currency
                            and the 1:1 GL mapping
  statement|estado-cuenta   Bank statements as documents: import, inspect and
                            check their integrity
  transaction|movimiento    Bank transactions: what the bank says happened,
                            before anyone explains it
  book-item|partida-libros  The other side: posted journal lines against the
                            bank GL account, still unsealed
  match|cotejo              Matching a bank transaction to what the books
                            already say about it
  help [command]            display help for command
```

### `mnemosine bank account` (alias: cuenta)

```
Usage: mnemosine bank account|cuenta [options] [command]

Bank accounts as master data: identifiers, currency and the 1:1 GL mapping

Options:
  -h, --help                       display help for command

Commands:
  create|crear [options] <name>    Register a bank account, validating the CLABE
                                   check digit, the ABA routing checksum, the
                                   currency against the GL account and the 1:1
                                   mapping
  list|listar [options] [query]    List the accounts with currency, type, GL
                                   account, book balance and the last approved
                                   reconciliation
  show|ver [options] <account>     Show one account: masked identifiers, SAT
                                   bank key, book vs bank balance and the
                                   reconciliation anchor
  edit|editar [options] <account>  Change master data, recording the before and
                                   after field by field
  set|fijar [options] <account>    Write the 1:1 GL mapping, refusing the change
                                   when the old account has posted entries
  help [command]                   display help for command
```

#### `mnemosine bank account create` (alias: crear)

```
Usage: mnemosine bank account create|crear [options] <name>

Register a bank account, validating the CLABE check digit, the ABA routing
checksum, the currency against the GL account and the 1:1 mapping

Arguments:
  name                                                     name this account is known by inside the books

Options:
  -e, --entity <idOrName>                                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                                        tenant (firm) whose data to scope to
  -u, --user <email>                                       acting user, for attribution and permissions
  --bank <name>                                            name of the institution
  --gl-account <code>                                      GL account this bank account maps to, 1:1 (code or id)
  --currency <code>                                        3-letter ISO code; must equal the GL account currency
  --type <checking|savings|petty-cash|credit-card|escrow>  account nature; credit-card is a LIABILITY and maps to a liability GL account (default: "checking")
  --clabe <18 digits>                                      CLABE; stored encrypted, only the last 4 are ever shown
  --account-number <number>                                account number; stored encrypted
  --routing-ach <9 digits>                                 ABA routing number for ACH
  --routing-wire <9 digits>                                ABA routing number for wires
  --sat-bank-code <ccc>                                    SAT c_Banco key; derived from the CLABE when omitted
  --branch <text>                                          branch
  --swift <code>                                           SWIFT/BIC
  --iban <code>                                            IBAN
  --dry-run                                                run every validation and the insert, then roll it back
  --json                                                   JSON output
  -h, --help                                               display help for command
```

#### `mnemosine bank account list` (alias: listar)

```
Usage: mnemosine bank account list|listar [options] [query]

List the accounts with currency, type, GL account, book balance and the last
approved reconciliation

Arguments:
  query                                                    match against the account name or the bank name

Options:
  -e, --entity <idOrName>                                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                                        tenant (firm) whose data to scope to
  -u, --user <email>                                       acting user, for attribution and permissions
  -n, --limit <n>                                          maximum rows to return
  --offset <n>                                             skip this many rows
  -s, --status <state...>                                  filter by lifecycle state (repeatable)
  -a, --all                                                no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>                  output format (default: "table")
  --json                                                   shorthand for --format json
  -o, --output <path>                                      write to a file instead of stdout
  --fields [names]                                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                                              identifiers only, one per line, for piping
  --type <checking|savings|petty-cash|credit-card|escrow>  only accounts of this nature
  --currency <code>                                        only accounts in this currency
  --all-entities                                           every entity of the tenant, for a firm's overview; still bounded inside the SQL
  -h, --help                                               display help for command
```

#### `mnemosine bank account show` (alias: ver)

```
Usage: mnemosine bank account show|ver [options] <account>

Show one account: masked identifiers, SAT bank key, book vs bank balance and the
reconciliation anchor

Arguments:
  account                                  account name or id

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --redacted                               drop even the last 4 digits of the identifiers, for a shared screen
  -h, --help                               display help for command
```

#### `mnemosine bank account edit` (alias: editar)

```
Usage: mnemosine bank account edit|editar [options] <account>

Change master data, recording the before and after field by field

Arguments:
  account                                                  account name or id

Options:
  -e, --entity <idOrName>                                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                                        tenant (firm) whose data to scope to
  -u, --user <email>                                       acting user, for attribution and permissions
  --name <text>                                            new account name
  --bank <name>                                            new institution name
  --branch <text>                                          branch; empty clears it
  --type <checking|savings|petty-cash|credit-card|escrow>  account nature
  --currency <code>                                        currency; re-checked against the GL account
  --clabe <18 digits>                                      CLABE; requires --reason. Empty clears it
  --account-number <number>                                account number; requires --reason. Empty clears it
  --routing-ach <9 digits>                                 ABA routing for ACH; requires --reason. Empty clears it
  --routing-wire <9 digits>                                ABA routing for wires; requires --reason. Empty clears it
  --sat-bank-code <ccc>                                    SAT c_Banco key; empty clears it
  --swift <code>                                           SWIFT/BIC; empty clears it
  --iban <code>                                            IBAN; empty clears it
  --reason <text>                                          justification recorded in the audit trail; required for identifiers
  --dry-run                                                apply the change and roll it back, showing what would differ
  -y, --yes                                                skip the confirmation prompt
  --json                                                   JSON output
  -h, --help                                               display help for command
```

#### `mnemosine bank account set` (alias: fijar)

```
Usage: mnemosine bank account set|fijar [options] <account>

Write the 1:1 GL mapping, refusing the change when the old account has posted
entries

Arguments:
  account                  account name or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --force                  override a blocking validation (closed period, lock
                           date, duplicate); requires --reason
  --gl-account <code>      GL account to map to (code or id)
  --reason <text>          justification recorded in the audit trail; required
                           by --force
  --dry-run                apply the remap and roll it back
  --json                   JSON output
  -h, --help               display help for command
```

### `mnemosine bank statement` (alias: estado-cuenta)

```
Usage: mnemosine bank statement|estado-cuenta [options] [command]

Bank statements as documents: import, inspect and check their integrity

Options:
  -h, --help                           display help for command

Commands:
  import|importar [options] <file...>  Parse, normalize and stage a bank
                                       statement, deduplicating by native id or
                                       content hash; posts NOTHING to the ledger
  list|listar [options]                List imported statements by account and
                                       period, with opening and closing balance,
                                       line count and the balance chain
  show|ver [options] <id>              Show one statement: electronic sequence
                                       number, date range, hash of the original
                                       file and the profile applied
  check|verificar [options] [id]       Run the seven integrity checks and EXIT 4
                                       naming which one broke
  help [command]                       display help for command
```

#### `mnemosine bank statement import` (alias: importar)

```
Usage: mnemosine bank statement import|importar [options] <file...>

Parse, normalize and stage a bank statement, deduplicating by native id or
content hash; posts NOTHING to the ledger

Arguments:
  file                                                          statement files; combine with --dir to take a whole folder

Options:
  -e, --entity <idOrName>                                       legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                                             tenant (firm) whose data to scope to
  -u, --user <email>                                            acting user, for attribution and permissions
  --account <ref>                                               bank account these statements belong to (name or id)
  --format <csv|camt053|mt940|ofx|qfx|mt942|camt054|bai2|xlsx>  format of the FILE (not of the output; use --json for that); sniffed from the content when omitted
  --profile <name>                                              CSV column profile to read the file with
  --dir <path>                                                  import every file in this folder as well
  --closing-balance <amount>                                    closing balance you assert, for a format that carries none (a CSV); refused if the file says otherwise
  --dry-run                                                     parse, run the seven checks and roll the write back
  --json                                                        JSON output
  -h, --help                                                    display help for command
```

#### `mnemosine bank statement list` (alias: listar)

```
Usage: mnemosine bank statement list|listar [options]

List imported statements by account and period, with opening and closing
balance, line count and the balance chain

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
  --account <ref>                          only this bank account (name or id)
  --since <date>                           statements whose period ENDS on or after this date (YYYY-MM-DD)
  --until <date>                           statements whose period STARTS on or before this date (YYYY-MM-DD)
  -h, --help                               display help for command
```

#### `mnemosine bank statement show` (alias: ver)

```
Usage: mnemosine bank statement show|ver [options] <id>

Show one statement: electronic sequence number, date range, hash of the original
file and the profile applied

Arguments:
  id                                       statement id

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --lines                                  include the statement lines
  -n, --limit <n>                          maximum lines to list with --lines (default 500)
  -h, --help                               display help for command
```

#### `mnemosine bank statement check` (alias: verificar)

```
Usage: mnemosine bank statement check|verificar [options] [id]

Run the seven integrity checks and EXIT 4 naming which one broke

Arguments:
  id                                       one statement; without it, the latest of each account

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
  --check [names]                          comma-separated checks to run; bare --check lists them (cadena-de-saldos, continuidad, huecos-y-traslapes, identidad, moneda, secuencia, reversos)
  -a, --all                                every statement of the entity, not just the latest per account
  --account <ref>                          every statement of this bank account (name or id)
  --since <date>                           only statements whose period ends on or after this date (YYYY-MM-DD)
  -h, --help                               display help for command
```

### `mnemosine bank transaction` (alias: movimiento)

```
Usage: mnemosine bank transaction|movimiento [options] [command]

Bank transactions: what the bank says happened, before anyone explains it

Options:
  -h, --help                     display help for command

Commands:
  list|listar [options] [query]  List bank transactions filtered by account,
                                 date range, direction, amount, text, type and
                                 match state
  show|ver [options] <id>        Show one transaction: the normalized line, the
                                 statement it came from and the live matches
                                 that explain it
  help [command]                 display help for command
```

#### `mnemosine bank transaction list` (alias: listar)

```
Usage: mnemosine bank transaction list|listar [options] [query]

List bank transactions filtered by account, date range, direction, amount, text,
type and match state

Arguments:
  query                                          hledger-style terms: desc:<text>, amt:[>|<|>=|<=]<amount>; a bare word means desc:

Options:
  -e, --entity <idOrName>                        legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                              tenant (firm) whose data to scope to
  -u, --user <email>                             acting user, for attribution and permissions
  -n, --limit <n>                                maximum rows to return
  --offset <n>                                   skip this many rows
  -s, --status <state...>                        filter by lifecycle state (repeatable)
  -a, --all                                      no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>        output format (default: "table")
  --json                                         shorthand for --format json
  -o, --output <path>                            write to a file instead of stdout
  --fields [names]                               comma-separated columns; with no value, lists the available ones
  -q, --quiet                                    identifiers only, one per line, for piping
  --account <ref>                                only this bank account (name or id)
  --since <date>                                 transactions on or after this date (YYYY-MM-DD)
  --until <date>                                 transactions on or before this date (YYYY-MM-DD)
  --unmatched                                    only transactions with no live match; shorthand for -s unmatched
  --direction <in|out>                           money in (positive amount) or out (negative amount)
  --type <debit|credit|fee|interest|adjustment>  transaction nature as the bank classified it (not its direction)
  -h, --help                                     display help for command
```

#### `mnemosine bank transaction show` (alias: ver)

```
Usage: mnemosine bank transaction show|ver [options] <id>

Show one transaction: the normalized line, the statement it came from and the
live matches that explain it

Arguments:
  id                                       transaction id

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --raw                                    include raw_data exactly as the bank published it; it can carry the counterparty in the clear
  -h, --help                               display help for command
```

### `mnemosine bank book-item` (alias: partida-libros)

```
Usage: mnemosine bank book-item|partida-libros [options] [command]

The other side: posted journal lines against the bank GL account, still unsealed

Options:
  -h, --help                       display help for command

Commands:
  list|listar [options] <account>  List posted journal lines against the bank GL
                                   account that are still unsealed, oldest
                                   first, with their age
  help [command]                   display help for command
```

#### `mnemosine bank book-item list` (alias: listar)

```
Usage: mnemosine bank book-item list|listar [options] <account>

List posted journal lines against the bank GL account that are still unsealed,
oldest first, with their age

Arguments:
  account                                  bank account whose GL account the entries were posted to (name or id)

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
  --since <date>                           entries on or after this entry date (YYYY-MM-DD)
  --until <date>                           entries on or before this entry date (YYYY-MM-DD)
  --over-days <n>                          only what has gone MORE than this many days without showing up at the bank
  -h, --help                               display help for command
```

### `mnemosine bank match` (alias: cotejo)

```
Usage: mnemosine bank match|cotejo [options] [command]

Matching a bank transaction to what the books already say about it

Options:
  -h, --help                               display help for command

Commands:
  preview|previsualizar [options] [tx-id]  Show what the engine would propose, with the score broken into its signals and every gate’s verdict, WITHOUT applying anything
  run|ejecutar [options]                   Run the engine over one account and period, applying ONLY what clears the confidence threshold, the amount floor, an open period and an exact-amount hard signal
  apply|aplicar [options] [id...]          Apply the engine’s proposal for the named transactions in ONE transaction, idempotently, linked to the session
  create|crear [options]                   Build an explicit match group of N bank transactions against M book items plus adjustments, requiring Σbank = Σbooks + Σadjustments
  unapply|desaplicar [options] <match-id>  Undo a match with a typed reason, releasing the book-item seal; refuses if the session is already approved or posted, and touches no posted journal entry
  help [command]                           display help for command
```

#### `mnemosine bank match preview` (alias: previsualizar)

```
Usage: mnemosine bank match preview|previsualizar [options] [tx-id]

Show what the engine would propose, with the score broken into its signals and
every gate’s verdict, WITHOUT applying anything

Arguments:
  tx-id                                    one transaction; without it, every unmatched one of --account

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --account <ref>                          bank account to sweep when no transaction id is given
  --since <date>                           transactions on or after this date (YYYY-MM-DD)
  --until <date>                           transactions on or before this date (YYYY-MM-DD)
  --top <n>                                maximum TRANSACTIONS to preview (not candidates per transaction)
  --min-confidence <n>                     engine confidence a proposal needs before `run` would apply it (0..1)
  --max-amount <amount>                    ceiling for an automatic match; the hard floor still wins
  --rules-only                             a proposal outside the date window counts as not applicable
  -h, --help                               display help for command
```

#### `mnemosine bank match run` (alias: ejecutar)

```
Usage: mnemosine bank match run|ejecutar [options]

Run the engine over one account and period, applying ONLY what clears the
confidence threshold, the amount floor, an open period and an exact-amount hard
signal

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --account <ref>          bank account to sweep (name or id)
  --since <date>           transactions on or after this date (YYYY-MM-DD)
  --until <date>           transactions on or before this date (YYYY-MM-DD)
  --min-confidence <n>     engine confidence a proposal needs to be applied
                           (0..1)
  --max-amount <amount>    ceiling for an automatic match; the hard floor still
                           wins
  --rules-only             refuse a proposal outside the date window
  --top <n>                maximum transactions to evaluate in this run
  --session <id>           reconciliation session these matches belong to
  --dry-run                do the whole thing and roll it back
  --json                   JSON output
  -h, --help               display help for command
```

#### `mnemosine bank match apply` (alias: aplicar)

```
Usage: mnemosine bank match apply|aplicar [options] [id...]

Apply the engine’s proposal for the named transactions in ONE transaction,
idempotently, linked to the session

Arguments:
  id                       bank transaction ids; or feed them through --stdin

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --stdin                  read the ids from standard input, whitespace
                           separated
  --session <id>           reconciliation session these matches belong to
  --dry-run                do the whole thing and roll it back
  -y, --yes                skip the grouped confirmation
  --json                   JSON output
  -h, --help               display help for command
```

#### `mnemosine bank match create` (alias: crear)

```
Usage: mnemosine bank match create|crear [options]

Build an explicit match group of N bank transactions against M book items plus
adjustments, requiring Σbank = Σbooks + Σadjustments

Options:
  -e, --entity <idOrName>        legal entity to operate on (defaults to the
                                 active one)
  -t, --tenant <id>              tenant (firm) whose data to scope to
  -u, --user <email>             acting user, for attribution and permissions
  --account <ref>                bank account the whole group belongs to (name
                                 or id)
  --transaction <ids>            comma-separated bank transaction ids: the bank
                                 side
  --book-item <ids>              comma-separated book side: <id> for a journal
                                 line, or <type>:<id> (journal_entry_line,
                                 invoice, bill, customer_payment,
                                 vendor_payment)
  --adjust <concept=amount>      declared adjustment (bank fee, FX difference);
                                 repeatable (default: [])
  --residual <keep|write-off>    what happens to what is left over: keep it
                                 live, or write it off against an account
  --write-off-account <account>  GL account the residual is written off against
  --session <id>                 reconciliation session this group belongs to
  --dry-run                      do the whole thing and roll it back
  --json                         JSON output
  -h, --help                     display help for command
```

#### `mnemosine bank match unapply` (alias: desaplicar)

```
Usage: mnemosine bank match unapply|desaplicar [options] <match-id>

Undo a match with a typed reason, releasing the book-item seal; refuses if the
session is already approved or posted, and touches no posted journal entry

Arguments:
  match-id                 the match to undo; its whole group goes with it

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --reason <code>          typed reason, required: cotejo-erroneo |
                           monto-incorrecto | duplicado | movimiento-reversado |
                           documento-cancelado | reclasificacion |
                           error-de-captura
  --dry-run                do the whole thing and roll it back
  -y, --yes                skip the confirmation
  --json                   JSON output
  -h, --help               display help for command
```

## `mnemosine backup` (alias: respaldo)

```
Usage: mnemosine backup|respaldo [options] [command]

Logical backups of the whole installation (create, list, verify by rehearsing
the restore, restore) and per-tenant logical exports (export)

Options:
  -h, --help                          display help for command

Commands:
  create|crear [options]              Take a logical dump of the WHOLE
                                      installation with its schema-version
                                      manifest
  export|exportar [options]           Logical EXPORT of ONE tenant (or one
                                      entity): consistent, scoped by the
                                      database's own RLS, with a manifest. NOT a
                                      restorable backup
  list|listar [options]               List known backups and exports with their
                                      date, scope, size, schema version and
                                      whether their hash still matches
  verify|comprobar [options] <file>   Verify a backup against its manifest; with
                                      --restore, rehearse the restore and run
                                      the ledger checks
  restore|restaurar [options] <file>  Restore a backup into a NEW database;
                                      never over an existing one
  help [command]                      display help for command
```

### `mnemosine backup create` (alias: crear)

```
Usage: mnemosine backup create|crear [options]

Take a logical dump of the WHOLE installation with its schema-version manifest

Options:
  -t, --tenant <id>        NOT here: this dump is not scoped. A per-tenant
                           archive is `mnemosine backup export --tenant <id>`
  -e, --entity <idOrName>  NOT here: a per-entity archive is `mnemosine backup
                           export --entity <idOrName>`
  --target <dir>           directory to write into (default: ./respaldos)
  --json                   JSON output
  -h, --help               display help for command
```

### `mnemosine backup export` (alias: exportar)

```
Usage: mnemosine backup export|exportar [options]

Logical EXPORT of ONE tenant (or one entity): consistent, scoped by the
database's own RLS, with a manifest. NOT a restorable backup

Options:
  -t, --tenant <id>        tenant (firm) to export (defaults to --tenant /
                           MNEMOSINE_TENANT)
  -e, --entity <idOrName>  narrow it further to one legal entity of that tenant
  --target <dir>           directory to write into (default: ./respaldos)
  --json                   JSON output
  -h, --help               display help for command
```

### `mnemosine backup list` (alias: listar)

```
Usage: mnemosine backup list|listar [options]

List known backups and exports with their date, scope, size, schema version and
whether their hash still matches

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
  --target <dir>                           directory to read (default: ./respaldos)
  -h, --help                               display help for command
```

### `mnemosine backup verify` (alias: comprobar)

```
Usage: mnemosine backup verify|comprobar [options] <file>

Verify a backup against its manifest; with --restore, rehearse the restore and
run the ledger checks

Arguments:
  file                                     backup file to verify

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --restore                                RESTORE it into a throwaway database and run the ledger checks (the only real proof)
  --strict                                 exit 4 on warnings too
  -h, --help                               display help for command
```

### `mnemosine backup restore` (alias: restaurar)

```
Usage: mnemosine backup restore|restaurar [options] <file>

Restore a backup into a NEW database; never over an existing one

Arguments:
  file                     backup file to restore

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --target <database>      name of the NEW database to create and restore into
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command
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

Examples:
  # The activity of July 2026, by account, with the footing.
  mnemosine report trial-balance show --period 2026-07
  # Cumulative to a cutoff date, rolled up to two levels, zero balances omitted.
  mnemosine report trial-balance show --as-of 2026-07-31 --level 2 --exclude-zero
  # The same figures as CSV, to hand over with the close.
  mnemosine report trial-balance show --period 2026-07 --format csv --output balanza-2026-07.csv
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

Examples:
  # Assets, liabilities and equity at the cutoff date, in natural sign.
  mnemosine report balance-sheet show --as-of 2026-07-31
  # At the end of a fiscal period, as JSON.
  mnemosine report balance-sheet show --period 2026-07 --json
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

Examples:
  # Revenue, expenses and net income for one month.
  mnemosine report income-statement show --period 2026-07
  # The first half of the year, as markdown for the board pack.
  mnemosine report income-statement show --since 2026-01-01 --until 2026-06-30 --format md
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

Examples:
  # Every posted movement of the peso bank account during July 2026.
  mnemosine report general-ledger show --account 1111 --period 2026-07
  # The receivables control account over a date range, as CSV.
  mnemosine report general-ledger show --account 1120 --since 2026-07-01 --until 2026-07-31 --format csv
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

Examples:
  # What customers owe, bucketed by age, as of today.
  mnemosine report aged-receivable show
  # As of the close date, as CSV for the AR working paper.
  mnemosine report aged-receivable show --as-of 2026-07-31 --format csv
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

Examples:
  # What we owe vendors, bucketed by age, as of today.
  mnemosine report aged-payable show
  # As of the close date, as CSV for the AP working paper.
  mnemosine report aged-payable show --as-of 2026-07-31 --format csv
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

Examples:
  # Whether each reporting view still agrees with the ledger, and by how much.
  mnemosine report view show
  # As JSON, to gate a pipeline on the drift.
  mnemosine report view show --json
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

Examples:
  # Rebuild every reporting view from the ledger. It is firm-wide, not per entity.
  mnemosine report view sync
  # Only the trial balance view, with an exclusive lock — needed the first time.
  mnemosine report view sync --view mv_trial_balance --no-concurrently
```

## `mnemosine ledger` (alias: mayor)

```
Usage: mnemosine ledger|mayor [options] [command]

The general ledger itself: integrity checks, stale drafts, auxiliaries and
balances

Options:
  -h, --help                  display help for command

Commands:
  check|verificar [options]   Named ledger checks; with no flag runs the
                              blocking ones and exits 4 on findings
  stale-draft|borrador-viejo  Draft journal entries that have sat unposted too
                              long
  auxiliary|auxiliar          Account auxiliary: beginning balance, movements,
                              ending — the SAT XC shape
  balance|saldo               One account balance decomposed by period, with the
                              period status
  help [command]              display help for command
```

### `mnemosine ledger check` (alias: verificar)

```
Usage: mnemosine ledger check|verificar [options]

Named ledger checks; with no flag runs the blocking ones and exits 4 on findings

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --strict                                 treat warnings as blocking (exit 4)
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --check <names>                          checks to run, comma-separated (available: balance, audit-trail, continuity; empty lists them)
  --account <code>                         scope the balance check to one account
  --period <name>                          scope the balance check to one fiscal period
  -h, --help                               display help for command

Examples:
  # The blocking checks; exit 4 if anything is found.
  mnemosine ledger check
  # One named check, scoped to a single account and period.
  mnemosine ledger check --check balance --account 1120 --period "July 2026"
  # Every check, with warnings blocking too.
  mnemosine ledger check --check balance,audit-trail,continuity --strict
```

### `mnemosine ledger stale-draft` (alias: borrador-viejo)

```
Usage: mnemosine ledger stale-draft|borrador-viejo [options] [command]

Draft journal entries that have sat unposted too long

Options:
  -h, --help             display help for command

Commands:
  list|listar [options]  Drafts older than N days — the number-one blocker of
                         every close checklist
  help [command]         display help for command
```

#### `mnemosine ledger stale-draft list` (alias: listar)

```
Usage: mnemosine ledger stale-draft list|listar [options]

Drafts older than N days — the number-one blocker of every close checklist

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
  --days <n>                               minimum age in days (default: "30")
  --period <name>                          only drafts dated into this fiscal period
  -h, --help                               display help for command

Examples:
  # Drafts sitting unposted for more than 30 days.
  mnemosine ledger stale-draft list
  # Older than a week and dated into one period, as CSV.
  mnemosine ledger stale-draft list --days 7 --period "July 2026" --format csv
```

### `mnemosine ledger auxiliary` (alias: auxiliar)

```
Usage: mnemosine ledger auxiliary|auxiliar [options] [command]

Account auxiliary: beginning balance, movements, ending — the SAT XC shape

Options:
  -h, --help          display help for command

Commands:
  show|ver [options]  One account, one period: beginning → every movement →
                      ending
  help [command]      display help for command
```

#### `mnemosine ledger auxiliary show` (alias: ver)

```
Usage: mnemosine ledger auxiliary show|ver [options]

One account, one period: beginning → every movement → ending

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
  --account <code>                         account code
  --period <name>                          fiscal period name (or unambiguous fragment)
  -h, --help                               display help for command

Examples:
  # One account, one period: beginning balance, every movement, ending balance.
  mnemosine ledger auxiliary show --account 1120 --period "July 2026"
  # The payables account in the same shape, as CSV for the auditor.
  mnemosine ledger auxiliary show --account 2110 --period "July 2026" --format csv
```

### `mnemosine ledger balance` (alias: saldo)

```
Usage: mnemosine ledger balance|saldo [options] [command]

One account balance decomposed by period, with the period status

Options:
  -h, --help          display help for command

Commands:
  show|ver [options]  Beginning, debits, credits and ending per period for one
                      account
  help [command]      display help for command
```

#### `mnemosine ledger balance show` (alias: ver)

```
Usage: mnemosine ledger balance show|ver [options]

Beginning, debits, credits and ending per period for one account

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --account <code>                         account code or id
  --as-of <date>                           only the period containing this date (YYYY-MM-DD)
  --period <name>                          only the periods whose name matches
  --dim <name>                             per-dimension breakdown (not available: the dimension family does not exist yet)
  -h, --help                               display help for command

Examples:
  # One account decomposed by period, with each period's status.
  mnemosine ledger balance show --account 1111
  # Only the period that contains a date.
  mnemosine ledger balance show --account 1111 --as-of 2026-07-31
```

## `mnemosine cfdi`

```
Usage: mnemosine cfdi [options] [command]

The CFDI mirror: list, inspect, SAT status and the classifier trail

Options:
  -h, --help                         display help for command

Commands:
  list|listar [options]              The mirror, filtered by direction, type,
                                     status and date
  show|ver [options] <uuid>          One CFDI: header, lines, taxes and SAT
                                     status; --format xml prints the exact bytes
  status|estatus                     SAT status of the mirror (public
                                     ConsultaCFDIService; no e.firma involved)
  explain|explicar [options] <uuid>  WHY it was recorded the way it was: case,
                                     facts and decisions the classifier left
  help [command]                     display help for command
```

### `mnemosine cfdi list` (alias: listar)

```
Usage: mnemosine cfdi list|listar [options]

The mirror, filtered by direction, type, status and date

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
  --direction <d>                          emitido, recibido o ajeno (derivada contra el RFC de la entidad)
  --type <t>                               document_type (cfdi_ingreso, cfdi_egreso, cfdi_pago…)
  -h, --help                               display help for command

Examples:
  # Everything this entity issued during July 2026.
  mnemosine cfdi list --direction emitido --since 2026-07-01 --until 2026-07-31
  # Received payment receipts (REP) only, as CSV.
  mnemosine cfdi list --direction recibido --type cfdi_pago --format csv
```

### `mnemosine cfdi show` (alias: ver)

```
Usage: mnemosine cfdi show|ver [options] <uuid>

One CFDI: header, lines, taxes and SAT status; --format xml prints the exact
bytes

Arguments:
  uuid                                     CFDI UUID (timbre fiscal)

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

Examples:
  # Header, lines, taxes and the SAT status held in the mirror.
  mnemosine cfdi show 3F2504E0-4F89-11D3-9A0C-0305E82C3301
  # The exact bytes as they arrived, to verify the seal outside this system.
  mnemosine cfdi show 3F2504E0-4F89-11D3-9A0C-0305E82C3301 --format xml
```

### `mnemosine cfdi status` (alias: estatus)

```
Usage: mnemosine cfdi status|estatus [options] [command]

SAT status of the mirror (public ConsultaCFDIService; no e.firma involved)

Options:
  -h, --help                  display help for command

Commands:
  show|ver [options] <uuid>   Estado, EsCancelable and EstatusCancelacion as the
                              SAT last answered
  sync|sincronizar [options]  Re-check the whole mirror against the SAT: stale
                              or never-consulted first
  help [command]              display help for command
```

#### `mnemosine cfdi status show` (alias: ver)

```
Usage: mnemosine cfdi status show|ver [options] <uuid>

Estado, EsCancelable and EstatusCancelacion as the SAT last answered

Arguments:
  uuid                                     CFDI UUID

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --refresh                                consulta al SAT ahora y actualiza la caché sat_* del documento
  -h, --help                               display help for command

Examples:
  # What the SAT last answered about this CFDI, from the cache.
  mnemosine cfdi status show 3F2504E0-4F89-11D3-9A0C-0305E82C3301
  # Ask the SAT now and update the cache with the answer.
  mnemosine cfdi status show 3F2504E0-4F89-11D3-9A0C-0305E82C3301 --refresh
```

#### `mnemosine cfdi status sync` (alias: sincronizar)

```
Usage: mnemosine cfdi status sync|sincronizar [options]

Re-check the whole mirror against the SAT: stale or never-consulted first

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  -n, --limit <n>          maximum CFDIs to consult in this run (default: "100")
  --stale-hours <h>        a consultation older than this is stale (default:
                           "24")
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  --live                   perform the real external effect (default is the
                           sandbox endpoint)
  -h, --help               display help for command

Examples:
  # Which CFDIs would be consulted, calling nothing at all.
  mnemosine cfdi status sync --dry-run
  # Really consult the SAT for the 50 stalest; --live is what leaves the sandbox.
  mnemosine cfdi status sync --limit 50 --stale-hours 24 --live --yes
```

### `mnemosine cfdi explain` (alias: explicar)

```
Usage: mnemosine cfdi explain|explicar [options] <uuid>

WHY it was recorded the way it was: case, facts and decisions the classifier
left

Arguments:
  uuid                                     CFDI UUID

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

Examples:
  # Why the classifier recorded it the way it did: case, facts and decisions.
  mnemosine cfdi explain 3F2504E0-4F89-11D3-9A0C-0305E82C3301
  # The same, as JSON, to attach to the working paper.
  mnemosine cfdi explain 3F2504E0-4F89-11D3-9A0C-0305E82C3301 --json
```

## `mnemosine rep`

```
Usage: mnemosine rep [options] [command]

Payment receipts (REP): what is missing one, and the parked ones to retry

Options:
  -h, --help                     display help for command

Commands:
  missing|faltante               Payments and collections whose REP has not
                                 arrived or been issued
  reconcile|conciliar [options]  Retry the parked REPs (needs_review): safe to
                                 repeat, resolved nodes are skipped
  help [command]                 display help for command
```

### `mnemosine rep missing` (alias: faltante)

```
Usage: mnemosine rep missing|faltante [options] [command]

Payments and collections whose REP has not arrived or been issued

Options:
  -h, --help             display help for command

Commands:
  list|listar [options]  received: paid PPD bills without the supplier REP (VAT
                         parked); issued: our collections without a REP
  help [command]         display help for command
```

#### `mnemosine rep missing list` (alias: listar)

```
Usage: mnemosine rep missing list|listar [options]

received: paid PPD bills without the supplier REP (VAT parked); issued: our
collections without a REP

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
  --direction <d>                          received (default) or issued (default: "received")
  --min-amount <n>                         only payments at or above this amount
  -h, --help                               display help for command
```

### `mnemosine rep reconcile` (alias: conciliar)

```
Usage: mnemosine rep reconcile|conciliar [options]

Retry the parked REPs (needs_review): safe to repeat, resolved nodes are skipped

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  -n, --limit <n>          maximum parked REPs to retry (default: "50")
  --dry-run                list what would be retried, retry nothing
  -h, --help               display help for command
```

## `mnemosine ai` (alias: ia)

```
Usage: mnemosine ai|ia [options] [command]

Métricas y calibración del agente contable

Options:
  -h, --help                    display help for command

Commands:
  stats|estadisticas [options]  Aprobación por bucket de confianza, delta
                                confianza-vs-realidad, costo y eventos
  help [command]                display help for command
```

### `mnemosine ai stats` (alias: estadisticas)

```
Usage: mnemosine ai stats|estadisticas [options]

Aprobación por bucket de confianza, delta confianza-vs-realidad, costo y eventos

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
                             this from cron/launchd; --live enables the external
                             reads)
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

Tick entry point: claim and run every due job (call this from cron/launchd;
--live enables the external reads)

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -t, --tenant <id>        Tenant
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
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
  --period <name>          Period to close (default: the oldest open one)
  -l, --list               List closable periods and exit
  --check                  Only check readiness, never close
  --hard                   Hard close (irreversible) instead of soft close
  --reason <text>          why this close happens now; recorded in the audit
                           trail
  --json                   JSON output for scripts
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # What is still missing before the oldest open period can be closed.
  mnemosine close --check
  # The periods that can be closed right now, and nothing else.
  mnemosine close --list
  # Soft-close one month, by the name the calendar gave it.
  mnemosine close --period "July 2026" --reason "Cierre mensual de julio"
  # Hard close posts the closing entries and carries balances forward: see it first.
  mnemosine close --period "December 2026" --hard --reason "Cierre anual 2026" --dry-run
```

## `mnemosine completion` (alias: completado)

```
Usage: mnemosine completion|completado [options] [shell]

Print a shell completion script (bash, zsh) on stdout

Arguments:
  shell       Shell to generate for: bash or zsh

Options:
  -h, --help  display help for command

Examples:
  mnemosine completion bash > /usr/local/etc/bash_completion.d/mnemosine
  mnemosine completion zsh > "${fpath[1]}/_mnemosine"

The script is generated from the installed command tree, so it covers
the Spanish aliases too. Regenerate it after every upgrade.
```

