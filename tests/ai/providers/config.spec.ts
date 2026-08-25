import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

import {
  resolveProfile, listProfiles, resolveIngestThresholds, writeConfigPatch, loadConfigFile, setLanguage,
  resolveFailoverChain, resolveCompactionConfig, DEFAULT_COMPACTION_THRESHOLD_TOKENS,
  BUILTIN_PROFILES,
} from '../../../src/ai/providers/config.js';
import { createLlmSessionWithFailover, CooldownRegistry } from '../../../src/ai/providers/index.js';
import type { LlmSession, ResolvedProfile } from '../../../src/ai/providers/types.js';
import type { AgentContext } from '../../../src/ai/context.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-test-'));
  delete process.env.MNEMOSINE_PROVIDER;
  delete process.env.NOUS_API_KEY;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MNEMOSINE_PROVIDER;
  delete process.env.NOUS_API_KEY;
});

describe('BUILTIN_PROFILES', () => {
  it('ships anthropic, hermes, hermes-agent and ollama', () => {
    expect(Object.keys(BUILTIN_PROFILES)).toEqual(
      expect.arrayContaining(['anthropic', 'hermes', 'hermes-agent', 'ollama'])
    );
    expect(BUILTIN_PROFILES.hermes.base_url).toBe('https://inference-api.nousresearch.com/v1');
    expect(BUILTIN_PROFILES['hermes-agent'].base_url).toBe('http://127.0.0.1:8642/v1');
    // hermes-agent runs its own tools server-side: mnemosine must not declare tools
    expect(BUILTIN_PROFILES['hermes-agent'].tools).toBe(false);
  });

  it('ships the extended provider roster (openai, grok, minimax, qwen, openrouter, copilot, openclaw)', () => {
    expect(Object.keys(BUILTIN_PROFILES)).toEqual(
      expect.arrayContaining(['openai', 'grok', 'minimax', 'qwen', 'openrouter', 'copilot', 'openclaw'])
    );
    // OpenAI reasoning models reject max_tokens: the profile must opt into max_completion_tokens
    expect(BUILTIN_PROFILES.openai.max_tokens_param).toBe('max_completion_tokens');
    expect(BUILTIN_PROFILES.grok.base_url).toBe('https://api.x.ai/v1');
    expect(BUILTIN_PROFILES.minimax.base_url).toBe('https://api.minimax.io/v1');
    expect(BUILTIN_PROFILES.openrouter.base_url).toBe('https://openrouter.ai/api/v1');
    // OpenClaw is an agent gateway (server-side tools): chat channel only
    expect(BUILTIN_PROFILES.openclaw.base_url).toBe('http://127.0.0.1:18789/v1');
    expect(BUILTIN_PROFILES.openclaw.tools).toBe(false);
    expect(BUILTIN_PROFILES.openclaw.model).toBe('openclaw:main');
    // every remote provider names its key env; local ollama is the keyless one
    for (const name of ['openai', 'grok', 'minimax', 'qwen', 'openrouter', 'copilot', 'openclaw', 'gemini']) {
      expect(BUILTIN_PROFILES[name].api_key_env).toBeTruthy();
    }
  });

  it('ships gemini via the Google AI Studio OpenAI-compatible endpoint', () => {
    expect(BUILTIN_PROFILES.gemini.base_url).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(BUILTIN_PROFILES.gemini.api_key_env).toBe('GEMINI_API_KEY');
  });
});

describe('api_key_cmd (credential helper)', () => {
  const writeProfile = (extra: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(tmpDir, 'mnemosine.config.json'),
      JSON.stringify({
        providers: {
          sub: {
            type: 'openai-compatible', model: 'x', base_url: 'http://localhost:9/v1',
            api_key_env: 'SUB_TOKEN', ...extra,
          },
        },
      })
    );

  afterEach(() => delete process.env.SUB_TOKEN);

  it('runs the command when the env var is absent', () => {
    writeProfile({ api_key_cmd: "printf 'oauth-token-123\n'" });
    const p = resolveProfile('sub', undefined, tmpDir);
    expect(p.apiKey).toBe('oauth-token-123');
  });

  it('prefers the env var over the command', () => {
    process.env.SUB_TOKEN = 'from-env';
    writeProfile({ api_key_cmd: "printf 'from-cmd'" });
    expect(resolveProfile('sub', undefined, tmpDir).apiKey).toBe('from-env');
  });

  it('fails clearly when the command errors or prints nothing', () => {
    writeProfile({ api_key_cmd: 'exit 3' });
    expect(() => resolveProfile('sub', undefined, tmpDir)).toThrow(/api_key_cmd/);
    writeProfile({ api_key_cmd: 'printf ""' });
    expect(() => resolveProfile('sub', undefined, tmpDir)).toThrow(/did not print/);
  });
});

