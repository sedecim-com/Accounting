import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { listProfiles, resolveProfile, writeConfigPatch } from '../../ai/providers/config.js';
import { checkModelProvider } from '../../ai/doctor-service.js';
import type { CheckResult } from '../../ai/doctor-service.js';
import { upsertEnvVar } from './s0-infra.js';
import type { SectionContext, SectionStatus, SetupSection } from './section.js';

// ============================================================
// S3 · AI PROVIDER
// Three flavors: API key, local (detected), or subscription via
// credential helper / broker. It is tested live with TWO probes:
// chat and tool-calling — a provider that does not support tools
// is fine for conversation but not for the accounting work.
//
// Persist-after-proof: nothing is written to the config until
// the probe answers. On re-run, an already-persisted provider is
// re-probed (verify/repair) and left untouched when healthy.
// ============================================================

/** Where the user gets each credential (deep-links). */
export const KEY_URLS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'https://console.anthropic.com/settings/keys',
  OPENAI_API_KEY: 'https://platform.openai.com/api-keys',
  NOUS_API_KEY: 'https://portal.nousresearch.com',
  GEMINI_API_KEY: 'https://aistudio.google.com/apikey',
  XAI_API_KEY: 'https://console.x.ai',
  MINIMAX_API_KEY: 'https://www.minimax.io/platform',
  DASHSCOPE_API_KEY: 'https://dashscope.console.aliyun.com',
  OPENROUTER_API_KEY: 'https://openrouter.ai/keys',
  HERMES_AGENT_KEY: 'API_SERVER_KEY in ~/.hermes/.env (run: hermes gateway)',
  OPENCLAW_GATEWAY_TOKEN: 'OpenClaw gateway token (local config)',
  COPILOT_API_TOKEN: 'GitHub OAuth flow — requires a copilot-api style proxy',
};

export type ProbeErrorCategory = 'auth' | 'connection' | 'other';

export interface ProbeResult {
  chat: boolean;
  tools: boolean;
  detail: string;
  /** Only meaningful when chat=false; lets the wizard suggest the right fix. */
  category?: ProbeErrorCategory;
}

/**
 * Maps a raw provider error onto the action the user must take:
 * auth → get/rotate the credential; connection → start/point the
 * service; other → read the message. HTTP statuses beat message
 * heuristics when the SDK exposes them (see defaultProbe).
 */
export function categorizeProbeError(detail: string): ProbeErrorCategory {
  if (
    /\b40[13]\b|unauthorized|forbidden|invalid[ _-]?(x-)?api[ _-]?key|invalid[ _-]?key|authentication|permission denied|credential/i.test(
      detail
    )
  ) {
    return 'auth';
  }
  if (
    /econnrefused|enotfound|etimedout|econnreset|eai_again|ehostunreach|fetch failed|network|timed? ?out|socket hang up|connection (error|refused)/i.test(
      detail
    )
  ) {
    return 'connection';
  }
  return 'other';
}

export interface IaDeps {
  cwd?: string;
  /** Injectable: in tests no model is ever called. */
  probe?: (profileName: string) => Promise<ProbeResult>;
  listOllamaModels?: () => Promise<string[]>;
}

export class IaSection implements SetupSection {
  readonly id = 'ia' as const;
  readonly title = 'AI provider';
  readonly required = true;

  constructor(private readonly deps: IaDeps = {}) {}

  private get cwd(): string {
    return this.deps.cwd ?? process.cwd();
  }

  async status(): Promise<SectionStatus> {
    const c = checkModelProvider(this.cwd);
    return c.level === 'ok' ? 'ok' : c.level === 'warn' ? 'partial' : 'missing';
  }

  async verify(): Promise<CheckResult[]> {
    return [checkModelProvider(this.cwd)];
  }

