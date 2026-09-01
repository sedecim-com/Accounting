import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type { ProviderProfile, ResolvedProfile } from './types.js';

// ============================================================
// PROVIDER CONFIG
// Built-in profiles + configuration file + overrides.
// Precedence (standard practice for CLI harnesses):
//   --provider flag  >  env MNEMOSINE_PROVIDER  >  config default_provider  >  'anthropic'
// API keys ALWAYS live in environment variables; the config
// only names the variable (api_key_env).
// Files: ./mnemosine.config.json (project) > ~/.mnemosine/config.json (user)
// ============================================================

export const BUILTIN_PROFILES: Record<string, ProviderProfile> = {
  anthropic: {
    type: 'anthropic',
    model: 'claude-opus-5',
    api_key_env: 'ANTHROPIC_API_KEY',
    note: 'Claude via the Anthropic API (default)',
  },
  hermes: {
    type: 'openai-compatible',
    model: 'Hermes-4-405B',
    base_url: 'https://inference-api.nousresearch.com/v1',
    api_key_env: 'NOUS_API_KEY',
    note: 'Hermes 4 via Nous Portal — standard function calling, the accounting tools work',
  },
  'hermes-agent': {
    type: 'openai-compatible',
    model: 'hermes-agent',
    base_url: 'http://127.0.0.1:8642/v1',
    api_key_env: 'HERMES_AGENT_KEY',
    tools: false,
    note:
      'Local Hermes Agent (hermes gateway). WARNING: it runs ITS OWN tools server-side and does not ' +
      'return tool calls to the client — mnemosine accounting tools are NOT invoked ' +
      'over this channel; it is generic chat/agent. For accounting with tools use "hermes".',
  },
  ollama: {
    type: 'openai-compatible',
    model: 'llama3.1',
    base_url: 'http://localhost:11434/v1',
    note: 'Local model via Ollama. Set "model" to an installed one that supports tools',
  },
  openai: {
    type: 'openai-compatible',
    model: 'gpt-5.1',
    base_url: 'https://api.openai.com/v1',
    api_key_env: 'OPENAI_API_KEY',
    max_tokens_param: 'max_completion_tokens',
    note: 'OpenAI via API key (API equivalent of the ChatGPT/Codex subscription)',
  },
  grok: {
    type: 'openai-compatible',
    model: 'grok-4',
    base_url: 'https://api.x.ai/v1',
    api_key_env: 'XAI_API_KEY',
    note: 'xAI Grok — OpenAI-compatible API',
  },
  minimax: {
    type: 'openai-compatible',
    model: 'MiniMax-M2',
    base_url: 'https://api.minimax.io/v1',
    api_key_env: 'MINIMAX_API_KEY',
    note: 'MiniMax (global endpoint; for China change base_url to api.minimaxi.com/v1)',
  },
  qwen: {
    type: 'openai-compatible',
    model: 'qwen3-max',
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    api_key_env: 'DASHSCOPE_API_KEY',
    note: 'Qwen via DashScope compatible-mode (the API route used by Qwen Code)',
  },
  gemini: {
    type: 'openai-compatible',
    model: 'gemini-2.5-pro',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    api_key_env: 'GEMINI_API_KEY',
    note: 'Google AI Studio (Gemini) — OpenAI-compatible endpoint; set "model" to the version your account has',
  },
  openrouter: {
    type: 'openai-compatible',
    model: 'openrouter/auto',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_env: 'OPENROUTER_API_KEY',
    note: 'OpenRouter — one key, hundreds of models; change "model" to whichever you prefer',
  },
  copilot: {
    type: 'openai-compatible',
    model: 'gpt-5.1',
    base_url: 'https://api.githubcopilot.com',
    api_key_env: 'COPILOT_API_TOKEN',
    note:
      'GitHub Copilot. WARNING: it does not use a classic API key — the token comes from the GitHub OAuth flow ' +
      '(short-lived and renewable); useful behind a proxy like copilot-api that refreshes it.',
  },
  openclaw: {
    type: 'openai-compatible',
    model: 'openclaw:main',
    base_url: 'http://127.0.0.1:18789/v1',
    api_key_env: 'OPENCLAW_GATEWAY_TOKEN',
    tools: false,
    note:
      'Local OpenClaw gateway. Requires gateway.http.endpoints.chatCompletions.enabled=true ' +
      'in its config; the gateway token is an operator credential — loopback only. ' +
      'Like hermes-agent, it runs ITS OWN tools server-side: chat channel, no accounting tools.',
  },
};