describe('resolveIngestThresholds', () => {
  it('keeps conservative defaults and applies finite overrides', () => {
    const d = resolveIngestThresholds({}, tmpDir);
    expect(d).toEqual({ autoPost: false, minConfidence: 0.95, maxAmount: 10000 });
    const o = resolveIngestThresholds({ autoPost: true, minConfidence: 0.7, maxAmount: 5000 }, tmpDir);
    expect(o).toEqual({ autoPost: true, minConfidence: 0.7, maxAmount: 5000 });
  });

  it('ignores NaN overrides (invalid --min-confianza must not open the auto-post gate)', () => {
    const t = resolveIngestThresholds({ minConfidence: NaN, maxAmount: NaN }, tmpDir);
    expect(t.minConfidence).toBe(0.95);
    expect(t.maxAmount).toBe(10000);
  });

  it('clamps out-of-range values', () => {
    const t = resolveIngestThresholds({ minConfidence: 7, maxAmount: -5 }, tmpDir);
    expect(t.minConfidence).toBe(1);
    expect(t.maxAmount).toBe(0);
  });
});

describe('compaction config (auto-compaction ON by default)', () => {
  const configPath = () => path.join(tmpDir, 'mnemosine.config.json');
  const quarantineFiles = () =>
    fs.readdirSync(tmpDir).filter((f) => f.includes('.rejected-'));

  it('defaults to ~150k threshold with no config section at all', () => {
    const c = resolveCompactionConfig(tmpDir);
    expect(DEFAULT_COMPACTION_THRESHOLD_TOKENS).toBe(150000);
    expect(c.thresholdTokens).toBe(150000);
    expect(c.keepRecentTokens).toBeUndefined();
    expect(c.identifierPolicy).toBeUndefined();
  });

  it('threshold_tokens: 0 is the explicit off switch', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ compaction: { threshold_tokens: 0 } }));
    expect(resolveCompactionConfig(tmpDir).thresholdTokens).toBeUndefined();
  });

  it('honors explicit threshold / tail / policy values', () => {
    fs.writeFileSync(
      configPath(),
      JSON.stringify({
        compaction: { threshold_tokens: 80000, keep_recent_tokens: 10000, identifier_policy: 'strict' },
      })
    );
    expect(resolveCompactionConfig(tmpDir)).toEqual({
      thresholdTokens: 80000,
      keepRecentTokens: 10000,
      identifierPolicy: 'strict',
    });
  });

  it('fails closed (throw + quarantine) on junk in the compaction section', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ compaction: { threshold_tokens: 'lots' } }));
    expect(() => resolveCompactionConfig(tmpDir)).toThrow(/Invalid configuration/);
    expect(quarantineFiles()).toHaveLength(1);
  });

  it('rejects negative thresholds and unknown keys (typos never silently default)', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ compaction: { threshold_tokens: -5 } }));
    expect(() => resolveCompactionConfig(tmpDir)).toThrow(/Invalid configuration/);
    fs.writeFileSync(configPath(), JSON.stringify({ compaction: { thresold_tokens: 1000 } }));
    expect(() => resolveCompactionConfig(tmpDir)).toThrow(/Invalid configuration/);
  });
});

