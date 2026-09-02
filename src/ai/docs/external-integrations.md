# External accounting systems (Contalink, …)

## What it is
API connection to other accounting systems to ACQUIRE their data and keep
supervised synchrony. Available: **contalink** (requires `CONTALINK_API_KEY`
in .env; the human requests it in Contalink → API Configuration).

## Safety rule
Direct READS with your tools; WRITES to the external system ALWAYS
queued (external_push → outbox) — the human reviews with `mnemosine outbox
list` and executes with `mnemosine outbox run --live` (no sandbox exists, so
the real effect is opt-in). Never claim something was already applied over
there: it was "queued".

## Your tools
- external_pull {provider, resource}: trial_balance (start/end), account_balance
  (account_code, date), documents (rfc, transaction_type E/R, document_type
  Nomina|Ingreso|Egreso|Pago, dates, page from 0).
- external_diff_trial_balance {provider, start_date, end_date}: deterministic
  remote-vs-local diff by account code (tolerance 0.01): differences (with delta),
  only_local, only_remote, matched_equal. Interpret and propose: local adjustment
  drafts (draft_journal_entry) or remote journal entries (external_push).
- external_push {provider, operation, payload, reasoning} → queues. list_external_ops
  to follow up (failed carries the provider's error).

## Payload contracts (contalink)
- create_policy / update_policy: { record_date: "YYYY-MM-DD", description,
  records: [{ account_code, debit, credit }] } (update also takes a numeric policy_id).
  account_code is the code IN CONTALINK'S CHART OF ACCOUNTS (verify it with
  external_pull trial_balance, not with the local chart).
- upload_xml: { xml_base64, name? } — uploads a CFDI to Contalink (asynchronous load).
- bank_transaction: { bank, date, deposit, withdrawal, reference, description? }
  (BOTH fields present; exactly one > 0, the other 0 — omitting one fails closed).
- reconcile_invoice: { invoice_id: UUID of the CFDI, amount, bank_account,
  payment_date ISO8601, payment_form SAT key e.g. "03" }.

## Contalink quirks
- Responses: status 1 = success, 0 = error (inverted from the intuitive).
- Trial balance amounts arrive as strings; the adapter already normalizes them to numbers.
- The remote trial balance uses CONTALINK'S chart: codes may not match the
  local ones — treat only_local/only_remote first as a chart-of-accounts
  difference, not a balance difference.

## Typical flows
- Migration/parallel run: monthly external_diff_trial_balance → explain each delta
  → propose local adjustments as drafts or queued remote journal entries.
- Mirror into Contalink: after a relevant local journal entry is approved, queue
  the equivalent create_policy (map the codes to the remote chart).
- CFDI acquisition: external_pull documents to know what the other system has;
  the XMLs are ingested locally with `mnemosine ingest`.

## Onboarding: importing a new client's books
The human runs `mnemosine onboard --provider contalink --cutoff YYYY-MM-DD`
(--dry-run to see the plan). The wizard: (1) reads the remote trial balance at the
cutoff, (2) creates missing accounts with type/nature inferred from the MX
grouping code (1 asset, 2 liability, 3 equity, 4 income, 5-6 expenses; ⚠ doubtful
ones require review), (3) generates the opening balance journal entry as a DRAFT
(or posts it with --post) with idempotent reference onboarding:<provider>:<cutoff>
— re-importing requires voiding the previous one, (4) if the remote trial balance
does not sum to zero it asks for --balance-account (suggested 3200) and creates
that account if missing, (5) upon posting it automatically verifies with the diff:
it must yield 0 differences.
Your role: guide the human to the command, review the doubtful inferred types,
explain differences if the verification does not close, and propose the adjustments.
