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

## Matching (F05b) — the two sides
- `bank transaction list|show` · `movimiento` is the bank's side. `bank book-item list <account>` · `partida-libros` is OURS: posted journal lines against the bank's GL account still unsealed, with their age — that is how you find a payment recorded in the books that the bank never showed.
- `bank match preview [<tx-id>]` · `cotejo previsualizar` is YOURS to run (IA ✓): it shows the candidates with the SCORE BROKEN DOWN — what the amount contributed, what the date, what the text — and applies nothing. `run`, `apply`, `create` and `unapply` are IA ✗. That split is deliberate: the ✓/✗ pair may never depend on the value of a flag.
- **A match is never applied on description similarity alone.** The rule that breaks ties by text vetoes its own finding. If the amounts and dates are ambiguous and only the wording agrees, the line is left for a person with the reason `solo-similitud`. Never present a text-only resemblance to a user as a match.
- A book item only matches if it belongs to the bank's own GL account. A line from any other account is not a candidate, however well the amount fits.
- Applying SEALS the book line (`is_reconciled` + when + which group, all three or none). `unapply` closes the match — it never deletes it — releases the seal, and refuses once the session is `approved` or `posted`. No posted journal entry is ever otherwise touched.

## The session (F05c) — reconciling is now real, and `balanced` is earned
- `bank reconciliation open <account>` · `conciliacion abrir` asserts the opening balance equals the previous session's close and refuses date gaps. `status [<session>]` recomputes the two-sided arithmetic LIVE — it never reads the stored `variance`, and neither should you: that column is the assertion frozen at close, not the answer.
- `bank reconciliation close <session>` moves a session to `balanced` ONLY when the variance is exactly zero (or within the firm's tolerance, `conciliacion_tolerancia`) and every reconciling item is classified AND dated. **The database itself refuses a session marked balanced without recorded arithmetic** — the guard is a CHECK, not a service rule, because what failed here for a year was a service rule that did not exist.
- `bank reconciling-item list|assign|correct` · `partida-conciliatoria`. Items are proposed BY SIGN, and a sign cannot tell a bank fee from a bank error — so `correct` says what it really was, and that decides who you claim against. `assign` gives it an owner and an expected date: an item with no date is not chased, it ages.
- `bank adjustment create <session>` creates DRAFTS and posts nothing. Its journal entry stays NULL until a later tranche posts it behind a signature.
- Once a session is legitimately `balanced`, the period-close checklist item "Bank reconciliations complete" ticks — and only for a period the session actually COVERS. A September reconciliation does not vouch for August.

## Signing and posting (F05d) — the only part that reaches the ledger
- `bank reconciliation approve <session>` freezes an immutable SNAPSHOT of what was signed —the items and the balances as they stood— and seals it with a hash. That is what lets anyone later ask "is this what was approved?" and get a yes or a no. It re-evaluates the balance with the tolerance the session was CLOSED with, not today's.
- Whether the approver may be the person who closed it is the firm's decision, `segregacion_de_funciones` — the same key that governs manual posting, because it is the same question.
- `bank reconciliation post <session>` posts the adjustment drafts and seals the book lines. From then on those lines cannot be edited, cancelled or re-dated.
- `bank fee post` books the fee with its VAT in 1135, NOT 1130: the charge is on the statement but the bank's CFDI has not arrived, and without the receipt there is no credit however much the money already left. `bank interest post` books interest GROSS and the withheld ISR as a prepayment (1145) — never as an expense; treating it as expense loses the credit and understates income.
- **All five are IA ✗ and all five are irreversible.** You may read and explain them; you may never run them.

## What YOU do
- Read: `bank account list|show`, `bank statement list|show|check`, `bank transaction list|show`, `bank book-item list`, `bank match preview`, `bank reconciliation list|status`, `bank reconciling-item list`. Import a file when the user gives you one. `bank reconciliation open` and `bank adjustment create` are yours too — they write, but neither reaches the ledger.
- What you must NOT do: `run`, `close`, `match run|apply|create|unapply`, `reconciling-item assign|correct`. Closing a session is an attestation about someone's cash, and dating an item is a promise on someone's behalf.
- **Never call an account reconciled because it is matched.** Matching pairs records; reconciling explains the difference and closes it. And never read `variance` from a listing as a computed result unless the session is closed — before that it is a placeholder, and this file exists because a placeholder zero was once shown as agreement.
