import type { Command } from 'commander';
import { resolveEntity, bootstrapTenant, type AgentContext } from '../ai/context.js';
import {
  createJob, listJobs, setEnabled, listRuns,
  JOB_KINDS, type JobKind, type JobRow, type JobRunRow,
} from '../ai/jobs/job-store.js';
import { runDueJobs, type RunAgentTurn } from '../ai/jobs/runner.js';

// ============================================================
// mnemosine jobs — persisted scheduled agent tasks.
// `jobs run-due` is the tick entry point: an external scheduler
// (cron/launchd) calls `mnemosine jobs run-due` and the runner
// claims due jobs atomically, gates them deterministically and
// wakes an isolated agent session only when there is work.
// All agent output lands as reviewable drafts/questions.
// ============================================================

export interface JobsDeps {
  palette: { dim: (s: string) => string; bold: (s: string) => string; cyan: (s: string) => string };
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
  /**
   * Wired by the CLI entry point: builds a fresh one-shot LlmSession for
   * the entity (capturing created drafts into `capture`) and runs the
   * prompt as a single turn. Keeps this module free of provider imports.
   */
  makeRunAgentTurn: (ctx: AgentContext) => RunAgentTurn;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
}

const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length));
const fmtDate = (d: Date | null): string => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '—');

function formatJobsTable(jobs: JobRow[], c: JobsDeps['palette']): string[] {
  if (jobs.length === 0) return ['No jobs configured. Create one with `mnemosine jobs create`.'];
  const out = [
    c.bold(
      `  ${pad('ID', 36)}  ${pad('NAME', 24)}  ${pad('KIND', 20)}  ${pad('SCHEDULE', 14)}  ` +
        `${pad('ENABLED', 8)}  ${pad('FAILS', 6)}  ${pad('NEXT RUN', 16)}`
    ),
  ];
  for (const j of jobs) {
    out.push(
      `  ${pad(j.id, 36)}  ${pad(j.name.slice(0, 24), 24)}  ${pad(j.kind, 20)}  ` +
        `${pad(j.schedule, 14)}  ${pad(j.enabled ? 'yes' : 'no', 8)}  ` +
        `${pad(`${j.consecutive_failures}/${j.max_failures}`, 6)}  ${pad(fmtDate(j.next_run_at), 16)}`
    );
  }
  return out;
}

function formatRunsTable(runs: JobRunRow[], c: JobsDeps['palette']): string[] {
  if (runs.length === 0) return ['No runs recorded yet.'];
  const out = [
    c.bold(
      `  ${pad('STARTED', 16)}  ${pad('JOB', 24)}  ${pad('STATUS', 16)}  ${pad('DRAFTS', 6)}  DETAIL`
    ),
  ];
  for (const r of runs) {
    const detail =
      r.detail && typeof r.detail === 'object'
        ? String((r.detail as { summary?: unknown; error?: unknown }).summary ??
            (r.detail as { error?: unknown }).error ?? '')
        : '';
    out.push(
      `  ${pad(fmtDate(r.started_at), 16)}  ${pad((r.job_name ?? r.job_id).slice(0, 24), 24)}  ` +
        `${pad(r.status, 16)}  ${pad(String(r.drafts_created), 6)}  ${c.dim(detail.slice(0, 80))}`
    );
  }
  return out;
}

