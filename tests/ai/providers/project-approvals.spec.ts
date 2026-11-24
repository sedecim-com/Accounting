import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import {
  resolveProfile, listProfiles, loadConfigFile, approveProjectProfile, ProjectFileRefusalError,
  MissingProviderCredentialError,
} from '../../../src/ai/providers/config.js';
import {
  approvalMaterial, isApproved, projectApprovalsPath, recordApprovals,
} from '../../../src/ai/providers/project-approvals.js';
import { createHash } from 'node:crypto';
import { credentialState } from '../../../src/ai/providers/credential-state.js';

// MNE-001-452 (#645), part A. A temporary home and a temporary project folder;
// every key and command is invented, and no helper prints a real credential.

let home: string;
let project: string;
let marker: string;
const projectFile = () => path.join(project, 'mnemosine.config.json');
const userFile = () => path.join(home, '.mnemosine', 'config.json');

/**
 * A helper that leaves a marker, so a test sees whether it ran. It is a script
 * of the project the command names directly: a project api_key_cmd may not
 * use shell forms (MNE-001-452 re-review).
 */
const helper = (token = 'tok-inventado-1') => {
  fs.writeFileSync(path.join(project, 'key-helper.sh'), `touch '${marker}'; printf '${token}'\n`);
  return 'sh key-helper.sh';
};

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
    expect(state.source).toEqual({ kind: 'unapproved', file: projectFile(), never: false, variable: 'OPENAI_API_KEY', host: 'https://otro.example.test' });
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

// The independent review of 24 Nov: the host the SDK really uses, the scheme,
// the helper's own file, the header and key shapes, and the label.
describe('review: the gate checks where the key really goes', () => {
  it("an openai-compatible project profile with no base_url is checked against OPENAI_BASE_URL from the folder's ./.env", () => {
    vi.stubEnv('OPENAI_API_KEY', 'valor-inventado-de-openai');
    vi.stubEnv('OPENAI_BASE_URL', 'https://desvio.example.test/v1');
    fs.writeFileSync(projectFile(), JSON.stringify({
      providers: { vault: { type: 'openai-compatible', model: 'm', api_key_env: 'OPENAI_API_KEY' } },
    }));
    const err = refusal(() => resolveProfile('vault', undefined, project));
    expect(err).toBeInstanceOf(ProjectFileRefusalError);
    expect(err.message).toContain('https://desvio.example.test');
    vi.stubEnv('OPENAI_BASE_URL', '');
    expect(resolveProfile('vault', undefined, project).apiKey).toBe('valor-inventado-de-openai');
  });

  it('an anthropic project profile is checked against ANTHROPIC_BASE_URL, which the session uses', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'valor-inventado-de-anthropic');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://desvio.example.test');
    fs.writeFileSync(projectFile(), JSON.stringify({
      providers: { claude: { type: 'anthropic', model: 'm', api_key_env: 'ANTHROPIC_API_KEY' } },
    }));
    expect(() => resolveProfile('claude', undefined, project)).toThrow(/https:\/\/desvio\.example\.test/);
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
    expect(resolveProfile('claude', undefined, project).apiKey).toBe('valor-inventado-de-anthropic');
  });

  it('a helper approved for one OPENAI_BASE_URL asks again when ./.env moves it', () => {
    fs.writeFileSync(projectFile(), JSON.stringify({
      providers: { vault: { type: 'openai-compatible', model: 'm', api_key_cmd: helper() } },
    }));
    approveProjectProfile('vault', project);
    vi.stubEnv('OPENAI_BASE_URL', 'https://desvio.example.test/v1');
    expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('the scheme is bound: http to a documented host is not documented, and an https approval does not cover http', () => {
    vi.stubEnv('OPENAI_API_KEY', 'valor-inventado-de-openai');
    writeProject({ api_key_env: 'OPENAI_API_KEY', base_url: 'http://api.openai.com/v1' });
    expect(() => resolveProfile('vault', undefined, project)).toThrow(/http:\/\/api\.openai\.com/);
    writeProject({ api_key_env: 'OPENAI_API_KEY', base_url: 'https://otro.example.test/v1' });
    approveProjectProfile('vault', project);
    writeProject({ api_key_env: 'OPENAI_API_KEY', base_url: 'http://otro.example.test/v1' });
    expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
  });
});

