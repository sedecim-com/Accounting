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
  asset|activo                          Fixed asset register: the ledger of what
                                        the company owns and depreciates
  depreciation|depreciacion             The monthly depreciation run: compute
                                        it, look at it, then post it
  batch|lote                            Staged entry batches: list, inspect,
                                        check, post transactionally and reverse
                                        as a unit
  closing|cierre-proceso                The close as a process: its read-only
                                        surface — readiness, named checks,
                                        offenders
  fx|cambio                             Exchange rates: the origin every
                                        foreign-currency amount converts from
  prepaid|pago-anticipado               Prepaid expenses: the schedule that
                                        takes them out of 1160, month by month
  cashflow|flujo                        Statement of cash flows (NIF B-2 / ASC
                                        230): build it, and tie it to real cash
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
                           anticipo_proveedores, banco, comision_bancaria, cxc…
                           (see role list)
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
  -h, --help                       display help for command

Commands:
  list|listar [options]            List every period with its state, dates and
                                   overdue mark
  show|ver [options] <name>        Show a period: state, who closed it, the
                                   checklist it closed with, its entries
  open|abrir [options] <name>      Open a future period so work can be captured
                                   in it
  reopen|reabrir [options] <name>  Reopen a closed period so a correction can
                                   land in the month it belongs to
  help [command]                   display help for command
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

### `mnemosine period reopen` (alias: reabrir)

```
Usage: mnemosine period reopen|reabrir [options] <name>

Reopen a closed period so a correction can land in the month it belongs to

Arguments:
  name                     period name, YYYY-MM, or id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --force                  override a blocking validation (closed period, lock
                           date, duplicate); requires --reason
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command

Examples:
  # Reopen a soft-closed month so a correction lands in the month it belongs to.
  # --reason is required, and the audit trail keeps who, why and the previous state.
  mnemosine period reopen "July 2026" --reason "Llego un CFDI de CFE con fecha de julio"
  # See the transition first: nothing is written and nothing is recorded.
  mnemosine period reopen 2026-07 --dry-run
  # A hard-closed month keeps its closing entries and its carry-forward when it
  # reopens, so it also takes --force. A 'locked' month never reopens, not even
  # with it: the information already left the system.
  mnemosine period reopen "December 2026" --force --reason "Ajuste pedido por el auditor externo"
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
  -h, --help                              display help for command

Commands:
  account|cuenta                          Bank accounts as master data: identifiers, currency and the 1:1 GL mapping
  statement|estado-cuenta                 Bank statements as documents: import, inspect and check their integrity
  transaction|movimiento                  Bank transactions: what the bank says happened, before anyone explains it
  book-item|partida-libros                The other side: posted journal lines against the bank GL account, still unsealed
  match|cotejo                            Matching a bank transaction to what the books already say about it
  reconciliation|conciliacion             The reconciliation session: the two-sided arithmetic that makes `balanced` mean something
  reconciling-item|partida-conciliatoria  Reconciling items as rows: what explains the difference, with age, owner, due date and escalation
  adjustment|ajuste                       The fees, VAT, interest and withholdings a reconciliation uncovers, created as DRAFTS
  fee|comision                            Bank fees as an accounting act: the charge as an expense and its VAT parked until the bank issues the CFDI
  interest|interes                        Interest earned on bank balances: income at its GROSS amount and the tax the bank withheld as a prepayment in the entity’s favour
  check|cheque                            Paper checks as a fiscal fact: when the bank actually paid one, which under the VAT law is when the payment counts
  help [command]                          display help for command
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

Examples:
  # The peso operating account, mapped 1:1 to the cash account of the chart.
  # The CLABE is 18 digits and its check digit is verified before anything is written.
  mnemosine bank account create "BBVA Operativa MXN" --bank "BBVA Mexico" --gl-account 1111 --currency MXN --clabe 012180001234567899
  # A second peso account on its own GL account. --currency is re-checked
  # against the GL account, so a mismatch is refused and never converted.
  # OJO, medido: el catalogo siembra 1112 «Banco Nacional - USD» SIN
  # currency_code, y COALESCE(a.currency_code, le.functional_currency) la
  # resuelve como MXN. Un ejemplo con --currency USD sobre 1112 parsea y el
  # servicio lo RECHAZA. Hasta que la siembra le ponga su moneda, aqui no se
  # escribe una cuenta en dolares: un ejemplo copiable que no corre es peor
  # que ninguno.
  mnemosine bank account create "Santander Operativa MXN" --bank "Santander Mexico" --gl-account 1115 --currency MXN --clabe 014180011223344558
  # A company card is a LIABILITY and maps to a liability account. --dry-run
  # runs the real insert, unique 1:1 index included, and rolls it back.
  mnemosine bank account create "Banorte Empresarial" --bank "Banorte" --gl-account 2110 --currency MXN --type credit-card --dry-run
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

Examples:
  # Every account of the active entity, with its GL mapping and both balances.
  mnemosine bank account list
  # Only the dollar ones, as JSON.
  mnemosine bank account list --currency USD --json
  # Every entity of the firm at once; the tenant bound stays inside the SQL.
  mnemosine bank account list --all-entities --format csv
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

Examples:
  # One account: masked identifiers, SAT bank key and the reconciliation anchor.
  mnemosine bank account show "BBVA Operativa MXN"
  # For a screen somebody else can see: not even the last four digits.
  mnemosine bank account show "BBVA Operativa MXN" --redacted
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

Examples:
  # Rename it and record the branch: nothing sensitive changes here.
  mnemosine bank account edit "BBVA Operativa MXN" --name "BBVA Operativa Principal" --branch "Polanco"
  # The CLABE is the identifier the money leaves by, so --reason is required,
  # the before and after land MASKED in the append-only audit trail, and it
  # asks before writing. -y skips the question, never the reason.
  mnemosine bank account edit "BBVA Operativa MXN" --clabe 012180001234567899 --reason "Cambio de CLABE notificado por el banco el 2026-07-01"
  # An empty value CLEARS the field; omitting the flag leaves it alone.
  mnemosine bank account edit "Santander Operativa MXN" --swift ""
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

Examples:
  # Point the account at the GL account it really is; refused when the old one
  # already carries posted entries.
  mnemosine bank account set "BBVA Operativa MXN" --gl-account 1111
  # Remap over an account that DOES have posted entries: --force, and --force
  # is what makes --reason mandatory.
  mnemosine bank account set "Santander Operativa MXN" --gl-account 1115 --force --reason "El mayor quedo mal asignado en la migracion de abril"
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

Examples:
  # A CAMT.053 the bank publishes: the format is sniffed and both balances come
  # inside it. Re-importing the same file adds nothing, because the dedupe is by
  # the content hash a trigger computes and not by an id the bank may not publish.
  mnemosine bank statement import ./extractos/bbva-2026-07.xml --account "BBVA Operativa MXN"
  # A CSV carries no closing balance: assert it. If the file does carry one and
  # they differ the import is refused, which is what catches a truncated download.
  mnemosine bank statement import ./extractos/santander-2026-07.csv --account "Santander Operativa MXN" --format csv --profile santander-mx --closing-balance 184320.55
  # A whole folder, parsed and run through the seven checks, writing nothing.
  mnemosine bank statement import ./extractos/julio/bbva-01.csv --dir ./extractos/julio --account "BBVA Operativa MXN" --dry-run
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

Examples:
  # Every statement imported for one account, with opening and closing balance.
  mnemosine bank statement list --account "BBVA Operativa MXN"
  # The third quarter across every account, as CSV for the audit file.
  mnemosine bank statement list --since 2026-07-01 --until 2026-09-30 --format csv
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

Examples:
  # The document: sequence number, date range, hash of the file and the profile used.
  mnemosine bank statement show 9d3f1c26-5a4b-4f77-9c1e-2b7d84a6e510
  # With its lines, capped so a four-thousand-line statement does not fill the screen.
  mnemosine bank statement show 9d3f1c26-5a4b-4f77-9c1e-2b7d84a6e510 --lines --limit 200
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

Examples:
  # Bare --check lists the seven checks and touches no database.
  mnemosine bank statement check --check
  # The latest statement of every account; exit 4 NAMES the check that broke.
  mnemosine bank statement check
  # One statement, balance chain only, with warnings blocking as well.
  mnemosine bank statement check 9d3f1c26-5a4b-4f77-9c1e-2b7d84a6e510 --check cadena-de-saldos --strict
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

Examples:
  # What the bank says happened in July and nobody has explained yet.
  mnemosine bank transaction list --account "BBVA Operativa MXN" --since 2026-07-01 --until 2026-07-31 --unmatched
  # hledger-style terms in one quoted argument: a bare word searches the
  # description, amt: compares the amount. Money out, over 10,000.
  mnemosine bank transaction list "desc:CFE amt:>10000" --direction out --account "BBVA Operativa MXN"
  # Only what the BANK classified as a fee, which is its nature and not its direction.
  mnemosine bank transaction list --type fee --account "BBVA Operativa MXN" --json
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

Examples:
  # One movement, the statement it came from and the live matches that explain it.
  mnemosine bank transaction show 4c8e21b7-0f53-4a19-9d62-71ea3c05b8d4
  # With raw_data exactly as the bank published it: it can carry the
  # counterparty in the clear, so it is opt-in.
  mnemosine bank transaction show 4c8e21b7-0f53-4a19-9d62-71ea3c05b8d4 --raw
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

Examples:
  # What the books say went through the bank and the bank has not shown yet,
  # oldest first. The argument is the BANK account, not its GL code.
  mnemosine bank book-item list "BBVA Operativa MXN"
  # Only what has been waiting more than 30 days: the outstanding-check candidates.
  mnemosine bank book-item list "BBVA Operativa MXN" --over-days 30 --format csv
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

Examples:
  # What the engine would propose for one movement, signal by signal and gate
  # by gate, applying nothing.
  mnemosine bank match preview 4c8e21b7-0f53-4a19-9d62-71ea3c05b8d4
  # Sweep July with the SAME gates run would use. Write them identically or the
  # preview stops predicting what the write will do.
  mnemosine bank match preview --account "BBVA Operativa MXN" --since 2026-07-01 --until 2026-07-31 --min-confidence 0.9 --max-amount 50000
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

Examples:
  # Apply only what clears every gate. A proposal decided by description
  # similarity alone is never applied, however high it scores.
  mnemosine bank match run --account "BBVA Operativa MXN" --since 2026-07-01 --until 2026-07-31 --min-confidence 0.9
  # The same run, rolled back, to read what it would seal before sealing it.
  mnemosine bank match run --account "BBVA Operativa MXN" --since 2026-07-01 --until 2026-07-31 --dry-run
  # Tie the matches to the open session so the arithmetic of the month counts them.
  mnemosine bank match run --account "BBVA Operativa MXN" --session 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --max-amount 25000
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

Examples:
  # Apply the engine proposal for two movements, in ONE database transaction.
  mnemosine bank match apply 4c8e21b7-0f53-4a19-9d62-71ea3c05b8d4 7a1d09f4-6b28-4c31-8e05-9f42d7c1a63b
  # The whole effect, rolled back.
  mnemosine bank match apply 4c8e21b7-0f53-4a19-9d62-71ea3c05b8d4 --dry-run
  # Ids from a file: --stdin eats standard input, so no TTY is left to ask on
  # and the confirmation has to be given by name with -y.
  mnemosine bank match apply --stdin -y < movimientos-julio.txt
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

Examples:
  # One deposit that settles two invoices. The group is refused unless
  # the bank side, the book side and the adjustments add up to each other.
  mnemosine bank match create --account "BBVA Operativa MXN" --transaction 4c8e21b7-0f53-4a19-9d62-71ea3c05b8d4 --book-item invoice:2e6c94b1-7d05-4f83-a219-64bd8c30f7a5,invoice:3d91e7a5-24bf-4c68-9013-8ad5f6207e4c
  # A short payment: the wire fee the bank kept is DECLARED as an adjustment and
  # written off. Declaring it is not posting it: no journal entry is created here.
  mnemosine bank match create --account "BBVA Operativa MXN" --transaction 7a1d09f4-6b28-4c31-8e05-9f42d7c1a63b --book-item 2e6c94b1-7d05-4f83-a219-64bd8c30f7a5 --adjust "comision por transferencia=-35.00" --residual write-off --write-off-account 6310
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

Examples:
  # Undo a match with its typed reason: the whole group goes with it and the
  # book-item seal is released. It refuses once the session is approved or posted.
  mnemosine bank match unapply 1f8b47c9-90d2-4e35-b6a1-c73f025d8e91 --reason cotejo-erroneo
  # A movement the bank published twice, without the confirmation prompt.
  mnemosine bank match unapply 1f8b47c9-90d2-4e35-b6a1-c73f025d8e91 --reason duplicado -y
```