describe('resolveProfile', () => {
  it('defaults to anthropic without flags, env or config', () => {
    const p = resolveProfile(undefined, undefined, tmpDir);
    expect(p.name).toBe('anthropic');
    expect(p.type).toBe('anthropic');
    expect(p.model).toBe('claude-opus-5');
  });

  it('honors precedence: flag > env > config default', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mnemosine.config.json'),
      JSON.stringify({ default_provider: 'ollama' })
    );
    expect(resolveProfile(undefined, undefined, tmpDir).name).toBe('ollama');

    process.env.HERMES_AGENT_KEY = 'test-key';
    process.env.MNEMOSINE_PROVIDER = 'hermes-agent';
    expect(resolveProfile(undefined, undefined, tmpDir).name).toBe('hermes-agent');
    delete process.env.HERMES_AGENT_KEY;

    expect(resolveProfile('anthropic', undefined, tmpDir).name).toBe('anthropic');
  });

  it('applies --model as override of the profile model', () => {
    const p = resolveProfile('ollama', 'gemma4:26b', tmpDir);
    expect(p.model).toBe('gemma4:26b');
  });

  it('merges file profiles over builtins and accepts new ones', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mnemosine.config.json'),
      JSON.stringify({
        providers: {
          ollama: { type: 'openai-compatible', model: 'gemma4:26b', base_url: 'http://localhost:11434/v1' },
          groq: { type: 'openai-compatible', model: 'llama-3.3-70b', base_url: 'https://api.groq.com/openai/v1', api_key_env: 'GROQ_API_KEY' },
        },
      })
    );
    const { profiles } = listProfiles(tmpDir);
    expect(profiles.ollama.model).toBe('gemma4:26b');
    expect(profiles.groq.base_url).toBe('https://api.groq.com/openai/v1');
    // builtins survive
    expect(profiles.anthropic).toBeDefined();
  });

  it('demands the named env key for openai-compatible providers', () => {
    expect(() => resolveProfile('hermes', undefined, tmpDir)).toThrow(/NOUS_API_KEY/);
    process.env.NOUS_API_KEY = 'sk-test';
    const p = resolveProfile('hermes', undefined, tmpDir);
    expect(p.apiKey).toBe('sk-test');
  });

  it('does not demand a key for keyless local providers (ollama)', () => {
    const p = resolveProfile('ollama', undefined, tmpDir);
    expect(p.apiKey).toBeUndefined();
  });

  it('rejects unknown providers listing the available ones', () => {
    expect(() => resolveProfile('nope', undefined, tmpDir)).toThrow(/anthropic/);
  });

  it('rejects a malformed config file with a useful message', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mnemosine.config.json'),
      JSON.stringify({ providers: { bad: { type: 'wat', model: '' } } })
    );
    expect(() => listProfiles(tmpDir)).toThrow(/Invalid configuration/);
  });
});

describe('strict schema + quarantine (fail closed on invalid config)', () => {
  const configPath = () => path.join(tmpDir, 'mnemosine.config.json');
  const quarantineFiles = () =>
    fs.readdirSync(tmpDir).filter((f) => f.includes('.rejected-'));

  it('rejects unknown keys at the ROOT (typos never fall back to defaults silently)', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ default_provder: 'ollama' }));
    expect(() => loadConfigFile(tmpDir)).toThrow(/Invalid configuration/);
  });

  it('rejects unknown keys inside a PROFILE (api_key_evn must not silently drop the credential)', () => {
    fs.writeFileSync(
      configPath(),
      JSON.stringify({
        providers: {
          sub: { type: 'openai-compatible', model: 'x', api_key_evn: 'SUB_TOKEN' },
        },
      })
    );
    expect(() => loadConfigFile(tmpDir)).toThrow(/Invalid configuration/);
  });

  it('quarantines the invalid file to <file>.rejected-<hash> and names the copy in the error', () => {
    const original = JSON.stringify({ unknown_root_key: true });
    fs.writeFileSync(configPath(), original);
    let message = '';
    try {
      loadConfigFile(tmpDir);
    } catch (err) {
      message = (err as Error).message;
    }
    const copies = quarantineFiles();
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^mnemosine\.config\.json\.rejected-/);
    // The copy preserves the rejected content byte-for-byte
    expect(fs.readFileSync(path.join(tmpDir, copies[0]), 'utf-8')).toBe(original);
    // and the error tells the user where it went
    expect(message).toContain(copies[0]);
    // the original stays in place: we never destroy the user's file
    expect(fs.existsSync(configPath())).toBe(true);
  });

  it('quarantines on broken JSON too (parse errors are also invalid config)', () => {
    fs.writeFileSync(configPath(), '{ not json');
    expect(() => loadConfigFile(tmpDir)).toThrow(/rejected copy kept at/);
    expect(quarantineFiles()).toHaveLength(1);
  });

  it('repeated loads of the SAME invalid config produce a single quarantine copy (idempotent by content hash)', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ unknown_root_key: true }));
    expect(() => loadConfigFile(tmpDir)).toThrow(/Invalid configuration/);
    expect(() => loadConfigFile(tmpDir)).toThrow(/Invalid configuration/);
    expect(() => loadConfigFile(tmpDir)).toThrow(/Invalid configuration/);
    expect(quarantineFiles()).toHaveLength(1);
  });

  it('a DIFFERENTLY broken config still gets its own quarantine copy', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ unknown_root_key: 1 }));
    expect(() => loadConfigFile(tmpDir)).toThrow(/Invalid configuration/);
    fs.writeFileSync(configPath(), JSON.stringify({ unknown_root_key: 2 }));
    expect(() => loadConfigFile(tmpDir)).toThrow(/Invalid configuration/);
    expect(quarantineFiles()).toHaveLength(2);
  });

  it('does not quarantine anything when no config file exists', () => {
    const { config, source } = loadConfigFile(tmpDir);
    expect(config).toEqual({});
    expect(source).toBeNull();
    expect(quarantineFiles()).toHaveLength(0);
  });
});

