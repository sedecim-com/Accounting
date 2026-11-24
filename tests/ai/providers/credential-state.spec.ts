import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  credentialState,
  isLoopbackUrl,
  KEY_URLS,
  providerReadiness,
} from '../../../src/ai/providers/credential-state.js';
import type { ProviderProfile } from '../../../src/ai/providers/types.js';
import { approvalKey, recordApprovals } from '../../../src/ai/providers/project-approvals.js';

// MNE-001-443: one answer to «is this provider ready?». Every value here is
// invented; no helper is ever run, so a helper that would leave a marker file
// proves it by the file's absence.

let cwd: string;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-cwd-'));
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const remote = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  type: 'openai-compatible',
  model: 'm',
  base_url: 'https://llm.example.test/v1',
  api_key_env: 'FAKE_PROVIDER_KEY',
  ...over,
});

describe('credentialState — the five answers', () => {
  it('the variable is set', () => {
    const s = credentialState(remote(), { cwd, home, env: { FAKE_PROVIDER_KEY: 'fake-value-1' } });
    expect(s.source).toEqual({ kind: 'env', variable: 'FAKE_PROVIDER_KEY' });
    expect(s.ready).toBe(true);
    expect(s.label).toBe('FAKE_PROVIDER_KEY set');
    expect(s.label).not.toContain('fake-value-1');
  });

  it('an empty variable counts as unset, as resolveProfile reads it', () => {
    const s = credentialState(remote(), { cwd, home, env: { FAKE_PROVIDER_KEY: '' } });
    expect(s.source.kind).toBe('missing');
    expect(s.ready).toBe(false);
  });

  it('missing: names the variable and where to get it', () => {
    const s = credentialState(remote({ api_key_env: 'OPENAI_API_KEY' }), { cwd, home, env: {} });
    expect(s.source).toEqual({ kind: 'missing', variable: 'OPENAI_API_KEY', where: KEY_URLS.OPENAI_API_KEY });
    expect(s.label).toBe(`OPENAI_API_KEY missing (get it at ${KEY_URLS.OPENAI_API_KEY})`);
  });

  it('missing with an unknown variable: no link is invented', () => {
    const s = credentialState(remote(), { cwd, home, env: {} });
    expect(s.label).toBe('FAKE_PROVIDER_KEY missing');
  });

  it('an api_key_cmd in the user file: named with its file, never run, its command never printed', () => {
    const marker = path.join(cwd, 'helper-ran');
    const cmd = `touch ${marker} && echo fake-token-from-helper`;
    const userFile = path.join(home, '.mnemosine', 'config.json');
    const s = credentialState(remote({ api_key_cmd: cmd }), { cwd, home, env: {}, source: userFile });
    expect(s.source).toEqual({ kind: 'helper', file: userFile, shared: false });
    expect(s.ready).toBe(true);
    expect(s.label).toBe('api_key_cmd in ~/.mnemosine/config.json');
    expect(s.label).not.toContain('touch');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('an api_key_cmd in a project file is unapproved until its person approves it (MNE-001-452)', () => {
    const project = path.join(cwd, 'mnemosine.config.json');
    const s = credentialState(remote({ api_key_cmd: 'echo x' }), { cwd, home, env: {}, source: project });
    expect(s.source).toEqual({ kind: 'unapproved', file: project, never: false });
    expect(s.ready).toBe(false);
  });

  it('an approved api_key_cmd in a project file is flagged as shared', () => {
    const project = path.join(cwd, 'mnemosine.config.json');
    recordApprovals([{ key: approvalKey('helper', project, 'echo x', 'https://llm.example.test'), kind: 'helper', file: project }], home);
    const s = credentialState(remote({ api_key_cmd: 'echo x' }), { cwd, home, env: {}, source: project });
    expect(s.source).toEqual({ kind: 'helper', file: project, shared: true });
    expect(s.label).toMatch(/^api_key_cmd in .*mnemosine\.config\.json, a project file shared by everyone who runs mnemosine in that folder$/);
  });

  it('the variable wins over the helper, as resolveProfile does', () => {
    const s = credentialState(remote({ api_key_cmd: 'echo x' }), {
      cwd, home, env: { FAKE_PROVIDER_KEY: 'fake-value-2' }, source: path.join(home, '.mnemosine', 'config.json'),
    });
    expect(s.source.kind).toBe('env');
  });

  it('a helper with no variable named still counts', () => {
    const s = credentialState(remote({ api_key_env: undefined, api_key_cmd: 'echo x' }), {
      cwd, home, env: {}, source: path.join(home, '.mnemosine', 'config.json'),
    });
    expect(s.source.kind).toBe('helper');
  });

  it('none needed: «local» only for a loopback base_url', () => {
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:8642/v1', 'http://[::1]:9/v1', 'http://127.1.2.3/v1']) {
      const s = credentialState(remote({ base_url: url, api_key_env: undefined }), { cwd, home, env: {} });
      expect(s.source, url).toEqual({ kind: 'none', local: true });
      expect(s.label).toBe('local, no credential');
      expect(s.ready).toBe(true);
    }
  });

  it('a remote endpoint with no key says it has no credential, not that it is local', () => {
    // A self-hosted NIM on another host, say.
    const s = credentialState(remote({ base_url: 'http://x/v1', api_key_env: undefined }), { cwd, home, env: {} });
    expect(s.source).toEqual({ kind: 'none', local: false });
    expect(s.label).toBe('no credential configured');
    expect(s.label).not.toMatch(/local/);
  });

  it('a profile with no base_url is not local (the SDK default is a remote host)', () => {
    const s = credentialState(remote({ base_url: undefined, api_key_env: undefined }), { cwd, home, env: {} });
    expect(s.source).toEqual({ kind: 'none', local: false });
  });
});

describe('credentialState — an installation secret is not a provider credential (MNE-001-445)', () => {
  it('names the variable, is not ready, and wins over a value and a helper', () => {
    const s = credentialState(remote({ api_key_env: 'ENCRYPTION_KEY', api_key_cmd: 'echo fake-helper' }), {
      cwd, home, env: { ENCRYPTION_KEY: 'fake-installation-secret' },
    });
    expect(s.source).toEqual({ kind: 'refused', variable: 'ENCRYPTION_KEY' });
    expect(s.ready).toBe(false);
    expect(s.label).toBe('ENCRYPTION_KEY is not a provider credential');
    expect(JSON.stringify(s)).not.toMatch(/fake-installation-secret|fake-helper/);
  });

  it('even when ./.env defines it, nothing more is said about it', () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'DATABASE_URL=postgres://fake\n');
    const s = credentialState(remote({ api_key_env: 'DATABASE_URL' }), { cwd, home, env: {} });
    expect(s.label).toBe('DATABASE_URL is not a provider credential');
    expect(s.folderEnv).toBeNull();
  });
});

