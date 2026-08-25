import os from 'node:os';
import type { Command } from 'commander';
import { query } from '../database/connection.js';
import { bootstrapTenant } from '../ai/context.js';
import {
  listProfiles,
  resolveFailoverChain,
  resolveIngestThresholds,
  resolveLanguage,
  resolveProfile,
  type ProfileWithFailover,
} from '../ai/providers/config.js';
import { probeAll, type NamedProbeResult, type ProbeOptions } from '../ai/providers/probe.js';
import { FLOOR_MAX_AUTO_POST, floorMaxAutoAmount } from '../ai/floor.js';
import type { ResolvedProfile } from '../ai/providers/types.js';

// ============================================================
// mnemosine status [--all] [--json]
// Operator-facing health snapshot: config summary (thresholds
// shown AFTER floor clamping — what actually applies), live
// provider probes with categorized errors, DB reachability and
// RLS-active check.
//
// REDACTED BY DESIGN: the output (and --json, meant for support
// tickets) never contains API keys or other env var VALUES, and
// never absolute paths under the user's home — only env var
// NAMES with set/unset, and '~'-relative paths. What is safe to
// print here is safe to paste in a ticket.
// ============================================================

export interface ProviderStatusRow {
  name: string;
  type: string;
  model: string;
  /** NAME of the env var holding the credential (never its value). */
  keyEnv: string | null;
  keySet: boolean;
  /** Where the credential came from ('cmd' = the profile's api_key_cmd). */
  keySource?: 'env' | 'cmd';
  failover?: string[];
  probe?: NamedProbeResult;
  /** Reason the probe was skipped (e.g. credential unset). */
  skipped?: string;
}

export interface StatusReport {
  config: {
    /** Config file path with the home directory collapsed to '~'. */
    source: string | null;
    provider: string;
    model: string;
    language: string;
    thresholds: {
      autoPost: boolean;
      minConfidence: number;
      /** Effective cap AFTER floor clamping (Math.min with the floor). */
      maxAmount: number;
      floorCap: number;
    };
  };
  database: { ok: boolean; detail: string };
  rls: { active: boolean; detail: string };
  providers: ProviderStatusRow[];
}

/** Collapses the home directory to '~': home paths never leave the machine. */
export function redactHomePath(p: string | null, home = os.homedir()): string | null {
  if (p === null) return null;
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// ─── DB error sanitization ───
//
// Raw pg / node-postgres error MESSAGES can embed connection-string data:
// usernames ('password authentication failed for user "victor"'), hostnames
// (getaddrinfo ENOTFOUND db.internal.corp), socket paths under $HOME, or
// fragments of a malformed DATABASE_URL. The report promises redacted output,
// so message text NEVER lands in a detail — only a fixed taxonomy plus the
// bare error CODE (SQLSTATE or errno name), which carries no identity data.

const DB_AUTH_CODES = new Set(['28P01', '28000']);
const DB_TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', '57014']);
const DB_UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  '57P03', // cannot_connect_now
  '3D000', // invalid_catalog_name (database does not exist)
]);
const DB_KNOWN_CODES = [...DB_AUTH_CODES, ...DB_TIMEOUT_CODES, ...DB_UNREACHABLE_CODES];

/**
 * Maps a DB error to `<category> (<code>)` with a fixed taxonomy —
 * unreachable / auth / timeout / other — never echoing err.message.
 */
export function sanitizeDbError(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
  let code: string | undefined;
  for (const c of [e?.code, e?.cause?.code]) {
    if (typeof c === 'string' && c.length > 0) {
      code = c;
      break;
    }
  }
  if (!code && typeof e?.message === 'string') {
    // Fallback for errors that carry the errno only inside the message
    // (safe: we extract a token from a FIXED allowlist, never free text).
    code = DB_KNOWN_CODES.find((k) => (e.message as string).includes(k));
  }
  let category: 'unreachable' | 'auth' | 'timeout' | 'other' = 'other';
  if (code && DB_AUTH_CODES.has(code)) category = 'auth';
  else if (code && DB_TIMEOUT_CODES.has(code)) category = 'timeout';
  else if (code && DB_UNREACHABLE_CODES.has(code)) category = 'unreachable';
  return code ? `${category} (${code})` : category;
}

export interface BuildStatusOptions {
  /** Probe every profile instead of just the active chain. */
  all?: boolean;
  cwd?: string;
  probeOptions?: ProbeOptions;
  /** Injectable env for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Injectable credential resolver for tests. Defaults to config.ts's
   * resolveProfile — the SAME path real sessions use, so profiles whose
   * credential comes from api_key_cmd probe exactly like they run.
   */
  resolveProfileFn?: typeof resolveProfile;
}

