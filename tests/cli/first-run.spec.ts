import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// detectSetupState must never touch a real pool in tests: every case injects
// its probes. The connection module is mocked anyway as a tripwire — if a
// default dependency leaks through, the mock throws loudly instead of dialing
// a database.
vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn().mockRejectedValue(new Error('unit test tried to reach the real database')),
}));

import { detectSetupState, type DetectDeps } from '../../src/cli/first-run.js';

const CWD = '/fake/project';

/** Base deps for a fully healthy system; individual tests break one leg. */
function healthyDeps(over: Partial<DetectDeps> = {}): DetectDeps {
  return {
    cwd: CWD,
    env: { DATABASE_URL: 'postgresql://localhost/accounting' },
    fileExists: (p: string) => p === path.join(CWD, '.env'),
    probeDb: vi.fn().mockResolvedValue(undefined),
    countActiveEntities: vi.fn().mockResolvedValue(2),
    resolveProvider: () => ({ name: 'anthropic' }),
    ...over,
  };
}

describe('detectSetupState — fresh', () => {
  it('is fresh when neither .env nor any config file exists', async () => {
    const probeDb = vi.fn();
    const state = await detectSetupState(
      healthyDeps({ fileExists: () => false, env: {}, probeDb })
    );
    expect(state.state).toBe('fresh');
    expect(state.reasons).toContain('no .env file (never configured)');
    // Cheap checks only: a fresh install must not probe the database.
    expect(probeDb).not.toHaveBeenCalled();
  });

  it('is fresh when config exists but DATABASE_URL is missing', async () => {
    const state = await detectSetupState(healthyDeps({ env: {} }));
    expect(state.state).toBe('fresh');
    expect(state.reasons.join(' ')).toContain('DATABASE_URL');
  });

  it('a config file alone (no .env) counts as configured', async () => {
    const state = await detectSetupState(
      healthyDeps({
        fileExists: (p: string) => p === path.join(CWD, 'mnemosine.config.json'),
      })
    );
    expect(state.state).toBe('ready');
  });
});

describe('detectSetupState — per-user .env', () => {
  it('a ~/.mnemosine/.env alone counts as configured', async () => {
    const state = await detectSetupState(
      healthyDeps({
        home: '/fake/home',
        fileExists: (p: string) => p === path.join('/fake/home', '.mnemosine', '.env'),
      })
    );
    expect(state.state).toBe('ready');
  });
});

describe('detectSetupState — broken', () => {
  it('reports the database unreachable when the probe rejects', async () => {
    const state = await detectSetupState(
      healthyDeps({ probeDb: vi.fn().mockRejectedValue(new Error('connection refused')) })
    );
    expect(state.state).toBe('broken');
    expect(state.reasons).toContain('database unreachable: connection refused');
    expect(state.entityCount).toBeUndefined();
  });

  it('reports no legal entities when the DB is up but empty', async () => {
    const state = await detectSetupState(
      healthyDeps({ countActiveEntities: vi.fn().mockResolvedValue(0) })
    );
    expect(state.state).toBe('broken');
    expect(state.reasons).toContain('no legal entities registered');
    expect(state.entityCount).toBe(0);
    expect(state.providerName).toBe('anthropic');
  });

  it('reports the provider when resolution throws, keeping entity facts', async () => {
    const state = await detectSetupState(
      healthyDeps({
        resolveProvider: () => {
          throw new Error('ANTHROPIC_API_KEY missing');
        },
      })
    );
    expect(state.state).toBe('broken');
    expect(state.reasons).toContain('AI provider not configured');
    expect(state.entityCount).toBe(2);
    expect(state.providerName).toBeUndefined();
  });

  it('accumulates independent reasons (empty DB + no provider)', async () => {
    const state = await detectSetupState(
      healthyDeps({
        countActiveEntities: vi.fn().mockResolvedValue(0),
        resolveProvider: () => {
          throw new Error('nope');
        },
      })
    );
    expect(state.state).toBe('broken');
    expect(state.reasons).toEqual(
      expect.arrayContaining(['no legal entities registered', 'AI provider not configured'])
    );
  });

  it('times out a hung probe instead of hanging the entry flow', async () => {
    const state = await detectSetupState(
      healthyDeps({
        timeoutMs: 20,
        probeDb: () => new Promise<void>(() => undefined), // never settles
      })
    );
    expect(state.state).toBe('broken');
    expect(state.reasons.join(' ')).toContain('timed out after 20ms');
  });
});

describe('detectSetupState — ready', () => {
  it('is ready with entityCount and providerName filled', async () => {
    const state = await detectSetupState(healthyDeps());
    expect(state).toEqual({
      state: 'ready',
      reasons: [],
      entityCount: 2,
      providerName: 'anthropic',
    });
  });

  it('accepts an async provider resolver', async () => {
    const state = await detectSetupState(
      healthyDeps({ resolveProvider: async () => ({ name: 'hermes' }) })
    );
    expect(state.providerName).toBe('hermes');
  });
});

