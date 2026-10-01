import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { InvalidArgumentError, type Command } from 'commander';
import { resolveEntity, type AgentContext } from '../ai/context.js';
import { resolveReviewer, type Reviewer } from '../ai/draft-service.js';
import { ingestCfdiFiles } from '../ai/ingest-service.js';
import { entityScope, type EntityScope } from '../database/scope.js';
import { t } from '../i18n/index.js';
import { conLlave } from '../services/idempotency/idempotency-store.js';
import {
  requestDownload, verifyDownload, SatDownloadError, LIFETIME_XML_LIMIT, OPEN_STATES,
  type BulkDownloadDeps, type DownloadRequestInput,
} from '../services/sat-download/descarga-masiva.js';
import {
  ensurePackage, getRequest, listRequests, quotaRows, type MirrorRequest,
} from '../services/sat-download/packages.js';
import { CredentialAccessDenied, CredentialError } from '../services/fiscal-credentials/service.js';
import { declareRisk, gateMutation } from './kernel/risk.js';
import { argumentByKey, describeCommand, optionByKey } from './kernel/help.js';
import { ExitCode, blockedByState, conflict, exitCodeFor, notFound, usageError } from './kernel/index.js';
import { runCensus } from './ingest-census.js';
import type { SatCommandDeps } from './sat-commands.js';

// ============================================================
// `mnemosine sat download|package|quota …` (EFIRMA-2 2/2, #440, MNE-001-143)
//
// The command surface of the Descarga Masiva engine. Two halves, split by the
// catalog's rule (a): what uses the e.firma against the SAT (`create`,
// `check`, `package download`) the agent may not run; what only reads the
// local mirror (`status`, `list`, `quota show`) it may, and none of those
// opens a connection or touches the credential.
//
// The action bodies are the exported `run*` functions below, which take their
// effects as a `RunIo`, so the orchestration (the wait, the archive, the
// output, the import) is driven in-process against the simulator by the tests.
// ============================================================

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DIRECTIONS = ['issued', 'received'] as const;

// Waiting for a request to finish. Every ask to the SAT decrypts the e.firma and counts against the
// daily cap of efirma_max_accesos_diarios (24 by default), and `sat package download` needs accesses
// left inside the 72 h the packages last, so the wait backs off instead of polling at a fixed rate.
/** Gap before the second ask; it doubles each time up to POLL_MAX_MS. It is also the minimum gap between two asks. */
export const POLL_FIRST_MS = 60_000;
export const POLL_MAX_MS = 15 * 60_000;
/** Most asks one `check --wait` makes, however long --timeout is: the rest of the day's cap stays for the download. */
export const MAX_POLLS_PER_WAIT = 10;

const dayOrUsage = (flag: string, v: string | undefined): string => {
  if (!v || !DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw usageError(t('sat.dl.bad_day', { flag, value: v ?? '' }));
  }
  return v;
};

/** A commander parser: a whole number greater than 0, or InvalidArgumentError (never NaN, never 0). */
export const positiveInt = (flag: string) => (v: string): number => {
  const n = Number(v.trim());
  if (!/^\d+$/.test(v.trim()) || !Number.isSafeInteger(n) || n < 1) {
    throw new InvalidArgumentError(t('sat.dl.bad_positive', { flag, value: v }));
  }
  return n;
};

const safeName = (s: string): string => s.replace(/[^\w.-]/g, '_');

/** `--json` or `--format json`; any other format is a usage error, not a silent table. */
function wantsJson(opts: { json?: boolean; format?: string }): boolean {
  if (opts.format !== undefined && opts.format !== 'table' && opts.format !== 'json') {
    throw usageError(t('sat.dl.bad_format', { value: opts.format }));
  }
  return opts.json === true || opts.format === 'json';
}

