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
import { t, type TranslationKey } from '../i18n/index.js';
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

/** One line to stdout: this leaf prints through here, never console (#268's console clause, MNE-001-587). */
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** A header cell and its column's width, never narrower than the label in the active language. */
const column = (key: TranslationKey, width: number): { label: string; width: number } => {
  const label = t(key);
  return { label, width: Math.max(width, label.length) };
};

function formatJobsTable(jobs: JobRow[], c: JobsDeps['palette'], zone: string): string[] {
  if (jobs.length === 0) return [t('platform.jobs.list.none')];
  const name = column('platform.jobs.list.column.name', 24);
  const kind = column('platform.jobs.list.column.kind', 20);
  const schedule = column('platform.jobs.list.column.schedule', 14);
  const enabled = column('platform.jobs.list.column.enabled', 8);
  const fails = column('platform.jobs.list.column.fails', 6);
  const next = column('platform.jobs.list.column.next_run', 16);
  const out = [
    c.bold(
      `  ${pad('ID', 36)}  ${pad(name.label, name.width)}  ${pad(kind.label, kind.width)}  ${pad(schedule.label, schedule.width)}  ` +
        `${pad(enabled.label, enabled.width)}  ${pad(fails.label, fails.width)}  ${pad(next.label, next.width)}`
    ),
  ];
  for (const j of jobs) {
    const yesNo = t('platform.jobs.list.enabled', { enabled: j.enabled ? 'yes' : 'no' });
    out.push(
      `  ${pad(j.id, 36)}  ${pad(j.name.slice(0, 24), name.width)}  ${pad(j.kind, kind.width)}  ` +
        `${pad(j.schedule, schedule.width)}  ${pad(yesNo, enabled.width)}  ` +
        `${pad(`${j.consecutive_failures}/${j.max_failures}`, fails.width)}  ${pad(fmtDate(j.next_run_at, zone), next.width)}`
    );
  }
  return out;
}

function formatRunsTable(runs: JobRunRow[], c: JobsDeps['palette'], zone: string): string[] {
  if (runs.length === 0) return [t('platform.jobs.history.none')];
  const started = column('platform.jobs.history.column.started', 16);
  const jobCol = column('platform.jobs.history.column.job', 24);
  const status = column('platform.jobs.history.column.status', 16);
  const drafts = column('platform.jobs.history.column.drafts', 6);
  const out = [
    c.bold(
      `  ${pad(started.label, started.width)}  ${pad(jobCol.label, jobCol.width)}  ${pad(status.label, status.width)}  ` +
        `${pad(drafts.label, drafts.width)}  ${t('platform.jobs.history.column.detail')}`
    ),
  ];
  for (const r of runs) {
    const detail =
      r.detail && typeof r.detail === 'object'
        ? String((r.detail as { summary?: unknown; error?: unknown }).summary ??
            (r.detail as { error?: unknown }).error ?? '')
        : '';
    out.push(
      `  ${pad(fmtDate(r.started_at, zone), started.width)}  ${pad((r.job_name ?? r.job_id).slice(0, 24), jobCol.width)}  ` +
        `${pad(r.status, status.width)}  ${pad(String(r.drafts_created), drafts.width)}  ${c.dim(detail.slice(0, 80))}`
    );
  }
  return out;
}

