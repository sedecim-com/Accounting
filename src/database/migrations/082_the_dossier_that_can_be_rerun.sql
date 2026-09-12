-- ============================================================
-- 082 · THE DOSSIER THAT CAN BE RE-RUN (A6 · the close conductor)
--
-- A6 asks for a conductor, and it is born with its acceptance test already
-- nailed on: THE DOSSIER IT HANDS OVER HAS TO BE RE-RUNNABLE BY A THIRD PARTY
-- AND YIELD THE SAME FIGURES. Everything below exists to make that sentence
-- checkable by a machine, and nothing below exists for any other reason.
--
-- This file is written in English because `docs/language.md` rule 1 says what
-- is new is born English from day one, and it names migration files among what
-- that reaches. The eighty-one siblings keep their Spanish titles until I25
-- renames them all at once with the migrator's legacy map; this one does not
-- need to be renamed later.
--
-- ── WHY THREE TABLES AND NOT ONE ────────────────────────────────────────
--
-- `closing_runs` is the RUN: one per period per attempt, with the state that
-- makes `--resume` possible. `closing_run_steps` is what the run DID, one row
-- per step, and it is the only reason a resumed run can tell "already done"
-- from "never ran" without asking five engines. `closing_packs` is the
-- EVIDENCE: the dossier as it was handed over, with its seal.
--
-- Folding the steps into a JSONB column of the run was the obvious shortcut
-- and it is wrong for a reason this repo already paid for: a step is
-- addressed, it has a UNIQUE that stops the same step from being recorded
-- twice, and a JSONB array has neither. The conductor's whole idempotency
-- rests on `uq_closing_run_step`.
--
-- ── THE RUN DOES NOT OWN THE IDEMPOTENCY, IT ONLY MAKES IT CHEAP ────────
--
-- Every engine the conductor drives already refuses to run the same month
-- twice on its own terms: depreciation asks the ledger (`is_posted` of ANY
-- book, `depreciation.ts`), amortization asks the schedule, provisions ask
-- `benefit_provision_schedules`. The step row is a FAST PATH and an audit
-- trail, never the only guard — if it were, deleting a row would double-post
-- a month. It cannot: the engines would still refuse.
--
-- ── ONE OPEN RUN PER PERIOD, MANY CLOSED ONES ───────────────────────────
--
-- `uq_closing_run_open` allows exactly one run in a resumable state per
-- (entity, period). A finished run stays as history, so a period that is
-- reopened and closed again has two runs and the dossiers say which is which.
-- The alternative — one run per period, ever — would have made the second
-- close overwrite the evidence of the first.
--
-- ── THE DOSSIER IS APPEND-ONLY, LIKE THE LOG IT RESEMBLES ───────────────
--
-- A dossier that can be rewritten proves nothing, which is the same sentence
-- migration 033 wrote about `audit_log`. So `closing_packs` gets the trigger
-- that rejects UPDATE and DELETE — reaching the schema owner too, whom table
-- privileges do not stop — and its name enters the two `append_only` arrays
-- (`src/database/rls-policies.sql`, `scripts/provision-roles.sql`) that run
-- after every migration and would otherwise hand the UPDATE straight back.
-- Criterion `append-only-triggers-match-grants` fails if those three places
-- stop saying the same thing.
--
-- A correction is a NEW dossier with a new seal, exactly as a correction in
-- the ledger is a new entry. The old one keeps standing: "what we said in
-- March" is evidence even after March turned out to be wrong.
--
-- ── THE ENTITY TRAVELS IN THE FOREIGN KEYS ──────────────────────────────
--
-- Lesson already paid for in 059 and 079: a row cannot point at another
-- entity's period or another entity's run, and not because a query remembers
-- to filter — because Postgres refuses. `entity_id` is its OWN column and not
-- derived by JOIN, which is what makes the first loop of `rls-policies.sql`
-- generate the isolation policy by itself.
-- ============================================================