// Strict fail-closed schemas: an unknown key is ALWAYS a mistake (a typo like
// "api_key_evn" would otherwise silently fall back to defaults — the worst
// failure mode for a credential-bearing config). Rejecting loudly beats
// running on defaults the user did not choose.
const profileSchema = z
  .object({
    type: z.enum(['anthropic', 'openai-compatible']),
    model: z.string().min(1),
    base_url: z.string().url().optional(),
    api_key_env: z.string().optional(),
    api_key_cmd: z.string().optional(),
    stream: z.boolean().optional(),
    /**
     * false = do NOT send `stream_options: { include_usage: true }` on
     * streamed requests. The default (absent/true) asks the server to report
     * token usage on the final streamed chunk; a few old local servers 400
     * on the unknown `stream_options` field — set stream_usage: false for
     * those. Non-streamed requests are unaffected.
     */
    stream_usage: z.boolean().optional(),
    max_tokens_param: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    tools: z.boolean().optional(),
    headers: z.record(z.string()).optional(),
    max_iterations: z.number().int().min(1).max(100).optional(),
    /**
     * Ordered failover chain: names of OTHER profiles to try when this one
     * fails with a failover-eligible error (see providers/failover.ts).
     * Validated lazily by resolveFailoverChain (existence, self-references,
     * cycles) so a chain naming a profile defined later in the file works.
     */
    failover: z.array(z.string().min(1)).optional(),
    /**
     * Per-profile skills allowlist: when present, it is the FINAL set of
     * firm skills the model may see (src/ai/skills/gating.ts). Absent =
     * every visible (ungated) skill.
     */
    skills: z.array(z.string().min(1)).optional(),
    note: z.string().optional(),
  })
  .strict();

const ingestSchema = z
  .object({
    auto_post: z.boolean().optional(),
    auto_post_min_confidence: z.number().min(0).max(1).optional(),
    auto_post_max_amount: z.number().positive().optional(),
  })
  .strict();

/**
 * A3 · E5.1-e: el presupuesto del agente. Sin sección budget no hay
 * límites y no se consulta gasto alguno (opt-in). on_exceed decide si al
 * cruzarlo se ADVIERTE o se CORTA; su omisión la resuelve la ruta: las
 * DESATENDIDAS cortan por defecto («solo avisa» significa que no hay tope).
 */
const budgetSchema = z
  .object({
    daily_usd: z.number().positive().optional(),
    monthly_usd: z.number().positive().optional(),
    on_exceed: z.enum(['warn', 'block']).optional(),
  })
  .strict();

/**
 * History-compaction settings. Auto-compaction is ON BY DEFAULT (see
 * resolveCompactionConfig): omitting the section compacts at ~150k
 * estimated tokens. `threshold_tokens: 0` disables auto-compaction
 * explicitly (manual /compact still works).
 */
const compactionSchema = z
  .object({
    /** Auto-compact above this many estimated in-flight tokens; 0 = off. */
    threshold_tokens: z.number().int().min(0).optional(),
    /** Intact recent tail the compaction must keep. */
    keep_recent_tokens: z.number().int().min(1).optional(),
    /** Identifier survival policy; only 'strict' exists today. */
    identifier_policy: z.enum(['strict']).optional(),
  })
  .strict();

const configFileSchema = z
  .object({
    /** Language for the AGENT's responses (CLI UI is English). Default: es. */
    language: z.enum(['en', 'es']).optional(),
    default_provider: z.string().optional(),
    providers: z.record(profileSchema).optional(),
    ingest: ingestSchema.optional(),
    budget: budgetSchema.optional(),
    compaction: compactionSchema.optional(),
  })
  .strict();

export type MnemosineConfig = z.infer<typeof configFileSchema>;

export function configFilePaths(cwd = process.cwd()): string[] {
  return [
    path.join(cwd, 'mnemosine.config.json'),
    path.join(os.homedir(), '.mnemosine', 'config.json'),
  ];
}

