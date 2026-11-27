import os from 'node:os';
import type { Command } from 'commander';
import { query } from '../database/connection.js';
import {
  bootstrapTenant,
  inquilinoDeLaSesion,
  type OrigenDeInquilino,
} from '../ai/context.js';
import {
  listProfiles,
  resolveFailoverChain,
  resolveIngestThresholds,
  resolveLanguage,
  resolveProfile,
  type ProfileWithFailover,
} from '../ai/providers/config.js';
import { probeAll, type NamedProbeResult, type ProbeOptions } from '../ai/providers/probe.js';
import { credentialState } from '../ai/providers/credential-state.js';
import { FLOOR_MAX_AUTO_POST, floorMaxAutoAmount } from '../ai/floor.js';
import type { ResolvedProfile } from '../ai/providers/types.js';
import { describeCommand, exitCodeFor, optionByKey } from './kernel/index.js';
import { t } from '../i18n/index.js';

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
  /**
   * The readiness answer doctor, providers, init and the tick give too
   * (credential-state.ts): a variable's name, a helper's file, «local» or what
   * is missing. Never a value, never a helper's command.
   */
  credential: string;
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

/** The fixed details the report carries in English (--json keeps them); the table reads them back by key. */
const DETAILS = ['reachable', 'key_cmd_failed', 'no_tenant', 'db_unreachable'] as const;
const english = (k: (typeof DETAILS)[number]): string => t(`platform.status.detail.${k}`, {}, 'en');
const spoken = (v: string): string => {
  const k = DETAILS.find((d) => english(d) === v);
  return k ? t(`platform.status.detail.${k}`) : v;
};

/** Cómo se nombra en la salida cada escalón de la precedencia publicada. */
const FUENTE_DEL_INQUILINO: Record<OrigenDeInquilino, string | null> = {
  bandera: '--tenant',
  entorno: 'MNEMOSINE_TENANT',
  config: 'mnemosine.config.json',
  ninguno: null,
};

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
  env: NodeJS.ProcessEnv,
  cwd: string,
  source: string | null
): ProviderStatusRow {
  const keyEnv = profile.api_key_env ?? null;
  return {
    name,
    type: profile.type,
    model: profile.model,
    keyEnv,
    keySet: keyEnv !== null && Boolean(env[keyEnv]),
    credential: credentialState(profile, { cwd, env, source }).label,
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
  const { profiles, defaultName, source, origins } = listProfiles(cwd);

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
  for (const target of probeTargets) rows.set(target.name, toRow(target.name, target, env, cwd, origins[target.name] ?? null));

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
        row.skipped = english('key_cmd_failed');
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
    database = { ok: true, detail: english('reachable') };
    try {
      const r = await query<{ tenant: string | null }>(
        "SELECT current_setting('app.current_tenant', true) AS tenant"
      );
      const tenant = r.rows[0]?.tenant ?? null;
      // DE DÓNDE SALIÓ, no sólo cuál es. Mientras la bandera se ignoraba en
      // silencio, «tenant context X applied» era verdad y aun así engañaba:
      // no decía que X venía del .env y no del `--tenant` que se tecleó.
      const sesion = inquilinoDeLaSesion();
      const fuente =
        tenant && sesion.tenantId === tenant ? FUENTE_DEL_INQUILINO[sesion.origen] : null;
      rls =
        tenant && tenant.length > 0
          ? {
              active: true,
              detail: `tenant context "${tenant}" applied${fuente ? ` (from ${fuente})` : ''}`,
            }
          : {
              active: false,
              detail: english('no_tenant'),
            };
    } catch (err) {
      rls = { active: false, detail: sanitizeDbError(err) };
    }
  } catch (err) {
    database = { ok: false, detail: sanitizeDbError(err) };
    rls = { active: false, detail: english('db_unreachable') };
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

const LABELS = ['config_file', 'provider', 'model', 'language', 'auto_post', 'connection', 'rls'] as const;

/** Renders the report as plain lines. Pure formatting — no I/O. */
export function formatStatus(report: StatusReport, c: StatusDeps['palette']): string[] {
  const out: string[] = ['', c.bold('mnemosine status'), ''];

  // The label column pads to the longest label of the language, plus three (19 in English).
  const width = Math.max(...LABELS.map((k) => t(`platform.status.label.${k}`).length)) + 3;
  const label = (k: (typeof LABELS)[number]): string => `  ${t(`platform.status.label.${k}`).padEnd(width)}`;
  out.push(c.bold(t('platform.status.section.configuration')));
  out.push(`${label('config_file')}${report.config.source ?? c.dim(t('platform.status.no_config'))}`);
  out.push(`${label('provider')}${c.cyan(report.config.provider)}`);
  out.push(`${label('model')}${report.config.model}`);
  out.push(`${label('language')}${report.config.language}`);
  const th = report.config.thresholds;
  out.push(
    `${label('auto_post')}${t('platform.status.thresholds', { on: String(th.autoPost), confidence: th.minConfidence, max: th.maxAmount })} ` +
      c.dim(t('platform.status.floor_cap', { cap: th.floorCap }))
  );

  out.push('');
  out.push(c.bold(t('platform.status.section.database')));
  out.push(`${label('connection')}${t('platform.status.mark', { ok: String(report.database.ok) })}  ${c.dim(spoken(report.database.detail))}`);
  out.push(`${label('rls')}${t('platform.status.rls_state', { active: String(report.rls.active) })}  ${c.dim(spoken(report.rls.detail))}`);

  out.push('');
  out.push(c.bold(t('platform.status.section.providers')));
  for (const p of report.providers) {
    const key = p.credential;
    let probeText: string;
    if (p.skipped) probeText = t('platform.status.probe.skipped', { reason: spoken(p.skipped) });
    else if (p.probe && p.probe.ok) probeText = t('platform.status.probe.ok', { ms: p.probe.latencyMs });
    else if (p.probe) probeText = t('platform.status.probe.failed', { category: String(p.probe.category), detail: p.probe.detail });
    else probeText = c.dim(t('platform.status.probe.none'));
    out.push(`  ${c.cyan(p.name.padEnd(14))} ${p.model.padEnd(24)} ${key}`);
    out.push(`  ${''.padEnd(14)} ${probeText}`);
    if (p.failover?.length) out.push(`  ${''.padEnd(14)} ${c.dim(`failover: ${p.failover.join(' -> ')}`)}`);
  }
  out.push('');
  out.push(c.dim(t('platform.status.redacted')));
  out.push('');
  return out;
}

export function registerStatusCommand(program: Command, deps: StatusDeps): void {
  const status = describeCommand(program.command('status').alias('estado'), 'help.status.description');
  optionByKey(status, '--all', 'help.status.option.all');
  optionByKey(status, '-t, --tenant <id>', 'help.status.option.tenant');
  optionByKey(status, '--json', 'help.status.option.json');
  optionByKey(status, '--strict', 'help.status.option.strict');
  status.action(async (opts: { all?: boolean; tenant?: string; json?: boolean; strict?: boolean }) => {
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
        await deps.shutdown(exitCodeFor(err));
      }
    });
}