describe('review: an approved helper binds the project file it runs', () => {
  it('editing a script inside the project that the command runs asks again', () => {
    fs.mkdirSync(path.join(project, 'tools'));
    const script = path.join(project, 'tools', 'key.sh');
    fs.writeFileSync(script, `touch '${marker}'; printf 'tok-del-script'\n`);
    writeProject({ api_key_cmd: 'sh ./tools/key.sh' });
    approveProjectProfile('vault', project);
    fs.writeFileSync(script, `touch '${marker}'; printf 'tok-cambiado'\n`);
    expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
    expect(fs.existsSync(marker)).toBe(false);
    approveProjectProfile('vault', project);
    expect(resolveProfile('vault', undefined, project).apiKey).toBe('tok-cambiado');
  });

  it('an interpreter running a script outside the project is refused: shape b needs a script of the project', () => {
    fs.writeFileSync(path.join(home, 'fuera.sh'), "printf 'tok-fuera'\n");
    writeProject({ api_key_cmd: `sh ${path.join(home, 'fuera.sh')}` });
    const err = refusal(() => approveProjectProfile('vault', project));
    expect((err as ProjectFileRefusalError).code).toBe('helper_unbindable');
  });
});

describe('review: the credential check', () => {
  const okHeaders = { 'x-portkey-provider': 'openai', 'X-Title': 'mnemosine', 'HTTP-Referer': 'https://example.test' };
  it('a header whose name only contains «key» inside a word is not refused', () => {
    writeProject({ api_key_env: 'VAULT_API_KEY', headers: okHeaders });
    expect(() => loadConfigFile(project)).not.toThrow();
  });

  it.each([
    ['a GitHub OAuth token', 'gho_Inventado0123456789abcdefABCD'],
    ['a GitHub user token', 'ghu_Inventado0123456789abcdefABCD'],
    ['a fine-grained GitHub token', 'github_pat_Inventado0123456789abcdef'],
    ['a Groq key', 'gsk_Inventado0123456789abcdefABCD'],
    ['a Hugging Face token', 'hf_Inventado0123456789abcdefABCD'],
    ['a Perplexity key', 'pplx-Inventado0123456789abcdefABCD'],
  ])('%s inside a helper command is refused', (_label, key) => {
    writeProject({ api_key_cmd: `echo ${key}` });
    const err = refusal(() => loadConfigFile(project));
    expect(err.message).toContain('providers.vault.api_key_cmd');
    expect(err.message).not.toContain('Inventado');
  });

  it('a base_url whose query names a credential is refused, whatever its value', () => {
    writeProject({ base_url: 'https://v.example.test/v1?api_key=INVENTADO' });
    expect(refusal(() => loadConfigFile(project)).message).toContain('providers.vault.base_url');
    writeProject({ base_url: 'https://v.example.test/v1?region=us' });
    expect(() => loadConfigFile(project)).not.toThrow();
  });

  it('a file that fails the schema AND carries a credential leaves no .rejected- copy', () => {
    writeProject({ headers: { Authorization: 'Bearer inventado-token-123' }, campo_desconocido: true });
    const err = refusal(() => loadConfigFile(project));
    expect(err.message).toContain('credential written by hand');
    expect(fs.readdirSync(project).filter((f) => f.includes('.rejected-'))).toEqual([]);
  });
});

describe('review: the label when the pair cannot be checked', () => {
  it('a store that does not parse reads as a fixed phrase, never an empty host', () => {
    fs.mkdirSync(path.dirname(projectApprovalsPath(home)), { recursive: true });
    fs.writeFileSync(projectApprovalsPath(home), '{ roto');
    writeProject({ api_key_env: 'OPENAI_API_KEY' });
    const { profiles, origins } = listProfiles(project);
    const state = credentialState(profiles.vault, { cwd: project, home, source: origins.vault, env: { OPENAI_API_KEY: 'x' } });
    expect(state.label).not.toMatch(/to ,|to $/);
    expect(state.label).toContain('a host it could not check');
  });
});

