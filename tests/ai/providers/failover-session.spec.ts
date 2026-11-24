import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLlmSessionWithFailover, CooldownRegistry } from '../../../src/ai/providers/index.js';
import { AllProvidersFailedError } from '../../../src/ai/providers/failover.js';
import type { AgentContext } from '../../../src/ai/context.js';
import type { LlmSession, ResolvedProfile, SessionCallbacks } from '../../../src/ai/providers/types.js';

// ============================================================
// createLlmSessionWithFailover — session label (#20)
// The banner and the `[entity · label]` header are printed BEFORE the first
// turn runs, so a --model override must be reflected in the label from the
// start, not only after the first turn resolves the provider.
// ============================================================

const CTX: AgentContext = {
  entityId: 'entity-1', entityName: 'Acme', tenantId: 'tenant-a',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AME010101AAA',
};

const dirs: string[] = [];

function cwdWithFailoverChain(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-failover-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'mnemosine.config.json'),
    JSON.stringify({
      providers: {
        primary: {
          type: 'openai-compatible',
          model: 'Head-Default-Model',
          base_url: 'https://example.test/v1',
          failover: ['backup'],
        },
        backup: {
          type: 'openai-compatible',
          model: 'Backup-Model',
          base_url: 'https://example.test/v1',
        },
      },
    })
  );
  return dir;
}