describe('credentialState — the folder\'s ./.env', () => {
  it('warns when ./.env defines the variable: that key serves everyone who runs mnemosine there', () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'OTHER=1\nFAKE_PROVIDER_KEY=fake-folder-key\n');
    const s = credentialState(remote(), { cwd, home, env: { FAKE_PROVIDER_KEY: 'fake-folder-key' } });
    expect(s.folderEnv).toBe('key');
    expect(s.label).toBe(
      `FAKE_PROVIDER_KEY set; ${path.join(cwd, '.env')} defines it, so that key serves everyone who runs mnemosine in that folder`
    );
    expect(s.label).not.toContain('fake-folder-key');
  });

  it('an empty definition in ./.env is named: it hides ~/.mnemosine/.env', () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'FAKE_PROVIDER_KEY=\n');
    const s = credentialState(remote(), { cwd, home, env: { FAKE_PROVIDER_KEY: '' } });
    expect(s.source.kind).toBe('missing');
    expect(s.folderEnv).toBe('empty');
    expect(s.label).toBe(
      `FAKE_PROVIDER_KEY missing; the empty FAKE_PROVIDER_KEY= in ${path.join(cwd, '.env')} hides ~/.mnemosine/.env`
    );
  });

  it('no ./.env, or one without the variable: nothing to say', () => {
    expect(credentialState(remote(), { cwd, home, env: {} }).folderEnv).toBeNull();
    fs.writeFileSync(path.join(cwd, '.env'), 'OTHER=1\n');
    expect(credentialState(remote(), { cwd, home, env: {} }).folderEnv).toBeNull();
  });
});

