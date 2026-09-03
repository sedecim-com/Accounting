import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AgentContext } from '../context.js';
import { buildSystemBlocks } from '../system-prompt.js';
import { MnemosineAgent } from '../agent.js';
import { OpenAiCompatSession } from './openai-compat.js';
import type { LlmSession, ResolvedProfile, SessionCallbacks } from './types.js';
import type { CompactionConfig, CompactionResult } from '../compaction.js';
import type { GroundingOptions } from '../grounding.js';
import {
  listProfiles,
  resolveCompactionConfig,
  resolveFailoverChain,
  resolveProfile,
} from './config.js';
import { assertWithinBudget, BudgetGuard, type BudgetStatus } from '../budget.js';
import { estimateCostUsd } from '../usage-ledger.js';
import {
  CooldownRegistry,
  runWithFailover,
  type ProviderErrorCategory,
} from './failover.js';

export { resolveProfile, listProfiles, BUILTIN_PROFILES, configFilePaths, resolveCompactionConfig, resolveFailoverChain } from './config.js';
export { classifyProviderError, runWithFailover, CooldownRegistry } from './failover.js';
export { redactDetail } from './probe.js';
export type { LlmSession, ResolvedProfile, ProviderProfile, SessionCallbacks } from './types.js';

// ============================================================
// SESSION FACTORY
// anthropic → MnemosineAgent (native BetaToolRunner: adaptive
//   thinking, prompt caching, thinking-block replay).
// openai-compatible → OpenAiCompatSession (manual loop over
//   Chat Completions: Hermes/Nous, Hermes Agent, Ollama, etc.).
// ============================================================

export interface CreateLlmSessionOptions {
  /**
   * History compaction. When absent it is resolved from the config file
   * (resolveCompactionConfig): auto-compaction is ON BY DEFAULT at ~150k
   * estimated tokens; `compaction.threshold_tokens: 0` in the config file
   * disables it.
   */
  compaction?: CompactionConfig;
  /**
   * Grounding backstop (see grounding.ts). Enabled by default; UNATTENDED
   * pipelines (ingest, scheduled jobs, init import) must pass
   * `{ enabled: false }` — there is no human watching the corrective turn,
   * and its extra model call would feed auto-post style hooks.
   */
  grounding?: GroundingOptions;
  /**
   * Lista blanca de herramientas por nombre (tools/superficie.ts). La
   * corrida DESATENDIDA la pasa siempre: sin ella, la sesión recibe la
   * superficie completa, que es lo correcto en la interactiva y una
   * propiedad por accidente en la desatendida.
   */
  herramientas?: readonly string[];
  /** A3 · presupuesto: directorio del mnemosine.config.json (default cwd). */
  cwd?: string;
  /** A3: aviso al 80% del presupuesto — el chat lo imprime; los jobs a stderr. */
  onBudgetWarning?: (status: BudgetStatus) => void;
}

