import fs from 'node:fs';
import { envFileCandidates } from '../config/env-file.js';
import { configFilePaths } from '../ai/providers/config.js';
import { providerReadiness } from '../ai/providers/credential-state.js';
import { missingCredentialHint } from './provider-readiness.js';

// ============================================================
// FIRST-RUN DETECTION
// The wizard has no state file: state IS the system, re-derived
// on every bare invocation (OpenClaw's state-aware entry). This
// module answers one question cheaply and WITHOUT EVER THROWING:
//   fresh   nothing configured yet → offer the init wizard
//   broken  configured but not working → offer rescue/repair
//   ready   DB up, entities exist, provider has a credential → chat
// Each shortfall carries a human-readable reason; the entry flow
// turns reasons into the exact next command (never dead-end).
//
// The DB probe is injected for tests and lazy at runtime: merely
// requiring this module must never spin up a connection pool.
// ============================================================

export type SetupState = {
  state: 'fresh' | 'broken' | 'ready';
  reasons: string[];
  entityCount?: number;
  providerName?: string;
};

export interface DetectDeps {
  cwd?: string;
  /** Home directory that holds ~/.mnemosine/.env; default os.homedir(). */
  home?: string;
  env?: NodeJS.ProcessEnv;
  fileExists?: (p: string) => boolean;
  /** Cheap liveness probe; default: lazy-imported query('SELECT 1'). */
  probeDb?: () => Promise<void>;
  /** Count of active legal entities; default: lazy-imported query. */
  countActiveEntities?: () => Promise<number>;
  /** The profile chat was asked for (--provider); default: the configured default. */
  provider?: string;
  /**
   * Judges the AI provider: its name, and `notReady`, the reason to print when
   * it has no credential. Default: the readiness answer (credential-state),
   * which never runs a helper, so a failed startup does not run it twice.
   */
  resolveProvider?: () => ProviderVerdict | Promise<ProviderVerdict>;
  /** Cap on each DB call; keeps the bare invocation snappy. */
  timeoutMs?: number;
}

export interface ProviderVerdict {
  name: string;
  notReady?: string;
}

/** The readiness answer for the profile chat starts on (MNE-001-444). Throws when the config does not load. */
function readinessVerdict(deps: DetectDeps, cwd: string, env: NodeJS.ProcessEnv): ProviderVerdict {
  const { profiles, states, defaultName } = providerReadiness({ cwd, env, home: deps.home });
  const name = deps.provider || defaultName;
  const profile = profiles[name];
  const state = states[name];
  // A --provider that names no profile is a typo, not a broken machine: the
  // startup's own «does not exist» error, which lists the names, says more.
  if ((!profile || !state) && deps.provider) return { name };
  if (!profile || !state) throw new Error(`provider ${name} does not exist`);
  return { name, notReady: missingCredentialHint(name, profile, state) ?? undefined };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref?.();
    // Promise.resolve().then(run) also converts a synchronous throw into a rejection.
    Promise.resolve()
      .then(run)
      .finally(() => clearTimeout(timer))
      .then(resolve, reject);
  });
}

async function detect(deps: DetectDeps): Promise<SetupState> {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const timeoutMs = deps.timeoutMs ?? 3000;
  const fileExists =
    deps.fileExists ??
    ((p: string) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });

  // ─── fresh: never configured ───
  const hasEnvFile = envFileCandidates(cwd, deps.home).some(fileExists);
  const hasConfigFile = configFilePaths(cwd).some(fileExists);
  if (!hasEnvFile && !hasConfigFile) {
    return { state: 'fresh', reasons: ['no .env file (never configured)'] };
  }
  if (!env.DATABASE_URL) {
    return { state: 'fresh', reasons: ['DATABASE_URL is not set (add it to your .env)'] };
  }

  // ─── broken vs ready: probe the live system ───
  const reasons: string[] = [];
  let entityCount: number | undefined;
  let providerName: string | undefined;

  // Lazy import: connection.js builds its pool on first query, and importing
  // it eagerly from here would put that machinery on every CLI code path.
  const probeDb =
    deps.probeDb ??
    (async () => {
      const { query } = await import('../database/connection.js');
      await query('SELECT 1');
    });
  const countActiveEntities =
    deps.countActiveEntities ??
    (async () => {
      const { query } = await import('../database/connection.js');
      const result = await query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM legal_entities WHERE is_active = true'
      );
      return result.rows[0]?.n ?? 0;
    });

  let dbUp = false;
  try {
    await withTimeout(probeDb, timeoutMs);
    dbUp = true;
  } catch (err) {
    reasons.push(`database unreachable: ${errorMessage(err)}`);
  }

  if (dbUp) {
    try {
      entityCount = await withTimeout(countActiveEntities, timeoutMs);
      if (entityCount === 0) reasons.push('no legal entities registered');
    } catch (err) {
      reasons.push(`database unreachable: ${errorMessage(err)}`);
    }
  }

  // Provider readiness is filesystem/env only — independent of the DB.
  const resolveProvider = deps.resolveProvider ?? (() => readinessVerdict(deps, cwd, env));
  try {
    const verdict = await resolveProvider();
    if (verdict.notReady) reasons.push(verdict.notReady);
    else providerName = verdict.name;
  } catch {
    reasons.push('AI provider not configured');
  }

  return {
    state: reasons.length > 0 ? 'broken' : 'ready',
    reasons,
    ...(entityCount !== undefined ? { entityCount } : {}),
    ...(providerName !== undefined ? { providerName } : {}),
  };
}

/**
 * Classifies the setup for the bare-invocation entry flow. NEVER throws:
 * any unexpected failure degrades to 'broken' with a reason, because the
 * entry banner must render no matter what state the machine is in.
 */
export async function detectSetupState(deps: DetectDeps = {}): Promise<SetupState> {
  try {
    return await detect(deps);
  } catch (err) {
    return { state: 'broken', reasons: [`setup check failed: ${errorMessage(err)}`] };
  }
}