CREATE TABLE closing_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    fiscal_period_id UUID NOT NULL,

    -- 'running' is the state a run is left in while it still has steps to
    -- take: the conductor returns to the operator between steps, so a run
    -- waiting for a blocker to be cleared is NOT a failure.
    --   running   — open, resumable
    --   blocked   — the checklist still has blocking items; resumable
    --   stopped   — the operator asked for --stop-at; resumable
    --   completed — every step took its turn and the period is soft-closed
    --   failed    — a step raised; resumable once the cause is fixed
    status VARCHAR(20) NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'blocked', 'stopped', 'completed', 'failed')),

    -- The step the run did not get past, and why the operator will care.
    -- NULL on a completed run, which is the only state that has no next step.
    halted_at_step VARCHAR(40),

    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    started_by UUID,

    CONSTRAINT fk_closing_run_period_entity
        FOREIGN KEY (fiscal_period_id, entity_id)
        REFERENCES fiscal_periods (id, entity_id),

    -- A completed run has an end. An open one does not claim to have had one.
    CONSTRAINT closing_run_completed_has_end
        CHECK (status <> 'completed' OR ended_at IS NOT NULL),
    CONSTRAINT closing_run_completed_has_no_next_step
        CHECK (status <> 'completed' OR halted_at_step IS NULL)
);

-- The composite target the run's children point at. Same shape as
-- `uq_fiscal_periods_id_entity` (059) and `uq_journal_entries_id_entity` (079).
CREATE UNIQUE INDEX IF NOT EXISTS uq_closing_runs_id_entity
    ON closing_runs (id, entity_id);

-- At most one resumable run per period. The partial index is the whole
-- mechanism behind `closing run --resume`: there is never a question of WHICH
-- run to resume.
CREATE UNIQUE INDEX uq_closing_run_open
    ON closing_runs (entity_id, fiscal_period_id)
    WHERE status IN ('running', 'blocked', 'stopped', 'failed');

CREATE INDEX idx_closing_runs_period ON closing_runs (entity_id, fiscal_period_id);

CREATE TABLE closing_run_steps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    run_id UUID NOT NULL,

    -- The stable key of the step (`accrue-benefits`, `soft-close`, …). It is
    -- a contract: the dossier quotes it, `--stop-at` takes it, and
    -- `src/plan/criterios.ts` reads the same list out of the conductor.
    step_key VARCHAR(40) NOT NULL,
    ordinal SMALLINT NOT NULL CHECK (ordinal > 0),

    --   done    — the step ran and did something
    --   skipped — the step ran and there was nothing to do (or it was
    --             already done in an earlier attempt of this run)
    --   blocked — the step refused: the close cannot go past it yet
    --   failed  — the step raised
    status VARCHAR(20) NOT NULL
        CHECK (status IN ('done', 'skipped', 'blocked', 'failed')),

    processed INTEGER NOT NULL DEFAULT 0 CHECK (processed >= 0),

    -- Money, like all money here: DECIMAL(19,4), never a float. NULLABLE on
    -- purpose, and the distinction is not pedantry: zero means the step moved
    -- nothing (a month with nothing to accrue), NULL means the engine does not
    -- report a total at all — `runMonthlyDepreciation` returns a count and a
    -- list of errors, and writing 0 there would have been a figure nobody
    -- computed. The dossier does not read this column anyway: its numbers come
    -- from the ledger, which is the only source a third party can re-run.
    amount DECIMAL(19,4)
        CONSTRAINT closing_step_amount_not_negative CHECK (amount IS NULL OR amount >= 0),

    -- What the step posted, if anything. An array and not a single id
    -- because amortization posts one entry per prepaid while provisions post
    -- exactly one for the whole payroll.
    journal_entry_ids UUID[] NOT NULL DEFAULT '{}',

    detail TEXT NOT NULL,
    ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- THE STEP IS ADDRESSED. This is the constraint the conductor's
    -- idempotency stands on: the same step cannot be recorded twice in the
    -- same run, so a resumed run reads its rows and knows what is left.
    CONSTRAINT uq_closing_run_step UNIQUE (run_id, step_key),

    CONSTRAINT fk_closing_step_run_entity
        FOREIGN KEY (run_id, entity_id)
        REFERENCES closing_runs (id, entity_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_closing_run_steps_run ON closing_run_steps (run_id, ordinal);

CREATE TABLE closing_packs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    fiscal_period_id UUID NOT NULL,
    run_id UUID,

    -- SHA-256 over the canonical form of the SEALED BODY, hex, lowercase.
    -- The CHECK is not decoration: a seal that is not a hash is a seal nobody
    -- can recompute, and `closing pack verify` would have no way to say so.
    seal CHAR(64) NOT NULL
        CONSTRAINT closing_pack_seal_is_sha256 CHECK (seal ~ '^[0-9a-f]{64}$'),

    -- The dossier exactly as it was handed over, envelope included. Stored
    -- whole, like `sat_anexo24_artefactos` (062) stores the XML it stamped:
    -- an artifact that only exists in the auditor's folder is an artifact the
    -- firm cannot answer questions about.
    body JSONB NOT NULL,

    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    generated_by UUID,

    CONSTRAINT fk_closing_pack_period_entity
        FOREIGN KEY (fiscal_period_id, entity_id)
        REFERENCES fiscal_periods (id, entity_id),
    CONSTRAINT fk_closing_pack_run_entity
        FOREIGN KEY (run_id, entity_id)
        REFERENCES closing_runs (id, entity_id)
);