export function registerJobsCommand(program: Command, deps: JobsDeps): void {
  const c = deps.palette;
  const jobs = describeCommand(program.command('jobs').alias('tareas'), 'help.jobs.description');

  // -e and -t with the leaf's own keys: their English is not cli.flag.*'s.
  const withCommon = (cmd: Command, keys: { entity: TranslationKey; tenant: TranslationKey }): Command => {
    optionByKey(cmd, '-e, --entity <idOrName>', keys.entity);
    return optionByKey(cmd, '-t, --tenant <id>', keys.tenant);
  };

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

  const list = describeCommand(jobs.command('list'), 'help.jobs.list.description');
  withCommon(list, { entity: 'help.jobs.list.option.entity', tenant: 'help.jobs.list.option.tenant' });
  list.action(run(async (ctx) => {
      for (const line of formatJobsTable(await listJobs(ctx), c, await zoneFor(ctx))) say(line);
    }));

  const create = describeCommand(jobs.command('create'), 'help.jobs.create.description');
  withCommon(create, { entity: 'help.jobs.create.option.entity', tenant: 'help.jobs.create.option.tenant' });
  optionByKey(create, '--name <name>', 'help.jobs.create.option.name', { mandatory: true });
  optionByKey(create, '--kind <kind>', 'help.jobs.create.option.kind', {
    params: { kinds: JOB_KINDS.join(' | ') },
    mandatory: true,
  });
  optionByKey(create, '--schedule <cron>', 'help.jobs.create.option.schedule', { mandatory: true });
  optionByKey(create, '--max-failures <n>', 'help.jobs.create.option.max_failures');
  optionByKey(create, '--user <email>', 'help.jobs.create.option.user');
  create
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
        say(c.bold(t('platform.jobs.create.done', { id: job.id })));
        const next = fmtDate(job.next_run_at, await zoneFor(ctx));
        say(`  ${t('platform.jobs.create.summary', { name: job.name, kind: job.kind, schedule: c.cyan(job.schedule), next })}`);
        // Adopted for its creator (MNE-001-453): an operator who chose
        // `jobs.run_due = adopted` keeps their own new jobs running.
        try {
          adoptJob({ id: job.id, entityId: ctx.entityId });
          say(c.dim(t('platform.jobs.create.adopted')));
        } catch (err) {
          process.stderr.write(`${t('platform.jobs.create.adopt_failed', { error: (err as Error).message, id: job.id })}\n`);
        }
        say(c.dim(`  ${t('platform.jobs.create.wire_tick')}`));
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
          say(t('platform.jobs.adopt.list.none'));
        } else {
          const names = new Map((await listJobs(ctx)).map((j) => [j.id, j.name]));
          say(c.bold(t('platform.jobs.adopt.list.header', { file: adoptionPath() })));
          for (const a of mine) {
            say(`  ${pad(a.jobId, 36)}  ${names.get(a.jobId) ?? c.dim(t('platform.jobs.adopt.list.gone'))}`);
          }
        }
        say(c.dim(t('platform.jobs.adopt.list.scope', { file: scope.file, scope: scope.scope })));
      } else {
        const job = await getJob(ctx, jobId!);
        if (!job) throw notFound({ key: 'platform.jobs.adopt.not_found', params: { id: jobId! } });
        const { file, already } = adoptJob({ id: job.id, entityId: ctx.entityId });
        say(t(already ? 'platform.jobs.adopt.already' : 'platform.jobs.adopt.done', { name: job.name, file }));
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
      say(t(removed ? 'platform.jobs.unadopt.done' : 'platform.jobs.unadopt.not_adopted', { id: jobId, file }));
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  });

  const enable = describeCommand(jobs.command('enable'), 'help.jobs.enable.description');
  withCommon(enable, { entity: 'help.jobs.enable.option.entity', tenant: 'help.jobs.enable.option.tenant' });
  argumentByKey(enable, '<jobId>', 'help.jobs.enable.argument.job_id');
  enable
    .addHelpText('after', ENABLE_EXAMPLES)
    .action(async (jobId: string, opts: CommonOpts) => {
      try {
        const ctx = await resolve(opts);
        const job = await setEnabled(ctx, jobId, true);
        say(t('platform.jobs.enable.done', { name: job.name, next: fmtDate(job.next_run_at, await zoneFor(ctx)) }));
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });

  const disable = describeCommand(jobs.command('disable'), 'help.jobs.disable.description');
  withCommon(disable, { entity: 'help.jobs.disable.option.entity', tenant: 'help.jobs.disable.option.tenant' });
  argumentByKey(disable, '<jobId>', 'help.jobs.disable.argument.job_id');
  disable
    .addHelpText('after', DISABLE_EXAMPLES)
    .action(async (jobId: string, opts: CommonOpts) => {
      try {
        const ctx = await resolve(opts);
        const job = await setEnabled(ctx, jobId, false);
        say(t('platform.jobs.disable.done', { name: job.name }));
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });

  const runDue = describeCommand(jobs.command('run-due'), 'help.jobs.run_due.description');
  withCommon(runDue, { entity: 'help.jobs.run_due.option.entity', tenant: 'help.jobs.run_due.option.tenant' });
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
      if (setting.scope === 'all') say(t('platform.jobs.run_due.all_first_line'));
      const ahora = new Date();
      const due = async (): Promise<JobRow[]> =>
        (await listJobs(ctx)).filter((j) => j.enabled && j.next_run_at && new Date(j.next_run_at) <= ahora);
      const skipped = only ? (await due()).filter((j) => !only.has(j.id)) : [];
      for (const j of skipped) say(t('platform.jobs.run_due.skipped', { name: j.name.slice(0, 24), id: j.id }));
      if (opts.idempotencyKey) {
        process.stderr.write(`  ${t('platform.jobs.run_due.key_not_applied')}\n`);
      }
      if (dryRun) {
        // Puro censo: qué correría, sin reclamar ni despertar al modelo.
        const zone = await zoneFor(ctx);
        const vencidos = (await due()).filter((j) => !only || only.has(j.id));
        if (vencidos.length === 0) {
          say(t(skipped.length > 0 ? 'platform.jobs.run_due.no_adopted_due' : 'platform.jobs.run_due.none'));
          return;
        }
        for (const j of vencidos) {
          const next = c.dim(t('platform.jobs.run_due.next_run', { date: fmtDate(j.next_run_at, zone) }));
          say(`  ${t('platform.jobs.run_due.would_run', { name: pad(j.name.slice(0, 24), 24), kind: j.kind, next })}`);
        }
        say(c.dim(`\n${t('platform.jobs.run_due.dry_run_summary', { count: vencidos.length })}`));
        return;
      }
      if (!live) {
        say(c.dim(t('platform.jobs.run_due.sandbox')));
      }
      // NVIDIA's hosted trial records what it receives: an unattended tick
      // refuses it before it claims any job (MNE-001-448).
      assertDefaultNotOnTrial();
      // Before the first job: the profile the tick opens sessions on and where
      // its credential comes from. It is the credential of whoever runs the
      // tick, spent on the due jobs `jobs.run_due` lets through (#644, #646).
      say(c.dim(tickCredentialLine()));
      const outcomes = await runDueJobs(ctx, {
        runAgentTurn: deps.makeRunAgentTurn(ctx, { externo: live }),
        onProgress: (m) => say(c.dim(m)),
        only,
      });
      if (outcomes.length === 0) {
        say(t(skipped.length > 0 ? 'platform.jobs.run_due.no_adopted_due' : 'platform.jobs.run_due.none'));
        return;
      }
      for (const o of outcomes) {
        const draftsCell = t('platform.jobs.run_due.outcome_drafts', { count: o.draftsCreated });
        say(`  ${pad(o.name.slice(0, 24), 24)}  ${pad(o.status, 16)}  ${draftsCell}  ${c.dim(o.detail.slice(0, 80))}`);
        if (o.autoDisabled) {
          say(c.bold(`  ⚠ ${t('platform.jobs.run_due.auto_disabled', { name: o.name, id: o.jobId })}`));
        }
        if (o.recordError) {
          say(c.bold(`  ⚠ ${t('platform.jobs.run_due.record_failed', { name: o.name, error: o.recordError })}`));
        }
      }
      const drafts = outcomes.reduce((sum, o) => sum + o.draftsCreated, 0);
      if (drafts > 0) {
        say(c.bold(`\n${t('platform.jobs.run_due.drafts_created', { count: drafts })}`));
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

  const history = describeCommand(jobs.command('history'), 'help.jobs.history.description');
  withCommon(history, { entity: 'help.jobs.history.option.entity', tenant: 'help.jobs.history.option.tenant' });
  optionByKey(history, '--job <jobId>', 'help.jobs.history.option.job');
  optionByKey(history, '--limit <n>', 'help.jobs.history.option.limit');
  history.action(run(async (ctx, opts: { job?: string; limit?: string }) => {
      const runs = await listRuns(ctx, {
        jobId: opts.job,
        limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      });
      for (const line of formatRunsTable(runs, c, await zoneFor(ctx))) say(line);
    }));
}
