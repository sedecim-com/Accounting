# Banking and reconciliation

## Flow
0. Every route here that reads or writes is scoped to the caller's entity — all seven mount `requireEntityAccess` — and answers 404, not 403, for an account, transaction or session belonging to another one. (The eighth, `complete`, carries no guard because it touches nothing: it throws 501 before any query.) Until recently only `auto-match` was scoped: with a foreign account UUID you could inject movements into someone else's statement, read it, match against it, and open a reconciliation session on it. That last one wrote into another entity's close, because the period-close checklist reads the session as proof the account was verified. Never suggest working around a 404 here by "using the id directly".
1. Import transactions: POST /v1/bank-accounts/:id/import (batch of transactions with a unique bank_transaction_id — automatic dedupe). Source: this API only. Plaid/Belvo are config keys and nullable columns; NO connector exists — never tell a user their bank can sync.
2. Matching: each transaction is paired with a journal entry LINE, invoice, bill, or customer/vendor payment.
   - Suggestions: GET /bank-accounts/transactions/:id/suggestions (invoices and bills only, by amount ±1%, with a confidence score).
   - Manual: POST /bank-accounts/transactions/:id/match {matched_entity_type: journal_entry_line|invoice|bill|customer_payment|vendor_payment, matched_entity_id, matched_amount?}. The old spellings 'journal_entry' and 'payment' do NOT exist and are rejected with 400.
   - Automatic: POST /:account_id/auto-match (matching engine).
3. Reconciliation session: POST /:account_id/reconciliations {start_date, end_date, ending_balance_per_bank} records the statement balance. It does NOT group the matches: nothing writes reconciliation_matches.reconciliation_session_id, so GET /reconciliations/:id always answers matches [] and matched_count 0 — only unmatched_count is real. It CANNOT be completed: POST /reconciliations/:id/complete answers 501.

## What mnemosine does NOT do
- It does not reconcile. Nothing here computes the book balance, the variance, outstanding checks or deposits in transit, and nothing posts the bank fees, interest or returns a reconciliation uncovers. `complete` used to flip the session to 'balanced' without any of that, and the period-close checklist read 'balanced' as proof the account had been verified — so it now refuses instead.
- Consequence to state plainly when asked: the close checklist item "Bank reconciliations complete" will stay unticked. That is accurate, not a bug. Reconcile the account outside mnemosine and post the adjustments you find as journal entries.
- A session's `variance` and `ending_balance_per_books` are column defaults of 0. Never read them as a computed result.

## The CLI (F05a) — the statement is now a document
- `bank account create|list|show|edit|set` · `banco cuenta …`. `create`/`edit`/`set` are yours to READ ABOUT, not to run (IA ✗). `show` masks every identifier: you will never see a full CLABE, account number or routing — only the last four. Do not ask the user to paste one either.
- `bank statement import <file...>` · `estado-cuenta importar` is IA ✓ **because it cannot reach the ledger**: it parses a file into the bank staging tables and posts nothing. Formats: csv (with per-bank profiles), camt053, mt940. Deduplicates twice — the whole file by sha256, and each line by a content hash the DATABASE computes; you cannot forge either. Re-importing the same file is refused, not silently duplicated.
- `bank statement check [<id>]` · `estado-cuenta verificar` runs seven integrity tests and EXITS 4 when one blocks: balance chain, continuity with the previous statement, date gaps/overlaps, account identity, currency, sequence, reversals. Run it after every import and read the finding, do not just look at the exit code.
- A statement that fails `check` is not a statement you work from. Say so plainly instead of reconciling around it.

## What YOU do
- Read: `bank account list|show`, `bank statement list|show|check`. Import a file when the user gives you one. Query the ledger of the bank accounts (get_general_ledger with the account code, e.g. 1110), detect imbalances vs. the statement, and propose adjustment journal entries as drafts (fees, interest, exchange differences) explaining the reason.
- You still cannot reconcile: matching, the session and the adjustments it uncovers are later tranches. Importing a statement is not reconciling it, and saying otherwise would repeat the exact false attestation this file records above.
