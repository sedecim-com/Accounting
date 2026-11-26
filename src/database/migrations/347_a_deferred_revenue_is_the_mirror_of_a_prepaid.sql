-- ============================================================
-- 347 · A DEFERRED REVENUE IS THE MIRROR OF A PREPAID (#111, MNE-001-299)
--
-- Revenue billed or collected before the service is rendered is a contract
-- liability (NIF D-1; IFRS 15 para 106; ASC 606), and an evenly rendered
-- service turns it into revenue month by month. That is the prepaid expense
-- of 059 seen from the other side: an amount, a coverage window, an account
-- pair frozen at creation, a convention frozen at creation, one row per
-- period with the entry that posted it. Only the direction of the entry
-- (DR liability / CR revenue, where a prepaid is DR expense / CR 1160) and
-- the sign of the backing (a credit balance) differ.
--
-- So the register gains a kind instead of a second pair of tables. Two pairs
-- would copy 059's schema and every guard the D1a attack forced on it (the
-- live-row predicate, the brake per schedule and period, the lock on the
-- account row, the card rebuilt from the posted sum), and the next defect
-- would have to be repaired twice.
--
-- The column names stay: prepaid_account_id is the balance-sheet account the
-- schedule runs down (1160, or the contract liability 2158) and
-- expense_account_id the income-statement account it runs into (an expense,
-- or revenue). Renaming them is the internal renaming parked until after the
-- MVP (#603, D-05); the comments below say what they hold.
--
-- NULL/backfill: none. The column is NOT NULL with a constant default, which
-- PostgreSQL 11+ stores without rewriting the table. Every row written
-- before 347 was created by `prepaid create`, which only adopts debits to
-- 1160, so 'prepaid_expense' is the truth for all of them.
--
-- CONTRACT: schema, compatible. Additive: one column with a default every
-- existing row satisfies, one CHECK, one index, comments. No data moves.
-- RLS: no new table; prepaid_expenses keeps the policy rls-policies.sql
-- already generates for it from its entity_id.
-- ============================================================

ALTER TABLE prepaid_expenses
    ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'prepaid_expense';

ALTER TABLE prepaid_expenses
    DROP CONSTRAINT IF EXISTS prepaid_expenses_kind_known,
    ADD CONSTRAINT prepaid_expenses_kind_known
        CHECK (kind IN ('prepaid_expense', 'deferred_revenue'));

-- The run, the close review and the lists read one kind of one entity.
CREATE INDEX IF NOT EXISTS idx_prepaid_expenses_entity_kind
    ON prepaid_expenses (entity_id, kind, status);

COMMENT ON TABLE prepaid_expenses IS
  'Calendar schedules over a balance already in the ledger (059, 347). kind = prepaid_expense: an asset (1160) amortized to expense (NIF C-5). kind = deferred_revenue: a contract liability recognized to revenue as the service is rendered (NIF D-1). This register never posts the original charge or credit: it always adopts a balance the ledger already holds.';

COMMENT ON COLUMN prepaid_expenses.kind IS
  'prepaid_expense: DR expense_account_id / CR prepaid_account_id each period. deferred_revenue: DR prepaid_account_id / CR expense_account_id each period, source_type deferred_revenue_recognition. Set at creation and never changed: the entries already posted were cut in that direction.';

COMMENT ON COLUMN prepaid_expenses.prepaid_account_id IS
  'The balance-sheet account the schedule runs down: 1160 (role gasto_anticipado) for a prepaid expense, the contract liability (role ingreso_cobrado_por_anticipado, 2158) for a deferred revenue. Frozen at creation.';

COMMENT ON COLUMN prepaid_expenses.expense_account_id IS
  'The income-statement account the schedule runs into: an expense (role gasto) for a prepaid expense, revenue (role ingreso) for a deferred revenue. Frozen at creation.';

COMMENT ON COLUMN prepaid_expenses.amortization_convention IS
  'Frozen at creation from amortizacion_anticipados_convencion (prepaid_expense) or deferred_revenue_recognition_convention (deferred_revenue). Not re-read per run: changing the cut mid-life would re-cut months already posted, and the ledger is immutable (041).';