describe('detectSetupState — never throws', () => {
  it('degrades to broken when the probe throws synchronously', async () => {
    const state = await detectSetupState(
      healthyDeps({
        probeDb: () => {
          throw new Error('sync explosion');
        },
      })
    );
    expect(state.state).toBe('broken');
    expect(state.reasons.join(' ')).toContain('sync explosion');
  });

  it('degrades to broken when even the filesystem check throws', async () => {
    const state = await detectSetupState(
      healthyDeps({
        fileExists: () => {
          throw new Error('EACCES');
        },
      })
    );
    expect(state.state).toBe('broken');
    expect(state.reasons.join(' ')).toContain('setup check failed');
  });

  it('degrades to broken when the entity count rejects', async () => {
    const state = await detectSetupState(
      healthyDeps({ countActiveEntities: vi.fn().mockRejectedValue(new Error('relation missing')) })
    );
    expect(state.state).toBe('broken');
    expect(state.reasons.join(' ')).toContain('database unreachable: relation missing');
  });
});

// MNE-001-444: when chat's startup fails, the diagnosis judges the provider
// with the readiness answer (credential-state), not resolveProfile: the helper
// does not run a second time, and the reason names the profile, its variable,
// where to get it and the alternative; the repair line adds
// `mnemosine init --section ai`. A temporary home and folder; invented values.
describe('detectSetupState — the provider, judged by the readiness answer', () => {
  let cwd: string;
  let home: string;
  let homedir: { mockRestore: () => void };
  const deps = (over: Partial<DetectDeps> = {}): DetectDeps =>
    healthyDeps({
      cwd,
      home,
      env: { DATABASE_URL: 'postgresql://localhost/accounting', HOME: home },
      fileExists: (p: string) => p === path.join(cwd, '.env'),
      resolveProvider: undefined,
      ...over,
    });
  const userConfig = (cfg: unknown) => {
    fs.mkdirSync(path.join(home, '.mnemosine'), { recursive: true });
    fs.writeFileSync(path.join(home, '.mnemosine', 'config.json'), JSON.stringify(cfg));
  };

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-cwd-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-home-'));
    homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('MNEMOSINE_PROVIDER', '');
  });
  afterEach(() => {
    homedir.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('anthropic with no credential: the reason names the profile, its variable, the link and the alternative', async () => {
    const state = await detectSetupState(deps());
    expect(state.state).toBe('broken');
    expect(state.reasons).toEqual([
      'Provider anthropic has no credential: set ANTHROPIC_API_KEY in your shell or ~/.mnemosine/.env ' +
        '(get it at https://platform.claude.com/settings/keys). Or sign in with `ant auth login`, or set ANTHROPIC_AUTH_TOKEN.',
    ]);
    expect(state.providerName).toBeUndefined();
  });

  it('signed in with ant auth login: ready, no key asked for', async () => {
    const dir = path.join(home, '.config', 'anthropic', 'configs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'default.json'), '{}');
    const state = await detectSetupState(deps());
    expect(state).toMatchObject({ state: 'ready', providerName: 'anthropic' });
  });

  it('a helper profile is ready, and its helper does not run a second time', async () => {
    const marker = path.join(cwd, 'helper-ran');
    userConfig({
      default_provider: 'vault',
      providers: {
        vault: { type: 'openai-compatible', model: 'vm', base_url: 'https://v.example.test/v1', api_key_cmd: `touch ${marker} && echo fake-token` },
      },
    });
    const state = await detectSetupState(deps());
    expect(state).toMatchObject({ state: 'ready', providerName: 'vault' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('judges the --provider profile, not the default', async () => {
    const state = await detectSetupState(deps({ provider: 'grok', env: { DATABASE_URL: 'postgresql://x/y', ANTHROPIC_API_KEY: 'fake' } }));
    expect(state.reasons).toEqual([
      'Provider grok has no credential: set XAI_API_KEY in your shell or ~/.mnemosine/.env (get it at https://console.x.ai). ' +
        'Or give the profile an api_key_cmd in ~/.mnemosine/config.json.',
    ]);
  });

  it('a --provider that names no profile is left to the startup error, which lists the names', async () => {
    expect(await detectSetupState(deps({ provider: 'ghost' }))).toMatchObject({ state: 'ready', providerName: 'ghost' });
  });

  it('a default that does not exist, or a config that does not load, keeps the fixed reason', async () => {
    userConfig({ default_provider: 'ghost' });
    expect((await detectSetupState(deps())).reasons).toEqual(['AI provider not configured']);
    fs.writeFileSync(path.join(cwd, 'mnemosine.config.json'), '{ not json');
    expect((await detectSetupState(deps())).reasons).toEqual(['AI provider not configured']);
  });
});
