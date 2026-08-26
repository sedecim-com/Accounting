# Banking and reconciliation

## Flow
1. Import transactions: POST /v1/bank-accounts/:id/import (batch of transactions with a unique bank_transaction_id — automatic dedupe). Sources: API, Plaid/Belvo.
2. Matching: each transaction is paired with an invoice/bill/journal entry.
   - Suggestions: GET /transactions/:id/suggestions (by amount ±1%, with a confidence score).
   - Manual: POST /transactions/:id/match {matched_entity_type: invoice|bill|journal_entry|payment, matched_entity_id}.
   - Automatic: POST /:account_id/auto-match (matching engine).
3. Reconciliation session: POST /:account_id/reconciliations {start_date, end_date, ending_balance_per_bank} records the statement balance and groups the matches. It CANNOT be completed: POST /reconciliations/:id/complete answers 501.

## What mnemosine does NOT do
- It does not reconcile. Nothing here computes the book balance, the variance, outstanding checks or deposits in transit, and nothing posts the bank fees, interest or returns a reconciliation uncovers. `complete` used to flip the session to 'balanced' without any of that, and the period-close checklist read 'balanced' as proof the account had been verified — so it now refuses instead.
- Consequence to state plainly when asked: the close checklist item "Bank reconciliations complete" will stay unticked. That is accurate, not a bug. Reconcile the account outside mnemosine and post the adjustments you find as journal entries.
- A session's `variance` and `ending_balance_per_books` are column defaults of 0. Never read them as a computed result.

## What YOU do
- You have no direct banking tools yet. You can: query the ledger of the bank accounts (get_general_ledger with the account code, e.g. 1110), detect imbalances vs. the bank statement the user describes to you, and propose adjustment journal entries as drafts (fees, interest, exchange differences) explaining the reason.
- Direct the human to the endpoints above to import/reconcile.