CREATE INDEX idx_closing_packs_period
    ON closing_packs (entity_id, fiscal_period_id, generated_at DESC);

-- ── Append-only, with the two layers ──────────────────────────────────
-- The trigger is the one that holds: it reaches the schema owner, whom the
-- GRANT does not stop. The privilege is the cheap layer, and it is restored
-- by `rls-policies.sql` on every migrate run, which is why the table name has
-- to be in its `append_only` array too.

CREATE OR REPLACE FUNCTION public.closing_packs_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RAISE EXCEPTION
    'closing_packs is append-only: % rejected. A dossier that can be rewritten proves nothing; correct it by generating a new one, whose seal says it is new.',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;

COMMENT ON FUNCTION public.closing_packs_append_only() IS
  'Rejects UPDATE and DELETE on closing_packs. Reaches the schema owner too, whom table privileges do not stop.';

DROP TRIGGER IF EXISTS closing_packs_append_only ON public.closing_packs;

CREATE TRIGGER closing_packs_append_only
  BEFORE UPDATE OR DELETE ON public.closing_packs
  FOR EACH ROW
  EXECUTE FUNCTION public.closing_packs_append_only();

-- A TRUNCATE does not fire FOR EACH ROW triggers: it needs its own.
DROP TRIGGER IF EXISTS closing_packs_no_truncate ON public.closing_packs;

CREATE TRIGGER closing_packs_no_truncate
  BEFORE TRUNCATE ON public.closing_packs
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.closing_packs_append_only();

DO $privileges$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnemosine_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON public.closing_packs FROM mnemosine_app;
  END IF;
END
$privileges$;

COMMENT ON TABLE closing_runs IS
  'One attempt at conducting a period close. Resumable: at most one row per (entity, period) is in a resumable state, which is what --resume resolves without asking.';
COMMENT ON TABLE closing_run_steps IS
  'What the conductor did, one row per step. The UNIQUE (run_id, step_key) is the fast path of the conductor idempotency; the engines keep their own guards.';
COMMENT ON TABLE closing_packs IS
  'The dossier as it was handed over, with the SHA-256 of its sealed body. Append-only: a correction is a new dossier, never a rewrite of the old one.';
COMMENT ON COLUMN closing_packs.seal IS
  'SHA-256 of the canonical form of the sealed body — figures, criteria and the as-of date; never the clock, or no third party could reproduce it.';