describe('providerReadiness — every profile of the config that wins', () => {
  it('reads the project file and names it for a helper', () => {
    const project = path.join(cwd, 'mnemosine.config.json');
    fs.writeFileSync(project, JSON.stringify({
      default_provider: 'vault',
      providers: { vault: { type: 'openai-compatible', model: 'm', base_url: 'https://v.example.test/v1', api_key_cmd: 'echo x' } },
    }));
    const r = providerReadiness({ cwd, home, env: {} });
    expect(r.defaultName).toBe('vault');
    expect(r.source).toBe(project);
    expect(r.states.vault.source).toEqual({ kind: 'unapproved', file: project, never: false });
    // The built-ins are there too, with their own answer.
    expect(r.states.ollama.source).toEqual({ kind: 'none', local: true });
    expect(r.states.openai.source.kind).toBe('missing');
  });
});

// MNE-001-444: the sources the installed @anthropic-ai/sdk (1.8.0) reads
// when the profile's own variable and helper give nothing, in its order. Every
// case runs over a temporary HOME: the config root is built there, and the
// SDK's own variables are passed in `env`, never read from this machine.
describe('credentialState — the Anthropic SDK\'s own sources', () => {
  const anthropic = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
    type: 'anthropic',
    model: 'm',
    api_key_env: 'ANTHROPIC_API_KEY',
    ...over,
  });
  const configDir = () => path.join(home, '.config', 'anthropic');
  const signIn = (root: string, profile = 'default') => {
    fs.mkdirSync(path.join(root, 'configs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'configs', `${profile}.json`), '{"authentication":{"type":"user_oauth"}}');
  };
  const federation = { ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_fake', ANTHROPIC_ORGANIZATION_ID: 'org-fake' };

  it('nothing at all: missing, with the profile variable and the page Anthropic names', () => {
    const s = credentialState(anthropic(), { cwd, home, env: { HOME: home } });
    expect(s.source).toEqual({ kind: 'missing', variable: 'ANTHROPIC_API_KEY', where: 'https://platform.claude.com/settings/keys' });
    expect(s.ready).toBe(false);
  });

  it('ANTHROPIC_API_KEY counts for a profile whose api_key_env names another variable', () => {
    const s = credentialState(anthropic({ api_key_env: 'MY_CLAUDE_KEY' }), {
      cwd, home, env: { HOME: home, ANTHROPIC_API_KEY: 'fake-sdk-key' },
    });
    expect(s.source).toEqual({ kind: 'anthropic', sdk: { via: 'api_key' } });
    expect(s.ready).toBe(true);
    expect(s.label).toBe('ANTHROPIC_API_KEY set, which the Anthropic SDK reads');
    expect(JSON.stringify(s)).not.toContain('fake-sdk-key');
  });

  it('without that variable, the profile variable is what is missing, with Anthropic\'s link', () => {
    const s = credentialState(anthropic({ api_key_env: 'MY_CLAUDE_KEY' }), { cwd, home, env: { HOME: home } });
    expect(s.source).toEqual({ kind: 'missing', variable: 'MY_CLAUDE_KEY', where: KEY_URLS.ANTHROPIC_API_KEY });
  });

  it('an anthropic profile with no api_key_env reads ANTHROPIC_API_KEY, as the SDK does', () => {
    const s = credentialState(anthropic({ api_key_env: undefined }), { cwd, home, env: { HOME: home, ANTHROPIC_API_KEY: 'fake' } });
    expect(s.source).toEqual({ kind: 'env', variable: 'ANTHROPIC_API_KEY' });
    const none = credentialState(anthropic({ api_key_env: undefined }), { cwd, home, env: { HOME: home } });
    expect(none.source.kind).toBe('missing');
  });

  it('ANTHROPIC_AUTH_TOKEN', () => {
    const s = credentialState(anthropic(), { cwd, home, env: { HOME: home, ANTHROPIC_AUTH_TOKEN: 'fake-bearer' } });
    expect(s.source).toEqual({ kind: 'anthropic', sdk: { via: 'auth_token' } });
    expect(s.label).toBe('ANTHROPIC_AUTH_TOKEN set, a bearer token the Anthropic SDK sends');
    expect(s.label).not.toContain('fake-bearer');
  });

  it('an x-api-key or Authorization line in ANTHROPIC_CUSTOM_HEADERS, by presence, never printed', () => {
    const xKey = credentialState(anthropic(), {
      cwd, home, env: { HOME: home, ANTHROPIC_CUSTOM_HEADERS: 'X-Trace: 1\nX-Api-Key: fake-header-key' },
    });
    expect(xKey.source).toEqual({ kind: 'anthropic', sdk: { via: 'custom_header', header: 'x-api-key' } });
    expect(xKey.label).toBe('an x-api-key line in ANTHROPIC_CUSTOM_HEADERS');
    const bearer = credentialState(anthropic(), {
      cwd, home, env: { HOME: home, ANTHROPIC_CUSTOM_HEADERS: 'authorization: Bearer fake-header-token' },
    });
    expect(bearer.source).toEqual({ kind: 'anthropic', sdk: { via: 'custom_header', header: 'Authorization' } });
    expect(JSON.stringify([xKey, bearer])).not.toMatch(/fake-header/);
  });

  it('a custom header that is not an auth header, or one with no value, does not count', () => {
    for (const lines of ['X-Trace: 1', 'x-api-key:', 'x-api-key fake-no-colon', '   ']) {
      const s = credentialState(anthropic(), { cwd, home, env: { HOME: home, ANTHROPIC_CUSTOM_HEADERS: lines } });
      expect(s.source.kind, lines).toBe('missing');
    }
  });

  it('a signed-in profile under ~/.config/anthropic; credentials/<profile>.json is never opened', () => {
    signIn(configDir());
    // A directory where the credentials file would be: opening it would throw.
    fs.mkdirSync(path.join(configDir(), 'credentials', 'default.json'), { recursive: true });
    const open = vi.spyOn(fs, 'openSync');
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      const s = credentialState(anthropic(), { cwd, home, env: { HOME: home } });
      expect(s.source).toEqual({
        kind: 'anthropic',
        sdk: { via: 'profile', profile: 'default', file: path.join(configDir(), 'configs', 'default.json') },
      });
      expect(s.ready).toBe(true);
      expect(s.label).toBe('signed in: Anthropic profile default in ~/.config/anthropic/configs/default.json');
      const touched = [...open.mock.calls, ...read.mock.calls].map((c) => String(c[0]));
      expect(touched.filter((f) => f.includes(`${path.sep}credentials${path.sep}`))).toEqual([]);
      expect(touched.filter((f) => f.includes(`${path.sep}configs${path.sep}`))).toEqual([]);
    } finally {
      open.mockRestore();
      read.mockRestore();
    }
  });

  it('the config root is ANTHROPIC_CONFIG_DIR first, then $XDG_CONFIG_HOME/anthropic', () => {
    const custom = path.join(home, 'elsewhere');
    signIn(custom);
    const viaDir = credentialState(anthropic(), { cwd, home, env: { HOME: home, ANTHROPIC_CONFIG_DIR: custom } });
    expect(viaDir.source).toMatchObject({ sdk: { via: 'profile', file: path.join(custom, 'configs', 'default.json') } });

    const xdg = path.join(home, 'xdg');
    signIn(path.join(xdg, 'anthropic'));
    const viaXdg = credentialState(anthropic(), { cwd, home, env: { HOME: home, XDG_CONFIG_HOME: xdg } });
    expect(viaXdg.source).toMatchObject({ sdk: { via: 'profile', file: path.join(xdg, 'anthropic', 'configs', 'default.json') } });

    // With XDG_CONFIG_HOME set, ~/.config/anthropic is not looked at.
    signIn(configDir(), 'other');
    const notHome = credentialState(anthropic(), {
      cwd, home, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, 'empty-xdg'), ANTHROPIC_PROFILE: 'other' },
    });
    expect(notHome.source.kind).toBe('missing');
  });

  it('the profile comes from ANTHROPIC_PROFILE, else from active_config, else default', () => {
    signIn(configDir(), 'work');
    const fromEnv = credentialState(anthropic(), { cwd, home, env: { HOME: home, ANTHROPIC_PROFILE: 'work' } });
    expect(fromEnv.source).toMatchObject({ sdk: { via: 'profile', profile: 'work' } });

    fs.writeFileSync(path.join(configDir(), 'active_config'), 'work\n');
    const fromFile = credentialState(anthropic(), { cwd, home, env: { HOME: home } });
    expect(fromFile.source).toMatchObject({ sdk: { via: 'profile', profile: 'work' } });

    // ANTHROPIC_PROFILE wins over active_config, and a profile with no file is no source.
    const ghost = credentialState(anthropic(), { cwd, home, env: { HOME: home, ANTHROPIC_PROFILE: 'ghost' } });
    expect(ghost.source.kind).toBe('missing');
  });

  it('a profile name the SDK refuses is no source', () => {
    signIn(configDir());
    for (const name of ['..', 'a/b', 'bad name']) {
      const s = credentialState(anthropic(), { cwd, home, env: { HOME: home, ANTHROPIC_PROFILE: name } });
      expect(s.source.kind, name).toBe('missing');
    }
  });

  it('a Windows root: APPDATA/Anthropic, else USERPROFILE/AppData/Roaming/Anthropic, and never HOME', () => {
    const appData = path.join(home, 'AppData-Roaming');
    signIn(path.join(appData, 'Anthropic'));
    const viaAppData = credentialState(anthropic(), { cwd, home, platform: 'win32', env: { APPDATA: appData } });
    expect(viaAppData.source).toMatchObject({ sdk: { via: 'profile', file: path.join(appData, 'Anthropic', 'configs', 'default.json') } });

    signIn(path.join(home, 'AppData', 'Roaming', 'Anthropic'));
    const viaProfile = credentialState(anthropic(), { cwd, home, platform: 'win32', env: { USERPROFILE: home } });
    expect(viaProfile.source).toMatchObject({ sdk: { via: 'profile' } });

    signIn(configDir());
    const noRoot = credentialState(anthropic(), { cwd, home, platform: 'win32', env: { HOME: home } });
    expect(noRoot.source.kind).toBe('missing');
  });

  it('federation: its three inputs with a config root', () => {
    for (const token of [{ ANTHROPIC_IDENTITY_TOKEN: 'fake-jwt' }, { ANTHROPIC_IDENTITY_TOKEN_FILE: path.join(home, 'token') }]) {
      const s = credentialState(anthropic(), { cwd, home, env: { HOME: home, ...federation, ...token } });
      expect(s.source).toEqual({ kind: 'anthropic', sdk: { via: 'federation' } });
      expect(s.label).toBe(
        'workload identity federation (ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID and an identity token)'
      );
      expect(s.label).not.toContain('fake-jwt');
    }
  });

  it('federation with only the rule id, with two of its three inputs, or with no config root, is missing', () => {
    const cases: NodeJS.ProcessEnv[] = [
      { HOME: home, ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_fake' },
      { HOME: home, ...federation },
      { HOME: home, ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_fake', ANTHROPIC_IDENTITY_TOKEN: 'fake-jwt' },
      // The three, but neither XDG_CONFIG_HOME nor HOME: the SDK resolves no config at all.
      { ...federation, ANTHROPIC_IDENTITY_TOKEN: 'fake-jwt' },
    ];
    for (const env of cases) {
      const s = credentialState(anthropic(), { cwd, home, env });
      expect(s.source.kind, JSON.stringify(Object.keys(env))).toBe('missing');
    }
  });

  it('the SDK order: the profile variable, then its helper, then the SDK\'s own sources', () => {
    signIn(configDir());
    const all = { HOME: home, ANTHROPIC_AUTH_TOKEN: 'fake', ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: fake' };
    expect(credentialState(anthropic(), { cwd, home, env: { ...all, ANTHROPIC_API_KEY: 'fake' } }).source.kind).toBe('env');
    expect(credentialState(anthropic({ api_key_cmd: 'echo x' }), { cwd, home, env: all }).source.kind).toBe('helper');
    expect(credentialState(anthropic(), { cwd, home, env: all }).source).toMatchObject({ sdk: { via: 'auth_token' } });
    const { ANTHROPIC_AUTH_TOKEN: _t, ...noToken } = all;
    expect(credentialState(anthropic(), { cwd, home, env: noToken }).source).toMatchObject({ sdk: { via: 'custom_header' } });
    // SDK 1.x (core/credentials.js:108-137): federation from the environment comes
    // before the active profile, unless ANTHROPIC_PROFILE names one.
    expect(credentialState(anthropic(), { cwd, home, env: { HOME: home, ...federation, ANTHROPIC_IDENTITY_TOKEN: 'fake' } }).source)
      .toMatchObject({ sdk: { via: 'federation' } });
    expect(
      credentialState(anthropic(), {
        cwd, home, env: { HOME: home, ...federation, ANTHROPIC_IDENTITY_TOKEN: 'fake', ANTHROPIC_PROFILE: 'default' },
      }).source
    ).toMatchObject({ sdk: { via: 'profile', profile: 'default' } });
  });

  it('ANTHROPIC_PROFILE naming a profile with no file is no source, even with federation set (the SDK throws)', () => {
    const s = credentialState(anthropic(), {
      cwd, home, env: { HOME: home, ...federation, ANTHROPIC_IDENTITY_TOKEN: 'fake', ANTHROPIC_PROFILE: 'ghost' },
    });
    expect(s.source.kind).toBe('missing');
  });

  it('an empty or blank SDK variable counts as unset, as the SDK reads it', () => {
    const s = credentialState(anthropic({ api_key_env: 'MY_CLAUDE_KEY' }), {
      cwd, home, env: { HOME: home, ANTHROPIC_API_KEY: '  ', ANTHROPIC_AUTH_TOKEN: '' },
    });
    expect(s.source.kind).toBe('missing');
  });

  it('an openai-compatible profile never reads the Anthropic sources', () => {
    signIn(configDir());
    const s = credentialState(remote(), { cwd, home, env: { HOME: home, ANTHROPIC_AUTH_TOKEN: 'fake' } });
    expect(s.source.kind).toBe('missing');
  });
});

describe('isLoopbackUrl', () => {
  it('only loopback hosts', () => {
    expect(isLoopbackUrl('http://localhost:1/v1')).toBe(true);
    expect(isLoopbackUrl('http://LOCALHOST/v1')).toBe(true);
    expect(isLoopbackUrl('http://localhost.example.test/v1')).toBe(false);
    expect(isLoopbackUrl('http://10.0.0.5/v1')).toBe(false);
    expect(isLoopbackUrl('https://api.openai.com/v1')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });
});