### `mnemosine bank reconciliation` (alias: conciliacion)

```
Usage: mnemosine bank reconciliation|conciliacion [options] [command]

The reconciliation session: the two-sided arithmetic that makes `balanced` mean
something

Options:
  -h, --help                             display help for command

Commands:
  run|ejecutar [options] <account>       Guided monthly pass over one account: statement, matching engine, session and reconciling items; it ALWAYS stops before approve and post, and prints what is missing
  open|abrir [options] <account>         Open the period session, asserting the opening balance equals the previous session closing and refusing date gaps and overlaps
  list|listar [options]                  List sessions by account, state and period, with the FROZEN variance and how many items are still open
  status|estado [options] [session]      Recompute the variance LIVE and print the two-sided breakdown: bank balance, its items one by one, adjusted; books balance, its items, adjusted; and the difference
  close|cerrar [options] <session>       Recompute the whole arithmetic and move the session to `balanced` ONLY if the variance is exactly zero (or within the policy tolerance) and every item is classified and dated
  approve|aprobar [options] <session>    Sign the session, requiring that the approver is not the preparer, and freeze an immutable snapshot with a hash of its members and its balances
  post|contabilizar [options] <session>  Post the approved adjustment entries and seal the session’s book lines as reconciled, blocking their edit, their void and their date change
  generate|generar [options] <session>   Produce the two-sided bank reconciliation statement for the audit file: json for the whole document, md/csv/tsv for the line-by-line statement, plain text to print
  help [command]                         display help for command
```

#### `mnemosine bank reconciliation run` (alias: ejecutar)

```
Usage: mnemosine bank reconciliation run|ejecutar [options] <account>

Guided monthly pass over one account: statement, matching engine, session and
reconciling items; it ALWAYS stops before approve and post, and prints what is
missing

Arguments:
  account                                                       bank account to reconcile (name or id)

Options:
  -e, --entity <idOrName>                                       legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                                             tenant (firm) whose data to scope to
  -u, --user <email>                                            acting user, for attribution and permissions
  --note <text>                                                 free annotation stored with the record
  --period <yyyy-mm>                                            period to reconcile; or give --since and --until together
  --since <date>                                                first day of the period (YYYY-MM-DD)
  --until <date>                                                last day of the period (YYYY-MM-DD)
  --file <path>                                                 statement to import first; without it, the one already imported for the period is used
  --format <csv|camt053|mt940|ofx|qfx|mt942|camt054|bai2|xlsx>  format of the FILE given in --file (not of the output; use --json for that), as in `bank statement import`
  --profile <name>                                              CSV column profile to read --file with
  --min-confidence <n>                                          engine confidence a proposal needs to be applied (0..1)
  --max-amount <amount>                                         ceiling for an automatic match; the hard floor still wins
  --stop-at <extracto|cotejo|sesion|partidas|estado>            stop after this step; it never goes past `estado`, and never reaches approve or post
  --resume                                                      continue the session already open for this period instead of refusing
  --dry-run                                                     walk the real path and roll it back
  --json                                                        JSON output
  -h, --help                                                    display help for command

Examples:
  # The guided monthly pass over one account: statement, matching engine,
  # session and reconciling items. It ALWAYS stops before approve and post,
  # and prints what is still missing.
  mnemosine bank reconciliation run "BBVA Operativa MXN" --period 2026-07 --file ./extractos/bbva-2026-07.xml
  # Stop after the matching step to look before anything is opened, and roll back.
  mnemosine bank reconciliation run "BBVA Operativa MXN" --period 2026-07 --stop-at cotejo --dry-run
  # Continue the session already open for the period instead of refusing.
  mnemosine bank reconciliation run "BBVA Operativa MXN" --period 2026-07 --resume --min-confidence 0.9
```

