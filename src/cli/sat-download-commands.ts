import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import { resolveEntity, type AgentContext } from '../ai/context.js';
import { resolveReviewer, type Reviewer } from '../ai/draft-service.js';
import { ingestCfdiFiles } from '../ai/ingest-service.js';
import { entityScope, type EntityScope } from '../database/scope.js';
import { conLlave } from '../services/idempotency/idempotency-store.js';
import {
  requestDownload, verifyDownload, SatDownloadError, type DownloadRequestInput,
} from '../services/sat-download/descarga-masiva.js';
import {
  ensurePackage, getRequest, listRequests, quotaRows, type MirrorRequest,
} from '../services/sat-download/packages.js';
import { CredentialError } from '../services/fiscal-credentials/service.js';
import { declareRisk, gateMutation } from './kernel/risk.js';
import { argumentByKey, describeCommand, optionByKey } from './kernel/help.js';
import { ExitCode, exitCodeFor, notFound, usageError } from './kernel/index.js';
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
// ============================================================

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const POLL_MS = 30_000;
const DIRECTIONS = ['issued', 'received'] as const;
const OPEN = ['accepted', 'in_process'];

const dayOrUsage = (flag: string, v: string | undefined): string => {
  if (!v || !DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw usageError(`${flag} must be a day, YYYY-MM-DD (got "${v ?? ''}")`);
  }
  return v;
};

const safeName = (s: string): string => s.replace(/[^\w.-]/g, '_');

