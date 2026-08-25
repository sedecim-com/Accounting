# Accounting engine: journal entries and periods

## Journal entries (journal_entries)
- Types: standard, adjusting, closing, reversing, correction, auto_invoice, auto_payment, auto_depreciation, auto_reconciliation.
- States: draft → pending_approval → approved → posted; void at any point (if it was posted, a reversing journal entry is generated automatically and auto-posted).
- Golden rule: debits = credits EXACTLY (the DB enforces it with a CHECK at posting; there is no tolerance). Each line carries exactly one: debit_amount XOR credit_amount, both > 0. Minimum 2 lines.
- Validations at posting (engine-enforced, not optional): exact balance, XOR-positive line, active account + allow_manual_entries + not a header, open fiscal period, foreign currency requires exchange_rate and consistent foreign_debit/credit.
- Posting updates account_balances per (account, period) and triggers blockchain attestation (asynchronous, optional).
- Numbering: JE-<year>-<sequence> per entity.

## What YOU do
- Query: search_journal_entries, get_journal_entry, get_general_ledger.
- Propose: draft_journal_entry (draft in ai_drafts; a human approves it with `mnemosine review`, which creates AND posts via the engine).

## What the human does (REST /v1)
- POST /journal-entries (create), POST /journal-entries/:id/post, /void, /reverse.
- Approve your drafts: `mnemosine review`; view them: `mnemosine drafts`.

## Fiscal periods
- States: future → open → soft_close → hard_close → locked.
- soft_close: warning, only recommended adjustments. hard_close/locked: posting is NOT possible (your drafts for those dates will fail at approval; validate the date first).
- Human: GET /fiscal-periods, GET /fiscal-periods/:id/close-status, POST /:id/soft-close, POST /:id/hard-close.

## Sign convention
Positive balance = debit nature; negative = credit nature. In mnemosine reports, amounts already come in the natural sign of each section (contra-accounts appear negative and SUBTRACT).