#### `mnemosine bank reconciliation open` (alias: abrir)

```
Usage: mnemosine bank reconciliation open|abrir [options] <account>

Open the period session, asserting the opening balance equals the previous
session closing and refusing date gaps and overlaps

Arguments:
  account                     bank account to open the session on (name or id)

Options:
  -e, --entity <idOrName>     legal entity to operate on (defaults to the active
                              one)
  -t, --tenant <id>           tenant (firm) whose data to scope to
  -u, --user <email>          acting user, for attribution and permissions
  --note <text>               free annotation stored with the record
  --period <yyyy-mm>          period of the session; or give --since and --until
                              together
  --since <date>              first day of the period (YYYY-MM-DD)
  --until <date>              last day of the period (YYYY-MM-DD)
  --closing-balance <amount>  closing balance you assert; it is COMPARED against
                              the statement, never substituted for it
  --statement <id>            the statement to tie the session to, when the
                              period has more than one
  --dry-run                   do the whole thing and roll it back
  --json                      JSON output
  -h, --help                  display help for command

Examples:
  # Open July: the opening balance must equal the previous session closing, and
  # a gap or an overlap of dates is refused.
  mnemosine bank reconciliation open "BBVA Operativa MXN" --period 2026-07
  # Assert the closing balance you were given: it is COMPARED against the
  # statement, never substituted for it.
  mnemosine bank reconciliation open "BBVA Operativa MXN" --since 2026-07-01 --until 2026-07-31 --closing-balance 1284730.18
```

#### `mnemosine bank reconciliation list` (alias: listar)

```
Usage: mnemosine bank reconciliation list|listar [options]

List sessions by account, state and period, with the FROZEN variance and how
many items are still open

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
  --account <ref>                          only sessions of this bank account (name or id)
  --period <yyyy-mm>                       sessions that overlap this period
  --since <date>                           sessions ending on or after this date (YYYY-MM-DD)
  --until <date>                           sessions starting on or before this date (YYYY-MM-DD)
  --all-entities                           every entity of the tenant, for a firm's overview; still bounded inside the SQL
  -h, --help                               display help for command

Examples:
  # The sessions of one account with their FROZEN variance and open items.
  mnemosine bank reconciliation list --account "BBVA Operativa MXN"
  # The quarter, still open ones only. An EMPTY variance column means nobody
  # computed the arithmetic; it is never printed as a zero.
  mnemosine bank reconciliation list --since 2026-07-01 --until 2026-09-30 --status in_progress --format csv
```

#### `mnemosine bank reconciliation status` (alias: estado)

```
Usage: mnemosine bank reconciliation status|estado [options] [session]

Recompute the variance LIVE and print the two-sided breakdown: bank balance, its
items one by one, adjusted; books balance, its items, adjusted; and the
difference

Arguments:
  session                                  session id; without it, the one in progress for --account

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --account <ref>                          bank account whose in-progress session to read (name or id)
  --tolerance <amount>                     residual the close may absorb; only valid where the tolerance policy admits one
  -h, --help                               display help for command

Examples:
  # Recompute the variance LIVE and print both sides item by item. The frozen
  # column is shown apart and labelled: it is never the answer.
  mnemosine bank reconciliation status --account "BBVA Operativa MXN"
  # One session by id, as JSON, with the residual a close could absorb.
  mnemosine bank reconciliation status 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --tolerance 0.50 --json
```

#### `mnemosine bank reconciliation close` (alias: cerrar)

```
Usage: mnemosine bank reconciliation close|cerrar [options] <session>

Recompute the whole arithmetic and move the session to `balanced` ONLY if the
variance is exactly zero (or within the policy tolerance) and every item is
classified and dated

Arguments:
  session                  session to close

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --note <text>            free annotation stored with the record
  --tolerance <amount>     residual this close may absorb; refused unless the
                           tolerance policy admits one
  --dry-run                do the whole thing and roll it back
  -y, --yes                skip the confirmation
  --json                   JSON output
  -h, --help               display help for command

Examples:
  # Recompute the whole arithmetic and move the session to balanced ONLY if it
  # really balances. balanced is what the period-close checklist reads as the
  # evidence that this account was verified against the bank: it is not a word
  # that gets written, it is one that gets earned.
  mnemosine bank reconciliation close 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7
  # Read the arithmetic and roll it back, before answering the question it asks.
  mnemosine bank reconciliation close 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --dry-run
  # Absorb a residual of half a peso, only where the tolerance policy admits
  # one. The tolerance is stored with the session, so the signature later reads
  # the tolerance it was closed with and not today's.
  mnemosine bank reconciliation close 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --tolerance 0.50 --note "Diferencia de redondeo del extracto"
```

#### `mnemosine bank reconciliation approve` (alias: aprobar)

```
Usage: mnemosine bank reconciliation approve|aprobar [options] <session>

Sign the session, requiring that the approver is not the preparer, and freeze an
immutable snapshot with a hash of its members and its balances

Arguments:
  session                  balanced session to sign

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --reason <text>          why it is being signed; stored on the session and in
                           the audit trail
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # Sign the balanced session: the approver may not be the preparer, and the
  # snapshot freezes with a hash of its members and its balances.
  mnemosine bank reconciliation approve 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --reason "Revisada contra el estado de cuenta de julio"
  # A signature is not withdrawn: read what would be frozen before freezing it.
  mnemosine bank reconciliation approve 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --dry-run
```

#### `mnemosine bank reconciliation post` (alias: contabilizar)

```
Usage: mnemosine bank reconciliation post|contabilizar [options] <session>

Post the approved adjustment entries and seal the session’s book lines as
reconciled, blocking their edit, their void and their date change

Arguments:
  session                  approved session to post

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --note <text>            free annotation stored with the record
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # Post the adjustment entries the signature froze and seal the book lines
  # they produced. This is the only leaf of the family that moves the ledger.
  mnemosine bank reconciliation post 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7
  # Rehearsed: the real act runs and is rolled back, so what it prints is the
  # entry that would exist and not a description of it.
  mnemosine bank reconciliation post 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --dry-run
  # A retry with the same key and the same payload returns the RECORDED result
  # instead of posting a second time.
  mnemosine bank reconciliation post 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --idempotency-key conciliacion-bbva-2026-07
```

#### `mnemosine bank reconciliation generate` (alias: generar)

```
Usage: mnemosine bank reconciliation generate|generar [options] <session>

Produce the two-sided bank reconciliation statement for the audit file: json for
the whole document, md/csv/tsv for the line-by-line statement, plain text to
print

Arguments:
  session                                  session to write the statement for

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
  # The two-sided reconciliation statement for the audit file, as text to print.
  mnemosine bank reconciliation generate 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7
  # The whole document as json. There is no pdf and no xlsx: this leaf refuses
  # them by name instead of writing a file that would sit in an audit file
  # pretending to be one.
  mnemosine bank reconciliation generate 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --json --output conciliacion-bbva-2026-07.json
```

### `mnemosine bank reconciling-item` (alias: partida-conciliatoria)

```
Usage: mnemosine bank reconciling-item|partida-conciliatoria [options] [command]

Reconciling items as rows: what explains the difference, with age, owner, due
date and escalation

Options:
  -h, --help                                   display help for command

Commands:
  list|listar [options] <session>              List the typed reconciling items of a session — outstanding checks, deposits in transit, bank charges, errors — with age, owner, expected settlement date and escalation
  assign|asignar [options] <session> <item>    Give a reconciling item an owner, an expected settlement date and notes
  correct|corregir [options] <session> <item>  Say what a reconciling item really was, when the automatic proposal got it wrong
  help [command]                               display help for command
```

#### `mnemosine bank reconciling-item list` (alias: listar)

```
Usage: mnemosine bank reconciling-item list|listar [options] <session>

List the typed reconciling items of a session — outstanding checks, deposits in
transit, bank charges, errors — with age, owner, expected settlement date and
escalation

Arguments:
  session                                  reconciliation session id

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
  --type <name>                            only items of this type: cheque-en-circulacion, deposito-en-transito, cargo-del-banco, abono-del-banco, error-del-banco, error-de-libros
  --over-days <n>                          only what has gone MORE than this many days since its date
  -h, --help                               display help for command

Examples:
  # Everything that explains the difference, with age, owner and escalation.
  mnemosine bank reconciling-item list 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7
  # Outstanding checks that have been waiting more than 30 days.
  mnemosine bank reconciling-item list 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --type cheque-en-circulacion --over-days 30
```