function toRow(
  name: string,
  profile: ProfileWithFailover,
  env: NodeJS.ProcessEnv
): ProviderStatusRow {
  const keyEnv = profile.api_key_env ?? null;
  return {
    name,
    type: profile.type,
    model: profile.model,
    keyEnv,
    keySet: keyEnv !== null && Boolean(env[keyEnv]),
    ...(profile.failover ? { failover: profile.failover } : {}),
  };
}

/**
 * Builds the full (already redacted) status report. DB failures are captured
 * as rows, never thrown: a broken database is exactly what status must report.
 */
export async function buildStatusReport(options: BuildStatusOptions = {}): Promise<StatusReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const { profiles, defaultName, source } = listProfiles(cwd);

  const thresholds = resolveIngestThresholds({}, cwd);
  const active = profiles[defaultName] as ProfileWithFailover | undefined;

  // Which profiles get a live probe: the active failover chain by default,
  // everything with --all.
  let probeTargets: Array<ProfileWithFailover & { name: string }>;
  if (options.all) {
    probeTargets = Object.entries(profiles).map(([name, p]) => ({ ...(p as ProfileWithFailover), name }));
  } else if (active) {
    try {
      probeTargets = resolveFailoverChain(defaultName, cwd);
    } catch {
      // A broken failover chain must not hide the rest of the report; the
      // primary is still probed and the chain error surfaces on first use.
      probeTargets = [{ ...active, name: defaultName }];
    }
  } else {
    probeTargets = [];
  }

  const rows = new Map<string, ProviderStatusRow>();
  for (const target of probeTargets) rows.set(target.name, toRow(target.name, target, env));

  const resolveProfileFn = options.resolveProfileFn ?? resolveProfile;
  const probeable: ResolvedProfile[] = [];
  for (const target of probeTargets) {
    const row = rows.get(target.name)!;
    let apiKey = target.api_key_env ? env[target.api_key_env] : undefined;
    if (apiKey) row.keySource = 'env';
    if (!apiKey && target.api_key_cmd) {
      // api_key_cmd is a first-class credential path (vaults, OAuth helpers):
      // resolve it through the SAME code real sessions use instead of
      // reporting a working provider as unset.
      try {
        apiKey = resolveProfileFn(target.name, undefined, cwd).apiKey;
        if (apiKey) {
          row.keySet = true;
          row.keySource = 'cmd';
        }
      } catch {
        // Fixed string on purpose: helper errors can echo the command line
        // or paths, and every detail here must stay shareable.
        row.skipped = 'api_key_cmd failed to produce a credential';
        continue;
      }
    }
    if (target.type === 'openai-compatible' && target.api_key_env && !apiKey) {
      row.skipped = `credential ${target.api_key_env} unset`;
      continue;
    }
    probeable.push({ ...target, apiKey });
  }
  const probes = await probeAll(probeable, options.probeOptions);
  for (const probe of probes) {
    const row = rows.get(probe.name);
    if (row) row.probe = probe;
  }

  // DB reachability + RLS-active: current_setting('app.current_tenant', true)
  // returns the tenant the connection layer applies via set_config (see
  // src/database/connection.ts) — non-empty means RLS policies are filtering.
  let database: StatusReport['database'];
  let rls: StatusReport['rls'];
  try {
    await query('SELECT 1 AS ok');
    database = { ok: true, detail: 'reachable' };
    try {
      const r = await query<{ tenant: string | null }>(
        "SELECT current_setting('app.current_tenant', true) AS tenant"
      );
      const tenant = r.rows[0]?.tenant ?? null;
      rls =
        tenant && tenant.length > 0
          ? { active: true, detail: `tenant context "${tenant}" applied` }
          : {
              active: false,
              detail: 'no tenant context (set --tenant or MNEMOSINE_TENANT to scope by RLS)',
            };
    } catch (err) {
      rls = { active: false, detail: sanitizeDbError(err) };
    }
  } catch (err) {
    database = { ok: false, detail: sanitizeDbError(err) };
    rls = { active: false, detail: 'skipped: database unreachable' };
  }

  return {
    config: {
      source: redactHomePath(source),
      provider: defaultName,
      model: active?.model ?? '(unknown provider)',
      language: resolveLanguage(cwd),
      thresholds: {
        autoPost: thresholds.autoPost,
        minConfidence: thresholds.minConfidence,
        // What ACTUALLY applies at the auto-post gate: config clamped by the
        // unbreakable floor (Math.min — configuration can never raise it).
        maxAmount: floorMaxAutoAmount(thresholds.maxAmount),
        floorCap: FLOOR_MAX_AUTO_POST,
      },
    },
    database,
    rls,
    providers: [...rows.values()],
  };
}

