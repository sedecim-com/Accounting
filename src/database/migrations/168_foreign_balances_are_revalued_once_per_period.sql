-- ============================================================
-- 168 · FOREIGN BALANCES ARE REVALUED ONCE PER PERIOD (#305, MNE-001-083)
--
-- `closing fx revalue` posts the unrealised exchange difference of the open
-- foreign-currency receivables, payables and bank balances (NIF B-15) as an
-- adjusting entry on the period's last day, and its mirror on day 1 of the
-- next period. This table is the run's own idempotency marker: one row per
-- run that posted, numbered by `sequence` within the period.
--
-- WHY THE LEDGER CANNOT BE THE MARKER: the conductor counts an original that
-- was reversed as "not done" (closing-conductor.ts, `postedBy`), and every
-- revaluation is reversed by design. Asking the ledger "is there an unreversed
-- revaluation in this period?" would answer no after every run, and a resumed
-- run would post it again. The rows of a period say what was done whatever
-- happened to its entries afterwards.
--
-- A period with nothing to revalue writes no row: running it again once a
-- foreign balance exists is the right answer, not a double post.
--
-- WHY MORE THAN ONE ROW PER PERIOD: the period stays open (or soft-closed)
-- after the run, so a foreign-currency posting dated inside it can still land
-- and leave the revaluation stale. The next run recomputes, subtracts what the
-- earlier runs of the period already posted (their `lines`), and posts only
-- the difference as a supplementary entry with its own day-1 mirror, under the
-- next `sequence`. A run with nothing left to post writes no row.
--
-- A TAMPERED MARKER IS REFUSED, NOT TRUSTED: the rows are what stops a second
-- full post, so a DELETE, or an UPDATE that repoints a row or rewrites its
-- `lines`, would reopen that door. The engine checks the rows against the
-- ledger, which migration 041 already makes inviolable: the period's
-- `fx_revaluation` entries must be exactly the rows' entries, and their net
-- per account what the rows say, or the run stops
-- (FX_REVALUATION_MARKER_MISMATCH). An append-only trigger here would also
-- need the table in the `append_only` arrays of rls-policies.sql and
-- provision-roles.sql (criterion append-only-triggers-match-grants), which
-- takes the owner's approval; it is left to them.
--
-- The entity travels in every foreign key (the lesson of 059, 079 and 083):
-- a run cannot point at another entity's period or entries. No tenant_id
-- column, for the reason 083 gives: RLS scopes a table with entity_id alone
-- through legal_entities.
-- ============================================================

CREATE TABLE fx_revaluation_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    fiscal_period_id UUID NOT NULL,
    journal_entry_id UUID NOT NULL,
    reversal_entry_id UUID NOT NULL,
    -- 1 for the period's first run, then one more per supplementary run.
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    -- The day whose published rate was used: the period's last calendar day.
    rate_date DATE NOT NULL,
    -- {"USD": {"rate": "18.2000000000", "source": "dof"}}: what each currency
    -- was revalued at, so the entry can be rebuilt without guessing.
    rates JSONB NOT NULL,
    -- [{"accountId", "accountCode", "currency", "difference"}]: what this run
    -- posted per account and currency, which the next run subtracts.
    lines JSONB NOT NULL,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_fx_revaluation_run_period UNIQUE (entity_id, fiscal_period_id, sequence),
    CONSTRAINT fk_fx_revaluation_period_entity
        FOREIGN KEY (fiscal_period_id, entity_id) REFERENCES fiscal_periods (id, entity_id),
    CONSTRAINT fk_fx_revaluation_entry_entity
        FOREIGN KEY (journal_entry_id, entity_id) REFERENCES journal_entries (id, entity_id),
    CONSTRAINT fk_fx_revaluation_reversal_entity
        FOREIGN KEY (reversal_entry_id, entity_id) REFERENCES journal_entries (id, entity_id)
);

COMMENT ON TABLE fx_revaluation_runs IS
  'Idempotency marker of closing fx revalue: one row per run that posted a revaluation of an entity''s period (NIF B-15), numbered by sequence, with the rates used, what it posted per account and currency, and the adjusting entry and its day-1 reversal (#305). Checked against the ledger on every run.';