#### `mnemosine bank reconciling-item assign` (alias: asignar)

```
Usage: mnemosine bank reconciling-item assign|asignar [options] <session> <item>

Give a reconciling item an owner, an expected settlement date and notes

Arguments:
  session                  reconciliation session id
  item                     reconciling item id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --owner <name>           who is chasing this item
  --expected <date>        expected settlement date (YYYY-MM-DD)
  --clear-expected         remove the expected date instead of setting one
  --escalation <level>     escalation state: ninguno, avisado, vencido
  --note <text>            note stored with the item
  --json                   JSON output
  -h, --help               display help for command

Examples:
  # Give it an owner and the date it is expected to settle. close refuses to
  # sign while a single item has no expected date, and nothing invents one:
  # neither the statement nor the ledger knows when a check will be cashed.
  mnemosine bank reconciling-item assign 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 3d91e7a5-24bf-4c68-9013-8ad5f6207e4c --owner "Tesoreria" --expected 2026-08-15
  # Mark one that already went past its date, with the note that goes with it.
  mnemosine bank reconciling-item assign 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 3d91e7a5-24bf-4c68-9013-8ad5f6207e4c --escalation vencido --note "Segundo aviso al proveedor"
```

#### `mnemosine bank reconciling-item correct` (alias: corregir)

```
Usage: mnemosine bank reconciling-item correct|corregir [options] <session> <item>

Say what a reconciling item really was, when the automatic proposal got it wrong

Arguments:
  session                  reconciliation session id
  item                     reconciling item id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --type <name>            what it really is: cheque-en-circulacion,
                           deposito-en-transito, cargo-del-banco,
                           abono-del-banco, error-del-banco, error-de-libros
  --amount <amount>        its new contribution to the reconciliation; required
                           when the type changes side
  --json                   JSON output
  -h, --help               display help for command

Examples:
  # The automatic classification proposes by SIGN, and a sign cannot tell a
  # bank charge from a bank ERROR. That is what decides who gets billed.
  mnemosine bank reconciling-item correct 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 3d91e7a5-24bf-4c68-9013-8ad5f6207e4c --type error-del-banco
  # Moving it to the other side needs its new contribution, signed.
  mnemosine bank reconciling-item correct 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 3d91e7a5-24bf-4c68-9013-8ad5f6207e4c --type error-de-libros --amount "-1250.00"
```

### `mnemosine bank adjustment` (alias: ajuste)

```
Usage: mnemosine bank adjustment|ajuste [options] [command]

The fees, VAT, interest and withholdings a reconciliation uncovers, created as
DRAFTS

Options:
  -h, --help                        display help for command

Commands:
  create|crear [options] <session>  Create the fee, VAT, interest, ISR
                                    withholding or error correction found in the
                                    session AS A DRAFT waiting for `mnemosine
                                    review`; it never posts anything itself
  help [command]                    display help for command
```

#### `mnemosine bank adjustment create` (alias: crear)

```
Usage: mnemosine bank adjustment create|crear [options] <session>

Create the fee, VAT, interest, ISR withholding or error correction found in the
session AS A DRAFT waiting for `mnemosine review`; it never posts anything
itself

Arguments:
  session                                                    reconciliation session the adjustment belongs to

Options:
  -e, --entity <idOrName>                                    legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                                          tenant (firm) whose data to scope to
  -u, --user <email>                                         acting user, for attribution and permissions
  --note <text>                                              free annotation stored with the record
  --type <comision|iva-comision|interes|isr-retenido|error>  what the adjustment is
  --amount <amount>                                          SIGNED by its effect on the bank account: negative leaves the account, positive enters it
  --gl-account <code>                                        counterparty GL account; required for the types whose accounting role is not seeded yet (comision, interes)
  --item <id>                                                the reconciling item this adjustment explains
  --json                                                     JSON output
  -h, --help                                                 display help for command

Examples:
  # The fee the reconciliation uncovered, created AS A DRAFT for review: this
  # leaf posts nothing and exits 11 because it is waiting for a person.
  # --amount is SIGNED by its effect on the bank account, so a charge is negative.
  mnemosine bank adjustment create 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --type comision --amount "-348.00" --gl-account 6310
  # The interest the statement credited: 4310 and not 4300, so the only income
  # line a treasurer reads does not get mixed with the occasional.
  mnemosine bank adjustment create 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --type interes --amount 1275.40 --gl-account 4310
  # The ISR the bank withheld on that interest is a SEPARATE adjustment, it
  # LEAVES the account, and it needs no account: its role is already seeded.
  mnemosine bank adjustment create 6b2a5f80-3c14-4d92-a7e6-5081bc93f2d7 --type isr-retenido --amount "-15.94" --item 3d91e7a5-24bf-4c68-9013-8ad5f6207e4c
```

### `mnemosine bank fee` (alias: comision)

```
Usage: mnemosine bank fee|comision [options] [command]

Bank fees as an accounting act: the charge as an expense and its VAT parked
until the bank issues the CFDI

Options:
  -h, --help                             display help for command

Commands:
  post|contabilizar [options] <account>  Post the period’s bank fees from the statement, one entry per charge, leaving their VAT in pending-creditable until the bank’s CFDI arrives
  help [command]                         display help for command
```

#### `mnemosine bank fee post` (alias: contabilizar)

```
Usage: mnemosine bank fee post|contabilizar [options] <account>

Post the period’s bank fees from the statement, one entry per charge, leaving
their VAT in pending-creditable until the bank’s CFDI arrives

Arguments:
  account                  bank account whose fees to post (name or id)

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --period <YYYY-MM>       month whose fees to post
  --iva-rate <rate>        VAT rate the charge already carries INSIDE it, as a
                           fraction (0.16 for 16%); 0 for an exempt fee. No
                           default: a default here is a tax decision nobody
                           takes and nobody sees
  --max-amount <amount>    above this magnitude the charge is skipped and left
                           for human eyes; it is a confidence gate, not a
                           validation
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # July's bank fees, one entry per charge, with their VAT parked as pending
  # until the bank issues the CFDI. --iva-rate is the VAT the charge already
  # carries INSIDE it, as a fraction, and it has no default: a rate written
  # into the code is a tax decision nobody takes and nobody sees.
  mnemosine bank fee post "BBVA Operativa MXN" --period 2026-07 --iva-rate 0.16
  # An exempt fee: 0 is a legitimate answer, and it has to be typed.
  mnemosine bank fee post "BBVA Operativa MXN" --period 2026-07 --iva-rate 0
  # Leave the unusually large charges for human eyes, and rehearse first.
  mnemosine bank fee post "BBVA Operativa MXN" --period 2026-07 --iva-rate 0.16 --max-amount 5000 --dry-run
```

### `mnemosine bank interest` (alias: interes)

```
Usage: mnemosine bank interest|interes [options] [command]

Interest earned on bank balances: income at its GROSS amount and the tax the
bank withheld as a prepayment in the entity’s favour

Options:
  -h, --help                             display help for command

Commands:
  post|contabilizar [options] <account>  Post the period’s interest as income and the ISR the bank withheld as a provisional payment in the entity’s favour, never as an expense
  help [command]                         display help for command
```

#### `mnemosine bank interest post` (alias: contabilizar)

```
Usage: mnemosine bank interest post|contabilizar [options] <account>

Post the period’s interest as income and the ISR the bank withheld as a
provisional payment in the entity’s favour, never as an expense

Arguments:
  account                  bank account whose interest to post (name or id)

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --period <YYYY-MM>       month whose interest to post
  --rate <rate>            ISR WITHHOLDING rate the bank applied, as a fraction
                           (0.0125 for 1.25%); 0 when it withheld nothing. This
                           is NOT the interest rate: the interest is what the
                           statement says
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # July's interest as income at its GROSS amount, and the ISR the bank
  # withheld as a payment in the entity's favour, never as an expense.
  # --rate is the WITHHOLDING rate, not the interest rate: the interest is
  # whatever the statement says it was.
  mnemosine bank interest post "BBVA Operativa MXN" --period 2026-07 --rate 0.0125
  # A month in which the bank withheld nothing, rehearsed first.
  mnemosine bank interest post "BBVA Operativa MXN" --period 2026-07 --rate 0 --dry-run
```

