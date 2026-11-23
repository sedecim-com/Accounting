import fs from 'node:fs';
import path from 'node:path';
import { createOpenAiClient } from '../../ai/providers/openai-client.js';
import Anthropic from '@anthropic-ai/sdk';
import {
  BUILTIN_PROFILES, listProfiles, loadConfigFile, resolveProfile, userConfigPath, ventanaDe, writeConfigPatch,
} from '../../ai/providers/config.js';
import type { MnemosineConfig } from '../../ai/providers/config.js';
import { checkModelProvider } from '../../ai/doctor-service.js';
import { credentialState, isLoopbackUrl, KEY_URLS } from '../../ai/providers/credential-state.js';
import type { CheckResult } from '../../ai/doctor-service.js';
import { userEnvPath } from '../../config/env-file.js';
import { readEnvVar, upsertEnvVar } from './s0-infra.js';
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
  /** Home directory for ~/.mnemosine/.env; default os.homedir(). */
  home?: string;
  /** Injectable: in tests no model is ever called. `model` is the one about to be saved. */
  probe?: (profileName: string, model?: string) => Promise<ProbeResult>;
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
      const { profiles, source } = listProfiles(this.cwd);
      const p = profiles[persisted];
      // A helper counts as ready: the probe below runs it, as the session does.
      const ready = !!p && credentialState(p, { cwd: this.cwd, home: this.deps.home, source }).ready;
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
      const { profiles, defaultName, source } = listProfiles(this.cwd);

      // State of each profile: what is ready to use NOW (env may have
      // gained keys on a previous iteration). The same answer doctor and
      // `mnemosine providers` give; it never runs a helper.
      const rows = Object.entries(profiles).map(([name, p]) => {
        const state = credentialState(p, { cwd: this.cwd, home: this.deps.home, source });
        return { name, profile: p, state, ready: state.ready, local: isLoopbackUrl(p.base_url) };
      });

      if (firstPass) {
        ctx.print('  Available providers:');
        for (const r of rows) {
          const badge = r.ready ? '✔' : '○';
          ctx.print(`    ${badge} ${r.name.padEnd(14)} ${r.profile.model} · ${r.state.label}`);
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

      // Credential, only when it is missing: a helper is not asked for a key.
      if (row.state.source.kind === 'missing') {
        const variable = row.state.source.variable;
        const where = row.state.source.where;
        if (where) ctx.print(`  Get the credential at: ${where}`);
        const key = await ctx.askSecret(`  ${variable} (Enter to skip): `);
        if (key) {
          const envPath = this.saveTypedKey(ctx, variable, key);
          process.env[variable] = key;
          ctx.print(`  ✔ Saved ${variable} to ${envPath}`);
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
      const probe = await probeFn(chosen, model);
      if (!probe.chat) {
        this.reportFailure(ctx, chosen, probe);
        if (!(await ctx.confirm('  Try another provider?', false))) {
          ctx.print('  Nothing was persisted: the previous config (if any) is kept.');
          return;
        }
        continue;
      }

      ctx.print('  ✔ Responds to a minimal chat');
      this.reportTools(ctx, probe);
      if (!(await this.writeConfig(ctx, chosen, model))) return;
      ctx.print(`  ✔ Default provider: ${chosen}${model ? ` · ${model}` : ''}`);
      const fromEnv = process.env.MNEMOSINE_PROVIDER;
      if (fromEnv && fromEnv !== chosen) {
        ctx.print(`  ! MNEMOSINE_PROVIDER=${fromEnv} wins over the default_provider just saved.`);
        ctx.print(`    Empty it (in your .env or shell) to use ${chosen} by default.`);
      }
      return;
    }
    ctx.print('  Too many failed attempts; nothing was persisted.');
  }

  /**
   * The default_provider a previous run persisted in the config file that
   * wins here (the same file writeConfig writes), or null. listProfiles()
   * cannot be used here: it falls back to a built-in default even when nothing
   * was ever configured, which would make a fresh install look like a re-run.
   * An invalid file reads as null; listProfiles reports it right after.
   */
  private persistedDefault(): string | null {
    try {
      return loadConfigFile(this.cwd).config.default_provider ?? null;
    } catch {
      return null;
    }
  }

  /**
   * SECURITY: a key typed at the prompt is the person's own, so it goes to
   * ~/.mnemosine/.env (0600, directory 0700) and never to the folder's ./.env,
   * which serves everyone who runs mnemosine in that folder. The CLI loads
   * ./.env first and keeps its value even when empty, so an empty definition
   * there (as copied from .env.example) would hide the key: it is removed. A
   * non-empty one is left alone, and the person is told it wins there.
   */
  private saveTypedKey(ctx: SectionContext, variable: string, key: string): string {
    const target = userEnvPath(this.deps.home);
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    ctx.print(`  .env location: ${target} (yours; never the folder's ./.env)`);
    upsertEnvVar(target, variable, key, ctx.print);

    const local = path.join(this.cwd, '.env');
    const value = readEnvVar(local, variable);
    if (value === '') {
      const lines = fs.readFileSync(local, 'utf-8').split('\n');
      const kept = lines.filter((l) => !(l.startsWith(`${variable}=`) && l.slice(variable.length + 1).trim() === ''));
      fs.writeFileSync(local, kept.join('\n'));
      ctx.print(`  ✔ Removed the empty ${variable}= from ${local}, which would hide your key`);
    } else if (value !== null) {
      ctx.print(`  ! ${variable} in ${local} wins in ${this.cwd}: that key serves everyone who runs mnemosine here.`);
    }
    return target;
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
   * Writes the default and the model to the config file that wins here, as
   * setLanguage does, with two differences. When no file exists it creates
   * ~/.mnemosine/config.json, never a project file, because a project file
   * hides every user's own file in that folder. When the file that wins is a
   * project file it says who reads it and asks first (default No, which --yes
   * keeps); on No it writes the user file. A built-in gets `models.<name>`, so
   * it keeps its declared window and posture; a profile of the target file gets
   * its own `model` changed; nothing is ever copied from one file to another.
   * Routed through writeConfigPatch, so the strict-schema and no-secrets gates
   * apply. Returns false when nothing was written.
   */
  private async writeConfig(ctx: SectionContext, provider: string, model?: string): Promise<boolean> {
    // The reader (loadConfigFile) finds the user file through os.homedir(); so does this.
    const userFile = userConfigPath();
    const { source } = loadConfigFile(this.cwd);
    let target = userFile;
    if (source !== null && source !== userFile) {
      ctx.print(`  ! everyone who runs mnemosine in ${this.cwd} reads ${source}.`);
      if (await ctx.confirm(`  Save your choice there (No: in ${userFile})?`, false)) {
        target = source;
      } else {
        ctx.print(`  ${source} still decides in ${this.cwd}; your file applies elsewhere.`);
      }
    }

    const existing: MnemosineConfig =
      target === source ? loadConfigFile(this.cwd).config : this.readUserConfig(userFile);
    const inTarget = Object.prototype.hasOwnProperty.call(existing.providers ?? {}, provider);
    if (!inTarget && !Object.prototype.hasOwnProperty.call(BUILTIN_PROFILES, provider)) {
      ctx.print(`  ✘ "${provider}" is defined only in ${source}; it is not copied into ${target}, so nothing was saved.`);
      return false;
    }

    const patch: Record<string, unknown> = { default_provider: provider };
    if (model) patch[inTarget ? 'providers' : 'models'] = { [provider]: inTarget ? { model } : model };
    if (target === userFile) fs.mkdirSync(path.dirname(userFile), { recursive: true, mode: 0o700 });
    writeConfigPatch(patch, this.cwd, target);
    ctx.print(`  ✔ Saved to ${target}`);

    // Only built-ins declare a window, and they declare it for their own model.
    const declaredFor = BUILTIN_PROFILES[provider]?.model;
    const declared = ventanaDe(provider, this.cwd);
    if (model && declaredFor && model !== declaredFor && declared?.tokens !== undefined) {
      ctx.print(`  ! ${provider} declares a ${declared.tokens}-token context window for ${declaredFor}, not for ${model}.`);
      ctx.print('    If yours differs, set compaction.threshold_tokens in the config file.');
    }
    return true;
  }

  /** The user file's content, or {} when it does not exist yet. */
  private readUserConfig(file: string): MnemosineConfig {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as MnemosineConfig;
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
// 1 024 and not 64: a model that reasons before it answers can spend 64 tokens
// thinking and be reported as tool-less (inferred, not measured; MNE-001-442).
const PROBE_MAX_TOKENS = 1024;

export async function defaultProbe(profileName: string, model?: string): Promise<ProbeResult> {
  const PING_TOOL = {
    name: 'ping',
    description: 'Returns pong. Use it to confirm you can call tools.',
    input_schema: { type: 'object' as const, properties: {}, additionalProperties: false },
  };
  try {
    const profile = resolveProfile(profileName, model);

    if (profile.type === 'anthropic') {
      const client = profile.apiKey ? new Anthropic({ apiKey: profile.apiKey }) : new Anthropic();
      const res = await client.messages.create({
        model: profile.model, max_tokens: PROBE_MAX_TOKENS,
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

    // The same client the session builds: environment OpenAI headers reach
    // only OpenAI's own hosts (openai-client.ts, MNE-001-445).
    const client = createOpenAiClient(profile);
    const limit =
      profile.max_tokens_param === 'max_completion_tokens'
        ? { max_completion_tokens: PROBE_MAX_TOKENS }
        : { max_tokens: PROBE_MAX_TOKENS };
    const res = await client.chat.completions.create({
      model: profile.model,
      ...limit,
      ...(profile.reasoning_effort ? { reasoning_effort: profile.reasoning_effort } : {}),
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