const EXAMPLES = {
  create: `
Examples:
  # What a metadata request for last August's received CFDI would do (metadata is not limited).
  mnemosine sat download create --since 2026-08-01 --until 2026-08-31 --direction received --dry-run
  # Ask for the XML of the same period: spends one of its 2 lifetime requests.
  mnemosine sat download create --since 2026-08-01 --until 2026-08-31 --direction received --kind xml --live --idempotency-key aug-received-xml
`,
  check: `
Examples:
  # Ask the SAT once, or wait up to 10 minutes for the packages to be ready.
  mnemosine sat download check 3f6c1c52-0a9d-4c58-a6de-7b0f2f1f8a11 --live
  mnemosine sat download check 3f6c1c52-0a9d-4c58-a6de-7b0f2f1f8a11 --wait --timeout 600 --live
`,
  status: `
Examples:
  # The last state we recorded; never calls the SAT.
  mnemosine sat download status 3f6c1c52-0a9d-4c58-a6de-7b0f2f1f8a11
`,
  list: `
Examples:
  # Finished requests, as JSON.
  mnemosine sat download list --status finished --format json
`,
  packageDownload: `
Examples:
  # See what would be downloaded, then archive the ZIPs and load them through the ingestion.
  mnemosine sat package download 3f6c1c52-0a9d-4c58-a6de-7b0f2f1f8a11 --import --dry-run
  mnemosine sat package download 3f6c1c52-0a9d-4c58-a6de-7b0f2f1f8a11 --import --live
`,
  quotaShow: `
Examples:
  # Which periods of 2026 have no lifetime XML request left.
  mnemosine sat quota show --since 2026-01-01 --until 2026-12-31
`,
};

/** One line per request for the operator. */
function describe(r: MirrorRequest): string {
  return t('sat.dl.describe', {
    id: r.id, direction: r.direction, kind: r.requestType === 'CFDI' ? 'xml' : 'metadata',
    from: r.periodStart.slice(0, 10), to: r.periodEnd.slice(0, 10), status: r.status,
    count: r.cfdiCount === null ? '' : t('sat.dl.describe.count', { n: r.cfdiCount }),
    packages: r.packageIds.length > 0
      ? t('sat.dl.describe.packages', { archived: r.archivedPackageIds.length, total: r.packageIds.length })
      : '',
    error: r.errorKey ? ` · ${r.errorKey}` : '',
  });
}

/**
 * What an agent may see of a request. `satMessage` is the SAT's own text: sanitized and truncated by the
 * engine, but third-party content all the same, so the two agent-invocable reads leave it out.
 */
function forAgent(r: MirrorRequest): Omit<MirrorRequest, 'satMessage'> {
  const { satMessage, ...rest } = r;
  void satMessage;
  return rest;
}

/** What the exit code says about a failure: a spent limit is BLOCKED, the SAT or the wire failing is EXTERNAL_FAILED. */
function exitForSat(err: unknown): number {
  if (err instanceof SatDownloadError) return err.retry === 'permanent_quota' ? ExitCode.BLOCKED : ExitCode.EXTERNAL_FAILED;
  if (err instanceof CredentialError) return ExitCode.PERMISSION;
  return exitCodeFor(err);
}

async function requestOrNotFound(scope: EntityScope, id: string): Promise<MirrorRequest> {
  const row = await getRequest(scope, id);
  if (!row) throw notFound(t('sat.dl.request_not_found', { id }));
  return row;
}