describe('writeConfigPatch (secrets never land in the config file)', () => {
  const configPath = () => path.join(tmpDir, 'mnemosine.config.json');

  it('refuses values with well-known credential prefixes regardless of key name', () => {
    for (const secret of ['sk-ant-abc123', 'ghp_abcdef', 'xoxb-1234', 'AKIAIOSFODNN7', 'eyJhbGciOi']) {
      expect(() =>
        writeConfigPatch({ default_provider: secret }, tmpDir)
      ).toThrow(/api_key_env/);
    }
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it('refuses secret-named keys carrying a raw value (not an env var NAME)', () => {
    expect(() =>
      writeConfigPatch(
        { providers: { sub: { type: 'openai-compatible', model: 'x', api_key_env: 'my-actual-secret-value' } } },
        tmpDir
      )
    ).toThrow(/\.env/);
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it('accepts secret-named keys whose value IS an env var name, and api_key_cmd commands', () => {
    const file = writeConfigPatch(
      {
        providers: {
          sub: {
            type: 'openai-compatible',
            model: 'x',
            api_key_env: 'SUB_TOKEN',
            api_key_cmd: 'security find-generic-password -w -s sub',
          },
        },
      },
      tmpDir
    );
    const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(written.providers.sub.api_key_env).toBe('SUB_TOKEN');
  });

  it('still refuses a raw credential pasted into api_key_cmd (value-prefix check)', () => {
    expect(() =>
      writeConfigPatch(
        { providers: { sub: { type: 'openai-compatible', model: 'x', api_key_cmd: 'sk-ant-raw' } } },
        tmpDir
      )
    ).toThrow(/credential/);
  });

  it('deep-merges over the existing file, preserving unrelated keys', () => {
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ language: 'en', providers: { keep: { type: 'openai-compatible', model: 'k' } } })
    );
    writeConfigPatch({ providers: { added: { type: 'openai-compatible', model: 'a' } } }, tmpDir);
    const written = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    expect(written.language).toBe('en');
    expect(written.providers.keep.model).toBe('k');
    expect(written.providers.added.model).toBe('a');
  });

  it('refuses to write a patch the strict schema would quarantine on the next load', () => {
    expect(() => writeConfigPatch({ unknown_root_key: true }, tmpDir)).toThrow(/invalid configuration/i);
    expect(fs.existsSync(configPath())).toBe(false);
  });
});

describe('setLanguage (writes to the config file that currently WINS)', () => {
  const projectFile = () => path.join(tmpDir, 'mnemosine.config.json');
  const userFile = () => path.join(os.homedir(), '.mnemosine', 'config.json');

  // A fake, empty HOME for every test in this block: the layering itself is
  // under test, and the developer's real ~/.mnemosine must never be touched.
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('updates a user-level config IN PLACE instead of shadowing it with a new project file', () => {
    // Only ~/.mnemosine/config.json exists → it is the active config and must
    // stay so: creating ./mnemosine.config.json would silently shadow it all.
    fs.mkdirSync(path.dirname(userFile()), { recursive: true });
    fs.writeFileSync(userFile(), JSON.stringify({ default_provider: 'ollama' }));

    const written = setLanguage('en', tmpDir);

    expect(written).toBe(userFile());
    const cfg = JSON.parse(fs.readFileSync(userFile(), 'utf-8'));
    expect(cfg.language).toBe('en');
    expect(cfg.default_provider).toBe('ollama'); // unrelated keys preserved
    // no shadowing project file was created
    expect(fs.existsSync(projectFile())).toBe(false);
  });

  it('writes to the project file when it is the active config, preserving other keys', () => {
    fs.writeFileSync(projectFile(), JSON.stringify({ default_provider: 'ollama' }));
    const written = setLanguage('en', tmpDir);
    expect(written).toBe(projectFile());
    const cfg = JSON.parse(fs.readFileSync(projectFile(), 'utf-8'));
    expect(cfg).toEqual({ default_provider: 'ollama', language: 'en' });
  });

  it('creates the project file only when no config exists at all', () => {
    const written = setLanguage('es', tmpDir);
    expect(written).toBe(projectFile());
    expect(JSON.parse(fs.readFileSync(projectFile(), 'utf-8'))).toEqual({ language: 'es' });
  });

  it('fails closed with a descriptive error on a config with a typo key (strict-schema gate)', () => {
    const original = JSON.stringify({ defalt_provider: 'ollama' });
    fs.writeFileSync(projectFile(), original);
    expect(() => setLanguage('en', tmpDir)).toThrow(/Invalid configuration/);
    // the broken file is left untouched for the user to fix
    expect(fs.readFileSync(projectFile(), 'utf-8')).toBe(original);
  });
});

describe('failover chains (config field + resolveFailoverChain)', () => {
  const configPath = () => path.join(tmpDir, 'mnemosine.config.json');
  const writeProviders = (providers: Record<string, unknown>, defaultProvider?: string) =>
    fs.writeFileSync(configPath(), JSON.stringify({
      ...(defaultProvider ? { default_provider: defaultProvider } : {}),
      providers,
    }));
  const p = (extra: Record<string, unknown> = {}) => ({
    type: 'openai-compatible', model: 'x', base_url: 'http://localhost:9/v1', ...extra,
  });

  it('accepts the optional failover field in the strict profile schema', () => {
    writeProviders({ a: p({ failover: ['b'] }), b: p() });
    const { profiles } = listProfiles(tmpDir);
    expect((profiles.a as { failover?: string[] }).failover).toEqual(['b']);
  });

  it('still rejects unknown keys next to failover (strict schema intact)', () => {
    writeProviders({ a: p({ failovr: ['b'] }), b: p() });
    expect(() => listProfiles(tmpDir)).toThrow(/Invalid configuration/);
  });

  it('writeConfigPatch persists a failover list through the strict-schema gate', () => {
    const file = writeConfigPatch({ providers: { a: p({ failover: ['ollama'] }) } }, tmpDir);
    const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(written.providers.a.failover).toEqual(['ollama']);
  });

  it('resolves the ordered chain: profile first, then its fallbacks, expanding transitively', () => {
    writeProviders({
      a: p({ failover: ['b', 'ollama'] }),
      b: p({ failover: ['anthropic'] }),
    });
    const chain = resolveFailoverChain('a', tmpDir);
    expect(chain.map((x) => x.name)).toEqual(['a', 'b', 'ollama', 'anthropic']);
    // full profiles come back, not just names: the caller attempts them directly
    expect(chain[1].base_url).toBe('http://localhost:9/v1');
  });

  it('a profile without failover resolves to a single-element chain', () => {
    expect(resolveFailoverChain('ollama', tmpDir).map((x) => x.name)).toEqual(['ollama']);
  });

  it('refuses an unknown provider name in the chain', () => {
    writeProviders({ a: p({ failover: ['nope'] }) });
    expect(() => resolveFailoverChain('a', tmpDir)).toThrow(/unknown provider "nope"/);
  });

  it('refuses a self-reference', () => {
    writeProviders({ a: p({ failover: ['a'] }) });
    expect(() => resolveFailoverChain('a', tmpDir)).toThrow(/references itself/);
  });

  it('refuses a cycle (a → b → a)', () => {
    writeProviders({ a: p({ failover: ['b'] }), b: p({ failover: ['a'] }) });
    expect(() => resolveFailoverChain('a', tmpDir)).toThrow(/cycle detected/);
  });

  it('accepts a DIAMOND (same fallback reachable via two paths) and dedupes silently', () => {
    writeProviders({
      a: p({ failover: ['b', 'c'] }),
      b: p({ failover: ['d'] }),
      c: p({ failover: ['d'] }),
      d: p(),
    });
    // Not a cycle: d is never on its own expansion path. First position wins.
    expect(resolveFailoverChain('a', tmpDir).map((x) => x.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('still rejects a true cycle reached through a diamond', () => {
    writeProviders({
      a: p({ failover: ['b', 'c'] }),
      b: p({ failover: ['d'] }),
      c: p({ failover: ['d'] }),
      d: p({ failover: ['a'] }),
    });
    expect(() => resolveFailoverChain('a', tmpDir)).toThrow(/cycle detected/);
  });

  it('accepts stream_usage in the strict profile schema (streamed-usage opt-out)', () => {
    writeProviders({ a: p({ stream_usage: false }) });
    const { profiles } = listProfiles(tmpDir);
    expect((profiles.a as { stream_usage?: boolean }).stream_usage).toBe(false);
  });

  it('refuses an unknown ROOT profile', () => {
    expect(() => resolveFailoverChain('nope', tmpDir)).toThrow(/does not exist/);
  });
});

describe('createLlmSessionWithFailover (session-level failover factory)', () => {
  const configPath = () => path.join(tmpDir, 'mnemosine.config.json');
  const writeProviders = (providers: Record<string, unknown>) =>
    fs.writeFileSync(configPath(), JSON.stringify({ providers }));
  const p = (extra: Record<string, unknown> = {}) => ({
    type: 'openai-compatible', model: 'x', base_url: 'http://localhost:9/v1', ...extra,
  });
  const ctx = { entityId: 'e', tenantId: 't' } as unknown as AgentContext;
  const mkSession = (name: string, impl: (input: string) => Promise<string>): LlmSession => ({
    label: name,
    runTurn: (input: string) => impl(input),
    reset: () => {},
  });

  it('walks the chain on a failover-eligible first-turn error and pins the fallback', async () => {
    writeProviders({ a: p({ failover: ['b'] }), b: p() });
    const made: string[] = [];
    const sessionFactory = vi.fn(async (profile: ResolvedProfile) => {
      made.push(`${profile.name}:${profile.model}`);
      if (profile.name === 'a') {
        return mkSession('a', async () => {
          throw Object.assign(new Error('service unavailable'), { status: 503 });
        });
      }
      return mkSession('b', async (input) => `b:${input}`);
    });
    const events: string[][] = [];
    const session = await createLlmSessionWithFailover('a', ctx, {}, {
      cwd: tmpDir,
      model: 'custom',
      sessionFactory,
      cooldowns: new CooldownRegistry(),
      onFailover: (from, errorType, to) => events.push([from, errorType, to]),
    });

    expect(await session.runTurn('hola')).toBe('b:hola');
    expect(events).toEqual([['a', 'server', 'b']]);
    // --model applies to the REQUESTED profile only, never to fallbacks.
    expect(made).toEqual(['a:custom', 'b:x']);
    expect(session.label).toBe('b');

    // Single-provider once live: the second turn never re-walks the chain.
    expect(await session.runTurn('otra')).toBe('b:otra');
    expect(sessionFactory).toHaveBeenCalledTimes(2);
  });

  it('walks the chain when session SETUP itself fails with an eligible error', async () => {
    writeProviders({ a: p({ failover: ['b'] }), b: p() });
    const sessionFactory = vi.fn(async (profile: ResolvedProfile) => {
      if (profile.name === 'a') {
        throw Object.assign(new Error('bad key'), { status: 401 });
      }
      return mkSession('b', async () => 'ok');
    });
    const session = await createLlmSessionWithFailover('a', ctx, {}, {
      cwd: tmpDir,
      sessionFactory,
      cooldowns: new CooldownRegistry(),
    });
    expect(await session.runTurn('hola')).toBe('ok');
    expect(sessionFactory).toHaveBeenCalledTimes(2);
  });

  it('never shops a REFUSAL to the next provider (fail closed)', async () => {
    writeProviders({ a: p({ failover: ['b'] }), b: p() });
    const sessionFactory = vi.fn(async (profile: ResolvedProfile) =>
      mkSession(profile.name, async () => {
        throw new Error('the model refused to answer this request');
      })
    );
    const onFailover = vi.fn();
    const session = await createLlmSessionWithFailover('a', ctx, {}, {
      cwd: tmpDir,
      sessionFactory,
      cooldowns: new CooldownRegistry(),
      onFailover,
    });
    await expect(session.runTurn('hola')).rejects.toThrow(/refused/);
    expect(sessionFactory).toHaveBeenCalledTimes(1); // b was never tried
    expect(onFailover).not.toHaveBeenCalled();
  });

  it('creates a plain eager session when the profile has no fallbacks', async () => {
    writeProviders({ solo: p() });
    const sessionFactory = vi.fn(async (profile: ResolvedProfile) =>
      mkSession(profile.name, async () => 'ok')
    );
    const session = await createLlmSessionWithFailover('solo', ctx, {}, {
      cwd: tmpDir,
      sessionFactory,
      cooldowns: new CooldownRegistry(),
    });
    expect(sessionFactory).toHaveBeenCalledTimes(1); // eager, before any turn
    expect(await session.runTurn('hola')).toBe('ok');
  });
});