export function registerJobsCommand(program: Command, deps: JobsDeps): void {
  const c = deps.palette;
  const jobs = program
    .command('jobs')
    .alias('tareas')
    .description('Persisted scheduled agent tasks (all output is reviewable drafts, never direct writes)');

  const withCommon = (cmd: Command): Command =>
    cmd
      .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
      .option('-t, --tenant <id>', 'Tenant');

  const resolve = async (opts: CommonOpts): Promise<AgentContext> => {
    bootstrapTenant(opts.tenant);
    return resolveEntity(opts.entity);
  };

  const run = (fn: (ctx: AgentContext, opts: never) => Promise<void>) =>
    async (opts: CommonOpts): Promise<void> => {
      try {
        const ctx = await resolve(opts);
        await fn(ctx, opts as never);
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    };

  withCommon(jobs.command('list'))
    .description('List the scheduled jobs of this entity')
    .action(run(async (ctx) => {
      for (const line of formatJobsTable(await listJobs(ctx), c)) console.log(line);
    }));

  withCommon(jobs.command('create'))
    .description('Create a scheduled job')
    .requiredOption('--name <name>', 'Job name (unique per entity)')
    .requiredOption('--kind <kind>', `Job kind: ${JOB_KINDS.join(' | ')}`)
    .requiredOption('--schedule <cron>', '5-field cron expression, e.g. "0 2 * * *" (nightly at 02:00)')
    .option('--max-failures <n>', 'Auto-disable after N consecutive failures (default 3)')
    .option('--user <email>', 'Who creates the job (audit)')
    .action(
      run(async (ctx, opts: { name: string; kind: string; schedule: string; maxFailures?: string; user?: string }) => {
        const job = await createJob(ctx, {
          name: opts.name,
          kind: opts.kind as JobKind,
          schedule: opts.schedule,
          maxFailures: opts.maxFailures ? parseInt(opts.maxFailures, 10) : undefined,
          createdBy: opts.user,
        });
        console.log(c.bold(`Job created: ${job.id}`));
        console.log(`  ${job.name} (${job.kind}) · schedule ${c.cyan(job.schedule)} · next run ${fmtDate(job.next_run_at)}`);
        console.log(c.dim('  Wire the tick: schedule `mnemosine jobs run-due` in cron/launchd.'));
      })
    );

  withCommon(jobs.command('enable'))
    .description('Enable a job (resets its failure counter and recomputes the next run)')
    .argument('<jobId>', 'Job id')
    .action(async (jobId: string, opts: CommonOpts) => {
      try {
        const ctx = await resolve(opts);
        const job = await setEnabled(ctx, jobId, true);
        console.log(`Job "${job.name}" enabled · next run ${fmtDate(job.next_run_at)}`);
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });

  withCommon(jobs.command('disable'))
    .description('Disable a job (it stays configured; runs stop)')
    .argument('<jobId>', 'Job id')
    .action(async (jobId: string, opts: CommonOpts) => {
      try {
        const ctx = await resolve(opts);
        const job = await setEnabled(ctx, jobId, false);
        console.log(`Job "${job.name}" disabled.`);
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });

  withCommon(jobs.command('run-due'))
    .description('Tick entry point: claim and run every due job (call this from cron/launchd)')
    .action(run(async (ctx) => {
      const outcomes = await runDueJobs(ctx, {
        runAgentTurn: deps.makeRunAgentTurn(ctx),
        onProgress: (m) => console.log(c.dim(m)),
      });
      if (outcomes.length === 0) {
        console.log('No jobs due.');
        return;
      }
      for (const o of outcomes) {
        const line = `  ${pad(o.name.slice(0, 24), 24)}  ${pad(o.status, 16)}  drafts: ${o.draftsCreated}  ${c.dim(o.detail.slice(0, 80))}`;
        console.log(line);
        if (o.autoDisabled) {
          console.log(c.bold(`  ⚠ Job "${o.name}" reached its failure limit and was auto-disabled. Re-enable with: mnemosine jobs enable ${o.jobId}`));
        }
        if (o.recordError) {
          console.log(c.bold(`  ⚠ Run of "${o.name}" could not be recorded in the history: ${o.recordError}`));
        }
      }
      const drafts = outcomes.reduce((sum, o) => sum + o.draftsCreated, 0);
      if (drafts > 0) {
        console.log(c.bold(`\n${drafts} draft(s) created — review them with \`mnemosine review\`.`));
      }
    }));

  withCommon(jobs.command('history'))
    .description('Execution log (most recent first)')
    .option('--job <jobId>', 'Only this job')
    .option('--limit <n>', 'Rows to show (default 20)')
    .action(run(async (ctx, opts: { job?: string; limit?: string }) => {
      const runs = await listRuns(ctx, {
        jobId: opts.job,
        limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      });
      for (const line of formatRunsTable(runs, c)) console.log(line);
    }));
}