  async configure(ctx: SectionContext): Promise<void> {
    const probeFn = this.deps.probe ?? defaultProbe;

    // ---- Verify/repair path: a provider persisted by a previous run is
    // re-probed, NOT reconfigured. Healthy → the config stays byte-identical
    // (re-running init must never reset working state). Unhealthy → fall
    // through to the selection flow to repair it. Explicit flags mean the
    // user wants a change, so they skip this path.
    const persisted = this.persistedDefault();
    if (persisted && !ctx.flags.provider && !ctx.flags.model) {
      const { profiles } = listProfiles(this.cwd);
      const p = profiles[persisted];
      const ready = !!p && (!p.api_key_env || !!process.env[p.api_key_env]);
      if (ready) {
        ctx.print(`  Provider "${persisted}" is already configured; verifying it live…`);
        const probe = await probeFn(persisted);
        if (probe.chat) {
          ctx.print('  ✔ Verified: responds to a minimal chat (config left untouched)');
          this.reportTools(ctx, probe);
          return;
        }
        this.reportFailure(ctx, persisted, probe);
        ctx.print('  Repair: pick a provider that does respond (the current config is kept until one verifies).');
      }
    }

    // ---- Selection flow: choose → credential → model → PROBE → persist.
    let firstPass = true;
    // Bounded so a scripted/non-interactive session can never loop forever.
    for (let attempt = 0; attempt < 8; attempt++) {
      const { profiles, defaultName } = listProfiles(this.cwd);

      // State of each profile: what is ready to use NOW (env may have
      // gained keys on a previous iteration).
      const rows = Object.entries(profiles).map(([name, p]) => ({
        name, profile: p,
        ready: !p.api_key_env || !!process.env[p.api_key_env],
        local: !p.api_key_env || (p.base_url ?? '').includes('localhost') ||
               (p.base_url ?? '').includes('127.0.0.1'),
      }));

      if (firstPass) {
        ctx.print('  Available providers:');
        for (const r of rows) {
          const badge = r.ready ? '✔' : '○';
          const key = r.profile.api_key_env ? ` · ${r.profile.api_key_env}` : ' · no credential';
          ctx.print(`    ${badge} ${r.name.padEnd(14)} ${r.profile.model}${key}`);
        }
      }

      // Default suggestion: whatever already works without asking for anything.
      const flagProvider = firstPass ? ctx.flags.provider : undefined;
      const suggested =
        flagProvider ??
        rows.find((r) => r.ready && r.local)?.name ??
        rows.find((r) => r.ready)?.name ??
        defaultName;

      const chosen =
        flagProvider ??
        (await ctx.askText(`  Which one do I use by default? (${suggested}): `, suggested)) ??
        suggested;
      firstPass = false;

      const row = rows.find((r) => r.name === chosen);
      if (!row) {
        ctx.print(`  "${chosen}" does not exist. Leaving the config as is.`);
        return;
      }

      // Credential, if needed
      if (row.profile.api_key_env && !process.env[row.profile.api_key_env]) {
        const where = KEY_URLS[row.profile.api_key_env];
        if (where) ctx.print(`  Get the credential at: ${where}`);
        const key = await ctx.askSecret(`  ${row.profile.api_key_env} (Enter to skip): `);
        if (key) {
          upsertEnvVar(path.join(this.cwd, '.env'), row.profile.api_key_env, key);
          process.env[row.profile.api_key_env] = key;
          ctx.print(`  ✔ Saved ${row.profile.api_key_env} to .env`);
        } else {
          ctx.print(`  ○ Without a credential, ${chosen} cannot be used yet.`);
        }
      }

      // Model: if it is Ollama, offer the installed ones
      let model = ctx.flags.model;
      if (!model && row.local && (row.profile.base_url ?? '').includes('11434')) {
        const models = await (this.deps.listOllamaModels ?? defaultListOllama)();
        if (models.length > 0) {
          ctx.print('  Models installed in Ollama:');
          models.forEach((m, i) => ctx.print(`    ${i + 1}) ${m}`));
          const pick = await ctx.askText(`  Model (1): `, '1');
          const idx = Math.min(Math.max(parseInt(pick ?? '1', 10) || 1, 1), models.length) - 1;
          model = models[idx];
        }
      }

      // Live probe BEFORE persisting: a default that cannot answer a
      // 1-token chat is worse than no default — it fails at first use.
      const probe = await probeFn(chosen);
      if (!probe.chat) {
        this.reportFailure(ctx, chosen, probe);
        if (!(await ctx.confirm('  Try another provider?', false))) {
          ctx.print('  Nothing was persisted: the previous config (if any) is kept.');
          return;
        }
        continue;
      }

      this.writeConfig(chosen, model);
      ctx.print(`  ✔ Default provider: ${chosen}${model ? ` · ${model}` : ''}`);
      ctx.print('  ✔ Responds to a minimal chat');
      this.reportTools(ctx, probe);
      return;
    }
    ctx.print('  Too many failed attempts; nothing was persisted.');
  }

