import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { approveProfileLines } from '../../src/cli/provider-readiness.js';
import { resolveProfile } from '../../src/ai/providers/config.js';
import { setLanguage, resetLanguage } from '../../src/i18n/index.js';

// MNE-001-452 (#645): `mnemosine providers approve <profile>`. A temporary home
// and project folder; the helper is invented and leaves a marker when it runs.

const plain = { dim: (s: string) => s };
let home: string;
let project: string;
let marker: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-project-'));
  marker = path.join(home, 'helper-ran');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('MNEMOSINE_PROVIDER', '');
  setLanguage('en');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetLanguage();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

function writeProject(profile: Record<string, unknown>): string {
  const file = path.join(project, 'mnemosine.config.json');
  fs.writeFileSync(file, JSON.stringify({
    providers: { vault: { type: 'openai-compatible', model: 'm', base_url: 'https://v.example.test/v1', ...profile } },
  }));
  return file;
}

describe('providers approve', () => {
  it('approves the helper of a project profile, says for which file and host, and never prints the command', () => {
    const file = writeProject({ api_key_cmd: `touch '${marker}'; printf 'tok-inventado'` });
    const lines = approveProfileLines('vault', plain, project);
    expect(lines).toEqual([
      `Approved for you: the api_key_cmd of providers.vault in ${file}, for v.example.test. A changed command or host asks again.`,
    ]);
    expect(lines.join('\n')).not.toMatch(/touch|tok-inventado/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(resolveProfile('vault', undefined, project).apiKey).toBe('tok-inventado');
  });

  it('says that "never" still keeps it from running', () => {
    writeProject({ api_key_cmd: 'printf x' });
    fs.mkdirSync(path.join(home, '.mnemosine'), { recursive: true });
    fs.writeFileSync(path.join(home, '.mnemosine', 'config.json'), JSON.stringify({ project_helpers: 'never' }));
    expect(approveProfileLines('vault', plain, project)[1]).toBe(
      '"project_helpers" is "never" in ~/.mnemosine/config.json, so it still does not run.'
    );
  });

  it('a project profile with no helper, a built-in and an unknown name', () => {
    const file = writeProject({ api_key_env: 'OPENAI_API_KEY', base_url: 'https://api.openai.com/v1' });
    expect(approveProfileLines('vault', plain, project)).toEqual([
      `vault in ${file} runs no api_key_cmd and sends no key to another host: there is nothing to approve.`,
    ]);
    expect(approveProfileLines('ollama', plain, project)).toEqual(['ollama is a built-in profile: there is nothing to approve.']);
    expect(() => approveProfileLines('nadie', plain, project)).toThrow(/Provider "nadie" does not exist/);
    expect(fs.existsSync(path.join(home, '.mnemosine', 'project-approvals.json'))).toBe(false);
  });

  it('approves sending a variable to a host its provider does not document (MNE-001-452, part B)', () => {
    const file = writeProject({ api_key_env: 'OPENAI_API_KEY' });
    expect(approveProfileLines('vault', plain, project)).toEqual([
      `Approved for you: providers.vault in ${file} may send OPENAI_API_KEY to v.example.test. Another host asks again.`,
    ]);
  });

  it("a profile of the person's own file has nothing to approve", () => {
    const userFile = path.join(home, '.mnemosine', 'config.json');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, JSON.stringify({
      providers: { vault: { type: 'openai-compatible', model: 'm', base_url: 'https://v.example.test/v1', api_key_cmd: 'printf x' } },
    }));
    expect(approveProfileLines('vault', plain, project)).toEqual([
      `vault comes from your own ${userFile}: there is nothing to approve.`,
    ]);
  });
});