// A session factory that never touches a provider — the label test must not
// run a turn at all.
const neverCalledFactory = async (
  _profile: ResolvedProfile,
  _ctx: AgentContext,
  _callbacks: SessionCallbacks
): Promise<LlmSession> => {
  throw new Error('session factory must not be called before the first turn');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('createLlmSessionWithFailover label', () => {
  it('reflects the --model override in the label BEFORE the first turn (failover chain)', async () => {
    const cwd = cwdWithFailoverChain();
    const session = await createLlmSessionWithFailover('primary', CTX, {}, {
      model: 'Head-Override-Model',
      cwd,
      sessionFactory: neverCalledFactory,
    });
    // Pre-turn label uses the override, not the profile's default model.
    expect(session.label).toBe('primary · Head-Override-Model');
  });

  it('falls back to the head profile model when no override is given', async () => {
    const cwd = cwdWithFailoverChain();
    const session = await createLlmSessionWithFailover('primary', CTX, {}, {
      cwd,
      sessionFactory: neverCalledFactory,
    });
    expect(session.label).toBe('primary · Head-Default-Model');
  });
});

// MNE-001-448 (#644 P8): a fallback is chosen by an error, not by the person
// who would accept NVIDIA's trial terms, so a failover walk never moves into
// the hosted endpoint, and the final error says why it stopped before it.
describe('a failover walk never enters NVIDIA\'s hosted trial', () => {
  const before = process.env.NVIDIA_API_KEY;
  afterEach(() => {
    if (before === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = before;
  });

  function cwdWithChain(failover: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-failover-trial-'));
    dirs.push(dir);
    // The project file below hides the user file, so no home is read.
    process.env.NVIDIA_API_KEY = 'clave-falsa-de-prueba';
    const link = (model: string) => ({ type: 'openai-compatible', model, base_url: 'https://example.test/v1' });
    fs.writeFileSync(path.join(dir, 'mnemosine.config.json'), JSON.stringify({
      providers: { primary: { ...link('Head'), failover }, backup: link('Backup') },
    }));
    return dir;
  }

  const unavailable = Object.assign(new Error('Service Unavailable'), { status: 503 });
  function factoryFailing(names: string[], tried: string[]) {
    return async (profile: ResolvedProfile): Promise<LlmSession> => {
      tried.push(profile.name);
      if (names.includes(profile.name)) throw unavailable;
      return { label: `${profile.name} · ${profile.model}`, runTurn: async () => 'ok', reset: () => {} };
    };
  }

  it('the walk goes past it to the next link', async () => {
    const tried: string[] = [];
    const session = await createLlmSessionWithFailover('primary', CTX, {}, {
      cwd: cwdWithChain(['nvidia', 'backup']), sessionFactory: factoryFailing(['primary'], tried),
      cooldowns: new CooldownRegistry(),
    });
    expect(await session.runTurn('hola')).toBe('ok');
    expect(tried).toEqual(['primary', 'backup']);
  });

  it('when the walk ends before it, AllProvidersFailedError says it was not tried and why', async () => {
    const tried: string[] = [];
    const session = await createLlmSessionWithFailover('primary', CTX, {}, {
      cwd: cwdWithChain(['nvidia']), sessionFactory: factoryFailing(['primary'], tried),
      cooldowns: new CooldownRegistry(),
    });
    const err = await session.runTurn('hola').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect((err as Error).message).toMatch(/primary \(server\).*not tried: nvidia .*hosted trial.*never a fallback/);
    expect(tried).toEqual(['primary']);
  });
});

// MNE-001-447 (#644 P7): a link with no credential here is skipped, not a
// reason to stop. The chain is the person's own, in a temporary home; only
// GEMINI_API_KEY is set, with an invented value, and no provider is called:
// the session factory stands in for each one.
describe('a failover walk skips a link with no credential', () => {
  const NO_CREDENTIAL =
    'Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set. Or for the "Authorization" header to be explicitly omitted';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function homeWithChain(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-failover-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-failover-cwd-'));
    dirs.push(home, cwd);
    fs.mkdirSync(path.join(home, '.mnemosine'));
    fs.writeFileSync(
      path.join(home, '.mnemosine', 'config.json'),
      JSON.stringify({
        providers: {
          anthropic: { type: 'anthropic', model: 'claude-opus-5', failover: ['openai', 'grok', 'gemini'] },
        },
      })
    );
    vi.stubEnv('HOME', home);
    vi.stubEnv('MNEMOSINE_PROVIDER', '');
    for (const variable of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY']) vi.stubEnv(variable, '');
    return cwd;
  }

  /** anthropic fails with the SDK's exact error on its first request; any other link that gets this far answers. */
  function factory(tried: string[]) {
    return async (profile: ResolvedProfile): Promise<LlmSession> => {
      tried.push(profile.name);
      return {
        label: `${profile.name} · ${profile.model}`,
        runTurn: async () => {
          if (profile.type === 'anthropic') throw new Error(NO_CREDENTIAL);
          return `answer from ${profile.name}`;
        },
        reset: () => {},
      };
    };
  }

  it('with only GEMINI_API_KEY, the first turn lands on gemini and trips no cooldown', async () => {
    const cwd = homeWithChain();
    vi.stubEnv('GEMINI_API_KEY', 'gemini-clave-inventada');
    const tried: string[] = [];
    const events: string[] = [];
    const cooldowns = new CooldownRegistry();
    const session = await createLlmSessionWithFailover('anthropic', CTX, {}, {
      cwd,
      sessionFactory: factory(tried),
      cooldowns,
      onFailover: (from, errorType, to) => events.push(`${from}:${errorType}:${to}`),
    });
    expect(await session.runTurn('hola')).toBe('answer from gemini');
    expect(session.label).toBe('gemini · gemini-3.8-flash');
    // openai and grok fail in resolveProfile, before any session exists.
    expect(tried).toEqual(['anthropic', 'gemini']);
    expect(events).toEqual(['anthropic:unconfigured:openai', 'openai:unconfigured:grok', 'grok:unconfigured:gemini']);
    for (const name of ['anthropic', 'openai', 'grok', 'gemini']) expect(cooldowns.isCooling(name)).toBe(false);
  });

  it('with no key at all, AllProvidersFailedError names every link as unconfigured', async () => {
    const cwd = homeWithChain();
    const session = await createLlmSessionWithFailover('anthropic', CTX, {}, {
      cwd,
      sessionFactory: factory([]),
      cooldowns: new CooldownRegistry(),
    });
    const err = await session.runTurn('hola').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect((err as AllProvidersFailedError).failures.map((f) => `${f.provider}:${f.category}`)).toEqual([
      'anthropic:unconfigured',
      'openai:unconfigured',
      'grok:unconfigured',
      'gemini:unconfigured',
    ]);
    expect((err as Error).message).toMatch(/anthropic \(unconfigured\), openai \(unconfigured\), grok \(unconfigured\), gemini \(unconfigured\)/);
  });

  it.each([404, 410])('a %i on the head still fails loudly, with no walk', async (status) => {
    const cwd = homeWithChain();
    vi.stubEnv('GEMINI_API_KEY', 'gemini-clave-inventada');
    const tried: string[] = [];
    const gone = Object.assign(new Error(`${status} model not found`), { status });
    const session = await createLlmSessionWithFailover('anthropic', CTX, {}, {
      cwd,
      sessionFactory: async (profile) => {
        tried.push(profile.name);
        return { label: profile.name, runTurn: async () => Promise.reject(gone), reset: () => {} };
      },
      cooldowns: new CooldownRegistry(),
    });
    expect(await session.runTurn('hola').catch((e: unknown) => e)).toBe(gone);
    expect(tried).toEqual(['anthropic']);
  });
});
