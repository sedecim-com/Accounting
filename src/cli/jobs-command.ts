import type { Command } from 'commander';
import { resolveEntity, bootstrapTenant, type AgentContext } from '../ai/context.js';
import {
  createJob, listJobs, getJob, setEnabled, listRuns,
  JOB_KINDS, type JobKind, type JobRow, type JobRunRow,
} from '../ai/jobs/job-store.js';
import { adoptJob, unadoptJob, adoptedJobIds, readAdoptions, adoptionPath } from '../ai/jobs/adoption.js';
import { readRunDueScope } from '../ai/providers/config.js';
import { runDueJobs, type RunAgentTurn } from '../ai/jobs/runner.js';
import { declareRisk, gateMutation } from './kernel/risk.js';
import { exitCodeFor, notFound, usageError } from './kernel/index.js';
import { argumentByKey, describeCommand, optionByKey } from './kernel/help.js';
import { t } from '../i18n/index.js';
import { calendarDateTimeIn } from '../utils/calendar-date.js';
import { zoneFor } from '../services/policy/today.js';
import { tickCredentialLine } from './provider-readiness.js';
import { assertDefaultNotOnTrial } from '../ai/providers/trial-endpoint.js';

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
   * `opciones.externo` decides the unattended tool surface: with --live the
   * full SUPERFICIE_DESATENDIDA travels; without it, the sandbox variant
   * (same surface minus the reads against the client's external system).
   */
  makeRunAgentTurn: (ctx: AgentContext, opciones?: { externo?: boolean }) => RunAgentTurn;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
}

const ADOPT_EXAMPLES = `
Examples:
  # Adopt a job of this entity: with "jobs": { "run_due": "adopted" } in
  # ~/.mnemosine/config.json, your jobs run-due runs only the jobs you adopted.
  mnemosine jobs adopt 00000000-0000-4000-8000-000000000001
  # The jobs you adopted here, and the value of jobs.run_due.
  mnemosine jobs adopt --list
`;

const UNADOPT_EXAMPLES = `
Examples:
  # Stop adopting a job: with jobs.run_due set to "adopted", your tick no longer runs it.
  mnemosine jobs unadopt 00000000-0000-4000-8000-000000000001
`;

const CREATE_EXAMPLES = `
Examples:
  # A nightly close check at 02:00; it is adopted for you as it is created.
  mnemosine jobs create --name nightly-close --kind close_verification --schedule "0 2 * * *"
`;

const ENABLE_EXAMPLES = `
Examples:
  # Re-enable a job its failure limit disabled.
  mnemosine jobs enable 00000000-0000-4000-8000-000000000001
`;

const DISABLE_EXAMPLES = `
Examples:
  # Stop a job's runs and keep its configuration.
  mnemosine jobs disable 00000000-0000-4000-8000-000000000001
`;

const RUN_DUE_EXAMPLES = `
Examples:
  # What this tick would run, and skip, claiming nothing.
  mnemosine jobs run-due --dry-run
  # The tick for cron/launchd, with the reads against the client's external system.
  mnemosine jobs run-due --live
Which due jobs it runs on your credential is jobs.run_due in ~/.mnemosine/config.json:
"adopted" (only the jobs you adopted) or "all" (every due job of the entity).
`;

const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length));
const fmtDate = (d: Date | null, zone: string): string => (d ? calendarDateTimeIn(zone, d) : '—');

function formatJobsTable(jobs: JobRow[], c: JobsDeps['palette'], zone: string): string[] {
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
        `${pad(`${j.consecutive_failures}/${j.max_failures}`, 6)}  ${pad(fmtDate(j.next_run_at, zone), 16)}`
    );
  }
  return out;
}

