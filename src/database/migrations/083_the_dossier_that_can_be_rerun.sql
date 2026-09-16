-- ============================================================
-- 083 · THE DOSSIER THAT CAN BE RE-RUN (A6 · the close conductor)
--
-- A6 asks for a conductor, and it is born with its acceptance test already
-- nailed on: THE DOSSIER IT HANDS OVER HAS TO BE RE-RUNNABLE BY A THIRD PARTY
-- AND YIELD THE SAME FIGURES. Everything below exists to make that sentence
-- checkable by a machine, and nothing below exists for any other reason.
--
-- This file is written in English because `docs/language.md` rule 1 says what
-- is new is born English from day one, and it names migration files among what
-- that reaches. Its older siblings keep the titles they were born with until
-- I25 renames the Spanish ones with the migrator's legacy map; this one does
-- not need to be renamed later.
--
-- ── WHY THREE TABLES AND NOT ONE ────────────────────────────────────────
--
-- `closing_runs` is the RUN: one per close cycle of a period, reused by every
-- attempt of that cycle, with the state that makes `--resume` possible. `closing_run_steps` is what the run DID, one row
-- per step, accumulated across the attempts of that run. `closing_packs` is
-- the EVIDENCE: the dossier as it was handed over, with its seal, and the
-- registry `closing pack verify` asks to tell an issued seal from a forged one.
--
-- Folding the steps into a JSONB column of the run was the obvious shortcut
-- and it is wrong for a reason this repo already paid for: a step is
-- addressed, it has a UNIQUE that stops the same step from being recorded
-- twice, and a JSONB array has neither.
--
-- ── THE RUN DOES NOT OWN THE IDEMPOTENCY ────────────────────────────────
--
-- Every engine the conductor drives refuses to post the same month twice on
-- its own terms: depreciation asks the ledger (`is_posted` of ANY book,
-- `depreciation.ts`), amortization asks the schedule, provisions ask
-- `benefit_provision_schedules`. That is why the conductor can — and does —
-- run every step again on every attempt: a step already posted comes back
-- with nothing to do, and a step that had nothing to do the first time (no
-- payroll loaded yet, no asset registered yet) gets its chance. The step row
-- is history and never a guard: deleting it double-posts nothing.
--
-- ── ONE OPEN RUN PER PERIOD, MANY CLOSED ONES ───────────────────────────
--
-- `uq_closing_run_open` allows exactly one run in a resumable state per
-- (entity, period). A finished run stays as history, so a period that is
-- reopened and closed again has two runs and the dossiers say which is which.
-- Two operators conducting the SAME period at the SAME time are kept apart by
-- a transaction-scoped advisory lock the conductor holds for the whole call,
-- and by the run's heartbeat when that lock's connection dies mid-run — not
-- by this index. A run whose cycle was closed by another path is marked
-- `abandoned` before a new one opens, so this index never makes a reopened
-- period continue the previous cycle's run.
--
-- ── THE DOSSIER IS APPEND-ONLY, LIKE THE LOG IT RESEMBLES ───────────────
--
-- A dossier that can be rewritten proves nothing, which is the same sentence
-- migration 033 wrote about `audit_log`. So `closing_packs` gets the trigger
-- that rejects UPDATE, DELETE and TRUNCATE — reaching the schema owner too,
-- whom table privileges do not stop. The trigger lives HERE and nowhere else:
-- nothing re-creates it if someone drops it by hand. The cheap layer is the
-- privilege, and its name enters the `append_only` array of
-- `src/database/rls-policies.sql` — which `npm run migrate` applies once after
-- the migrations it ran, handing the UPDATE back to any table not listed —
-- and the one of `scripts/provision-roles.sql`, which runs when roles are
-- re-provisioned. Criterion `append-only-triggers-match-grants` fails if
-- those three places stop saying the same thing.
--
-- A correction is a NEW dossier with a new seal, exactly as a correction in
-- the ledger is a new entry. The old one keeps standing: "what we said in
-- March" is evidence even after March turned out to be wrong.
--
-- ── NO tenant_id COLUMN, ON PURPOSE ─────────────────────────────────────
--
-- The first loop of `rls-policies.sql` picks the policy by the columns a table
-- has. A table WITH `tenant_id` gets `tenant_id = app_current_tenant()`, and
-- that predicate never ties `entity_id` to the tenant: a row carrying MY
-- tenant and ANOTHER tenant's entity passes it, and a foreign key's check does
-- not go through RLS. With the global `uq_closing_run_open`, that was enough
-- for one tenant to plant an invisible open run on another tenant's period and
-- block its close. A table with `entity_id` alone gets
-- `entity_id IN (SELECT id FROM legal_entities WHERE tenant_id = …)`, which
-- refuses exactly that row. The same shape 059 and 079 already have.
--
-- ── THE ENTITY TRAVELS IN THE FOREIGN KEYS ──────────────────────────────
--
-- Lesson already paid for in 059 and 079: a row cannot point at another
-- entity's period or another entity's run, and not because a query remembers
-- to filter — because Postgres refuses.
-- ============================================================