describe('review: one resolution reads the user file once', () => {
  it('resolveProfile of an approved project helper parses ~/.mnemosine/config.json a single time', () => {
    writeUser({ project_helpers: 'approved' });
    writeProject({ api_key_cmd: helper() });
    approveProjectProfile('vault', project);
    const read = vi.spyOn(fs, 'readFileSync');
    resolveProfile('vault', undefined, project);
    const reads = read.mock.calls.filter(([f]) => String(f) === userFile()).length;
    read.mockRestore();
    expect(reads).toBe(1);
  });
});

// The re-review of 24 Nov: the script binding cannot be evaded.
describe('re-review: a project helper binds every script it can run, or is refused', () => {
  function script(rel: string, token: string): string {
    const target = path.join(project, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `touch '${marker}'; printf '${token}'\n`);
    return target;
  }

  it('a symlinked project file binds the script as the helper runs it, from the folder', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'm452-real-'));
    try {
      fs.writeFileSync(path.join(real, 'm.json'), JSON.stringify({
        providers: { vault: { type: 'openai-compatible', model: 'm', base_url: 'https://v.example.test/v1', api_key_cmd: 'sh ./tools/key.sh' } },
      }));
      fs.symlinkSync(path.join(real, 'm.json'), projectFile());
      const target = script('tools/key.sh', 'tok-1');
      approveProjectProfile('vault', project);
      fs.writeFileSync(target, `touch '${marker}'; printf 'tok-2'\n`);
      expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it.each([
    ['cd into a folder', 'cd tools && ./key.sh'],
    ['a $( ) substitution', '$(pwd)/tools/key.sh'],
    ['a ${ } variable', 'sh ${PWD}/tools/key.sh'],
    ['a backtick', 'sh `pwd`/tools/key.sh'],
    ['a ; list', 'true; ./tools/key.sh'],
    ['an || list', 'false || ./tools/key.sh'],
    ['a glob', 'sh tools/k*.sh'],
    ['a redirection', 'sh < tools/key.sh'],
    ['pushd', 'pushd tools'],
    ['a directory of the project', 'sh tools'],
  ])('%s is refused, naming the field, and nothing runs', (_label, command) => {
    script('tools/key.sh', 'tok-1');
    writeProject({ api_key_cmd: command });
    const err = refusal(() => approveProjectProfile('vault', project));
    expect(err).toBeInstanceOf(ProjectFileRefusalError);
    expect((err as ProjectFileRefusalError).code).toBe('helper_unbindable');
    expect(err.message).toContain('providers.vault.api_key_cmd');
    expect(err.message).toContain('point it at a script inside the project');
    expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([
    ['./tools/key.sh', './tools/key.sh'],
    ['sh tools/key.sh', 'sh tools/key.sh'],
    ['node tools/k.js', 'node tools/key.sh'],
  ])('the simple form %s still binds the script: an edit asks again', (_label, command) => {
    const target = script('tools/key.sh', 'tok-1');
    fs.chmodSync(target, 0o755);
    writeProject({ api_key_cmd: command });
    approveProjectProfile('vault', project);
    fs.writeFileSync(target, `touch '${marker}'; printf 'tok-2'\n`);
    expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
  });

  it('a PATH command with plain arguments is approved by name', () => {
    writeProject({ api_key_cmd: "printf tok-path" });
    approveProjectProfile('vault', project);
    expect(resolveProfile('vault', undefined, project).apiKey).toBe('tok-path');
  });

  it('a script that does not exist yet cannot be approved, and a file created later where an argument points asks again', () => {
    writeProject({ api_key_cmd: 'sh tools/key.sh' });
    expect(refusal(() => approveProjectProfile('vault', project))).toBeInstanceOf(ProjectFileRefusalError);
    writeProject({ api_key_cmd: 'printf tok-tarde tools/later.txt' });
    approveProjectProfile('vault', project);
    script('tools/later.txt', 'x');
    expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
  });

  it('a FIFO the command names is refused, not left unbound', () => {
    fs.mkdirSync(path.join(project, 'tools'));
    const fifo = path.join(project, 'tools', 'key.fifo');
    execSync(`mkfifo '${fifo}'`);
    writeProject({ api_key_cmd: 'sh tools/key.fifo' });
    const err = refusal(() => approveProjectProfile('vault', project));
    expect((err as ProjectFileRefusalError).code).toBe('helper_unbindable');
  });

  it('a renewal re-checks the approval and stops once the script changed', async () => {
    const target = script('tools/key.sh', 'tok-1');
    writeProject({ api_key_cmd: 'sh ./tools/key.sh' });
    approveProjectProfile('vault', project);
    const profile = resolveProfile('vault', undefined, project);
    expect(profile.keyRenewal).toBeDefined();
    profile.keyRenewal!.markStale();
    fs.writeFileSync(target, `printf 'tok-2'\n`);
    await expect(profile.keyRenewal!.apiKey()).rejects.toBeInstanceOf(ProjectFileRefusalError);
  });

  it('a project file that is not JSON and names an auth header leaves no .rejected- copy', () => {
    fs.writeFileSync(projectFile(), '{ "providers": { "vault": { "headers": { "Authorization": "INVENTADO" } }');
    expect(() => loadConfigFile(project)).toThrow(/Invalid configuration/);
    expect(fs.readdirSync(project).filter((f) => f.includes('.rejected-'))).toEqual([]);
    fs.writeFileSync(projectFile(), '{ "providers": { "vault": { "api_key_env": "VAULT_API_KEY" } }');
    expect(() => loadConfigFile(project)).toThrow(/rejected copy kept/);
  });
});

type Store = { salt?: string; approvals: Record<string, unknown> };
const readStore = (h: string): Store => JSON.parse(fs.readFileSync(projectApprovalsPath(h), 'utf-8')) as Store;

describe('the store derives its keys with scrypt and a salt of its own (CodeQL js/insufficient-password-hash)', () => {
  const material = approvalMaterial('helper', '/tmp/inventado/mnemosine.config.json', 'printf x', 'https://v.example.test');

  it('the stored key is not the SHA-256 of the material, and the store keeps a 16-byte salt', () => {
    recordApprovals([{ material, kind: 'helper', file: '/tmp/inventado/mnemosine.config.json' }], home);
    const store = readStore(home);
    expect(store.salt).toMatch(/^[0-9a-f]{32}$/);
    const [key] = Object.keys(store.approvals);
    expect(key).not.toBe(createHash('sha256').update(material).digest('hex'));
    expect(isApproved(material, home)).toBe(true);
  });

  it('two stores with different salts give different keys', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'm452-other-home-'));
    try {
      recordApprovals([{ material, kind: 'helper', file: '/tmp/inventado/mnemosine.config.json' }], home);
      recordApprovals([{ material, kind: 'helper', file: '/tmp/inventado/mnemosine.config.json' }], other);
      const keyOf = (h: string) => Object.keys(readStore(h).approvals)[0];
      expect(keyOf(home)).not.toBe(keyOf(other));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('a store without a salt reads as nothing approved, failing closed', () => {
    recordApprovals([{ material, kind: 'helper', file: '/tmp/inventado/mnemosine.config.json' }], home);
    const store = readStore(home);
    delete store.salt;
    fs.writeFileSync(projectApprovalsPath(home), JSON.stringify(store));
    expect(isApproved(material, home)).toBe(false);
  });
});

// The third review: an allowlist of shapes, not a denylist of forms.
describe('third review: a project api_key_cmd is accepted only in a shape whose code mnemosine binds', () => {
  function script(rel: string, token: string): string {
    const target = path.join(project, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `touch '${marker}'; printf '${token}'\n`);
    fs.chmodSync(target, 0o755);
    return target;
  }
  beforeEach(() => {
    script('tools/key.sh', 'tok-1');
    script('tools/k.js', 'tok-1');
    script('tools/k.py', 'tok-1');
    fs.writeFileSync(path.join(project, 'package.json'), '{"scripts":{"key":"sh tools/key.sh"}}');
    fs.writeFileSync(path.join(project, 'Makefile'), 'key:\n\tsh tools/key.sh\n');
  });

  it.each([
    ["quotes inside a path", "sh tools/k''ey.sh"],
    ['a backslash inside a path', 'sh ./tools/k\\ey.sh'],
    ['python -m', 'python3 -m tools.k'],
    ['node -e', `node -e "require('./tools/k'+'.js')"`],
    ['npm run', 'npm run --silent key'],
    ['make', 'make -s key'],
    ['npx', 'npx some-tool'],
    ['a wrapper that runs a task runner', 'timeout 5 npm run key'],
    ['an assignment before a command', 'FOO=1 npm run key'],
    ['sh without a script', 'sh'],
    ['an interpreter flag before the script', 'node --require ./tools/k.js tools/k.js'],
    ['a tab', 'sh\ttools/key.sh'],
    ['a PATH command with a project path argument', 'cat tools/key.sh'],
    ['a PATH command with a project path inside a flag', 'tool --file=tools/key.sh'],
  ])('%s is refused as helper_unbindable, and nothing runs', (_label, command) => {
    writeProject({ api_key_cmd: command });
    const err = refusal(() => approveProjectProfile('vault', project));
    expect((err as ProjectFileRefusalError).code).toBe('helper_unbindable');
    expect(err.message).toContain('providers.vault.api_key_cmd');
    expect(err.message).toContain('point it at a script inside the project, run directly or by sh/bash/node/python, or at a command outside it');
    expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([
    ['a) a project script run directly', './tools/key.sh', 'tools/key.sh'],
    ['a) with plain arguments', './tools/key.sh --profile prod', 'tools/key.sh'],
    ['b) sh and a script', 'sh tools/key.sh', 'tools/key.sh'],
    ['b) python3 and a script', 'python3 tools/k.py', 'tools/k.py'],
    ['env and shape b', 'env REGION=us-east-1 sh tools/key.sh', 'tools/key.sh'],
  ])('%s is accepted, and an edit to the script asks again', (_label, command, rel) => {
    writeProject({ api_key_cmd: command });
    expect(approveProjectProfile('vault', project).approved).toContain('helper');
    fs.appendFileSync(path.join(project, rel), '# editado\n');
    expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
  });

  it('c) a PATH command that loads nothing from the project is accepted by name, env included', () => {
    writeProject({ api_key_cmd: 'env LANG=C printf tok-path' });
    approveProjectProfile('vault', project);
    expect(resolveProfile('vault', undefined, project).apiKey).toBe('tok-path');
  });

  it('readiness names an unbindable helper as such, and doctor would not ask to approve it', () => {
    writeProject({ api_key_cmd: 'npm run --silent key' });
    const { profiles, origins } = listProfiles(project);
    const state = credentialState(profiles.vault, { cwd: project, home, source: origins.vault, env: {} });
    expect(state.ready).toBe(false);
    expect(state.source).toMatchObject({ kind: 'unapproved', unbindable: true });
    expect(state.label).toContain('cannot be approved');
    expect(state.label).not.toContain('until you approve it');
  });
});

// The fourth review: env values, interpreters under another name, the helper's environment.
describe('fourth review: env, versioned interpreters, runners and PATH', () => {
  function script(rel: string, body: string): string {
    const target = path.join(project, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    fs.chmodSync(target, 0o755);
    return target;
  }
  beforeEach(() => {
    script('tools/key.sh', `touch '${marker}'; printf 'tok-1'\n`);
    script('tools/k.js', `require('fs').writeFileSync(${JSON.stringify(marker)}, ''); process.stdout.write('tok-js')\n`);
    script('tools/k.py', 'print("tok-py")\n');
    script('tools/gcloud', `#!/bin/sh\ntouch '${marker}'; printf 'tok-falso'\n`);
    script('tools/x.so', 'no es una biblioteca\n');
  });

  it.each([
    ['PATH pointing into the project', 'env PATH=tools:/usr/bin:/bin gcloud auth print-access-token'],
    ['BASH_ENV', 'env BASH_ENV=tools/k.sh bash tools/key.sh'],
    ['LD_PRELOAD', 'env LD_PRELOAD=./tools/x.so gcloud auth print-access-token'],
    ['NODE_OPTIONS', 'env NODE_OPTIONS=--inspect node tools/k.js'],
    ['an env value that reaches the project', 'env CONFIG=tools/key.sh printf x'],
    ['python3.12 -m', 'python3.12 -m tools.k'],
    ['a versioned interpreter as a PATH command', '/usr/bin/python3.12 tools/k.py'],
    ['pytest', 'pytest -q'],
    ['git', 'git config --get user.key'],
  ])('%s is refused as helper_unbindable, and nothing runs', (_label, command) => {
    writeProject({ api_key_cmd: command });
    const err = refusal(() => approveProjectProfile('vault', project));
    expect((err as ProjectFileRefusalError).code).toBe('helper_unbindable');
    expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('nodejs ./tools/k.js is shape b: accepted, and an edit to the script asks again', () => {
    writeProject({ api_key_cmd: 'nodejs ./tools/k.js' });
    expect(approveProjectProfile('vault', project).approved).toContain('helper');
    fs.appendFileSync(path.join(project, 'tools', 'k.js'), '// editado\n');
    expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
  });

  it('a PATH command that resolves inside the project through the user PATH is refused', () => {
    script('bin/mytool', `#!/bin/sh\ntouch '${marker}'; printf 'tok-falso'\n`);
    vi.stubEnv('PATH', `${path.join(project, 'bin')}:/usr/bin:/bin`);
    writeProject({ api_key_cmd: 'mytool' });
    expect((refusal(() => approveProjectProfile('vault', project)) as ProjectFileRefusalError).code).toBe('helper_unbindable');
    script('mytool2', `#!/bin/sh\nprintf 'tok-falso'\n`);
    vi.stubEnv('PATH', `.:/usr/bin:/bin`);
    writeProject({ api_key_cmd: 'mytool2' });
    expect((refusal(() => approveProjectProfile('vault', project)) as ProjectFileRefusalError).code).toBe('helper_unbindable');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a PATH command inside the project is refused when the folder is reached through a symlink', () => {
    script('gkey', `#!/bin/sh\ntouch '${marker}'; printf 'tok-falso'\n`);
    writeProject({ api_key_cmd: 'gkey' });
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm452-link-')), 'project');
    fs.symlinkSync(project, link);
    for (const pathVar of ['.:/usr/bin:/bin', '/usr/bin:/bin:']) {
      vi.stubEnv('PATH', pathVar);
      expect((refusal(() => approveProjectProfile('vault', link)) as ProjectFileRefusalError).code).toBe('helper_unbindable');
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("a project helper runs without the loader variables of the folder's environment", () => {
    script('tools/env.sh', `printf 'tok-[%s][%s][%s]' "$NODE_OPTIONS" "$BASH_ENV" "$PYTHONPATH"\n`);
    vi.stubEnv('NODE_OPTIONS', '--require=./tools/k.js');
    vi.stubEnv('BASH_ENV', 'tools/key.sh');
    vi.stubEnv('PYTHONPATH', 'tools');
    writeProject({ api_key_cmd: 'sh tools/env.sh' });
    approveProjectProfile('vault', project);
    expect(resolveProfile('vault', undefined, project).apiKey).toBe('tok-[][][]');
  });

  it('a project helper also runs without the Ruby, Perl, Python-home, LD_AUDIT and git loader variables', () => {
    script('tools/env2.sh', `printf 'tok-[%s][%s][%s][%s][%s][%s]' "$RUBYOPT" "$RUBYLIB" "$PERL5OPT" "$PYTHONHOME" "$LD_AUDIT" "$GIT_DIR"\n`);
    vi.stubEnv('RUBYOPT', '-r./tools/evil');
    vi.stubEnv('RUBYLIB', 'tools');
    vi.stubEnv('PERL5OPT', '-Mtools');
    vi.stubEnv('PYTHONHOME', 'tools');
    vi.stubEnv('LD_AUDIT', './tools/x.so');
    vi.stubEnv('GIT_DIR', 'tools');
    writeProject({ api_key_cmd: 'sh tools/env2.sh' });
    approveProjectProfile('vault', project);
    expect(resolveProfile('vault', undefined, project).apiKey).toBe('tok-[][][][][][]');
  });
});
