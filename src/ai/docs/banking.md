# Banking and reconciliation

## Flow
1. Import transactions: POST /v1/bank-accounts/:id/import (batch of transactions with a unique bank_transaction_id — automatic dedupe). Sources: API, Plaid/Belvo.
2. Matching: each transaction is paired with an invoice/bill/journal entry.
   - Suggestions: GET /transactions/:id/suggestions (by amount ±1%, with a confidence score).
   - Manual: POST /transactions/:id/match {matched_entity_type: invoice|bill|journal_entry|payment, matched_entity_id}.
   - Automatic: POST /:account_id/auto-match (matching engine).
3. Reconciliation session: POST /:account_id/reconciliations {start_date, end_date, ending_balance_per_bank} → review → POST /reconciliations/:id/complete (ends up 'balanced').

## What YOU do
- You have no direct banking tools yet. You can: query the ledger of the bank accounts (get_general_ledger with the account code, e.g. 1110), detect imbalances vs. the bank statement the user describes to you, and propose adjustment journal entries as drafts (fees, interest, exchange differences) explaining the reason.
- Direct the human to the endpoints above to import/reconcile.
