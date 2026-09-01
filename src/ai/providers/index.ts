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
import {
  CooldownRegistry,
  runWithFailover,
  type NamedProfile,
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
}

export async function createLlmSession(
  profile: ResolvedProfile,
  ctx: AgentContext,
  callbacks: SessionCallbacks = {},
  opts: CreateLlmSessionOptions = {}
): Promise<LlmSession> {
  const systemBlocks = await buildSystemBlocks(ctx);
  const compaction = opts.compaction ?? resolveCompactionConfig();

  if (profile.type === 'anthropic') {
    const client = profile.apiKey ? new Anthropic({ apiKey: profile.apiKey }) : new Anthropic();
    return new MnemosineAgent(client, ctx, systemBlocks, callbacks, profile.model, profile.name, {
      compaction,
      grounding: opts.grounding,
      herramientas: opts.herramientas,
    });
  }

  const client = new OpenAI({
    baseURL: profile.base_url,
    // Local endpoints (Ollama, LM Studio) require no key, but the SDK
    // demands a string — a placeholder is the standard practice.
    apiKey: profile.apiKey ?? 'not-needed',
    defaultHeaders: profile.headers,
  });
  const systemText = systemBlocks.map((b) => b.text).join('\n\n');
  return new OpenAiCompatSession(client, profile, ctx, systemText, callbacks, {
    compaction,
    grounding: opts.grounding,
    herramientas: opts.herramientas,
  });
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
  const sessionOpts: CreateLlmSessionOptions = {
    compaction: opts.compaction,
    grounding: opts.grounding,
  };

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
      chain as NamedProfile[],
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