/** `--json` or `--format json`; any other format is a usage error, not a silent table. */
function wantsJson(opts: { json?: boolean; format?: string }): boolean {
  if (opts.format !== undefined && opts.format !== 'table' && opts.format !== 'json') {
    throw usageError(`--format must be table or json (got "${opts.format}")`);
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
  const packages = r.packageIds.length > 0 ? ` · ${r.archivedPackageIds.length}/${r.packageIds.length} package(s) archived` : '';
  const count = r.cfdiCount === null ? '' : ` · ${r.cfdiCount} CFDI`;
  return `${r.id} · ${r.direction} ${r.requestType === 'CFDI' ? 'xml' : 'metadata'} ` +
    `${r.periodStart.slice(0, 10)}..${r.periodEnd.slice(0, 10)} · ${r.status}${count}${packages}` +
    `${r.errorKey ? ` · ${r.errorKey}` : ''}`;
}

/** What the exit code says about a failure: a spent limit is BLOCKED, the SAT or the wire failing is EXTERNAL_FAILED. */
function exitForSat(err: unknown): number {
  if (err instanceof SatDownloadError) return err.retry === 'permanent_quota' ? ExitCode.BLOCKED : ExitCode.EXTERNAL_FAILED;
  if (err instanceof CredentialError) return ExitCode.PERMISSION;
  return exitCodeFor(err);
}

async function requestOrNotFound(scope: EntityScope, id: string): Promise<MirrorRequest> {
  const row = await getRequest(scope, id);
  if (!row) throw notFound(`Download request ${id} not found for this entity`);
  return row;
}

/**
 * A package's bytes go through the ingestion of MNE-001-096: `runCensus` loads
 * the census (metadata, or the XML of the ZIP) and hands the ingestible XML
 * back; those then enter by the same path as `mnemosine ingest`, marked
 * `sat_download` and deduplicated by UUID. No model is consulted: what the
 * firm's rules do not decide stays in the inbox to code.
 */
export async function importPackage(
  ctx: AgentContext, reviewer: Reviewer, scope: EntityScope, request: MirrorRequest, file: string
): Promise<{ invalid: number }> {
  const run = await runCensus({
    kind: request.requestType === 'Metadata' ? 'metadata' : 'zip', files: [file], scope, entityRfc: ctx.taxId,
    dryRun: false, loadedBy: reviewer.userId,
  });
  if (run.xmlFiles.length > 0) {
    const report = await ingestCfdiFiles({
      ctx, reviewer, files: run.xmlFiles, thresholds: { autoPost: false, minConfidence: 1, maxAmount: 0 },
      session: null, capture: { drafts: [] }, importSource: 'sat_download',
    });
    const counts = Object.entries(report.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
    console.log(`  ingest: ${counts || 'nothing'}`);
  }
  return { invalid: run.reading.invalid.length };
}

export function registerSatDownloadCommands(sat: Command, deps: SatCommandDeps): void {
  const { color: c, shutdown, reportError, ask } = deps;
  const authCtx = (ctx: AgentContext, reviewer: Reviewer) => ({
    tenantId: ctx.tenantId, entityId: ctx.entityId, actor: reviewer.email, unattended: false,
  });
  const fail = async (err: unknown): Promise<never> => {
    reportError(err);
    return shutdown(exitForSat(err));
  };

  const download = describeCommand(sat.command('download').alias('descarga'), 'help.sat.download.description');
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
      const { dryRun, live } = gateMutation(create, opts);
      if (!(DIRECTIONS as readonly string[]).includes(opts.direction)) {
        throw usageError(`--direction must be issued or received (got "${opts.direction}")`);
      }
      if (opts.kind !== 'metadata' && opts.kind !== 'xml') {
        throw usageError(`--kind must be metadata or xml (got "${opts.kind}")`);
      }
      const input: DownloadRequestInput = {
        direction: opts.direction as DownloadRequestInput['direction'],
        requestType: opts.kind === 'xml' ? 'CFDI' : 'Metadata',
        start: `${dayOrUsage('--since', opts.since)}T00:00:00`,
        end: `${dayOrUsage('--until', opts.until)}T23:59:59`,
      };
      if (input.start >= input.end) throw usageError('--since must be before --until');
      const scope = entityScope(ctx.tenantId, ctx.entityId);

      // The same counter the engine reserves from, read first so the operator
      // sees what a real run would spend. The engine still refuses from the
      // database at the moment of the call.
      const used = (await quotaRows(scope, {})).find((q) =>
        q.direction === input.direction && q.periodStart === input.start && q.periodEnd === input.end);
      const spent = input.requestType === 'CFDI' && used?.remaining === 0;
      const plan = `${input.direction} ${opts.kind} ${input.start}..${input.end} for ${ctx.entityName} (${ctx.taxId})` +
        (input.requestType === 'CFDI' ? ` · lifetime XML requests left for this period: ${used ? used.remaining : 2}` : '');
      if (dryRun || !live) {
        console.log(`${dryRun ? 'Would ask the SAT for' : 'Not sent:'} ${plan}`);
        if (spent) console.log('The lifetime limit of this period is spent: a real run refuses before calling the SAT.');
        console.log(c.dim(dryRun
          ? '(dry-run: nothing was written and the SAT was not called)'
          : 'Asking the SAT uses the e.firma and is opt-in: re-run with --live.'));
        await shutdown(spent ? ExitCode.BLOCKED : 0);
      }
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      if (input.requestType === 'CFDI' && !opts.yes) {
        const rl = readline.createInterface({ input: stdin, output: stdout });
        const ok = await ask(rl, c.cyan(`This spends one of the 2 lifetime XML requests of the period (${plan}). Type "yes": `));
        rl.close();
        if ((ok ?? '').trim().toLowerCase() !== 'yes') {
          console.log(c.dim('Cancelled. Nothing was requested.'));
          await shutdown(0);
        }
      }
      const payloadHash = createHash('sha256').update(JSON.stringify([ctx.entityId, input])).digest('hex');
      const done = await conLlave(
        { tenantId: ctx.tenantId, entityId: ctx.entityId },
        { scope: 'sat download create', clave: opts.idempotencyKey, payloadHash },
        async () => {
          const s = await requestDownload(authCtx(ctx, reviewer), input);
          return { id: s.id, status: s.status, satCode: s.satCode, errorKey: s.errorKey };
        }
      );
      const r = done.resultado;
      console.log(`${done.repetido ? 'Already requested with this key: ' : ''}${r.status === 'accepted' ? '✔' : '·'} ` +
        `request ${String(r.id)} · ${String(r.status)}${r.errorKey ? ` · ${String(r.errorKey)}` : ''}`);
      if (r.status === 'accepted') console.log(c.dim(`Follow it with: mnemosine sat download check ${String(r.id)} --live`));
      await shutdown(r.status === 'rejected' ? ExitCode.EXTERNAL_REJECTED : 0);
    } catch (err) {
      await fail(err);
    }
  });

  // ── check ─────────────────────────────────────────────────
  const check = describeCommand(download.command('check').alias('verificar'), 'help.sat.download.check.description');
  argumentByKey(check, '<id>', 'help.sat.download.argument.id');
  optionByKey(check, '--wait', 'help.sat.download.check.option.wait');
  optionByKey(check, '--timeout <seconds>', 'help.sat.download.check.option.timeout', {
    parser: (v) => parseInt(v, 10), defaultValue: 900,
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
    writes: 'sat_download_requests (state and package ids); one signed request to the SAT per poll',
  });
  check.action(async (id: string, opts: {
    wait?: boolean; timeout: number; strict?: boolean; json?: boolean; format?: string; entity?: string; user?: string;
    dryRun?: boolean; live?: boolean; yes?: boolean; idempotencyKey?: string;
  }) => {
    try {
      const ctx = await resolveEntity(opts.entity);
      const { dryRun, live } = gateMutation(check, opts);
      const scope = entityScope(ctx.tenantId, ctx.entityId);
      let row = await requestOrNotFound(scope, id);
      if (dryRun || !live) {
        console.log(`${dryRun ? 'Would ask' : 'Not asked:'} the SAT about ${describe(row)}`);
        console.log(c.dim(dryRun ? '(dry-run: the SAT was not called)' : 'Asking the SAT uses the e.firma: re-run with --live.'));
        await shutdown(0);
      }
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const deadline = Date.now() + opts.timeout * 1000;
      for (;;) {
        if (OPEN.includes(row.status)) {
          await verifyDownload(authCtx(ctx, reviewer), row.id);
          row = await requestOrNotFound(scope, row.id);
        }
        if (!opts.wait || !OPEN.includes(row.status) || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))));
      }
      console.log(wantsJson(opts) ? JSON.stringify(row) : describe(row));
      await shutdown(opts.strict && !(row.status === 'finished' && row.packageIds.length > 0) ? 1 : 0);
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
      console.log(wantsJson(opts) ? JSON.stringify(row) : describe(row));
      await shutdown(0);
    } catch (err) {
      await fail(err);
    }
  });

  // ── list ──────────────────────────────────────────────────
  const list = describeCommand(download.command('list').alias('listar'), 'help.sat.download.list.description');
  optionByKey(list, '-s, --status <status>', 'help.sat.download.list.option.status');
  optionByKey(list, '--since <date>', 'help.sat.download.list.option.since');
  optionByKey(list, '-n, --limit <n>', 'help.sat.download.list.option.limit', { parser: (v) => parseInt(v, 10), defaultValue: 30 });
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
      if (wantsJson(opts)) console.log(JSON.stringify(rows));
      else if (rows.length === 0) console.log('No download requests.');
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
    let tmp: string | null = null;
    try {
      const ctx = await resolveEntity(opts.entity);
      const { dryRun, live } = gateMutation(pkgDownload, opts);
      const scope = entityScope(ctx.tenantId, ctx.entityId);
      const row = await requestOrNotFound(scope, id);
      if (row.status !== 'finished') {
        throw new SatDownloadError(
          `Request ${row.id} is ${row.status}; only a finished request has packages (run: mnemosine sat download check ${row.id} --live)`,
          'sat_download.request_not_finished', 'ambiguous');
      }
      const wanted = opts.package ? row.packageIds.filter((p) => p === opts.package) : row.packageIds;
      if (wanted.length === 0) throw notFound(`Request ${row.id} has no package ${opts.package ?? ''}`.trim());
      const missing = wanted.filter((p) => !row.archivedPackageIds.includes(p));
      if (dryRun || (missing.length > 0 && !live)) {
        console.log(`${dryRun ? 'Would download' : 'Not downloaded:'} ${missing.length} of ${wanted.length} package(s); ` +
          `${wanted.length - missing.length} already archived${opts.import ? '; then load them with the ingestion' : ''}.`);
        console.log(c.dim(dryRun ? '(dry-run: the SAT was not called and nothing was written)'
          : 'Downloading uses the e.firma and is opt-in: re-run with --live. Packages expire at the SAT 72 h after they are ready.'));
        await shutdown(0);
      }
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      let failed = 0;
      let invalid = 0;
      if (opts.output) fs.mkdirSync(opts.output, { recursive: true });
      for (const packageId of wanted) {
        try {
          const kept = await ensurePackage(authCtx(ctx, reviewer), scope, row, packageId);
          console.log(`✔ ${packageId} · ${kept.bytes.length} bytes · sha256 ${kept.sha256} · ` +
            (kept.from === 'archive' ? 'already archived' : 'archived'));
          if (opts.output) fs.writeFileSync(path.join(opts.output, `${safeName(packageId)}.zip`), kept.bytes, { flag: 'wx' });
          if (opts.import) {
            tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-sat-download-'));
            const file = path.join(tmp, `${safeName(packageId)}.zip`);
            fs.writeFileSync(file, kept.bytes);
            invalid += (await importPackage(ctx, reviewer, scope, row, file)).invalid;
          }
        } catch (err) {
          failed += 1;
          reportError(err);
        }
      }
      await shutdown(failed > 0 ? ExitCode.EXTERNAL_FAILED : invalid > 0 ? 1 : 0);
    } catch (err) {
      await fail(err);
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
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
      else if (rows.length === 0) console.log('No XML requests counted. Metadata requests are not limited.');
      else {
        for (const q of rows) {
          console.log(`${q.remaining === 0 ? '✘ spent (unrecoverable)' : `· ${q.remaining} left`} · ${q.direction} ` +
            `${q.periodStart.slice(0, 10)}..${q.periodEnd.slice(0, 10)} · ${q.requestsMade}/2 used`);
        }
      }
      await shutdown(0);
    } catch (err) {
      await fail(err);
    }
  });
}
