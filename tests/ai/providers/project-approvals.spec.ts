import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveProfile, listProfiles, loadConfigFile, approveProjectProfile, ProjectFileRefusalError,
  MissingProviderCredentialError,
} from '../../../src/ai/providers/config.js';
import { projectApprovalsPath } from '../../../src/ai/providers/project-approvals.js';
import { credentialState } from '../../../src/ai/providers/credential-state.js';

// MNE-001-452 (#645), part A. A temporary home and a temporary project folder;
// every key and command is invented, and no helper prints a real credential.

let home: string;
let project: string;
let marker: string;
const projectFile = () => path.join(project, 'mnemosine.config.json');
const userFile = () => path.join(home, '.mnemosine', 'config.json');

/** A helper that leaves a marker, so a test sees whether it ran. */
const helper = (token = 'tok-inventado-1') => `touch '${marker}'; printf '${token}'`;

function writeProject(profile: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(projectFile(), JSON.stringify({
    providers: { vault: { type: 'openai-compatible', model: 'm', base_url: 'https://v.example.test/v1', ...profile } },
    ...extra,
  }));
}

function writeUser(content: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(userFile()), { recursive: true });
  fs.writeFileSync(userFile(), JSON.stringify(content));
}

function refusal(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'm452-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'm452-project-'));
  marker = path.join(home, 'helper-ran');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('MNEMOSINE_PROVIDER', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

describe('a project file helper runs only after its person approves that exact command', () => {
  it('an unapproved helper does not run, and the error says how to approve it without printing the command', () => {
    writeProject({ api_key_cmd: helper() });
    const err = refusal(() => resolveProfile('vault', undefined, project));
    expect(err).toBeInstanceOf(ProjectFileRefusalError);
    expect(err).not.toBeInstanceOf(MissingProviderCredentialError);
    expect(err.message).toContain('providers.vault.api_key_cmd');
    expect(err.message).toContain('mnemosine providers approve vault');
    expect(err.message).not.toContain('touch');
    expect(err.message).not.toContain('tok-inventado');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('once approved it runs, and the store under the home holds no command (0600)', () => {
    writeProject({ api_key_cmd: helper() });
    const approved = approveProjectProfile('vault', project);
    expect(approved.approved).toEqual(['helper']);
    expect(resolveProfile('vault', undefined, project).apiKey).toBe('tok-inventado-1');
    expect(fs.existsSync(marker)).toBe(true);
    const store = fs.readFileSync(projectApprovalsPath(home), 'utf-8');
    expect(store).not.toContain('touch');
    expect(store).not.toContain('tok-inventado');
    expect(fs.statSync(projectApprovalsPath(home)).mode & 0o777).toBe(0o600);
  });

  it('a changed command asks again', () => {
    writeProject({ api_key_cmd: helper() });
    approveProjectProfile('vault', project);
    writeProject({ api_key_cmd: helper('tok-inventado-2') });
    expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
  });

  it('an approved helper whose base_url moves to another host asks again', () => {
    writeProject({ api_key_cmd: helper() });
    approveProjectProfile('vault', project);
    writeProject({ api_key_cmd: helper(), base_url: 'https://otro.example.test/v1' });
    expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('"project_helpers": "never" in the user file refuses even an approved helper', () => {
    writeProject({ api_key_cmd: helper() });
    approveProjectProfile('vault', project);
    writeUser({ project_helpers: 'never' });
    const err = refusal(() => resolveProfile('vault', undefined, project));
    expect(err).toBeInstanceOf(ProjectFileRefusalError);
    expect(err.message).toContain('"project_helpers" is "never"');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('the setting is read from the user file only: a project file that says "approved" changes nothing', () => {
    writeUser({ project_helpers: 'never' });
    writeProject({ api_key_cmd: helper() }, { project_helpers: 'approved' });
    approveProjectProfile('vault', project);
    expect(() => resolveProfile('vault', undefined, project)).toThrow(/"project_helpers" is "never"/);
  });

  it('a value other than the two is refused by the schema', () => {
    writeUser({ project_helpers: 'always' });
    expect(() => loadConfigFile(project)).toThrow(/project_helpers/);
  });

  it("the person's own helper runs with no approval", () => {
    writeUser({ providers: { vault: { type: 'openai-compatible', model: 'm', base_url: 'https://v.example.test/v1', api_key_cmd: helper() } } });
    expect(resolveProfile('vault', undefined, project).apiKey).toBe('tok-inventado-1');
  });

  it('a store that does not parse is never overwritten and fails closed with its path', () => {
    writeProject({ api_key_cmd: helper() });
    fs.mkdirSync(path.dirname(projectApprovalsPath(home)), { recursive: true });
    fs.writeFileSync(projectApprovalsPath(home), '{ roto');
    expect(() => resolveProfile('vault', undefined, project)).toThrow(projectApprovalsPath(home));
    expect(() => approveProjectProfile('vault', project)).toThrow(projectApprovalsPath(home));
    expect(fs.readFileSync(projectApprovalsPath(home), 'utf-8')).toBe('{ roto');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a built-in profile has nothing to approve', () => {
    expect(approveProjectProfile('openai', project).approved).toEqual([]);
  });

  it('readiness says unapproved and not ready, and never runs the helper', () => {
    writeProject({ api_key_cmd: helper() });
    const { profiles, source } = listProfiles(project);
    const state = credentialState(profiles.vault, { cwd: project, home, source, env: {} });
    expect(state.ready).toBe(false);
    expect(state.source.kind).toBe('unapproved');
    expect(state.label).toContain('not approved');
    approveProjectProfile('vault', project);
    expect(credentialState(profiles.vault, { cwd: project, home, source, env: {} }).ready).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('a credential written by hand into a project file is refused at load, naming the field only', () => {
  const KEY = 'sk-inventada0123456789abcdef';
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
    ['an Authorization header', { headers: { Authorization: 'Bearer inventado-token-123' } }, {}, 'providers.vault.headers.Authorization'],
    ['a key-named header, whatever its value', { headers: { 'X-Api-Key': 'INVENTADO' } }, {}, 'providers.vault.headers.X-Api-Key'],
    ['a key in a header value', { headers: { 'X-Note': `uso ${KEY}` } }, {}, 'providers.vault.headers.X-Note'],
    ['a literal key inside a helper command', { api_key_cmd: `op read x || echo ${KEY}` }, {}, 'providers.vault.api_key_cmd'],
    ['a model that is a key', { model: KEY }, {}, 'providers.vault.model'],
    ['a base_url that carries a key', { base_url: `https://v.example.test/v1?key=AIzaInventada0123456789abcd` }, {}, 'providers.vault.base_url'],
    ['a base_url with a password', { base_url: 'https://yo:inventada@v.example.test/v1' }, {}, 'providers.vault.base_url'],
    ['a key where the variable name goes', { api_key_env: KEY }, {}, 'providers.vault.api_key_env'],
    ['a key as a chosen model', {}, { models: { vault: KEY } }, 'models.vault'],
  ];

  it.each(cases)('%s', (_label, profile, extra, field) => {
    writeProject(profile, extra);
    const err = refusal(() => loadConfigFile(project));
    expect(err.message).toContain(field);
    expect(err.message).toContain('credential written by hand');
    expect(err.message).not.toContain('inventad');
    expect(err.message).not.toContain('INVENTADO');
    expect(fs.readdirSync(project).filter((f) => f.includes('.rejected-'))).toEqual([]);
  });

  it('a project file with no credential loads, attribution headers included', () => {
    writeProject({ api_key_env: 'VAULT_API_KEY', headers: { 'HTTP-Referer': 'https://example.test', 'X-Title': 'mnemosine' } });
    expect(loadConfigFile(project).config.providers?.vault.headers?.['X-Title']).toBe('mnemosine');
  });

  it('the same values in the user own file load: the rule is about a shared file', () => {
    writeUser({ providers: { vault: { type: 'openai-compatible', model: 'm', headers: { Authorization: 'Bearer inventado-token-123' } } } });
    expect(() => loadConfigFile(project)).not.toThrow();
  });
});

// Part B: the user's profiles beneath, the variable sent to a host, the folder's ./.env.

describe("the person's own profiles stay available beneath a project file", () => {
  it('a profile of the user file is listed, with its own origin, and a project profile of the same name wins', () => {
    writeUser({ providers: {
      mine: { type: 'openai-compatible', model: 'propio', base_url: 'https://mio.example.test/v1', api_key_cmd: helper() },
      vault: { type: 'openai-compatible', model: 'del-usuario', base_url: 'https://v.example.test/v1' },
    } });
    writeProject({ api_key_env: 'VAULT_API_KEY' });
    const { profiles, origins, source } = listProfiles(project);
    expect(source).toBe(projectFile());
    expect(profiles.mine.model).toBe('propio');
    expect(origins.mine).toBe(userFile());
    expect(profiles.vault.model).toBe('m');
    expect(origins.vault).toBe(projectFile());
    expect(origins.openai).toBeNull();
  });

  it("the user's helper beneath a project file runs with no approval", () => {
    writeUser({ providers: { mine: { type: 'openai-compatible', model: 'm', base_url: 'https://mio.example.test/v1', api_key_cmd: helper() } } });
    writeProject({ api_key_env: 'VAULT_API_KEY' });
    expect(resolveProfile('mine', undefined, project).apiKey).toBe('tok-inventado-1');
  });

  it('the user file is checked too: one that does not parse stops the folder, failing closed', () => {
    fs.mkdirSync(path.dirname(userFile()), { recursive: true });
    fs.writeFileSync(userFile(), '{ roto');
    writeProject({ api_key_env: 'VAULT_API_KEY' });
    expect(() => listProfiles(project)).toThrow(userFile());
  });
});

describe("a project profile sends a key only where it belongs, unless its person approves the pair", () => {
  it("an undocumented variable and host pair is refused before the key is read, naming both and not the value", () => {
    vi.stubEnv('OPENAI_API_KEY', 'valor-inventado-de-openai');
    writeProject({ api_key_env: 'OPENAI_API_KEY', base_url: 'https://otro.example.test/v1' });
    const err = refusal(() => resolveProfile('vault', undefined, project));
    expect(err).toBeInstanceOf(ProjectFileRefusalError);
    expect(err.message).toContain('OPENAI_API_KEY');
    expect(err.message).toContain('otro.example.test');
    expect(err.message).toContain('mnemosine providers approve vault');
    expect(err.message).not.toContain('valor-inventado');
  });

  it('approved once, the pair is sent; another host asks again', () => {
    vi.stubEnv('OPENAI_API_KEY', 'valor-inventado-de-openai');
    writeProject({ api_key_env: 'OPENAI_API_KEY', base_url: 'https://otro.example.test/v1' });
    expect(approveProjectProfile('vault', project).approved).toEqual(['pair']);
    expect(resolveProfile('vault', undefined, project).apiKey).toBe('valor-inventado-de-openai');
    writeProject({ api_key_env: 'OPENAI_API_KEY', base_url: 'https://tercero.example.test/v1' });
    expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
  });

  it("a provider's documented pair passes with no approval, and an unset variable sends nothing to refuse", () => {
    vi.stubEnv('OPENAI_API_KEY', 'valor-inventado-de-openai');
    writeProject({ api_key_env: 'OPENAI_API_KEY', base_url: 'https://api.openai.com/v1' });
    expect(resolveProfile('vault', undefined, project).apiKey).toBe('valor-inventado-de-openai');
    vi.stubEnv('OTRA_LLAVE', '');
    writeProject({ api_key_env: 'OTRA_LLAVE', base_url: 'http://localhost:9/v1', type: 'openai-compatible' });
    expect(() => resolveProfile('vault', undefined, project)).toThrow(MissingProviderCredentialError);
  });

  it("the person's own profile may pair any variable with any host", () => {
    vi.stubEnv('OPENAI_API_KEY', 'valor-inventado-de-openai');
    writeUser({ providers: { vault: { type: 'openai-compatible', model: 'm', base_url: 'https://otro.example.test/v1', api_key_env: 'OPENAI_API_KEY' } } });
    expect(resolveProfile('vault', undefined, project).apiKey).toBe('valor-inventado-de-openai');
  });

  it('readiness says unapproved for the pair, with the variable and host', () => {
    writeProject({ api_key_env: 'OPENAI_API_KEY', base_url: 'https://otro.example.test/v1' });
    const { profiles, origins } = listProfiles(project);
    const env = { OPENAI_API_KEY: 'valor-inventado-de-openai' };
    const state = credentialState(profiles.vault, { cwd: project, home, source: origins.vault, env });
    expect(state.ready).toBe(false);
    expect(state.source).toEqual({ kind: 'unapproved', file: projectFile(), never: false, variable: 'OPENAI_API_KEY', host: 'otro.example.test' });
    expect(state.label).not.toContain('valor-inventado');
  });
});

describe("readiness names the routing variables the folder's ./.env sets for everyone", () => {
  it('ANTHROPIC_BASE_URL and ANTHROPIC_CONFIG_DIR for an anthropic profile, OPENAI_BASE_URL for one with no base_url', () => {
    fs.writeFileSync(path.join(project, '.env'),
      'ANTHROPIC_BASE_URL=https://proxy.example.test\nANTHROPIC_CONFIG_DIR=/tmp/otro\nOPENAI_BASE_URL=https://proxy.example.test/v1\n');
    const anthropic = credentialState({ type: 'anthropic', model: 'm' }, { cwd: project, home, env: { ANTHROPIC_API_KEY: 'x' } });
    expect(anthropic.folderRouting).toEqual(['ANTHROPIC_BASE_URL', 'ANTHROPIC_CONFIG_DIR']);
    expect(anthropic.label).toContain('ANTHROPIC_BASE_URL, ANTHROPIC_CONFIG_DIR');
    expect(anthropic.label).toContain('serve everyone who runs mnemosine in that folder');
    const bare = credentialState({ type: 'openai-compatible', model: 'm', api_key_env: 'K' }, { cwd: project, home, env: { K: 'x' } });
    expect(bare.folderRouting).toEqual(['OPENAI_BASE_URL']);
    const pinned = credentialState({ type: 'openai-compatible', model: 'm', base_url: 'https://a.example.test/v1' }, { cwd: project, home, env: {} });
    expect(pinned.folderRouting).toEqual([]);
  });

  it('an empty value in ./.env is not reported, and no ./.env reports nothing', () => {
    fs.writeFileSync(path.join(project, '.env'), 'ANTHROPIC_BASE_URL=\n');
    expect(credentialState({ type: 'anthropic', model: 'm' }, { cwd: project, home, env: {} }).folderRouting).toEqual([]);
    fs.rmSync(path.join(project, '.env'));
    expect(credentialState({ type: 'anthropic', model: 'm' }, { cwd: project, home, env: {} }).folderRouting).toEqual([]);
  });
});
