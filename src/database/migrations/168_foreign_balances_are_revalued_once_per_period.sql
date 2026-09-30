-- ============================================================
-- 168 · FOREIGN BALANCES ARE REVALUED ONCE PER PERIOD (#305, MNE-001-083)
--
-- `closing fx revalue` posts the unrealised exchange difference of the open
-- foreign-currency receivables, payables and bank balances (NIF B-15) as an
-- adjusting entry on the period's last day, and its mirror on day 1 of the
-- next period. This table is the run's own idempotency marker.
--
-- WHY THE LEDGER CANNOT BE THE MARKER: the conductor counts an original that
-- was reversed as "not done" (closing-conductor.ts, `postedBy`), and every
-- revaluation is reversed by design. Asking the ledger "is there an unreversed
-- revaluation in this period?" would answer no after every run, and a resumed
-- run would post it again. One row per (entity, period), refused twice by the
-- UNIQUE, says it was done whatever happened to its entries afterwards.
--
-- A period with nothing to revalue writes no row: running it again once a
-- foreign balance exists is the right answer, not a double post.
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
    -- The day whose published rate was used: the period's last calendar day.
    rate_date DATE NOT NULL,
    -- {"USD": {"rate": "18.2000000000", "source": "dof"}}: what each currency
    -- was revalued at, so the entry can be rebuilt without guessing.
    rates JSONB NOT NULL,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_fx_revaluation_run_period UNIQUE (entity_id, fiscal_period_id),
    CONSTRAINT fk_fx_revaluation_period_entity
        FOREIGN KEY (fiscal_period_id, entity_id) REFERENCES fiscal_periods (id, entity_id),
    CONSTRAINT fk_fx_revaluation_entry_entity
        FOREIGN KEY (journal_entry_id, entity_id) REFERENCES journal_entries (id, entity_id),
    CONSTRAINT fk_fx_revaluation_reversal_entity
        FOREIGN KEY (reversal_entry_id, entity_id) REFERENCES journal_entries (id, entity_id)
);

COMMENT ON TABLE fx_revaluation_runs IS
  'Idempotency marker of closing fx revalue: one row per entity and period whose foreign balances were revalued (NIF B-15), with the rates used and the adjusting entry and its day-1 reversal (#305).';