CREATE TABLE closing_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    fiscal_period_id UUID NOT NULL,

    -- A call of the conductor walks every step it can in one go, so these
    -- states describe where the LAST call left the run:
    --   running   — a call is in progress, or one died mid-run (a crash
    --               leaves it here; the heartbeat below tells the two apart)
    --   blocked   — the checklist had blocking items; resumable
    --   stopped   — the operator asked for --stop-at; resumable
    --   completed — every step took its turn and the period is soft-closed
    --   failed    — a step raised, or an engine returned per-row errors;
    --               resumable once the cause is fixed
    --   abandoned — the period was soft-closed by another path after this
    --               run started (by hand, or a conductor that died after
    --               closing): its close cycle is over, and a reopen starts a
    --               new run instead of merging two cycles into this one
    status VARCHAR(20) NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'blocked', 'stopped', 'completed', 'failed', 'abandoned')),

    -- The step the run did not get past. NULL on a completed run, which is
    -- the only state that has no next step.
    halted_at_step VARCHAR(40),

    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    started_by UUID,

    -- Written by the conductor, outside its lock's transaction, for as long as
    -- it acts on the run. The advisory lock cannot tell a conductor that died
    -- from one that lost its lock connection and is still finishing a step —
    -- the lock is free in both cases —, and continuing the second would put two
    -- conductors on one month. A `running` run heard from recently is live and
    -- is not resumed; one silent for longer than the window is a dead one's.
    heartbeat_at TIMESTAMPTZ,

    -- Which call of the conductor claimed the run. Every write a conductor
    -- makes to its run — the heartbeat, a step's record, the end of the run —
    -- carries it, so a conductor that was paused past the window and taken
    -- over cannot write into the run its successor is conducting. A random
    -- value per call; it identifies nobody, and `started_by` says who.
    conductor_token UUID,

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

-- At most one resumable run per period. There is never a question of WHICH
-- run `closing run --resume` continues.
CREATE UNIQUE INDEX uq_closing_run_open
    ON closing_runs (entity_id, fiscal_period_id)
    WHERE status IN ('running', 'blocked', 'stopped', 'failed');

CREATE INDEX idx_closing_runs_period ON closing_runs (entity_id, fiscal_period_id);

CREATE TABLE closing_run_steps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    run_id UUID NOT NULL,

    -- The stable key of the step (`accrue-benefits`, `soft-close`, …). It is
    -- a contract: `--stop-at` takes it and `src/plan/criterios.ts` reads the
    -- same list out of the conductor.
    step_key VARCHAR(40) NOT NULL,
    ordinal SMALLINT NOT NULL CHECK (ordinal > 0),

    -- The outcome of the LATEST attempt, except that a step that did work in
    -- an earlier attempt (a `done`, or a `failed` with something processed)
    -- is never demoted to `skipped` by a later attempt that found nothing
    -- left:
    --   done    — the step did something, in this or an earlier attempt
    --   skipped — there was nothing to do
    --   blocked — the step refused: the close cannot go past it yet
    --   failed  — the step raised, or its engine returned per-row errors
    status VARCHAR(20) NOT NULL
        CHECK (status IN ('done', 'skipped', 'blocked', 'failed')),

    -- Accumulated across attempts: what the engines report having processed.
    processed INTEGER NOT NULL DEFAULT 0 CHECK (processed >= 0),

    -- Money, like all money here: DECIMAL(19,4), never a float. Accumulated
    -- across attempts. NULLABLE on purpose: zero means the step moved nothing,
    -- NULL means its engine does not report a total at all —
    -- `runMonthlyDepreciation` returns a count and a list of errors, and a 0
    -- there would be a figure nobody computed. The dossier does not read this
    -- column: its numbers come from the ledger.
    amount DECIMAL(19,4)
        CONSTRAINT closing_step_amount_not_negative CHECK (amount IS NULL OR amount >= 0),

    -- The entries the step's engine has POSTED in this period, read back from
    -- the ledger by `source_type` after every attempt — not the ids an attempt
    -- happened to return. An attempt that crashed between posting and writing
    -- this row loses nothing: the next attempt reads the ledger again.
    journal_entry_ids UUID[] NOT NULL DEFAULT '{}',

    detail TEXT NOT NULL,
    ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- THE STEP IS ADDRESSED: one row per step per run, upserted by every
    -- attempt.
    CONSTRAINT uq_closing_run_step UNIQUE (run_id, step_key),

    CONSTRAINT fk_closing_step_run_entity
        FOREIGN KEY (run_id, entity_id)
        REFERENCES closing_runs (id, entity_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_closing_run_steps_run ON closing_run_steps (run_id, ordinal);

CREATE TABLE closing_packs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    fiscal_period_id UUID NOT NULL,
    run_id UUID,

    -- SHA-256 over the canonical form of the SEALED BODY, hex, lowercase.
    -- The hash is not keyed: anyone can recompute it, which is the point for a
    -- third party and also why the seal alone cannot prove ORIGIN. Origin is
    -- this table — `closing pack verify` asks it whether these books ever
    -- issued a dossier with that seal.
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
CREATE INDEX idx_closing_packs_seal ON closing_packs (seal);

-- ── Append-only, with the two layers ──────────────────────────────────

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
  'Rejects UPDATE, DELETE and TRUNCATE on closing_packs. Reaches the schema owner too, whom table privileges do not stop.';

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
  'One run of the close conductor over a period. At most one row per (entity, period) is resumable; concurrent calls are kept apart by an advisory lock.';
COMMENT ON TABLE closing_run_steps IS
  'What the conductor did, one row per step per run, accumulated across attempts. History, never a guard: the engines keep their own.';
COMMENT ON TABLE closing_packs IS
  'The dossier as it was handed over, with the SHA-256 of its sealed body. Append-only, and the registry that tells an issued seal from a forged one.';
COMMENT ON COLUMN closing_packs.seal IS
  'Unkeyed SHA-256 of the canonical sealed body — figures, identity, criteria and the as-of date; never the clock, or no third party could reproduce it.';