function formatRunsTable(runs: JobRunRow[], c: JobsDeps['palette'], zone: string): string[] {
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
      `  ${pad(fmtDate(r.started_at, zone), 16)}  ${pad((r.job_name ?? r.job_id).slice(0, 24), 24)}  ` +
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

  // The same two flags, with their help by key, for the leaves born keyed.
  const withKeyedCommon = (cmd: Command): Command => {
    optionByKey(cmd, '-e, --entity <idOrName>', 'cli.flag.entity');
    return optionByKey(cmd, '-t, --tenant <id>', 'cli.flag.tenant_scope');
  };

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
        await deps.shutdown(exitCodeFor(err));
      }
    };

  withCommon(jobs.command('list'))
    .description('List the scheduled jobs of this entity')
    .action(run(async (ctx) => {
      for (const line of formatJobsTable(await listJobs(ctx), c, await zoneFor(ctx))) console.log(line);
    }));

  withCommon(jobs.command('create'))
    .description('Create a scheduled job')
    .requiredOption('--name <name>', 'Job name (unique per entity)')
    .requiredOption('--kind <kind>', `Job kind: ${JOB_KINDS.join(' | ')}`)
    .requiredOption('--schedule <cron>', '5-field cron expression, e.g. "0 2 * * *" (nightly at 02:00)')
    .option('--max-failures <n>', 'Auto-disable after N consecutive failures (default 3)')
    .option('--user <email>', 'Who creates the job (audit)')
    .addHelpText('after', CREATE_EXAMPLES)
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
        console.log(`  ${job.name} (${job.kind}) · schedule ${c.cyan(job.schedule)} · next run ${fmtDate(job.next_run_at, await zoneFor(ctx))}`);
        // Adopted for its creator (MNE-001-453): an operator who chose
        // `jobs.run_due = adopted` keeps their own new jobs running.
        try {
          adoptJob({ id: job.id, entityId: ctx.entityId });
          console.log(c.dim(t('platform.jobs.create.adopted')));
        } catch (err) {
          process.stderr.write(`${t('platform.jobs.create.adopt_failed', { error: (err as Error).message, id: job.id })}\n`);
        }
        console.log(c.dim('  Wire the tick: schedule `mnemosine jobs run-due` in cron/launchd.'));
      })
    );

  // MNE-001-453 (#646): the jobs this operator adopted, under their own home.
  const adopt = withKeyedCommon(describeCommand(jobs.command('adopt').alias('adoptar'), 'help.jobs.adopt.description'));
  argumentByKey(adopt, '[jobId]', 'help.jobs.adopt.argument.job_id');
  optionByKey(adopt, '--list', 'help.jobs.adopt.option.list');
  declareRisk(adopt, { risk: 'escritura', agent: false, writes: "~/.mnemosine/adopted-jobs.json, the operator's own (never the database)" });
  adopt.addHelpText('after', ADOPT_EXAMPLES);
  adopt.action(async (jobId: string | undefined, opts: CommonOpts & { list?: boolean }) => {
    try {
      if (Boolean(jobId) === Boolean(opts.list)) throw usageError({ key: 'platform.jobs.adopt.id_xor_list' });
      const ctx = await resolve(opts);
      if (opts.list) {
        const scope = readRunDueScope();
        const mine = readAdoptions().filter((a) => a.entityId === ctx.entityId);
        if (mine.length === 0) {
          console.log(t('platform.jobs.adopt.list.none'));
        } else {
          const names = new Map((await listJobs(ctx)).map((j) => [j.id, j.name]));
          console.log(c.bold(t('platform.jobs.adopt.list.header', { file: adoptionPath() })));
          for (const a of mine) {
            console.log(`  ${pad(a.jobId, 36)}  ${names.get(a.jobId) ?? c.dim(t('platform.jobs.adopt.list.gone'))}`);
          }
        }
        console.log(c.dim(t('platform.jobs.adopt.list.scope', { file: scope.file, scope: scope.scope })));
      } else {
        const job = await getJob(ctx, jobId!);
        if (!job) throw notFound({ key: 'platform.jobs.adopt.not_found', params: { id: jobId! } });
        const { file, already } = adoptJob({ id: job.id, entityId: ctx.entityId });
        console.log(t(already ? 'platform.jobs.adopt.already' : 'platform.jobs.adopt.done', { name: job.name, file }));
      }
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  });

  const unadopt = withKeyedCommon(describeCommand(jobs.command('unadopt').alias('desadoptar'), 'help.jobs.unadopt.description'));
  argumentByKey(unadopt, '<jobId>', 'help.jobs.unadopt.argument.job_id');
  declareRisk(unadopt, { risk: 'escritura', agent: false, writes: "~/.mnemosine/adopted-jobs.json, the operator's own (never the database)" });
  unadopt.addHelpText('after', UNADOPT_EXAMPLES);
  unadopt.action(async (jobId: string, opts: CommonOpts) => {
    try {
      await resolve(opts);
      const { file, removed } = unadoptJob(jobId);
      console.log(t(removed ? 'platform.jobs.unadopt.done' : 'platform.jobs.unadopt.not_adopted', { id: jobId, file }));
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  });

  withCommon(jobs.command('enable'))
    .description('Enable a job (resets its failure counter and recomputes the next run)')
    .argument('<jobId>', 'Job id')
    .addHelpText('after', ENABLE_EXAMPLES)
    .action(async (jobId: string, opts: CommonOpts) => {
      try {
        const ctx = await resolve(opts);
        const job = await setEnabled(ctx, jobId, true);
        console.log(`Job "${job.name}" enabled · next run ${fmtDate(job.next_run_at, await zoneFor(ctx))}`);
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });

  withCommon(jobs.command('disable'))
    .description('Disable a job (it stays configured; runs stop)')
    .argument('<jobId>', 'Job id')
    .addHelpText('after', DISABLE_EXAMPLES)
    .action(async (jobId: string, opts: CommonOpts) => {
      try {
        const ctx = await resolve(opts);
        const job = await setEnabled(ctx, jobId, false);
        console.log(`Job "${job.name}" disabled.`);
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });

  const runDue = withCommon(jobs.command('run-due'))
    .description('Tick entry point: claim and run every due job (call this from cron/launchd; --live enables the external reads)');
  // Externo, declarado junto a su registro (S0.6): el único brazo de una
  // corrida desatendida que sale del sistema son las lecturas contra el
  // sistema del cliente con su credencial, y --live es su compuerta — sin la
  // bandera los trabajos corren completos con la superficie sandbox. El
  // kernel añade --dry-run, --yes, --idempotency-key y --live.
  declareRisk(runDue, {
    risk: 'externo',
    llave: { sinLlave: { key: 'platform.jobs.run_due.retry_reruns' } },
    agent: false,
    writes: "job_runs; and runs the work of each due job — with --live, with reads against the client's external system",
  });
  runDue.addHelpText('after', RUN_DUE_EXAMPLES);
  runDue.action(run(async (ctx, opts: { dryRun?: boolean; live?: boolean; idempotencyKey?: string }) => {
      const { dryRun, live } = gateMutation(runDue, opts);
      // Which due jobs this tick spends its operator's credential on
      // (MNE-001-453, #646), from their own ~/.mnemosine/config.json.
      const setting = readRunDueScope();
      if (setting.projectCarriesKey) {
        process.stderr.write(`${t('platform.jobs.run_due.project_key_ignored', { file: 'mnemosine.config.json' })}\n`);
      }
      let adopted: ReadonlySet<string> = new Set();
      try {
        adopted = adoptedJobIds(ctx.entityId);
      } catch (err) {
        // Under `adopted` it fails closed: an unreadable list cannot say what
        // the operator chose to spend their credential on. Otherwise only the
        // notice reads it, and a schedule must not stop over a notice.
        if (setting.scope === 'adopted') throw err;
        process.stderr.write(`${t('platform.jobs.run_due.adoptions_unreadable', { error: (err as Error).message })}\n`);
      }
      const only = setting.scope === 'adopted' ? adopted : undefined;
      if (setting.scope === 'all') console.log(t('platform.jobs.run_due.all_first_line'));
      const ahora = new Date();
      const due = async (): Promise<JobRow[]> =>
        (await listJobs(ctx)).filter((j) => j.enabled && j.next_run_at && new Date(j.next_run_at) <= ahora);
      const skipped = only ? (await due()).filter((j) => !only.has(j.id)) : [];
      for (const j of skipped) console.log(t('platform.jobs.run_due.skipped', { name: j.name.slice(0, 24), id: j.id }));
      if (opts.idempotencyKey) {
        process.stderr.write(
          '  --idempotency-key does not apply to the tick: each due job is claimed atomically, and ' +
            'deduplicating ticks would silently skip legitimate runs.\n'
        );
      }
      if (dryRun) {
        // Puro censo: qué correría, sin reclamar ni despertar al modelo.
        const zone = await zoneFor(ctx);
        const vencidos = (await due()).filter((j) => !only || only.has(j.id));
        if (vencidos.length === 0) {
          console.log(skipped.length > 0 ? t('platform.jobs.run_due.no_adopted_due') : 'No jobs due.');
          return;
        }
        for (const j of vencidos) {
          console.log(`  would run: ${pad(j.name.slice(0, 24), 24)}  ${j.kind}  ${c.dim(`next_run ${fmtDate(j.next_run_at, zone)}`)}`);
        }
        console.log(c.dim(`\n(dry-run: ${vencidos.length} job(s) due; nothing was claimed or run)`));
        return;
      }
      if (!live) {
        console.log(c.dim(
          'sandbox: jobs run without the external reads (external_pull / external_diff_trial_balance). ' +
            'A reconciliation cron needs the full surface: schedule `mnemosine jobs run-due --live`.'
        ));
      }
      // NVIDIA's hosted trial records what it receives: an unattended tick
      // refuses it before it claims any job (MNE-001-448).
      assertDefaultNotOnTrial();
      // Before the first job: the profile the tick opens sessions on and where
      // its credential comes from. It is the credential of whoever runs the
      // tick, spent on the due jobs `jobs.run_due` lets through (#644, #646).
      console.log(c.dim(tickCredentialLine()));
      const outcomes = await runDueJobs(ctx, {
        runAgentTurn: deps.makeRunAgentTurn(ctx, { externo: live }),
        onProgress: (m) => console.log(c.dim(m)),
        only,
      });
      if (outcomes.length === 0) {
        console.log(skipped.length > 0 ? t('platform.jobs.run_due.no_adopted_due') : 'No jobs due.');
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
      if (setting.scope === 'unset') {
        // The notice before any default changes: the jobs this tick ran that
        // its operator has not adopted, with the key and its two values.
        const foreign = outcomes.filter((o) => !adopted.has(o.jobId));
        if (foreign.length > 0) {
          const lines = [
            t('platform.jobs.run_due.hint.header', { count: foreign.length }),
            ...foreign.map((o) => `  ${o.name} (${o.jobId})`),
            t('platform.jobs.run_due.hint.choose'),
          ];
          process.stderr.write(`${lines.join('\n')}\n`);
        }
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
      for (const line of formatRunsTable(runs, c, await zoneFor(ctx))) console.log(line);
    }));
}