/**
 * Copies an invalid config file aside before we throw, so the user can inspect
 * (and diff) exactly what was rejected. OpenClaw pattern: a config that EXISTS
 * but is invalid must never be silently replaced by defaults — the throw fails
 * closed, and the quarantine copy preserves the evidence even if someone later
 * "fixes" the original by deleting it. Best-effort: quarantine failure must not
 * mask the real validation error.
 *
 * Named by content hash so retries are idempotent: the same invalid content
 * always maps to the same .rejected-<hash> file (no per-run litter), while a
 * differently-broken config still gets its own copy.
 */
function quarantineInvalidConfig(file: string): string | null {
  try {
    const content = fs.readFileSync(file);
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
    const target = `${file}.rejected-${hash}`;
    if (!fs.existsSync(target)) fs.copyFileSync(file, target);
    return target;
  } catch {
    return null;
  }
}

/** Loads the first existing configuration file (project > user). */
export function loadConfigFile(cwd = process.cwd()): { config: MnemosineConfig; source: string | null } {
  for (const file of configFilePaths(cwd)) {
    if (!fs.existsSync(file)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      const quarantined = quarantineInvalidConfig(file);
      throw new Error(
        `Invalid configuration in ${file}: ${(err as Error).message}` +
          (quarantined ? ` (rejected copy kept at ${quarantined})` : '')
      );
    }
    const parsed = configFileSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      const quarantined = quarantineInvalidConfig(file);
      throw new Error(
        `Invalid configuration in ${file}: ${issues}` +
          (quarantined ? ` (rejected copy kept at ${quarantined})` : '')
      );
    }
    return { config: parsed.data, source: file };
  }
  return { config: {}, source: null };
}

/**
 * Effective profiles: built-ins + file. A file profile REPLACES the
 * built-in of the same name (no merging): inheriting invisible fields
 * like api_key_env or tools=false would produce behaviors impossible
 * to disable from the config.
 */
export function listProfiles(cwd = process.cwd()): {
  profiles: Record<string, ProviderProfile>;
  defaultName: string;
  source: string | null;
} {
  const { config, source } = loadConfigFile(cwd);
  const profiles: Record<string, ProviderProfile> = { ...BUILTIN_PROFILES };
  for (const [name, profile] of Object.entries(config.providers ?? {})) {
    profiles[name] = profile;
  }
  const defaultName = process.env.MNEMOSINE_PROVIDER || config.default_provider || 'anthropic';
  return { profiles, defaultName, source };
}

/**
 * Resolves the profile to use. `flagName` comes from --provider; `modelOverride`
 * from --model. Validates that the named API key exists in the environment.
 */