### `mnemosine bank check` (alias: cheque)

```
Usage: mnemosine bank check|cheque [options] [command]

Paper checks as a fiscal fact: when the bank actually paid one, which under the
VAT law is when the payment counts

Options:
  -h, --help                          display help for command

Commands:
  reconcile|conciliar [options] <id>  Prove the check against the bank movement
                                      that cleared it and post the VAT
                                      reclassification from pending to
                                      creditable IN THE MONTH IT CLEARED
  help [command]                      display help for command
```

#### `mnemosine bank check reconcile` (alias: conciliar)

```
Usage: mnemosine bank check reconcile|conciliar [options] <id>

Prove the check against the bank movement that cleared it and post the VAT
reclassification from pending to creditable IN THE MONTH IT CLEARED

Arguments:
  id                       vendor payment made by check

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --transaction <id>       the bank movement that paid it, named by hand;
                           required when several charges match
  --as-of <date>           the clearing date you assert (YYYY-MM-DD); it is
                           CONTRASTED against the movement, never imposed — the
                           bank dates the clearing
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # Prove the check against the movement that cleared it. Under the VAT law the
  # payment counts when the bank actually paid, so the reclassification posts IN
  # THE MONTH IT CLEARED: a check signed in January and cashed in March belongs
  # to March, and to March's return.
  mnemosine bank check reconcile 8f27d3e6-1a94-4b50-9c83-fe6120a75d38
  # Name the movement by hand when several charges of the account could be it.
  mnemosine bank check reconcile 8f27d3e6-1a94-4b50-9c83-fe6120a75d38 --transaction 4c8e21b7-0f53-4a19-9d62-71ea3c05b8d4
  # Assert the clearing date: it is CONTRASTED against the movement and never
  # imposed on it. The bank dates the clearing.
  mnemosine bank check reconcile 8f27d3e6-1a94-4b50-9c83-fe6120a75d38 --as-of 2026-03-10 --dry-run
```

## `mnemosine asset` (alias: activo)

```
Usage: mnemosine asset|activo [options] [command]

Fixed asset register: the ledger of what the company owns and depreciates

Options:
  -h, --help                     display help for command

Commands:
  create|crear [options] <name>  Register a fixed asset with its class, dates,
                                 cost and accounts — writes no journal entry
  help [command]                 display help for command
```

### `mnemosine asset create` (alias: crear)

```
Usage: mnemosine asset create|crear [options] <name>

Register a fixed asset with its class, dates, cost and accounts — writes no
journal entry

Arguments:
  name                                     what the asset is called in the register

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --note <text>                            free annotation stored with the record
  --category <idOrName>                    asset class: its id, or enough of its name to be unambiguous
  --cost <amount>                          original cost of the investment (MOI), as a decimal
  --acquired <date>                        acquisition date (YYYY-MM-DD)
  --in-service <date>                      date depreciation starts (YYYY-MM-DD); defaults from the first-month convention on the panel
  --book <book|tax>                        the depreciation book you believe you are working on; checked against the panel
  --capitalized <yes|no>                   whether the cost is ALREADY charged to the asset account in the ledger — no default
  --source-entry <id>                      the journal entry the cost already sits in, when it is known
  --salvage <amount>                       residual value at the end of its life (default 0)
  --life-years <n>                         useful life in years
  --life-months <n>                        useful life in months; years are the ceiling of months over twelve
  --method <method>                        BOOK depreciation method: straight_line, declining_balance_150, declining_balance_200, sum_of_years_digits, units_of_production, macrs
  --tax-method <method>                    TAX depreciation method: straight_line, declining_balance_150, declining_balance_200, sum_of_years_digits, units_of_production, macrs
  --asset-account <id>                     GL account the cost sits in (defaults from the class)
  --accum-account <id>                     accumulated depreciation account (defaults from the class)
  --expense-account <id>                   depreciation expense account (defaults from the class)
  --number <folio>                         asset number; generated from the entity series when omitted
  --description <text>                     what the asset is
  --vendor <id>                            vendor it was bought from
  --serial <text>                          serial number, so the register can find the physical thing
  --location <text>                        where it is
  --dry-run                                run the real path and undo it: shows the asset that would be created
  -h, --help                               display help for command

Examples:
  # Rehearse the REAL path and undo it: the three accounts get resolved against
  # this entity's chart, the folio series is checked and the panel policies are
  # read, then the transaction is rolled back. Nothing is left behind.
  mnemosine asset create "Camioneta Nissan NP300 2026" --category "Equipo de Transporte" --cost 489000.00 --acquired 2026-07-08 --capitalized yes --dry-run
  # The cost is ALREADY charged to the asset account, because the CFDI was
  # capitalised: --capitalized yes, and the entry it sits in when it is known.
  # No journal entry is written here — a second one would double the asset.
  mnemosine asset create "Camioneta Nissan NP300 2026" --category "Equipo de Transporte" --cost 489000.00 --acquired 2026-07-08 --capitalized yes --source-entry 3c9a71e8-52d4-4f0b-9c17-8ab6d2540f31 --serial 3N6AD33A9SK812004
  # Not in the ledger yet: the register takes the asset and says in yellow the
  # exact amount still to be posted, because the credit side (bank, payables or
  # capital) is not something the register can guess.
  mnemosine asset create "Servidor Dell PowerEdge T360" --category "Equipo de Cómputo" --cost 62500.00 --acquired 2026-07-15 --capitalized no --life-years 4 --salvage 6250.00
```

## `mnemosine depreciation` (alias: depreciacion)

```
Usage: mnemosine depreciation|depreciacion [options] [command]

The monthly depreciation run: compute it, look at it, then post it

Options:
  -h, --help                   display help for command

Commands:
  run|ejecutar [options]       Compute the period run and show it asset by asset
                               — writes nothing, posts nothing
  post|contabilizar [options]  Post the period run to the ledger — one journal
                               entry per asset, irreversible
  help [command]               display help for command
```

### `mnemosine depreciation run` (alias: ejecutar)

```
Usage: mnemosine depreciation run|ejecutar [options]

Compute the period run and show it asset by asset — writes nothing, posts
nothing

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
  --period <expr>                          period to compute: 2026-08, or any unambiguous part of its name
  --book <book|tax>                        the depreciation book you believe you are running; checked against the panel
  --by <dimension>                         detail or summary: asset, class, account, method (asset is the per-asset detail) (default: "asset")
  -h, --help                               display help for command

Examples:
  # August, asset by asset: what each one charges this month, and which ones are
  # left out and why. This leaf writes nothing and posts nothing — the whole leaf
  # is the rehearsal, which is why it carries no --dry-run.
  mnemosine depreciation run --period 2026-08
  # The same month as JSON. THIS is the approved plan that depreciation post
  # --file compares against, so it is left per asset (the default --by).
  mnemosine depreciation run --period 2026-08 --format json -o plan-depreciacion-2026-08.json
  # Summarised by asset class, and with the missing-asset warning turned into a
  # blocker: --strict can only tighten, never loosen.
  mnemosine depreciation run --period 2026-08 --by class --strict
```

### `mnemosine depreciation post` (alias: contabilizar)

```
Usage: mnemosine depreciation post|contabilizar [options]

Post the period run to the ledger — one journal entry per asset, irreversible

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --period <expr>                          period to post: 2026-08, or any unambiguous part of its name
  --book <book|tax>                        the depreciation book you believe you are posting; checked against the panel
  --file <path>                            the approved plan (JSON from `depreciation run --format json`); refuses if the numbers moved
  --dry-run                                compute and show the full effect; write nothing and call nothing external
  -y, --yes                                skip the confirmation prompt
  --idempotency-key <key>                  client dedupe key, stored on success: a retry with the same key and payload returns the recorded result
  -h, --help                               display help for command

Examples:
  # What would land in the ledger: ONE journal entry per asset (DR 6140 expense /
  # CR 1290 accumulated), with the total in front. Run this first — a month
  # posted twice cannot be edited away, only reversed, entry by entry.
  mnemosine depreciation post --period 2026-08 --dry-run
  # Post it, declaring the book you believe you are on. --book has to agree with
  # `base_depreciacion` on the panel; it does not override it.
  mnemosine depreciation post --period 2026-08 --book book
  # Unattended and against the plan that was approved: if an asset moved since
  # then, it refuses and names the asset and both amounts. The same key replayed
  # returns the recorded result instead of posting again.
  mnemosine depreciation post --period 2026-08 --file plan-depreciacion-2026-08.json --yes --idempotency-key depreciacion-2026-08
```

