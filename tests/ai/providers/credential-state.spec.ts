import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('an api_key_cmd in a project file is flagged as shared', () => {
    const project = path.join(cwd, 'mnemosine.config.json');
    const s = credentialState(remote({ api_key_cmd: 'echo x' }), { cwd, home, env: {}, source: project });
    expect(s.source).toEqual({ kind: 'helper', file: project, shared: true });
    expect(s.label).toMatch(/^api_key_cmd in .*mnemosine\.config\.json, a project file shared by everyone who runs mnemosine in that folder$/);
  });

  it('the variable wins over the helper, as resolveProfile does', () => {
    const s = credentialState(remote({ api_key_cmd: 'echo x' }), {
      cwd, home, env: { FAKE_PROVIDER_KEY: 'fake-value-2' }, source: path.join(cwd, 'mnemosine.config.json'),
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
    expect(r.states.vault.source).toEqual({ kind: 'helper', file: project, shared: true });
    // The built-ins are there too, with their own answer.
    expect(r.states.ollama.source).toEqual({ kind: 'none', local: true });
    expect(r.states.openai.source.kind).toBe('missing');
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
