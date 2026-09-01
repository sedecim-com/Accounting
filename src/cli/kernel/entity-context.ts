import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveEntity, listEntities, type AgentContext } from '../../ai/context.js';
import { CliError, ExitCode } from './exit.js';

// ============================================================
// ACTIVE ENTITY CONTEXT
// A firm runs many client companies. Without a current-entity
// mechanism every single command needs --entity, which is both
// the biggest ergonomic cost in the CLI and a real hazard: the
// flag most often typed is the flag most often typed wrong.
//
// Precedence, one rule for the whole CLI:
//   1. --entity <id|name>        explicit beats everything
//   2. MNEMOSINE_ENTITY          for CI and scripts
//   3. the stored active entity  set by `entity use`
//   4. the only entity there is  convenience for single-tenant setups
//
// The store is USER state, not project configuration: it lives in
// ~/.mnemosine/state.json and never in mnemosine.config.json,
// which is project-scoped and may be committed. Which company a
// bookkeeper is looking at right now is not a fact about the repo.
//
// A stored entity that has since been archived or deleted must not
// crash the next command: we say so, drop the stale pointer, and
// fall through to normal resolution.
// ============================================================

interface CliState {
  entityId?: string;
  entityName?: string;
}

export function statePath(home = os.homedir()): string {
  return path.join(home, '.mnemosine', 'state.json');
}

export function readState(home = os.homedir()): CliState {
  const file = statePath(home);
  try {
    if (!fs.existsSync(file)) return {};
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const { entityId, entityName } = parsed as CliState;
    return {
      entityId: typeof entityId === 'string' ? entityId : undefined,
      entityName: typeof entityName === 'string' ? entityName : undefined,
    };
  } catch {
    // A corrupt state file is a cursor, not data: ignore it rather than
    // blocking every command until the user finds and deletes it.
    return {};
  }
}

export function writeState(patch: CliState, home = os.homedir()): string {
  const file = statePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...readState(home), ...patch };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return file;
}

export function clearActiveEntity(home = os.homedir()): void {
  const state = readState(home);
  delete state.entityId;
  delete state.entityName;
  const file = statePath(home);
  if (fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  }
}

export interface EntityResolution {
  ctx: AgentContext;
  /** Where the choice came from, so a command can say so when it matters. */
  source: 'flag' | 'env' | 'stored' | 'only';
}

/**
 * Resolves the entity a command should operate on, under the single
 * precedence rule. `warn` receives any note worth showing the user
 * (a stale stored entity), so this stays free of I/O decisions.
 */
export async function resolveActiveEntity(
  opts: { entity?: string } = {},
  deps: { home?: string; warn?: (message: string) => void } = {}
): Promise<EntityResolution> {
  const home = deps.home ?? os.homedir();
  const warn = deps.warn ?? (() => {});

  if (opts.entity) return { ctx: await resolveEntity(opts.entity), source: 'flag' };

  const fromEnv = process.env.MNEMOSINE_ENTITY?.trim();
  if (fromEnv) return { ctx: await resolveEntity(fromEnv), source: 'env' };

  const stored = readState(home).entityId;
  if (stored) {
    try {
      return { ctx: await resolveEntity(stored), source: 'stored' };
    } catch (err) {
      // NEVER clear the pin here. This catch fires for "the entity was
      // archived", but it fires just as readily on a dropped connection or on
      // a query that ran before the tenant context was entered — and one
      // mistimed command must not destroy the bookkeeper's selection. A stale
      // pin is an annoyance the user can fix in one command; a silently
      // deleted one is state they cannot get back.
      warn(
        `Could not resolve the active entity (${stored}): ${(err as Error).message}\n` +
          'The selection was kept. Use `mnemosine entity use <id|name>` to change it, ' +
          'or `mnemosine entity unset` to clear it.'
      );
    }
  }

  // Falls back to resolveEntity's own single-entity rule, whose errors
  // already list the candidates when there is more than one.
  return { ctx: await resolveEntity(), source: 'only' };
}

/** `entity use <id|name>`: pin the entity for subsequent commands. */
export async function useEntity(
  idOrName: string,
  home = os.homedir()
): Promise<{ ctx: AgentContext; file: string }> {
  const ctx = await resolveEntity(idOrName);
  const file = writeState({ entityId: ctx.entityId, entityName: ctx.entityName }, home);
  return { ctx, file };
}

/** `entity current`: what the next command would operate on, and why. */
export async function currentEntity(
  home = os.homedir()
): Promise<EntityResolution | null> {
  try {
    return await resolveActiveEntity({}, { home });
  } catch {
    return null;
  }
}

/**
 * Guard for commands that must not guess. Unlike resolveActiveEntity it
 * refuses the "only entity" fallback, so a destructive command in a
 * multi-entity firm always names its target explicitly.
 */
export async function requireExplicitEntity(
  opts: { entity?: string } = {},
  deps: { home?: string; warn?: (message: string) => void } = {}
): Promise<AgentContext> {
  const resolution = await resolveActiveEntity(opts, deps);
  if (resolution.source === 'only') {
    const all = await listEntities();
    if (all.length > 1) {
      throw new CliError(
        'This command changes data, so it will not guess the entity. ' +
          'Name it with --entity <id|name> or pin one with `mnemosine entity use`.',
        ExitCode.USAGE
      );
    }
  }
  return resolution.ctx;
}