## `mnemosine batch` (alias: lote)

```
Usage: mnemosine batch|lote [options] [command]

Staged entry batches: list, inspect, check, post transactionally and reverse as
a unit

Options:
  -h, --help                        display help for command

Commands:
  list|listar [options]             List batches with their state, row counts,
                                    posted entries and content hash
  show|ver [options] <id>           One batch in full: rows with their generated
                                    entries, stored parse errors by category,
                                    and the file hash
  check|verificar [options] <id>    Run the posting validations over every row
                                    and report each finding; exits 4 when any
                                    blocks
  post|contabilizar [options] <id>  Post the whole batch in one transaction;
                                    --partial applies the valid rows and leaves
                                    the rest staged
  reverse|reversar [options] <id>   Mirror every entry the batch posted, as one
                                    unit in one transaction — import errors are
                                    batch-shaped, not entry-shaped
  help [command]                    display help for command
```

### `mnemosine batch list` (alias: listar)

```
Usage: mnemosine batch list|listar [options]

List batches with their state, row counts, posted entries and content hash

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
  --kind <kind>                            batch class (available: import)
  -h, --help                               display help for command

Examples:
  # Everything entry import left staged and nobody has applied yet.
  mnemosine batch list --status staged
  # What was prepared since the first of July. This family filters by WHEN THE
  # BATCH WAS PREPARED: --since only; there is no upper bound and no date basis.
  mnemosine batch list --since 2026-07-01 --kind import --limit 20
```

### `mnemosine batch show` (alias: ver)

```
Usage: mnemosine batch show|ver [options] <id>

One batch in full: rows with their generated entries, stored parse errors by
category, and the file hash

Arguments:
  id                                       batch id

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --errors-only                            only the rows whose parser rejected them
  -h, --help                               display help for command

Examples:
  # One batch in full: every row, the entry each one produced, and the file hash.
  mnemosine batch show 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13
  # Only the rows the parser rejected, as CSV, to send back to whoever built the file.
  mnemosine batch show 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --errors-only --format csv
```

### `mnemosine batch check` (alias: verificar)

```
Usage: mnemosine batch check|verificar [options] <id>

Run the posting validations over every row and report each finding; exits 4 when
any blocks

Arguments:
  id                                       batch id

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
  --check <names>                          finding categories to display, comma-separated (available: parse, forma, cuenta, periodo, validacion); the full battery always runs
  -h, --help                               display help for command

Examples:
  # Run the whole battery over every row. Exit 4 means it found something.
  mnemosine batch check 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13
  # Narrow the REPORT to two of the five finding categories. The battery still
  # runs whole, and a blocking finding left outside the filter still counts
  # towards the exit code (it says so on stderr).
  mnemosine batch check 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --check cuenta,periodo
  # Warnings block too, for a scripted gate before the close.
  mnemosine batch check 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --strict
```

### `mnemosine batch post` (alias: contabilizar)

```
Usage: mnemosine batch post|contabilizar [options] <id>

Post the whole batch in one transaction; --partial applies the valid rows and
leaves the rest staged

Arguments:
  id                       batch id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --partial                apply the valid rows and leave the invalid ones in
                           staging (accepts an unchecked batch)
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  -h, --help               display help for command

Examples:
  # See the whole effect first: every entry the batch would post, with its total.
  # Do this before the real one — the ledger has no UPDATE and no DELETE.
  mnemosine batch post 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --dry-run
  # Apply the batch in ONE transaction: all the rows or none of them. A batch
  # that has not passed check is refused.
  mnemosine batch post 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13
  # Apply what is valid and leave the invalid rows staged, unattended. Replaying
  # the same key returns the recorded result instead of posting a second time.
  mnemosine batch post 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --partial --yes --idempotency-key lote-julio-2026
```

### `mnemosine batch reverse` (alias: reversar)

```
Usage: mnemosine batch reverse|reversar [options] <id>

Mirror every entry the batch posted, as one unit in one transaction — import
errors are batch-shaped, not entry-shaped

Arguments:
  id                       batch id

Options:
  -e, --entity <idOrName>  legal entity to operate on (defaults to the active
                           one)
  -t, --tenant <id>        tenant (firm) whose data to scope to
  -u, --user <email>       acting user, for attribution and permissions
  --as-of <date>           date for every mirror entry (YYYY-MM-DD); defaults to
                           today
  --json                   JSON output
  --dry-run                compute and show the full effect; write nothing and
                           call nothing external
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  client dedupe key, stored on success: a retry with
                           the same key and payload returns the recorded result
  --reason <text>          justification recorded in the audit trail (required)
  -h, --help               display help for command

Examples:
  # Mirror every entry the batch posted, as the unit it always was. --reason is
  # required: an import error is batch-shaped, not entry-shaped.
  mnemosine batch reverse 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --reason "El archivo traia el mes equivocado"
  # Which entries would be mirrored, without keeping anything. One entry already
  # reversed by hand stops the whole thing, naming its folio.
  mnemosine batch reverse 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --dry-run
  # Date every mirror into the month being closed instead of today.
  mnemosine batch reverse 8f14c2a6-3b57-4d90-9e21-5c7ab0d64e13 --as-of 2026-07-31 --reason "Reversa del lote de julio"
```

## `mnemosine closing` (alias: cierre-proceso)

```
Usage: mnemosine closing|cierre-proceso [options] [command]

The close as a process: its read-only surface — readiness, named checks,
offenders

Options:
  -h, --help                                display help for command

Commands:
  preview|previsualizar [options] [period]  Read-only twin of closing start: says whether the period can enter close and what is missing
  check|verificar [options]                 Run the close verification catalog, or only the named checks; bare --check lists the names
  explain|explicar [options] <code>         Print the offending rows of one check (ids, amounts, dates) and the exact command that fixes it
  help [command]                            display help for command
```

### `mnemosine closing preview` (alias: previsualizar)

```
Usage: mnemosine closing preview|previsualizar [options] [period]

Read-only twin of closing start: says whether the period can enter close and
what is missing

Arguments:
  period                                   open period name or id (default: the oldest open one)

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
  -h, --help                               display help for command

Examples:
  # Can the oldest open period enter close, and what is missing?
  mnemosine closing preview
  # A named month. Blocking items come from the engine AND from the AI queues:
  # a draft dated inside the period stops the close like a red checkbox does.
  mnemosine closing preview "July 2026"
  # Warnings block too, for a scripted gate: exit 4 where it would have been 0.
  mnemosine closing preview "July 2026" --strict
```

### `mnemosine closing check` (alias: verificar)

```
Usage: mnemosine closing check|verificar [options]

Run the close verification catalog, or only the named checks; bare --check lists
the names

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
  --check [codes]                          comma-separated check codes; with no value, prints the available ones
  --period <name>                          period to check (default: the oldest open one)
  -h, --help                               display help for command

Examples:
  # The whole catalog over the oldest open period.
  mnemosine closing check
  # What can be verified at all, without touching the database.
  mnemosine closing check --check
  # Two checks only, on a named month. Filtered, the verdict is about WHAT WAS
  # ASKED and nothing else; unfiltered it also weighs the AI blockers.
  mnemosine closing check --period "July 2026" --check trial-balance,ledger-integrity
```

### `mnemosine closing explain` (alias: explicar)