/**
 * True when any provider row is unhealthy: a probe that ran and failed, or a
 * probe that was SKIPPED (no credential — the provider cannot serve either
 * way; --strict fails closed on it rather than treating "not tested" as ok).
 */
export function hasProviderFailures(report: StatusReport): boolean {
  return report.providers.some((p) => p.skipped !== undefined || (p.probe !== undefined && !p.probe.ok));
}

/**
 * Exit code policy. DB reachability is ALWAYS the primary gate (a dead
 * database fails the command with or without --strict); --strict additionally
 * fails on any provider probe failure or skip.
 */
export function statusExitCode(report: StatusReport, strict: boolean): number {
  if (!report.database.ok) return 1;
  if (strict && hasProviderFailures(report)) return 1;
  return 0;
}

export interface StatusDeps {
  palette: { dim: (s: string) => string; bold: (s: string) => string; cyan: (s: string) => string };
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
}

const mark = (ok: boolean): string => (ok ? 'ok' : 'FAIL');

/** Renders the report as plain lines. Pure formatting — no I/O. */
export function formatStatus(report: StatusReport, c: StatusDeps['palette']): string[] {
  const out: string[] = ['', c.bold('mnemosine status'), ''];

  out.push(c.bold('Configuration'));
  out.push(`  config file        ${report.config.source ?? c.dim('(none — built-in defaults)')}`);
  out.push(`  provider           ${c.cyan(report.config.provider)}`);
  out.push(`  model              ${report.config.model}`);
  out.push(`  agent language     ${report.config.language}`);
  const t = report.config.thresholds;
  out.push(
    `  auto-post          ${t.autoPost ? 'on' : 'off'}  min confidence ${t.minConfidence}  ` +
      `max amount ${t.maxAmount} ${c.dim(`(floor cap ${t.floorCap})`)}`
  );

  out.push('');
  out.push(c.bold('Database'));
  out.push(`  connection         ${mark(report.database.ok)}  ${c.dim(report.database.detail)}`);
  out.push(`  RLS tenant scope   ${report.rls.active ? 'active' : 'inactive'}  ${c.dim(report.rls.detail)}`);

  out.push('');
  out.push(c.bold('Providers'));
  for (const p of report.providers) {
    const key =
      p.keyEnv === null ? c.dim('no credential required') : `${p.keyEnv} ${p.keySet ? 'set' : 'unset'}`;
    let probeText: string;
    if (p.skipped) probeText = `probe skipped (${p.skipped})`;
    else if (p.probe && p.probe.ok) probeText = `probe ok ${p.probe.latencyMs}ms`;
    else if (p.probe) probeText = `probe FAIL [${p.probe.category}] ${p.probe.detail}`;
    else probeText = c.dim('not probed');
    out.push(`  ${c.cyan(p.name.padEnd(14))} ${p.model.padEnd(24)} ${key}`);
    out.push(`  ${''.padEnd(14)} ${probeText}`);
    if (p.failover?.length) out.push(`  ${''.padEnd(14)} ${c.dim(`failover: ${p.failover.join(' -> ')}`)}`);
  }
  out.push('');
  out.push(c.dim('Redacted output: no keys, tokens or home paths. Safe to share in support tickets.'));
  out.push('');
  return out;
}

export function registerStatusCommand(program: Command, deps: StatusDeps): void {
  program
    .command('status')
    .alias('estado')
    .description('Health snapshot: config, live provider probes, database and RLS (redacted, shareable)')
    .option('--all', 'Probe every configured profile, not only the active failover chain')
    .option('-t, --tenant <id>', 'Tenant (for the RLS-active check)')
    .option('--json', 'JSON output (same redacted structure, for support tickets)')
    .option(
      '--strict',
      'Also exit 1 when any provider probe fails or is skipped ' +
        '(by default only database unreachability fails the command)'
    )
    .action(async (opts: { all?: boolean; tenant?: string; json?: boolean; strict?: boolean }) => {
      try {
        bootstrapTenant(opts.tenant);
        const report = await buildStatusReport({ all: opts.all });
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          for (const line of formatStatus(report, deps.palette)) console.log(line);
        }
        await deps.shutdown(statusExitCode(report, Boolean(opts.strict)));
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });
}
