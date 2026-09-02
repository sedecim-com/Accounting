# Accounting engine: journal entries and periods

## Journal entries (journal_entries)
- Types: standard, adjusting, closing, reversing, correction, auto_invoice, auto_payment, auto_depreciation, auto_reconciliation.
- States: draft → pending_approval → approved → posted. A POSTED entry is IMMUTABLE and never flips state: "voiding" a posted entry means a HUMAN runs `entry void`, which creates a linked posted mirror (reversal) in the same transaction; the original STAYS 'posted' and its annulment is expressed by reversed_by_entry_id (NIF B-1: corrections by reversal, never by edit). Only draft/pending entries — which never touched the ledger — are simply marked 'void'. post/reverse/void are irreversible acts and are NEVER agent-invocable.
- Golden rule: debits = credits EXACTLY (the DB enforces it with a CHECK at posting; there is no tolerance). Each line carries exactly one: debit_amount XOR credit_amount, both > 0. Minimum 2 lines.
- Validations at posting (engine-enforced, not optional): exact balance, XOR-positive line, active account + allow_manual_entries + not a header, open fiscal period.
- Foreign currency (R4, NIF B-15): a line in another currency MUST carry the four FX columns together (currency_code, foreign_debit/credit, exchange_rate) and the engine VERIFIES the conversion — functional = foreign × rate rounded half-up to 4 decimals; a mismatch is rejected quoting the three numbers. A line whose currency differs from the entity's functional currency without FX columns is rejected: nothing loses its origin silently. Reversal/void mirrors CROSS the foreign sides too, so the mirror keeps the origin. The rate an operation uses comes from the source the firm chose in the `fuente_tipo_cambio` policy (DOF by default, art. 20 CFF; FIX is a DIFFERENT number for the same day) and resolution FAILS CLOSED if that source has no rate for that date — it never borrows another source's rate. Paying a USD bill at a rate other than the document's posts the REALIZED difference to 4320 (gain) / 6320 (loss); revaluation at close is NOT built yet. AR is not wired yet either: a foreign-currency invoice REFUSES to post (phase 2) rather than record dollars as pesos.
- Posting updates account_balances per (account, period) and triggers blockchain attestation (asynchronous, optional).
- Numbering: JE-<year>-<sequence> per entity.

## What YOU do
- Query: search_journal_entries, get_journal_entry, get_general_ledger.
- Propose: draft_journal_entry (draft in ai_drafts; a human approves it with `mnemosine review`, which creates AND posts via the engine).

## What the human does (REST /v1)
- POST /journal-entries (create), POST /journal-entries/:id/post, /void, /reverse.
- Year-end close and the statements that quote it (G1a): the closing entry is dated at the END of the period it closes, which is INSIDE the range year-end reports ask for. The income statement therefore EXCLUDES entry_type='closing' (and the reversal mirror of a closing entry) while the trial balance INCLUDES it and says so in a note — that is the `informes_asientos_de_cierre` policy, and it is what lets both documents be true at once. Before G1a a closed year printed «Net income 0.0000» in all three surfaces, which share the query. The close itself sweeps each account to the side OPPOSITE its balance, decided by the SIGN: a contra-revenue like 4400 (debit-natured) is CREDITED and a contra-expense like 5200 is DEBITED. Using abs() looked right on ordinary accounts and doubled the contra ones — 10,000 sales with a 2,000 return published a 2,000 LOSS where there was a 3,000 profit, and the entry balanced, so nothing complained. The close now VERIFIES it swept: if any result account still carries a balance the hard close ROLLS BACK and names them (`severidad_resultado_sin_barrer`). Closing a period that already emitted its close (possible since `period reopen`) reverses the previous closing entry with an audited reason before emitting the new one (`cierre_recierre_de_periodo_reabierto`) — otherwise the result entered capital twice. Where the result lands is `destino_del_resultado_del_ejercicio`: by default through «Result of the Period» (3300) rather than straight to Retained Earnings, so the year stays identifiable until the asamblea resolves it.
- Imported batches (F06c): `entry import` stages rows; `batch check` validates each row with the SAME rules as a manual entry and moves staged→checked; `batch post` applies the valid rows transactionally (--partial keeps the invalid ones staged, with counts); `batch reverse` mirrors ALL the batch's entries as one unit and refuses if any was already reversed by hand, naming it. Batch entries carry source_type='import_batch' with the ROW as source_id. post/reverse are irreversible → never yours to run; list/show/check you may read and run.
- Approve your drafts: `mnemosine review`; view them: `mnemosine drafts`.

## Fiscal periods
- States: future → open → soft_close → hard_close → locked.
- soft_close: warning, only recommended adjustments. hard_close/locked: posting is NOT possible (your drafts for those dates will fail at approval; validate the date first).
- Human: GET /fiscal-periods, GET /fiscal-periods/:id/close-status, POST /:id/soft-close, POST /:id/hard-close.

## Sign convention
Positive balance = debit nature; negative = credit nature. In mnemosine reports, amounts already come in the natural sign of each section (contra-accounts appear negative and SUBTRACT).
