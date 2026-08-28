import fs from 'node:fs';
import path from 'node:path';
import { configFilePaths, resolveProfile } from '../ai/providers/config.js';

// ============================================================
// FIRST-RUN DETECTION
// The wizard has no state file: state IS the system, re-derived
// on every bare invocation (OpenClaw's state-aware entry). This
// module answers one question cheaply and WITHOUT EVER THROWING:
//   fresh   nothing configured yet → offer the init wizard
//   broken  configured but not working → offer rescue/repair
//   ready   DB up, entities exist, provider resolves → chat
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
  env?: NodeJS.ProcessEnv;
  fileExists?: (p: string) => boolean;
  /** Cheap liveness probe; default: lazy-imported query('SELECT 1'). */
  probeDb?: () => Promise<void>;
  /** Count of active legal entities; default: lazy-imported query. */
  countActiveEntities?: () => Promise<number>;
  /** Resolves the default AI provider; default: resolveProfile(). */
  resolveProvider?: () => { name: string } | Promise<{ name: string }>;
  /** Cap on each DB call; keeps the bare invocation snappy. */
  timeoutMs?: number;
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
  const hasEnvFile = fileExists(path.join(cwd, '.env'));
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

  // Provider resolution is filesystem/env only — independent of the DB.
  const resolveProvider =
    deps.resolveProvider ?? (() => ({ name: resolveProfile(undefined, undefined, cwd).name }));
  try {
    providerName = (await resolveProvider()).name;
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