/** What an action body needs from the outside: where it prints, how it asks, and (for tests) the SAT and the clock. */
export interface RunIo {
  log: (line: string) => void;
  reportError: (err: unknown) => void;
  dim: (s: string) => string;
  confirm: (prompt: string) => Promise<boolean>;
  /** The engine's URLs and fetch; the simulator's in tests. */
  sat?: BulkDownloadDeps;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Gate { dryRun: boolean; live: boolean }

const authCtx = (ctx: AgentContext, reviewer: Reviewer) => ({
  tenantId: ctx.tenantId, entityId: ctx.entityId, actor: reviewer.email, unattended: false,
});

/** Gap before the next ask, given how many were made: 60 s, 120 s, 240 s … up to 15 min. */
export const pollDelay = (asked: number): number => Math.min(POLL_MAX_MS, POLL_FIRST_MS * 2 ** Math.max(0, asked - 1));

export interface WaitOutcome {
  row: MirrorRequest;
  /** How many times the SAT was asked (each one decrypted the e.firma once). */
  polls: number;
  /** Why the loop stopped while the request was still open. */
  stopped?: 'rate_limit' | 'budget' | 'timeout';
}

/**
 * Asks the SAT about an open request, once or (with `wait`) with backoff until it is no longer open. Stops, and
 * says so, when the e.firma's daily cap denies an access, when MAX_POLLS_PER_WAIT asks were made, or at the deadline.
 */
export async function waitForDownload(
  first: MirrorRequest,
  opts: { wait: boolean; timeoutMs: number; maxPolls?: number },
  io: { verify: (id: string) => Promise<unknown>; reload: (id: string) => Promise<MirrorRequest>; now: () => number; sleep: (ms: number) => Promise<void> }
): Promise<WaitOutcome> {
  let row = first;
  let polls = 0;
  const deadline = io.now() + opts.timeoutMs;
  const maxPolls = opts.maxPolls ?? MAX_POLLS_PER_WAIT;
  for (;;) {
    if (OPEN_STATES.includes(row.status)) {
      try {
        await io.verify(row.id);
      } catch (err) {
        if (err instanceof CredentialAccessDenied && err.reason === 'rate_limit') return { row, polls, stopped: 'rate_limit' };
        throw err;
      }
      polls += 1;
      row = await io.reload(row.id);
    }
    if (!opts.wait || !OPEN_STATES.includes(row.status)) return { row, polls };
    if (polls >= maxPolls) return { row, polls, stopped: 'budget' };
    const left = deadline - io.now();
    if (left <= 0) return { row, polls, stopped: 'timeout' };
    await io.sleep(Math.min(pollDelay(polls), left));
  }
}

/** `sat download create`: what a run would spend, then (with --live) the signed request. Returns the exit code. */
export async function runCreate(
  ctx: AgentContext,
  opts: { since: string; until: string; direction: string; kind: string; user?: string; yes?: boolean; idempotencyKey?: string },
  gate: Gate, io: RunIo
): Promise<number> {
  if (!(DIRECTIONS as readonly string[]).includes(opts.direction)) {
    throw usageError(t('sat.dl.bad_direction', { value: opts.direction }));
  }
  if (opts.kind !== 'metadata' && opts.kind !== 'xml') {
    throw usageError(t('sat.dl.bad_kind', { value: opts.kind }));
  }
  const input: DownloadRequestInput = {
    direction: opts.direction as DownloadRequestInput['direction'],
    requestType: opts.kind === 'xml' ? 'CFDI' : 'Metadata',
    start: `${dayOrUsage('--since', opts.since)}T00:00:00`,
    end: `${dayOrUsage('--until', opts.until)}T23:59:59`,
  };
  if (input.start >= input.end) throw usageError(t('sat.dl.since_after_until'));
  const scope = entityScope(ctx.tenantId, ctx.entityId);

  // The entity's own counter, read first so the operator sees what a real run would spend. It is this entity's
  // view only (the SAT counts per RFC and parameters) and the engine still refuses from the database at the call.
  const used = (await quotaRows(scope, {})).find((q) =>
    q.direction === input.direction && q.periodStart === input.start && q.periodEnd === input.end);
  const spent = input.requestType === 'CFDI' && used?.remaining === 0;
  const plan = t('sat.dl.create.plan', {
    direction: input.direction, kind: opts.kind, start: input.start, end: input.end, entity: ctx.entityName, rfc: ctx.taxId,
  }) + (input.requestType === 'CFDI'
    ? t('sat.dl.create.plan_left', { n: used ? used.remaining : LIFETIME_XML_LIMIT })
    : '');
  if (gate.dryRun || !gate.live) {
    io.log(t(gate.dryRun ? 'sat.dl.create.would' : 'sat.dl.create.not_sent', { plan }));
    if (spent) io.log(t('sat.dl.create.spent'));
    io.log(io.dim(t(gate.dryRun ? 'sat.dl.create.dry_note' : 'sat.dl.create.live_note')));
    return spent ? ExitCode.BLOCKED : 0;
  }
  const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
  if (input.requestType === 'CFDI' && !opts.yes) {
    if (!(await io.confirm(t('sat.dl.create.confirm', { limit: LIFETIME_XML_LIMIT, plan })))) {
      io.log(io.dim(t('sat.dl.create.cancelled')));
      return 0;
    }
  }
  const payloadHash = createHash('sha256').update(JSON.stringify([ctx.entityId, input])).digest('hex');
  const done = await conLlave(
    { tenantId: ctx.tenantId, entityId: ctx.entityId },
    { scope: 'sat download create', clave: opts.idempotencyKey, payloadHash },
    async () => {
      const s = await requestDownload(authCtx(ctx, reviewer), input, io.sat);
      return { id: s.id, status: s.status, satCode: s.satCode, errorKey: s.errorKey };
    }
  );
  const r = done.resultado;
  io.log(t('sat.dl.create.done', {
    repeat: done.repetido ? t('sat.dl.create.repeat') : '', mark: r.status === 'accepted' ? '✔' : '·',
    id: String(r.id), status: String(r.status), error: r.errorKey ? ` · ${String(r.errorKey)}` : '',
  }));
  if (r.status === 'accepted') io.log(io.dim(t('sat.dl.create.follow', { id: String(r.id) })));
  return r.status === 'rejected' ? ExitCode.EXTERNAL_REJECTED : 0;
}

/** `sat download check`: asks the SAT about a request (and with --wait, backs off until it is ready). Returns the exit code. */
export async function runCheck(
  ctx: AgentContext,
  id: string,
  opts: { wait?: boolean; timeout: number; strict?: boolean; json?: boolean; format?: string; user?: string },
  gate: Gate, io: RunIo
): Promise<number> {
  const scope = entityScope(ctx.tenantId, ctx.entityId);
  const row = await requestOrNotFound(scope, id);
  if (gate.dryRun || !gate.live) {
    io.log(t(gate.dryRun ? 'sat.dl.check.would' : 'sat.dl.check.not_asked', { request: describe(row) }));
    io.log(io.dim(t(gate.dryRun ? 'sat.dl.check.dry_note' : 'sat.dl.check.live_note')));
    return 0;
  }
  const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
  const out = await waitForDownload(row, { wait: opts.wait === true, timeoutMs: opts.timeout * 1000 }, {
    verify: (rid) => verifyDownload(authCtx(ctx, reviewer), rid, io.sat),
    reload: (rid) => requestOrNotFound(scope, rid),
    now: io.now ?? Date.now,
    sleep: io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  });
  io.log(wantsJson(opts) ? JSON.stringify(out.row) : describe(out.row));
  if (out.stopped === 'rate_limit') {
    io.log(t('sat.dl.check.rate_limit', { polls: out.polls }));
    return ExitCode.PERMISSION;
  }
  if (out.stopped === 'budget') io.log(t('sat.dl.check.budget', { polls: out.polls }));
  if (out.stopped === 'timeout') io.log(t('sat.dl.check.timeout', { polls: out.polls }));
  return opts.strict && !(out.row.status === 'finished' && out.row.packageIds.length > 0) ? 1 : 0;
}

/** The message that says why a request that is not finished has no packages to download. */
function notFinished(row: MirrorRequest): string {
  if (row.status === 'no_data') return t('sat.dl.package.no_data');
  if (row.status === 'rejected') return t('sat.dl.package.rejected');
  if (row.status === 'expired') return t('sat.dl.package.expired');
  if (row.status === 'submitted' || OPEN_STATES.includes(row.status)) return t('sat.dl.package.open', { id: row.id, status: row.status });
  return t('sat.dl.package.failed', { id: row.id, status: row.status });
}

/** One ZIP into the `--output` directory: written, or left alone when it already holds these bytes. Never overwrites other bytes. */
function writeOutput(dir: string, packageId: string, bytes: Buffer): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeName(packageId)}.zip`);
  if (fs.existsSync(file)) {
    if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') === createHash('sha256').update(bytes).digest('hex')) {
      return t('sat.dl.package.output_same', { file });
    }
    throw conflict(t('sat.dl.package.output_differs', { file }));
  }
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return t('sat.dl.package.output_written', { file });
}

/**
 * A package's bytes go through the ingestion of MNE-001-096: `runCensus` loads
 * the census (metadata, or the XML of the ZIP) and hands the ingestible XML
 * back; those then enter by the same path as `mnemosine ingest`, marked
 * `sat_download` and deduplicated by UUID. No model is consulted: what the
 * firm's rules do not decide stays in the inbox to code.
 *
 * `invalid` counts census rows the reader could not use; `failed` the XML the
 * ingestion ended in `error` or `invalid`, which the exit code must show.
 */
export async function importPackage(
  ctx: AgentContext, reviewer: Reviewer, scope: EntityScope, request: MirrorRequest, file: string,
  log: (line: string) => void = console.log
): Promise<{ invalid: number; failed: number }> {
  const run = await runCensus({
    kind: request.requestType === 'Metadata' ? 'metadata' : 'zip', files: [file], scope, entityRfc: ctx.taxId,
    dryRun: false, loadedBy: reviewer.userId,
  });
  let failed = 0;
  if (run.xmlFiles.length > 0) {
    const report = await ingestCfdiFiles({
      ctx, reviewer, files: run.xmlFiles, thresholds: { autoPost: false, minConfidence: 1, maxAmount: 0 },
      session: null, capture: { drafts: [] }, importSource: 'sat_download',
    });
    // `blocked` is the normal case (no model consulted, the CFDI waits in the inbox): worded as such, not as a failure.
    const counts = Object.entries(report.counts).filter(([k, n]) => n > 0 && k !== 'blocked').map(([k, n]) => `${k} ${n}`).join(', ');
    log(t('sat.dl.ingest.line', { counts: counts || t('sat.dl.ingest.nothing') }));
    if (report.counts.blocked > 0) log(t('sat.dl.ingest.to_code', { n: report.counts.blocked }));
    failed = report.counts.error + report.counts.invalid;
  }
  return { invalid: run.reading.invalid.length, failed };
}

/**
 * `sat package download`: each package from the archive or the SAT, then (independently of each other) the
 * `--output` copy and the `--import`, so a local failure never skips the import and a re-run with the same
 * `--output` is clean. The exit code says what failed: the SAT (EXTERNAL_FAILED and kin), or only local work (1).
 */
export async function runPackageDownload(
  ctx: AgentContext,
  id: string,
  opts: { output?: string; package?: string; import?: boolean; user?: string },
  gate: Gate, io: RunIo
): Promise<number> {
  const scope = entityScope(ctx.tenantId, ctx.entityId);
  const row = await requestOrNotFound(scope, id);
  if (row.status !== 'finished') throw blockedByState(notFinished(row));
  const wanted = opts.package ? row.packageIds.filter((p) => p === opts.package) : row.packageIds;
  if (wanted.length === 0) throw notFound(t('sat.dl.package.no_such', { id: row.id, package: opts.package ?? '' }).trim());
  const missing = wanted.filter((p) => !row.archivedPackageIds.includes(p));
  if (gate.dryRun || (missing.length > 0 && !gate.live)) {
    io.log(t('sat.dl.package.would', {
      lead: t(gate.dryRun ? 'sat.dl.package.would_lead' : 'sat.dl.package.not_lead'),
      missing: missing.length, total: wanted.length, kept: wanted.length - missing.length,
      import: opts.import ? t('sat.dl.package.then_import') : '',
    }));
    io.log(io.dim(t(gate.dryRun ? 'sat.dl.package.dry_note' : 'sat.dl.package.live_note')));
    return 0;
  }
  const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
  let satExit: number | null = null;
  let localFailed = false;
  let tmp: string | null = null;
  try {
    for (const packageId of wanted) {
      let kept;
      try {
        kept = await ensurePackage(authCtx(ctx, reviewer), scope, row, packageId, io.sat);
      } catch (err) {
        io.reportError(err);
        satExit ??= exitForSat(err);
        continue;
      }
      io.log(t('sat.dl.package.archived', {
        id: packageId, bytes: kept.bytes.length, sha: kept.sha256,
        where: t(kept.from === 'archive' ? 'sat.dl.package.where_archive' : 'sat.dl.package.where_new'),
      }));
      if (opts.output) {
        try {
          io.log(writeOutput(opts.output, packageId, kept.bytes));
        } catch (err) {
          io.reportError(err);
          localFailed = true;
        }
      }
      if (opts.import) {
        try {
          tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-sat-download-'));
          const file = path.join(tmp, `${safeName(packageId)}.zip`);
          fs.writeFileSync(file, kept.bytes);
          const r = await importPackage(ctx, reviewer, scope, row, file, io.log);
          if (r.invalid > 0 || r.failed > 0) localFailed = true;
        } catch (err) {
          io.reportError(err);
          localFailed = true;
        }
      }
    }
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  return satExit ?? (localFailed ? ExitCode.FAILURE : 0);
}

export function registerSatDownloadCommands(sat: Command, deps: SatCommandDeps): void {
  const { color: c, shutdown, reportError, ask } = deps;
  const fail = async (err: unknown): Promise<never> => {
    reportError(err);
    return shutdown(exitForSat(err));
  };
  const io = (): RunIo => ({
    log: (line) => console.log(line),
    reportError,
    dim: (s) => c.dim(s),
    confirm: async (prompt) => {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      const ok = await ask(rl, c.cyan(prompt));
      rl.close();
      return (ok ?? '').trim().toLowerCase() === 'yes';
    },
  });

  // `sat download` is shared with the census (`reconcile`, MNE-001-119): whichever registers first creates the
  // group, the other reuses it, so the order of registration does not matter.
  const download =
    sat.commands.find((existing) => existing.name() === 'download') ??
    describeCommand(sat.command('download').alias('descarga'), 'help.sat.download.description');
  const entityOpt = (cmd: Command) => optionByKey(cmd, '-e, --entity <idOrName>', 'help.sat.download.option.entity');
  const userOpt = (cmd: Command) => optionByKey(cmd, '-u, --user <email>', 'help.sat.download.option.user');
  const jsonOpt = (cmd: Command) => {
    optionByKey(cmd, '--json', 'help.sat.download.option.json');
    return optionByKey(cmd, '--format <format>', 'help.sat.download.option.format');
  };

  // ── create ────────────────────────────────────────────────
  const create = describeCommand(download.command('create').alias('crear'), 'help.sat.download.create.description');
  optionByKey(create, '--since <date>', 'help.sat.download.create.option.since', { mandatory: true });
  optionByKey(create, '--until <date>', 'help.sat.download.create.option.until', { mandatory: true });
  optionByKey(create, '--direction <direction>', 'help.sat.download.create.option.direction', { mandatory: true });
  optionByKey(create, '--kind <kind>', 'help.sat.download.create.option.kind', { defaultValue: 'metadata' });
  entityOpt(create);
  userOpt(create);
  // The kernel adds --live only to `externo` leaves; this one is `irreversible` (it burns a lifetime slot) and
  // still reaches the SAT, so it carries the same opt-in gate the catalog row lists.
  optionByKey(create, '--live', 'cli.flag.live');
  create.addHelpText('after', EXAMPLES.create);
  declareRisk(create, {
    risk: 'irreversible',
    llave: { scope: 'sat download create' },
    agent: false,
    writes: 'sat_download_requests and sat_download_quota; one signed request to the SAT',
  });
  create.action(async (opts: {
    since: string; until: string; direction: string; kind: string; entity?: string; user?: string;
    dryRun?: boolean; live?: boolean; yes?: boolean; idempotencyKey?: string;
  }) => {
    try {
      const ctx = await resolveEntity(opts.entity);
      await shutdown(await runCreate(ctx, opts, gateMutation(create, opts), io()));
    } catch (err) {
      await fail(err);
    }
  });

  // ── check ─────────────────────────────────────────────────
  const check = describeCommand(download.command('check').alias('verificar'), 'help.sat.download.check.description');
  argumentByKey(check, '<id>', 'help.sat.download.argument.id');
  optionByKey(check, '--wait', 'help.sat.download.check.option.wait');
  optionByKey(check, '--timeout <seconds>', 'help.sat.download.check.option.timeout', {
    parser: positiveInt('--timeout'), defaultValue: 900,
  });
  optionByKey(check, '--strict', 'help.sat.download.check.option.strict');
  jsonOpt(check);
  entityOpt(check);
  userOpt(check);
  check.addHelpText('after', EXAMPLES.check);
  declareRisk(check, {
    risk: 'externo',
    llave: { innecesaria: 'asking the state again is harmless and records the latest state' },
    agent: false,
    writes: 'sat_download_requests (state and package ids); one signed request to the SAT per ask',
  });
  check.action(async (id: string, opts: {
    wait?: boolean; timeout: number; strict?: boolean; json?: boolean; format?: string; entity?: string; user?: string;
    dryRun?: boolean; live?: boolean; yes?: boolean; idempotencyKey?: string;
  }) => {
    try {
      const ctx = await resolveEntity(opts.entity);
      await shutdown(await runCheck(ctx, id, opts, gateMutation(check, opts), io()));
    } catch (err) {
      await fail(err);
    }
  });

  // ── status (local mirror, no network) ─────────────────────
  const status = describeCommand(download.command('status').alias('estado'), 'help.sat.download.status.description');
  argumentByKey(status, '<id>', 'help.sat.download.argument.id');
  jsonOpt(status);
  entityOpt(status);
  status.addHelpText('after', EXAMPLES.status);
  declareRisk(status, { risk: 'lectura', agent: true });
  status.action(async (id: string, opts: { json?: boolean; format?: string; entity?: string }) => {
    try {
      const ctx = await resolveEntity(opts.entity);
      const row = await requestOrNotFound(entityScope(ctx.tenantId, ctx.entityId), id);
      console.log(wantsJson(opts) ? JSON.stringify(forAgent(row)) : describe(row));
      await shutdown(0);
    } catch (err) {
      await fail(err);
    }
  });

  // ── list ──────────────────────────────────────────────────
  const list = describeCommand(download.command('list').alias('listar'), 'help.sat.download.list.description');
  optionByKey(list, '-s, --status <status>', 'help.sat.download.list.option.status');
  optionByKey(list, '--since <date>', 'help.sat.download.list.option.since');
  optionByKey(list, '-n, --limit <n>', 'help.sat.download.list.option.limit', { parser: positiveInt('--limit'), defaultValue: 30 });
  jsonOpt(list);
  entityOpt(list);
  list.addHelpText('after', EXAMPLES.list);
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action(async (opts: { status?: string; since?: string; limit: number; json?: boolean; format?: string; entity?: string }) => {
    try {
      const ctx = await resolveEntity(opts.entity);
      const rows = await listRequests(entityScope(ctx.tenantId, ctx.entityId), {
        status: opts.status, since: opts.since ? `${dayOrUsage('--since', opts.since)}T00:00:00` : undefined, limit: opts.limit,
      });
      if (wantsJson(opts)) console.log(JSON.stringify(rows.map(forAgent)));
      else if (rows.length === 0) console.log(t('sat.dl.list.empty'));
      else for (const r of rows) console.log(describe(r));
      await shutdown(0);
    } catch (err) {
      await fail(err);
    }
  });

  // ── package download ──────────────────────────────────────
  const pkg = describeCommand(sat.command('package').alias('paquete'), 'help.sat.package.description');
  const pkgDownload = describeCommand(pkg.command('download').alias('descargar'), 'help.sat.package.download.description');
  argumentByKey(pkgDownload, '<id>', 'help.sat.download.argument.id');
  optionByKey(pkgDownload, '-o, --output <dir>', 'help.sat.package.download.option.output');
  optionByKey(pkgDownload, '--package <packageId>', 'help.sat.package.download.option.package');
  optionByKey(pkgDownload, '--import', 'help.sat.package.download.option.import');
  entityOpt(pkgDownload);
  userOpt(pkgDownload);
  pkgDownload.addHelpText('after', EXAMPLES.packageDownload);
  declareRisk(pkgDownload, {
    risk: 'externo',
    llave: { innecesaria: 'a package already archived is never downloaded again, and each CFDI deduplicates by UUID' },
    agent: false,
    writes: 'sat_download_packages; with --import also sat_cfdi_census, sat_census_loads, xml_documents and the inbox',
  });
  pkgDownload.action(async (id: string, opts: {
    output?: string; package?: string; import?: boolean; entity?: string; user?: string;
    dryRun?: boolean; live?: boolean; yes?: boolean; idempotencyKey?: string;
  }) => {
    try {
      const ctx = await resolveEntity(opts.entity);
      await shutdown(await runPackageDownload(ctx, id, opts, gateMutation(pkgDownload, opts), io()));
    } catch (err) {
      await fail(err);
    }
  });

  // ── quota show (local, no network) ────────────────────────
  const quota = describeCommand(sat.command('quota').alias('cuota'), 'help.sat.quota.description');
  const quotaShow = describeCommand(quota.command('show').alias('ver'), 'help.sat.quota.show.description');
  optionByKey(quotaShow, '--since <date>', 'help.sat.quota.show.option.since');
  optionByKey(quotaShow, '--until <date>', 'help.sat.quota.show.option.until');
  jsonOpt(quotaShow);
  entityOpt(quotaShow);
  quotaShow.addHelpText('after', EXAMPLES.quotaShow);
  declareRisk(quotaShow, { risk: 'lectura', agent: true });
  quotaShow.action(async (opts: { since?: string; until?: string; json?: boolean; format?: string; entity?: string }) => {
    try {
      const ctx = await resolveEntity(opts.entity);
      const rows = await quotaRows(entityScope(ctx.tenantId, ctx.entityId), {
        since: opts.since ? `${dayOrUsage('--since', opts.since)}T00:00:00` : undefined,
        until: opts.until ? `${dayOrUsage('--until', opts.until)}T23:59:59` : undefined,
      });
      if (wantsJson(opts)) console.log(JSON.stringify(rows));
      else if (rows.length === 0) console.log(t('sat.dl.quota.empty'));
      else {
        for (const q of rows) {
          console.log(t('sat.dl.quota.line', {
            state: q.remaining === 0 ? t('sat.dl.quota.spent') : t('sat.dl.quota.left', { n: q.remaining }),
            direction: q.direction, from: q.periodStart.slice(0, 10), to: q.periodEnd.slice(0, 10),
            made: q.requestsMade, limit: LIFETIME_XML_LIMIT,
          }));
        }
      }
      await shutdown(0);
    } catch (err) {
      await fail(err);
    }
  });
}
