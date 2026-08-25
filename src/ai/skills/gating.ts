import fs from 'node:fs';
import path from 'node:path';

// ============================================================
// SKILL GATING (declarative)
// A skill declares what it needs (requires.bins/env/config) and
// the harness decides visibility BEFORE the model sees anything:
// a gated skill is not listed and cannot be viewed — "the model
// never sees what it must not use". Everything here fails
// CLOSED: an unreadable PATH, a missing config, or a malformed
// declaration gates the skill instead of exposing it.
// ============================================================

/** Declared requirements of a skill (all optional in the frontmatter;
 *  normalized to empty arrays by the store's parser). */
export interface SkillRequires {
  /** Executables that must exist on PATH (bare names, no separators). */
  bins: string[];
  /** Environment variables that must be present and non-empty. */
  env: string[];
  /** Dot-paths that must be present in the loaded mnemosine config. */
  config: string[];
}

export interface GateResult {
  gated: boolean;
  /** One human-readable reason per failed requirement (empty when open). */
  reasons: string[];
}

/** The environment the gates are evaluated against. Injectable so tests
 *  (and future per-tenant evaluation) control every input. */
export interface GateEnvironment {
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** The LOADED mnemosine config object; undefined = unavailable (config
   *  requirements then gate the skill — fail closed). */
  config?: unknown;
  /** PATH override for bin lookups; defaults to env.PATH. */
  pathEnv?: string;
}

/**
 * True when `bin` resolves to an existing file on PATH. Bare names only:
 * a requirement containing a path separator (or `..`) is never satisfied —
 * requires.bins declares tools, not filesystem locations.
 */
export function binOnPath(bin: string, pathEnv: string | undefined): boolean {
  if (!bin || bin.includes('/') || bin.includes('\\') || bin.includes('..')) return false;
  if (!pathEnv) return false; // no PATH to search = fail closed
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      if (fs.existsSync(path.join(dir, bin))) return true;
    } catch {
      // unreadable PATH entry: keep looking, never throw
    }
  }
  return false;
}

/**
 * True when the dot-path exists in the config object with a meaningful
 * value (undefined/null/'' count as absent). Only plain-object traversal:
 * a path segment landing on an array or scalar is absent.
 */
export function configPathPresent(config: unknown, dotPath: string): boolean {
  if (!dotPath) return false;
  let node: unknown = config;
  for (const segment of dotPath.split('.')) {
    if (!segment) return false;
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
    node = (node as Record<string, unknown>)[segment];
  }
  return node !== undefined && node !== null && node !== '';
}

/** Evaluates every declared requirement; any failure gates the skill. */
export function evaluateGates(requires: SkillRequires, environment: GateEnvironment = {}): GateResult {
  const env = environment.env ?? process.env;
  const pathEnv = environment.pathEnv ?? env.PATH;
  const reasons: string[] = [];

  for (const bin of requires.bins) {
    if (!binOnPath(bin, pathEnv)) reasons.push(`required binary "${bin}" not found on PATH`);
  }
  for (const name of requires.env) {
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') {
      reasons.push(`required environment variable "${name}" is not set`);
    }
  }
  for (const dotPath of requires.config) {
    if (environment.config === undefined) {
      // No config loaded at all: fail closed rather than guess.
      reasons.push(`required config "${dotPath}" unavailable (no configuration loaded)`);
    } else if (!configPathPresent(environment.config, dotPath)) {
      reasons.push(`required config "${dotPath}" is not set`);
    }
  }

  return { gated: reasons.length > 0, reasons };
}

/**
 * Per-profile allowlist as the FINAL set: when present, only the named
 * skills survive — it can only NARROW, never resurrect a gated skill
 * (callers apply it after gating). An empty allowlist means "no skills".
 * Absent (undefined) = no restriction.
 */
export function applyAllowlist<T extends { name: string }>(
  skills: T[],
  allowlist: string[] | undefined
): T[] {
  if (allowlist === undefined) return skills;
  const allowed = new Set(allowlist);
  return skills.filter((s) => allowed.has(s.name));
}

/**
 * Reads the optional `skills?: string[]` allowlist off a provider profile
 * STRUCTURALLY (the strict profile schema in providers/config.ts must
 * declare the key for user configs to carry it — see integration notes).
 * A malformed value (non-array, non-string entries) fails closed as an
 * EMPTY allowlist: a broken restriction must never widen visibility.
 */
export function resolveProfileAllowlist(profile: unknown): string[] | undefined {
  if (typeof profile !== 'object' || profile === null) return undefined;
  const skills = (profile as Record<string, unknown>).skills;
  if (skills === undefined) return undefined;
  if (!Array.isArray(skills)) return [];
  const names = skills.filter((s): s is string => typeof s === 'string' && s.length > 0);
  return names.length === skills.length ? names : [];
}