```
Usage: mnemosine closing explain|explicar [options] <code>

Print the offending rows of one check (ids, amounts, dates) and the exact
command that fixes it

Arguments:
  code                                     check code, one of: previous-period-closed, entries-posted, bank-reconciled, bank-variance-frozen, bank-items-overdue, bank-lines-unexplained, invoices-reviewed, depreciation-posted, trial-balance, ledger-integrity, rep-parked, rep-missing

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -n, --limit <n>                          maximum offending rows to print
  --period <name>                          period to explain (default: the oldest open one)
  -h, --help                               display help for command

Examples:
  # The rows keeping one check red, and the exact command that clears them.
  mnemosine closing explain entries-posted
  # Bank lines nobody explained, on a named month, ten rows at most.
  mnemosine closing explain bank-lines-unexplained --period "July 2026" -n 10
  # The offenders as CSV, which is the annex an auditor asks for. The real total
  # travels with the rows, so the --limit cut never passes in silence.
  mnemosine closing explain depreciation-posted --format csv -o cierre-julio-depreciacion.csv
```

## `mnemosine fx` (alias: cambio)

```
Usage: mnemosine fx|cambio [options] [command]

Exchange rates: the origin every foreign-currency amount converts from

Options:
  -h, --help      display help for command

Commands:
  rate|tipo       Published exchange rates by pair, date, type and source
  help [command]  display help for command
```

### `mnemosine fx rate` (alias: tipo)

```
Usage: mnemosine fx rate|tipo [options] [command]

Published exchange rates by pair, date, type and source

Options:
  -h, --help                                display help for command

Commands:
  list|listar [options]                     List stored exchange rates by pair, date, type and source
  show|ver [options] <pair> <date>          Resolve the applicable rate: direct, then inverse, then crossed through USD
  set|fijar [options] <pair> <date> <rate>  Record an exchange rate, naming its source
  download|descargar [options]              Download the DOF or Banxico FIX rate, stored per source (they differ on the same day)
  help [command]                            display help for command
```

#### `mnemosine fx rate list` (alias: listar)

```
Usage: mnemosine fx rate list|listar [options]

List stored exchange rates by pair, date, type and source

Options:
  -e, --entity <idOrName>                                          legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                                                tenant (firm) whose data to scope to
  -u, --user <email>                                               acting user, for attribution and permissions
  -n, --limit <n>                                                  maximum rows to return
  --offset <n>                                                     skip this many rows
  -s, --status <state...>                                          filter by lifecycle state (repeatable)
  -a, --all                                                        no default limit; include archived and closed
  --format <table|json|ndjson|csv|tsv|md>                          output format (default: "table")
  --json                                                           shorthand for --format json
  -o, --output <path>                                              write to a file instead of stdout
  --fields [names]                                                 comma-separated columns; with no value, lists the available ones
  -q, --quiet                                                      identifiers only, one per line, for piping
  --pair <pair>                                                    currency pair, e.g. USD/MXN
  --since <date>                                                   inclusive lower bound (YYYY-MM-DD)
  --until <date>                                                   inclusive upper bound (YYYY-MM-DD)
  --rate-type <spot|average|budget|historical>                     only rates of this type
  --source <manual|dof|banco_mexico|ecb|fed|xe|openexchangerates>  only rates from this source
  -h, --help                                                       display help for command

Examples:
  # Every USD/MXN rate stored for July 2026, whoever published it. The policy
  # column marks the source this firm actually converts with.
  mnemosine fx rate list --pair USD/MXN --since 2026-07-01 --until 2026-07-31
  # Only what the DOF published, which is the rate art. 20 CFF gives legal effect to.
  mnemosine fx rate list --pair USD/MXN --source dof --rate-type spot
```

#### `mnemosine fx rate show` (alias: ver)

```
Usage: mnemosine fx rate show|ver [options] <pair> <date>

Resolve the applicable rate: direct, then inverse, then crossed through USD

Arguments:
  pair                                          currency pair, e.g. USD/MXN
  date                                          date the rate applies to (YYYY-MM-DD)

Options:
  -e, --entity <idOrName>                       legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                             tenant (firm) whose data to scope to
  -u, --user <email>                            acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>       output format (default: "table")
  --json                                        shorthand for --format json
  -o, --output <path>                           write to a file instead of stdout
  --fields [names]                              comma-separated columns; with no value, lists the available ones
  -q, --quiet                                   identifiers only, one per line, for piping
  --rate-type <spot|average|budget|historical>  rate type to resolve (default: "spot")
  -h, --help                                    display help for command

Examples:
  # The rate a document dated 2026-07-08 converts at. Resolution is direct, then
  # inverse, then crossed through USD, and it says out loud when it had to carry
  # a rate forward from an earlier day.
  mnemosine fx rate show USD/MXN 2026-07-08
  # Another rate type, as JSON for a script.
  mnemosine fx rate show EUR/MXN 2026-07-08 --rate-type average --json
```

#### `mnemosine fx rate set` (alias: fijar)

```
Usage: mnemosine fx rate set|fijar [options] <pair> <date> <rate>

Record an exchange rate, naming its source

Arguments:
  pair                                                             currency pair, e.g. USD/MXN
  date                                                             effective date (YYYY-MM-DD)
  rate                                                             the rate, up to 10 decimals

Options:
  -e, --entity <idOrName>                                          legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                                                tenant (firm) whose data to scope to
  -u, --user <email>                                               acting user, for attribution and permissions
  --source <manual|dof|banco_mexico|ecb|fed|xe|openexchangerates>  who published the rate (required)
  --rate-type <spot|average|budget|historical>                     rate type (default: "spot")
  --until <date>                                                   last date the rate remains effective (YYYY-MM-DD)
  --dry-run                                                        show what would be recorded without writing
  -h, --help                                                       display help for command

Examples:
  # The DOF rate for the day. A vendor bill in USD dated 2026-07-08 converts at
  # this number, so it has to exist BEFORE the expense is captured: without the
  # rate of the source the policy names, the conversion stops instead of guessing.
  mnemosine fx rate set USD/MXN 2026-07-08 18.4231 --source dof
  # The Banxico FIX of the SAME day, which is a different number and lives beside
  # it. --dry-run says what would be recorded and writes nothing.
  mnemosine fx rate set USD/MXN 2026-07-08 18.3975 --source banco_mexico --dry-run
```

#### `mnemosine fx rate download` (alias: descargar)

```
Usage: mnemosine fx rate download|descargar [options]

Download the DOF or Banxico FIX rate, stored per source (they differ on the same
day)

Options:
  -e, --entity <idOrName>             legal entity to operate on (defaults to
                                      the active one)
  -t, --tenant <id>                   tenant (firm) whose data to scope to
  -u, --user <email>                  acting user, for attribution and
                                      permissions
  --source <dof|banxico-fix|fed|ecb>  which publisher to download from
                                      (required)
  --as-of <date>                      single date to download (YYYY-MM-DD)
  --since <date>                      inclusive lower bound (YYYY-MM-DD)
  --until <date>                      inclusive upper bound (YYYY-MM-DD)
  --dry-run                           compute and show the full effect; write
                                      nothing and call nothing external
  -y, --yes                           skip the confirmation prompt
  --idempotency-key <key>             client dedupe key, stored on success: a
                                      retry with the same key and payload
                                      returns the recorded result
  --live                              perform the real external effect (default
                                      is the sandbox endpoint)
  -h, --help                          display help for command

Examples:
  # What the download would fetch and where it would land. There is no connector
  # yet, so running it FAILS CLOSED instead of inventing a rate: today the honest
  # path is fx rate set with the number the publisher actually printed.
  mnemosine fx rate download --source dof --as-of 2026-07-08 --dry-run
  # A whole month of the Banxico FIX, which additionally needs a SIE token that
  # no credential store here governs yet.
  mnemosine fx rate download --source banxico-fix --since 2026-07-01 --until 2026-07-31 --dry-run
```

## `mnemosine prepaid` (alias: pago-anticipado)

```
Usage: mnemosine prepaid|pago-anticipado [options] [command]

Prepaid expenses: the schedule that takes them out of 1160, month by month

Options:
  -h, --help                            display help for command

Commands:
  create|crear [options] <description>  Register the amortisation schedule of a
                                        charge already sitting in prepaid
                                        expenses — posts nothing
  list|listar [options]                 Live schedules with their remaining
                                        balance and how many periods are left
  show|ver [options] <idOrDescription>  One schedule with its period-by-period
                                        table
  run|ejecutar [options]                Post the month accrual — one adjusting
                                        entry per schedule, irreversible
  help [command]                        display help for command
```