export async function createLlmSession(
  profile: ResolvedProfile,
  ctx: AgentContext,
  callbacks: SessionCallbacks = {},
  opts: CreateLlmSessionOptions = {}
): Promise<LlmSession> {
  // A3 · PRESUPUESTO (E5.1-e): el único punto donde nace toda sesión, así
  // que jobs, ingesta, chat e init lo heredan sin código propio. Sin
  // sección budget en el archivo, cero consultas (opt-in). La ruta
  // DESATENDIDA se autoidentifica con grounding deshabilitado — ahí el
  // default es BLOCK: «solo avisa» significa que no hay tope.
  const unattended = opts.grounding?.enabled === false;
  const { guard } = await assertWithinBudget(ctx, opts.cwd, { unattended });
  if (guard.status.state === 'warn') opts.onBudgetWarning?.(guard.status);
  const budgeted: SessionCallbacks = {
    ...callbacks,
    onUsage: (u) => {
      guard.addSpend(estimateCostUsd(u) ?? 0);
      callbacks.onUsage?.(u);
    },
  };

  const systemBlocks = await buildSystemBlocks(ctx);
  // LA COSTURA DE LA COMPACTACIÓN POR VENTANA (A5·3). Aquí se resuelve la
  // sección GLOBAL del archivo, con su marca `umbralDerivable`, y son los dos
  // runners los que la afinan contra la ventana de SU perfil
  // (compactacionParaPerfil). Esta línea es todo el enlace: pasar por aquí un
  // umbral ya fijado —o la misma sección con la marca apagada— convierte la
  // pieza entera en un no-op en producción sin que nada más lo note. Anclada de
  // lado a lado en tests/ai/providers/ventana-de-contexto.spec.ts: la sesión que
  // construye ESTA función, para el perfil de ventana pequeña, tiene que
  // compactar donde manda la ventana y no donde manda el respaldo global.
  //
  // `opts.cwd` y no process.cwd(): el presupuesto ya lee su configuración de ese
  // directorio (assertWithinBudget, arriba), y la sección `compaction` y la
  // ventana del perfil tienen que salir del MISMO archivo. Con dos directorios
  // distintos, un trabajo lanzado sobre otra carpeta leería el tope de gasto de
  // un mnemosine.config.json y el umbral de compactación de otro.
  const compaction = opts.compaction ?? resolveCompactionConfig(opts.cwd);

  let session: LlmSession;
  if (profile.type === 'anthropic') {
    const client = profile.apiKey ? new Anthropic({ apiKey: profile.apiKey }) : new Anthropic();
    session = new MnemosineAgent(client, ctx, systemBlocks, budgeted, profile.model, profile.name, {
      compaction,
      cwd: opts.cwd,
      grounding: opts.grounding,
      herramientas: opts.herramientas,
    });
  } else {
    const client = new OpenAI({
      baseURL: profile.base_url,
      // Local endpoints (Ollama, LM Studio) require no key, but the SDK
      // demands a string — a placeholder is the standard practice.
      apiKey: profile.apiKey ?? 'not-needed',
      defaultHeaders: profile.headers,
    });
    const systemText = systemBlocks.map((b) => b.text).join('\n\n');
    session = new OpenAiCompatSession(client, profile, ctx, systemText, budgeted, {
      compaction,
      cwd: opts.cwd,
      grounding: opts.grounding,
      herramientas: opts.herramientas,
    });
  }
  return withBudgetGuard(session, guard);
}

/** Decorador: check() al ENTRAR a cada turno — un cruce a mitad de sesión corta sin volver a la base. */
function withBudgetGuard(session: LlmSession, guard: BudgetGuard): LlmSession {
  return {
    get label() {
      return session.label;
    },
    async runTurn(userInput: string, signal?: AbortSignal): Promise<string> {
      guard.check();
      return session.runTurn(userInput, signal);
    },
    reset(): void {
      session.reset();
    },
    async compact(signal?: AbortSignal): Promise<CompactionResult | null> {
      return session.compact ? session.compact(signal) : null;
    },
  };
}

// ============================================================
// FAILOVER-AWARE SESSION FACTORY (#29)
// Walks the profile's failover chain when SESSION-LEVEL setup or
// the FIRST turn's connection fails with a failover-eligible
// error type (auth / rate_limit / server / timeout / billing —
// see providers/failover.ts). Once a session has completed one
// turn it stays SINGLE-PROVIDER: turn-level mid-session failover
// is future work and is deliberately not faked here — a live
// conversation's history is not portable across wire formats.
// ============================================================

export interface FailoverSessionOptions extends CreateLlmSessionOptions {
  /** --model override; applied to the REQUESTED profile only, never to fallbacks. */
  model?: string;
  /** Warning hook: "provider X failed (rate_limit), trying Y". */
  onFailover?: (from: string, errorType: string, to: string) => void;
  /** Config lookup directory (defaults to process.cwd()). */
  cwd?: string;
  /** Test seams: session construction + cooldown registry injection. */
  sessionFactory?: (
    profile: ResolvedProfile,
    ctx: AgentContext,
    callbacks: SessionCallbacks,
    opts: CreateLlmSessionOptions
  ) => Promise<LlmSession>;
  cooldowns?: CooldownRegistry;
}

/**
 * Creates an LlmSession that resolves its provider lazily on the FIRST
 * turn: the failover chain of `profileName` (or the configured default) is
 * walked with runWithFailover — session construction plus the first
 * runTurn are one attempt — and the first profile that completes the turn
 * becomes THE session's provider for its whole life. Non-eligible errors
 * (refusal / overflow / aborted / unknown) re-throw immediately and are
 * never shopped to another provider (fail closed on anything the model
 * could have influenced).
 */
