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
// Un pin que ya no resuelve no borra la selección ni sigue de
// largo: falla UNA vez, con el remedio de su causa (conexión →
// doctor; entidad → entity use), y conserva el pin intacto.
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

// Códigos de red de Node y clases de pg que significan «no hay base», no «no
// hay entidad»: 08* (fallo de conexión), 57P0* (el servidor se fue), 28*
// (autenticación: el «role postgres does not exist» del primer día) y 3D000
// (la base nombrada no existe).
const CODIGOS_DE_CONEXION = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN',
  '08000', '08001', '08003', '08004', '08006', '08P01',
  '57P01', '57P02', '57P03',
  '28000', '28P01',
  '3D000',
]);

/**
 * Con la base caída y con la entidad archivada este módulo veía el mismo
 * catch, y el remedio correcto es opuesto: `entity use` NECESITA la base, así
 * que sugerirlo ante una conexión caída manda al usuario a otro fallo igual.
 * Clasifica por el código del error (pg y la capa de red los traen) y, como
 * red de seguridad, por las firmas de texto que esos errores acarrean.
 */
export function esFalloDeConexion(err: unknown): boolean {
  const codigo = (err as { code?: unknown } | null)?.code;
  if (typeof codigo === 'string' && CODIGOS_DE_CONEXION.has(codigo)) return true;
  const mensaje = err instanceof Error ? err.message : String(err);
  return /conexi|connect|econn|timed?\s?out|terminat|tunnel|\bssl\b|socket|password authentication|role "?[^"\s]+"? does not exist|database .* does not exist|starting up|shutting down/i.test(
    mensaje
  );
}

/**
 * Resolves the entity a command should operate on, under the single
 * precedence rule. `warn` sigue aceptándose por compatibilidad con todas las
 * hojas que lo pasan, pero hoy no emite nada: el fallo del pin dejó de ser un
 * aviso-y-sigue (que duplicaba el error) y ahora lanza una sola vez con el
 * remedio de su causa.
 */
export async function resolveActiveEntity(
  opts: { entity?: string } = {},
  deps: { home?: string; warn?: (message: string) => void } = {}
): Promise<EntityResolution> {
  const home = deps.home ?? os.homedir();

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
      //
      // Y aquí se TERMINA: antes esta rama avisaba y seguía a resolveEntity(),
      // que con la base caída fallaba con el MISMO error — el usuario lo leía
      // dos veces y encima con el remedio de la otra causa. Cada causa lanza
      // una vez, con su remedio, y el pin queda intacto.
      const detalle = err instanceof Error ? err.message : String(err);
      if (esFalloDeConexion(err)) {
        throw new CliError(
          `Could not reach the database while resolving the active entity (${stored}): ${detalle}\n` +
            '  → mnemosine doctor   (and check DATABASE_URL in .env)\n' +
            'The pinned entity was kept.',
          ExitCode.FAILURE
        );
      }
      throw new CliError(
        `The pinned entity (${stored}) could not be resolved: ${detalle}\n` +
          '  → mnemosine entity use <id|name>   (or `mnemosine entity unset` to clear it)\n' +
          'The pinned entity was kept.',
        ExitCode.NOT_FOUND
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
