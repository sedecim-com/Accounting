-- ============================================================
-- 022: PERSISTED AGENT JOBS (cron) + EXECUTION LOG
-- Scheduled agent tasks (nightly close verification, CFDI-vs-
-- ledger reconciliation, AR reminders) become first-class rows:
-- the schedule, the enable switch and every run live in Postgres,
-- so RLS gives tenant isolation and a free audit trail.
--
-- The job runner NEVER writes the ledger: each run wakes an
-- isolated agent session whose only outputs are reviewable
-- drafts/questions through the staged tools. A deterministic
-- wake-gate runs first — no work means the LLM is never invoked
-- and the run is logged as 'skipped_no_work'.
--
-- Single-runner safety: claiming a due job is one guarded UPDATE
-- (WHERE next_run_at <= NOW() AND enabled ... RETURNING), the
-- same atomic-claim pattern as ai_external_ops (014).
--
-- Auto-disable: consecutive_failures increments on 'error' runs
-- and the job flips enabled = false when it reaches max_failures;
-- a successful run resets the counter.
--
-- RLS: like every tenant-scoped table, the policies come from
-- src/database/rls-policies.sql, which migrate.ts re-applies
-- after every migration (tenant_id NOT NULL on both tables is
-- what opts them in).
-- ============================================================

CREATE TABLE ai_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),

    name VARCHAR(120) NOT NULL,
    kind VARCHAR(50) NOT NULL CHECK (kind IN (
        'close_verification', 'cfdi_reconciliation', 'ar_reminders'
    )),

    -- 5-field cron expression (minute hour dom month dow); parsed by
    -- the application's minimal matcher (src/ai/jobs/job-store.ts).
    schedule VARCHAR(100) NOT NULL,

    enabled BOOLEAN NOT NULL DEFAULT true,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    max_failures INTEGER NOT NULL DEFAULT 3 CHECK (max_failures > 0),

    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ,

    created_by VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(entity_id, name)
);

-- The tick query: enabled jobs whose next run is due.
CREATE INDEX idx_ai_jobs_due ON ai_jobs(enabled, next_run_at);
CREATE INDEX idx_ai_jobs_entity ON ai_jobs(entity_id);

CREATE TABLE ai_job_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),

    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,

    status VARCHAR(50) NOT NULL CHECK (status IN (
        'ok', 'skipped_no_work', 'error'
    )),

    -- Wake-gate summary, agent outcome or error message.
    detail JSONB,
    drafts_created INTEGER NOT NULL DEFAULT 0,

    CHECK (drafts_created >= 0)
);

CREATE INDEX idx_ai_job_runs_job ON ai_job_runs(job_id, started_at DESC);
CREATE INDEX idx_ai_job_runs_entity ON ai_job_runs(entity_id, started_at DESC);