export async function createLlmSessionWithFailover(
  profileName: string | undefined,
  ctx: AgentContext,
  callbacks: SessionCallbacks = {},
  opts: FailoverSessionOptions = {}
): Promise<LlmSession> {
  const cwd = opts.cwd ?? process.cwd();
  const name = profileName || listProfiles(cwd).defaultName;
  const chain = resolveFailoverChain(name, cwd);
  const make = opts.sessionFactory ?? createLlmSession;
  // SE REENVÍA POR EXCLUSIÓN, NO POR ENUMERACIÓN, y la diferencia era una fuga.
  //
  // Este objeto listaba cuatro campos a mano y `herramientas` no estaba entre
  // ellos. Medido ejecutando buildTools: la corrida desatendida pasa
  // SUPERFICIE_DESATENDIDA_SANDBOX —23 herramientas— y al constructor llegaba
  // `undefined`, así que recibía las 25. Las dos de más son `external_pull` y
  // `external_diff_trial_balance`: LECTURAS CONTRA EL SISTEMA DEL CLIENTE CON
  // SU CREDENCIAL. Es decir, `jobs run-due` SIN `--live` tenía el brazo
  // externo de todos modos, y la compuerta que S0.3 construyó quedaba
  // derrotada por un literal de cuatro campos.
  //
  // Enumerar es el defecto, no el campo: el que se olvidó fue el quinto y el
  // sexto se habría olvidado igual. Se quitan las opciones PROPIAS del
  // failover y se reenvía el resto, así que un campo nuevo de
  // CreateLlmSessionOptions viaja por construcción y uno nuevo del failover
  // obliga a tocar esta línea, que es visible en el diff.
  const { model: _model, onFailover: _onFailover, sessionFactory: _factory, cooldowns: _cooldowns, ...heredadas } = opts;
  const sessionOpts: CreateLlmSessionOptions = heredadas;

  // No fallbacks configured → plain single-provider session, created eagerly
  // (same behavior as createLlmSession, credential errors surface now).
  if (chain.length === 1) {
    return make(resolveProfile(name, opts.model, cwd), ctx, callbacks, sessionOpts);
  }

  const onFailoverEvent = (event: { provider: string; errorType: ProviderErrorCategory; nextProvider?: string }) => {
    if (event.nextProvider) opts.onFailover?.(event.provider, event.errorType, event.nextProvider);
  };

  let live: LlmSession | null = null;
  // Reflect the --model override in the label from the START: the banner and
  // the `[entity · label]` header are printed before the first turn runs, and
  // the override applies only to the head profile (never to fallbacks), so the
  // pre-turn label must show the requested model, not the profile's default.
  let liveLabel = `${name} · ${opts.model ?? chain[0].model}`;

  const firstTurn = async (userInput: string, signal?: AbortSignal): Promise<string> => {
    const { result } = await runWithFailover<{ session: LlmSession; text: string }>(
      chain,
      async (candidate) => {
        // Setup (credential resolution + construction) and the first turn's
        // connection are ONE attempt: either can trip the walk.
        const resolved = resolveProfile(
          candidate.name,
          candidate.name === name ? opts.model : undefined,
          cwd
        );
        const session = await make(resolved, ctx, callbacks, sessionOpts);
        const text = await session.runTurn(userInput, signal);
        return { session, text };
      },
      { onFailover: onFailoverEvent, cooldowns: opts.cooldowns, signal }
    );
    live = result.session;
    liveLabel = result.session.label;
    return result.text;
  };

  return {
    get label() {
      return liveLabel;
    },
    async runTurn(userInput: string, signal?: AbortSignal): Promise<string> {
      // Single-provider once live: later turns never re-walk the chain.
      if (live) return live.runTurn(userInput, signal);
      return firstTurn(userInput, signal);
    },
    reset(): void {
      live?.reset();
    },
    async compact(signal?: AbortSignal): Promise<CompactionResult | null> {
      return live?.compact ? live.compact(signal) : null;
    },
  };
}