### `mnemosine prepaid create` (alias: crear)

```
Usage: mnemosine prepaid create|crear [options] <description>

Register the amortisation schedule of a charge already sitting in prepaid
expenses — posts nothing

Arguments:
  description                                what the prepayment covers, as it will read in the entries

Options:
  -e, --entity <idOrName>                    legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                          tenant (firm) whose data to scope to
  -u, --user <email>                         acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>    output format (default: "table")
  --json                                     shorthand for --format json
  -o, --output <path>                        write to a file instead of stdout
  --fields [names]                           comma-separated columns; with no value, lists the available ones
  -q, --quiet                                identifiers only, one per line, for piping
  --note <text>                              free annotation stored with the record
  --force                                    override a blocking validation (closed period, lock date, duplicate); requires --reason
  --amount <amount>                          amount to accrue, as a decimal
  --start <date>                             first day the coverage runs (YYYY-MM-DD)
  --end <date>                               last day the coverage runs, inclusive (YYYY-MM-DD)
  --origin <cfdi|manual|saldo_preexistente>  where the charge already in the account came from — no default
  --source-entry <id>                        the journal entry that charged the account; required with --origin cfdi
  --cfdi-uuid <uuid>                         the CFDI this prepayment came in on, for the trail
  --vendor <name>                            vendor name kept on the schedule
  --reference <text>                         the document this points at: policy number, contract, order
  --convention <convention>                  the convention you believe you are registering (proporcional_dias|meses_completos); checked against the panel
  --prepaid-account <idOrCode>               prepaid-expenses account the charge sits in (defaults to the `gasto_anticipado` role)
  --expense-account <idOrCode>               account the accrual will charge each month (defaults to the `gasto` role)
  --reason <text>                            why the threshold is being overridden; required with --force
  --dry-run                                  show the schedule that would be registered; write nothing
  -h, --help                                 display help for command

Examples:
  # An annual insurance premium already charged to prepaid expenses: the schedule
  # says how it becomes expense, month by month. Nothing posts here.
  mnemosine prepaid create "Seguro de flotilla 2026-2027" --amount 84000.00 --start 2026-08-01 --end 2027-07-31 --origin cfdi
  # A balance the client arrives with, mid-coverage. --origin has NO default on
  # purpose: where the charge came from changes what a reviewer has to check.
  mnemosine prepaid create "Renta anticipada de bodega" --amount 36000.00 --start 2026-01-01 --end 2026-12-31 --origin saldo_preexistente --note "Saldo migrado de CONTPAQi, cedula de abril"
```

### `mnemosine prepaid list` (alias: listar)

```
Usage: mnemosine prepaid list|listar [options]

Live schedules with their remaining balance and how many periods are left

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  -n, --limit <n>                          maximum rows to return
  --offset <n>                             skip this many rows
  -a, --all                                every live schedule, including those not started yet and already ended
  --as-of <date>                           only schedules whose coverage is open on this date (YYYY-MM-DD; default today)
  -h, --help                               display help for command

Examples:
  # What is still amortising, with what is left and how many periods remain.
  mnemosine prepaid list
  # Only what was open on a given date — the view a working paper needs.
  mnemosine prepaid list --as-of 2026-07-31 --limit 50
```

### `mnemosine prepaid show` (alias: ver)

```
Usage: mnemosine prepaid show|ver [options] <idOrDescription>

One schedule with its period-by-period table

Arguments:
  idOrDescription                          the schedule: its id, or enough of its description to be unambiguous

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
  # The full period-by-period table of one schedule.
  mnemosine prepaid show "Seguro de flotilla"
  # By id when the description is ambiguous; the table is the same.
  mnemosine prepaid show 3f2504e0-4f89-11d3-9a0c-0305e82c3301 --json
```

### `mnemosine prepaid run` (alias: ejecutar)

```
Usage: mnemosine prepaid run|ejecutar [options]

Post the month accrual — one adjusting entry per schedule, irreversible

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --period <expr>                          period to accrue: 2026-08, or any unambiguous part of its name
  --dry-run                                compute and show the full effect; write nothing and call nothing external
  -y, --yes                                skip the confirmation prompt
  --idempotency-key <key>                  client dedupe key, stored on success: a retry with the same key and payload returns the recorded result
  -h, --help                               display help for command

Examples:
  # ALWAYS this one first: the month accrual is irreversible, and --dry-run
  # computes and shows every entry it would post, writing nothing.
  mnemosine prepaid run --period 2026-08 --dry-run
  # The real run, with a key: a retry after a dropped connection returns the
  # recorded result instead of accruing the month twice.
  mnemosine prepaid run --period 2026-08 --yes --idempotency-key devengo-2026-08
```

## `mnemosine cashflow` (alias: flujo)

```
Usage: mnemosine cashflow|flujo [options] [command]

Statement of cash flows (NIF B-2 / ASC 230): build it, and tie it to real cash

Options:
  -h, --help                     display help for command

Commands:
  generate|generar [options]     Build the statement of cash flows for a period,
                                 with the tie-out to real cash
  reconcile|conciliar [options]  Reconcile the derived statement of cash flows
                                 against the real movement of cash and
                                 equivalents, and print the residue instead of
                                 absorbing it
  help [command]                 display help for command
```

### `mnemosine cashflow generate` (alias: generar)

```
Usage: mnemosine cashflow generate|generar [options]

Build the statement of cash flows for a period, with the tie-out to real cash

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
  --method <indirect|direct>               method to build the statement with (default: the `flujo_efectivo_metodo` policy)
  --gross                                  present gross receipts and payments instead of net (NIF B-2 §40 / ASC 230-10-45-7); refused with a reason — these books cannot support it
  -h, --help                               display help for command

Examples:
  # The statement for a closed month, with its tie-out to real cash. The method
  # comes from the `flujo_efectivo_metodo` policy unless you override it.
  mnemosine cashflow generate --period 2026-07
  # The direct method when the firm answered the panel the other way, or when a
  # working paper needs both presentations side by side.
  mnemosine cashflow generate --period 2026-07 --method direct --format csv -o flujo-julio.csv
```

### `mnemosine cashflow reconcile` (alias: conciliar)

```
Usage: mnemosine cashflow reconcile|conciliar [options]

Reconcile the derived statement of cash flows against the real movement of cash
and equivalents, and print the residue instead of absorbing it

Options:
  -e, --entity <idOrName>                  legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                        tenant (firm) whose data to scope to
  -u, --user <email>                       acting user, for attribution and permissions
  --period <expr>                          period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06
  --since <date>                           inclusive lower bound (YYYY-MM-DD)
  --until <date>                           inclusive upper bound (YYYY-MM-DD)
  --as-of <date>                           valuation/balance date (YYYY-MM-DD)
  --date-basis <document|posting|value>    which date the filters apply to (default: "posting")
  --strict                                 treat warnings as blocking (exit 4)
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  --json                                   shorthand for --format json
  -o, --output <path>                      write to a file instead of stdout
  --fields [names]                         comma-separated columns; with no value, lists the available ones
  -q, --quiet                              identifiers only, one per line, for piping
  --show-candidates                        list the journal lines that most likely explain the residue (suspects, not a verdict)
  -h, --help                               display help for command

Examples:
  # Tie the derived statement against the real movement of cash: the residue is
  # PRINTED, never absorbed, because a statement that always ties proves nothing.
  mnemosine cashflow reconcile --period 2026-07
  # When there IS a residue: the journal lines that most likely explain it —
  # suspects, not a verdict — and --strict to make CI stop on it (exit 4).
  mnemosine cashflow reconcile --period 2026-07 --show-candidates --strict
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
  uuid                                         CFDI UUID (timbre fiscal)

Options:
  -e, --entity <idOrName>                      legal entity to operate on (defaults to the active one)
  -t, --tenant <id>                            tenant (firm) whose data to scope to
  -u, --user <email>                           acting user, for attribution and permissions
  --format <table|json|ndjson|csv|tsv|md|xml>  output format (default: "table")
  --json                                       shorthand for --format json
  -o, --output <path>                          write to a file instead of stdout
  --fields [names]                             comma-separated columns; with no value, lists the available ones
  -q, --quiet                                  identifiers only, one per line, for piping
  -h, --help                                   display help for command

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