  /**
   * The default_provider a previous run persisted in THIS project's config,
   * or null. listProfiles() cannot be used here: it falls back to a built-in
   * default even when nothing was ever configured, which would make a fresh
   * install look like a re-run.
   */
  private persistedDefault(): string | null {
    const file = path.join(this.cwd, 'mnemosine.config.json');
    if (!fs.existsSync(file)) return null;
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf-8')) as { default_provider?: unknown };
      return typeof config.default_provider === 'string' ? config.default_provider : null;
    } catch {
      return null;
    }
  }

  private reportTools(ctx: SectionContext, probe: ProbeResult): void {
    if (probe.tools) {
      ctx.print('  ✔ Supports tool-calling (the accounting tools work)');
    } else {
      ctx.print('  ⚠ Does NOT support tool-calling: fine for conversation, not for operating');
      ctx.print('     Mark tools:false in its profile, or choose another provider.');
    }
  }

  /** Categorized failure: what broke AND what to do about it. */
  private reportFailure(ctx: SectionContext, name: string, probe: ProbeResult): void {
    ctx.print(`  ✘ No response: ${probe.detail}`);
    const category = probe.category ?? categorizeProbeError(probe.detail);
    if (category === 'auth') {
      ctx.print('     Cause: the credential was rejected (invalid, expired or missing permissions).');
      const { profiles } = listProfiles(this.cwd);
      const env = profiles[name]?.api_key_env;
      const where = env ? KEY_URLS[env] : undefined;
      if (where) ctx.print(`     Get a fresh one at: ${where}`);
    } else if (category === 'connection') {
      ctx.print('     Cause: could not reach the endpoint. Check base_url, your network,');
      ctx.print('     and that the service is running (for local ones: ollama serve, hermes gateway…).');
    } else {
      ctx.print('     Cause: the provider answered with an unexpected error (see the detail above).');
    }
  }

  /**
   * Writes the default and the model to mnemosine.config.json. Routed through
   * writeConfigPatch so the strict-schema and no-secrets gates apply: we never
   * persist a file the very next load would quarantine, and a raw credential
   * pasted where a model/provider name belongs is refused instead of written.
   */
  private writeConfig(provider: string, model?: string): void {
    const patch: Record<string, unknown> = { default_provider: provider };
    if (model) {
      const { profiles } = listProfiles(this.cwd);
      // A profile from the file REPLACES the built-in one, so it is copied
      // in full before changing its model (listProfiles already prefers the
      // file profile over the built-in of the same name).
      patch.providers = { [provider]: { ...profiles[provider], model } };
    }
    writeConfigPatch(patch, this.cwd);
  }
}

async function defaultListOllama(): Promise<string[]> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

/**
 * Real probe: a minimal chat and a call with a trivial tool. The second one
 * is the one that matters — a provider without function calling cannot query
 * the accounting, even if it chats perfectly.
 */
async function defaultProbe(profileName: string): Promise<ProbeResult> {
  const PING_TOOL = {
    name: 'ping',
    description: 'Returns pong. Use it to confirm you can call tools.',
    input_schema: { type: 'object' as const, properties: {}, additionalProperties: false },
  };
  try {
    const profile = resolveProfile(profileName);

    if (profile.type === 'anthropic') {
      const client = profile.apiKey ? new Anthropic({ apiKey: profile.apiKey }) : new Anthropic();
      const res = await client.messages.create({
        model: profile.model, max_tokens: 64,
        tools: [PING_TOOL],
        messages: [{ role: 'user', content: 'Call the ping tool.' }],
      });
      return {
        chat: true,
        tools: res.content.some((b) => b.type === 'tool_use'),
        detail: `stop_reason=${res.stop_reason}`,
      };
    }

    if (profile.tools === false) {
      // Agent channel: it runs its own tools server-side, not ours.
      return { chat: true, tools: false, detail: 'profile declared tools:false' };
    }

    const client = new OpenAI({
      baseURL: profile.base_url,
      apiKey: profile.apiKey ?? 'not-needed',
      defaultHeaders: profile.headers,
    });
    const limit =
      profile.max_tokens_param === 'max_completion_tokens'
        ? { max_completion_tokens: 64 }
        : { max_tokens: 64 };
    const res = await client.chat.completions.create({
      model: profile.model,
      ...limit,
      messages: [{ role: 'user', content: 'Call the ping tool.' }],
      tools: [{
        type: 'function',
        function: { name: 'ping', description: PING_TOOL.description, parameters: PING_TOOL.input_schema },
      }],
    });
    const msg = res.choices[0]?.message;
    return {
      chat: true,
      tools: (msg?.tool_calls?.length ?? 0) > 0,
      detail: `finish_reason=${res.choices[0]?.finish_reason}`,
    };
  } catch (err) {
    // HTTP status (Anthropic & OpenAI SDK errors carry it) beats message
    // heuristics: a 401 is auth even if the body says something exotic.
    const status = (err as { status?: number }).status;
    const message = (err as Error).message;
    const category: ProbeErrorCategory =
      status === 401 || status === 403 ? 'auth' : categorizeProbeError(message);
    return { chat: false, tools: false, detail: message, category };
  }
}