export function resolveProfile(
  flagName?: string,
  modelOverride?: string,
  cwd = process.cwd()
): ResolvedProfile {
  const { profiles, defaultName } = listProfiles(cwd);
  const name = flagName || defaultName;
  const profile = profiles[name];
  if (!profile) {
    throw new Error(
      `Provider "${name}" does not exist. Available: ${Object.keys(profiles).join(', ')}. ` +
        'Define your own providers in mnemosine.config.json'
    );
  }

  let apiKey: string | undefined;
  if (profile.api_key_env) {
    apiKey = process.env[profile.api_key_env] || undefined;
  }
  // Credential helper: only if the env did not resolve. Lets you reuse OAuth
  // tokens of already-logged-in subscriptions (e.g. Codex CLI) or vaults.
  if (!apiKey && profile.api_key_cmd) {
    try {
      apiKey =
        execSync(profile.api_key_cmd, {
          encoding: 'utf-8',
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim() || undefined;
    } catch (err) {
      throw new Error(
        `Provider "${name}" could not obtain its credential via api_key_cmd: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
    if (!apiKey) {
      throw new Error(`The api_key_cmd of provider "${name}" did not print any credential`);
    }
  }
  // Anthropic resolves credentials on its own (ant profile, auth token);
  // for the rest the credential is mandatory if the profile names it.
  if (!apiKey && profile.api_key_env && profile.type === 'openai-compatible') {
    throw new Error(
      `Provider "${name}" requires the environment variable ${profile.api_key_env} ` +
        '(add it to your .env) or an api_key_cmd in mnemosine.config.json'
    );
  }

  return {
    ...profile,
    name,
    model: modelOverride || profile.model,
    apiKey,
  };
}

// ─── Failover chains ───

/**
 * ProviderProfile plus the optional `failover` list. Kept as an intersection
 * here (rather than widening types.ts) because only the chain resolver reads
 * it; the runtime objects returned by listProfiles already carry the field
 * when the config declares it.
 */
export type ProfileWithFailover = ProviderProfile & { failover?: string[] };

/**
 * Resolves the ordered failover chain for a profile: the profile itself
 * first, then its `failover` list, expanding transitively in breadth-first
 * order (a fallback's own fallbacks are appended after it). Fail-closed
 * validation:
 *   - every referenced name must exist among the effective profiles;
 *   - a profile may not reference itself;
 *   - a profile appearing on its OWN expansion path is a true cycle and is
 *     rejected. A DIAMOND — the same profile reachable via two different
 *     paths (a → b → d, a → c → d) — is NOT a cycle: the duplicate is
 *     deduplicated silently and the chain keeps its first position.
 * Names only, no credential resolution: the caller resolves the credential
 * of the profile it actually attempts (resolveProfile), so a fallback with
 * a missing key fails at attempt time, not at chain-building time.
 */
export function resolveFailoverChain(
  profileName: string,
  cwd = process.cwd()
): Array<ProfileWithFailover & { name: string }> {
  const { profiles } = listProfiles(cwd);
  if (!profiles[profileName]) {
    throw new Error(
      `Provider "${profileName}" does not exist. Available: ${Object.keys(profiles).join(', ')}`
    );
  }

  const chain: Array<ProfileWithFailover & { name: string }> = [];
  // Parallel to `chain`: index of the entry that referenced this one (-1 for
  // the root). Walking `parents` reconstructs an entry's expansion path,
  // which is what distinguishes a true cycle from a harmless diamond.
  const parents: number[] = [];
  const visited = new Set<string>();
  const enqueue = (name: string, parent: number) => {
    chain.push({ ...(profiles[name] as ProfileWithFailover), name });
    parents.push(parent);
    visited.add(name);
  };
  enqueue(profileName, -1);

  const onExpansionPath = (index: number, name: string): boolean => {
    for (let p = index; p !== -1; p = parents[p]) {
      if (chain[p].name === name) return true;
    }
    return false;
  };

  for (let i = 0; i < chain.length; i++) {
    const current = chain[i];
    for (const next of (current as ProfileWithFailover).failover ?? []) {
      if (next === current.name) {
        throw new Error(
          `Invalid failover chain: profile "${current.name}" references itself`
        );
      }
      if (!profiles[next]) {
        throw new Error(
          `Invalid failover chain: profile "${current.name}" references unknown provider "${next}". ` +
            `Available: ${Object.keys(profiles).join(', ')}`
        );
      }
      if (visited.has(next)) {
        if (onExpansionPath(i, next)) {
          throw new Error(
            `Invalid failover chain: cycle detected — "${next}" (referenced by "${current.name}") ` +
              'is already on its own expansion path'
          );
        }
        continue; // diamond: same fallback via another path — dedupe silently
      }
      enqueue(next, i);
    }
  }
  return chain;
}

// ─── Ingest thresholds (auto-post) ───

export interface IngestThresholds {
  /** Master switch: false = everything stays as a draft (safe default). */
  autoPost: boolean;
  /**
   * A4 · modo sombra: las compuertas corren completas y el veredicto se
   * registra (ai_shadow_verdicts), pero nada postea. Solo lo enciende el
   * PANEL (ingest_auto_post = 'shadow'); no hay bandera ni archivo — la
   * sombra es una decisión del despacho, no un override de corrida.
   */
  sombra?: boolean;
  /**
   * A7: el archivo o la bandera pidieron ENCENDER y el panel no lo autoriza,
   * así que se ignoró. Se expone para que la corrida pueda decirlo en voz
   * alta en vez de dejar al operador creyendo que su `true` hizo algo.
   */
  encendidoIgnorado?: boolean;
  /** Minimum AI-reported confidence to auto-post. */
  minConfidence: number;
  /** Maximum amount (entity currency) eligible for auto-post. */
  maxAmount: number;
  /**
   * De dónde salió cada umbral, para el rastro: cuando algo se postea sin
   * humano, la bitácora tiene que poder decir QUIÉN lo decidió — una bandera
   * explícita, el archivo del operador, la política del despacho o la
   * omisión del código. Lo rellena el resolutor con panel.
   */
  fuentes?: {
    autoPost: 'bandera' | 'archivo' | 'politica' | 'omision';
    minConfidence: 'bandera' | 'archivo' | 'omision';
    maxAmount: 'bandera' | 'archivo' | 'politica' | 'omision';
  };
}

const INGEST_DEFAULTS: IngestThresholds = {
  autoPost: false,
  minConfidence: 0.95,
  maxAmount: 10000,
};

/**
 * Valores CRUDOS del bloque ingest del archivo del operador, sin mezclar con
 * omisiones. Existe para que el resolutor con panel (src/ai/ingest-thresholds)
 * pueda insertar la capa de la política ENTRE el archivo y la omisión: la
 * precedencia decidida es bandera > archivo del operador > política del
 * despacho > omisión del código, y para eso hay que saber si el archivo
 * TRAÍA valor, no sólo cuál quedó tras mezclar.
 */
/** A3: los valores CRUDOS de la sección budget del archivo del operador. */
export function budgetFileValues(cwd = process.cwd()): {
  dailyUsd?: number;
  monthlyUsd?: number;
  onExceed?: 'warn' | 'block';
} {
  const { config } = loadConfigFile(cwd);
  const file = config.budget ?? {};
  const num = (v: number | undefined): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  return {
    dailyUsd: num(file.daily_usd),
    monthlyUsd: num(file.monthly_usd),
    onExceed: file.on_exceed,
  };
}

export function ingestFileValues(cwd = process.cwd()): {
  autoPost?: boolean;
  minConfidence?: number;
  maxAmount?: number;
} {
  const { config } = loadConfigFile(cwd);
  const file = config.ingest ?? {};
  const num = (v: number | undefined): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  return {
    autoPost: typeof file.auto_post === 'boolean' ? file.auto_post : undefined,
    minConfidence: num(file.auto_post_min_confidence),
    maxAmount: num(file.auto_post_max_amount),
  };
}

export const UMBRALES_INGESTA_OMISION: IngestThresholds = INGEST_DEFAULTS;

/** Config file + CLI overrides. The default is conservative: no auto-post. */
export function resolveIngestThresholds(
  overrides: Partial<IngestThresholds> = {},
  cwd = process.cwd()
): IngestThresholds {
  const { config } = loadConfigFile(cwd);
  const file = config.ingest ?? {};
  // NaN is not nullish: an invalid flag (--min-confianza abc → parseFloat NaN)
  // would pass the ?? and ALSO `confidence < NaN` is false — the gate would
  // open auto-post. Only finite numbers count as overrides.
  const num = (v: number | undefined): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const minConfidence =
    num(overrides.minConfidence) ?? num(file.auto_post_min_confidence) ?? INGEST_DEFAULTS.minConfidence;
  const maxAmount =
    num(overrides.maxAmount) ?? num(file.auto_post_max_amount) ?? INGEST_DEFAULTS.maxAmount;
  return {
    autoPost: overrides.autoPost ?? file.auto_post ?? INGEST_DEFAULTS.autoPost,
    minConfidence: Math.min(1, Math.max(0, minConfidence)),
    maxAmount: Math.max(0, maxAmount),
  };
}


// ─── Compaction (auto-compaction ON by default) ───

/**
 * Default auto-compaction threshold: safely under every supported
 * provider's context window, so production sessions compact before they
 * overflow even when the config never mentions compaction.
 */
export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 150_000;

/**
 * Runner-facing compaction settings resolved from the config file.
 * Duplicated shape of compaction.ts's CompactionConfig (kept structural to
 * avoid a config → compaction import edge).
 */
export interface ResolvedCompactionConfig {
  /** undefined = auto-compaction OFF (explicit threshold_tokens: 0). */
  thresholdTokens?: number;
  keepRecentTokens?: number;
  identifierPolicy?: 'strict';
}

/**
 * Resolves the `compaction` config section. DEFAULT ON: with no section (or
 * no threshold_tokens) auto-compaction fires at ~150k estimated tokens;
 * `threshold_tokens: 0` is the explicit off switch (manual /compact keeps
 * working); any other value moves the threshold.
 */
export function resolveCompactionConfig(cwd = process.cwd()): ResolvedCompactionConfig {
  const { config } = loadConfigFile(cwd);
  const section = config.compaction ?? {};
  const threshold = section.threshold_tokens ?? DEFAULT_COMPACTION_THRESHOLD_TOKENS;
  return {
    thresholdTokens: threshold === 0 ? undefined : threshold,
    keepRecentTokens: section.keep_recent_tokens,
    identifierPolicy: section.identifier_policy,
  };
}

// ─── Response language ───

export type AgentLanguage = 'en' | 'es';

/** Language the AGENT answers in. CLI/UI text is always English; Spanish
 *  command aliases exist regardless. Default 'es' (Mexican accounting firms). */
export function resolveLanguage(cwd = process.cwd()): AgentLanguage {
  const env = process.env.MNEMOSINE_LANG?.trim().toLowerCase();
  if (env === 'en' || env === 'es') return env;
  if (env) {
    // An invalid value silently falling back to the default would make the
    // agent answer in the wrong language with no clue why.
    console.warn(
      `[mnemosine] MNEMOSINE_LANG="${process.env.MNEMOSINE_LANG}" is not supported (use en|es); ignoring it.`
    );
  }
  const { config } = loadConfigFile(cwd);
  return config.language ?? 'es';
}

/**
 * Persist the language, preserving other keys. Writes to the config file that
 * currently WINS (project > user): updating ~/.mnemosine/config.json in place
 * when it is the active config, instead of creating a project file that would
 * silently shadow the entire user config. Only when no config exists at all is
 * the project file created. Routed through writeConfigPatch so the strict
 * schema and no-secrets gates apply.
 */
export function setLanguage(lang: AgentLanguage, cwd = process.cwd()): string {
  const { source } = loadConfigFile(cwd);
  const target = source ?? path.join(cwd, 'mnemosine.config.json');
  return writeConfigPatch({ language: lang }, cwd, target);
}

// ─── Config writer (secret auto-routing) ───

// Well-known credential prefixes: Anthropic/OpenAI-style keys (sk-), GitHub
// PATs (ghp_), Slack bot tokens (xoxb-), AWS access key ids (AKIA), JWTs (eyJ).
const SECRET_VALUE_RE = /^(sk-|ghp_|xoxb-|AKIA|eyJ)/;
// Key names that normally carry credentials.
const SECRET_KEY_RE = /(key|token|secret|password)/i;
// The one legitimate value for a secret-named key: the NAME of an environment
// variable (api_key_env: "NOUS_API_KEY"), never the credential itself.
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function assertNoSecrets(value: unknown, keyPath: string[]): void {
  if (typeof value === 'string') {
    const key = keyPath[keyPath.length - 1] ?? '';
    const looksLikeSecretValue = SECRET_VALUE_RE.test(value);
    // *_cmd keys hold credential-helper COMMANDS (api_key_cmd), not credentials;
    // the value-prefix check above still catches a raw key pasted into one.
    const secretNamedWithRawValue =
      SECRET_KEY_RE.test(key) && !/_cmd$/i.test(key) && !ENV_NAME_RE.test(value);
    if (looksLikeSecretValue || secretNamedWithRawValue) {
      throw new Error(
        `Refusing to write "${keyPath.join('.')}" to the config file: the value looks like a ` +
          'credential. Config files are shareable and may end up in git — put the secret in your ' +
          '.env instead and reference it by variable name via api_key_env (or use api_key_cmd ' +
          'for a vault/credential helper).'
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, [...keyPath, String(i)]));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoSecrets(v, [...keyPath, k]);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/**
 * Merges a patch into the PROJECT config file (mnemosine.config.json), or
 * into `targetFile` when given (e.g. the user-level config when it is the
 * active one), preserving unrelated keys. Two fail-closed gates, in order:
 *   1. SECRETS NEVER LAND IN THE CONFIG: any value that looks like a raw
 *      credential is refused with instructions to route it through .env +
 *      api_key_env (Hermes/OpenClaw secret auto-routing: the config stays
 *      shareable; only names of variables cross it).
 *   2. The merged result must satisfy the strict schema BEFORE writing —
 *      never persist a file that the very next load would quarantine.
 * Returns the path written.
 */
export function writeConfigPatch(
  patch: Record<string, unknown>,
  cwd = process.cwd(),
  targetFile?: string
): string {
  assertNoSecrets(patch, []);

  const file = targetFile ?? path.join(cwd, 'mnemosine.config.json');
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    // Invalid existing JSON throws here (with no quarantine: we are not
    // loading it to run, and clobbering it would destroy the user's file).
    existing = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  }
  const merged = deepMerge(existing, patch);

  const parsed = configFileSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Refusing to write an invalid configuration to ${file}: ${issues}`);
  }

  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  return file;
}
