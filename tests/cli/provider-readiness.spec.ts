import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';

const order = vi.hoisted(() => [] as string[]);
vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(), enterTenant: vi.fn(), currentTenant: vi.fn(), withTenant: vi.fn(), withTransaction: vi.fn(),
}));
vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: () => undefined,
  resolveEntity: () => Promise.resolve({ tenantId: 'T1', entityId: 'E1', entityName: 'Demo SA' }),
}));
vi.mock('../../src/ai/jobs/runner.js', () => ({
  runDueJobs: vi.fn(async () => {
    order.push('runDueJobs');
    return [];
  }),
}));

import { providerLines, tickCredentialLine } from '../../src/cli/provider-readiness.js';
import { registerJobsCommand } from '../../src/cli/jobs-command.js';

// MNE-001-443: `mnemosine providers` and the `jobs run-due` tick print the
// same readiness answer as doctor and status. Invented values only; a helper
// that would leave a marker file proves by its absence that it never ran.

const plain = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };

let cwd: string;
let home: string;
let homedir: { mockRestore: () => void };
const SECRET_CMD_PART = 'fake-vault-item-secret-path';

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-cwd-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-home-'));
  // The config reader finds the user file through os.homedir().
  homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('MNEMOSINE_PROVIDER', '');
});
afterEach(() => {
  homedir.mockRestore();
  vi.unstubAllEnvs();
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function userConfig(cfg: unknown): string {
  const file = path.join(home, '.mnemosine', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg));
  return file;
}

const marker = () => path.join(cwd, 'helper-ran');
const helperCmd = () => `touch ${marker()} && echo ${SECRET_CMD_PART} >&2 && false`;

describe('providerLines — mnemosine providers', () => {
  it('names a helper with its file, and never runs it or prints its command', () => {
    userConfig({
      default_provider: 'vault',
      providers: { vault: { type: 'openai-compatible', model: 'vm', base_url: 'https://v.example.test/v1', api_key_cmd: helperCmd() } },
    });
    const out = providerLines(plain, { cwd, home, env: {} }).join('\n');
    expect(out).toMatch(/^vault ← default$/m);
    expect(out).toMatch(/vm · https:\/\/v\.example\.test\/v1 · tools · ✔ api_key_cmd in ~\/\.mnemosine\/config\.json$/m);
    expect(out).not.toContain(SECRET_CMD_PART);
    expect(out).not.toContain('touch');
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('a set variable, a missing one with its link, local and keyless remote', () => {
    userConfig({
      default_provider: 'nim',
      providers: { nim: { type: 'openai-compatible', model: 'n', base_url: 'http://nim.example.test/v1' } },
    });
    const out = providerLines(plain, { cwd, home, env: { GEMINI_API_KEY: 'fake-gemini-key' } }).join('\n');
    expect(out).toMatch(/· ✔ GEMINI_API_KEY set$/m);
    expect(out).toMatch(/· ✘ OPENAI_API_KEY missing \(get it at https:\/\/platform\.openai\.com\/api-keys\)$/m);
    expect(out).toMatch(/localhost:11434\/v1 · tools · ✔ local, no credential$/m);
    expect(out).toMatch(/nim\.example\.test\/v1 · tools · ○ no credential configured$/m);
    expect(out).not.toContain('fake-gemini-key');
    expect(out).toMatch(/Config: .*config\.json/);
  });

  it('says when the folder\'s ./.env holds the key', () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'XAI_API_KEY=fake-folder-xai\n');
    const out = providerLines(plain, { cwd, home, env: { XAI_API_KEY: 'fake-folder-xai' } }).join('\n');
    expect(out).toContain(`XAI_API_KEY set; ${path.join(cwd, '.env')} defines it, so that key serves everyone who runs mnemosine in that folder`);
    expect(out).not.toContain('fake-folder-xai');
  });
});

describe('tickCredentialLine — jobs run-due', () => {
  it('names the profile and its credential source, on the credential of whoever runs the tick', () => {
    userConfig({
      default_provider: 'vault',
      providers: { vault: { type: 'openai-compatible', model: 'vm', base_url: 'https://v.example.test/v1', api_key_cmd: helperCmd() } },
    });
    const line = tickCredentialLine({ cwd, home, env: {} });
    expect(line).toBe('provider vault · api_key_cmd in ~/.mnemosine/config.json · the credential of the user running this tick');
    expect(line).not.toContain(SECRET_CMD_PART);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('a missing credential is said before any job runs', () => {
    const line = tickCredentialLine({ cwd, home, env: {} });
    expect(line).toMatch(/^provider anthropic · ANTHROPIC_API_KEY missing/);
  });

  it('a default that does not exist, or a config that does not load, is said in a fixed line', () => {
    userConfig({ default_provider: 'ghost' });
    expect(tickCredentialLine({ cwd, home, env: {} })).toBe('provider ghost does not exist (mnemosine doctor says more)');
    fs.writeFileSync(path.join(cwd, 'mnemosine.config.json'), '{ not json');
    expect(tickCredentialLine({ cwd, home, env: {} })).toBe('provider: the configuration does not load (mnemosine doctor says why)');
  });
});

describe('jobs run-due prints the tick\'s credential line before the first job', () => {
  it('the line comes before the runner claims anything', async () => {
    userConfig({
      default_provider: 'vault',
      providers: { vault: { type: 'openai-compatible', model: 'vm', base_url: 'https://v.example.test/v1', api_key_cmd: helperCmd() } },
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void order.push(a.map(String).join(' ')));
    order.length = 0;
    try {
      const program = new Command();
      program.exitOverride();
      registerJobsCommand(program, {
        palette: plain,
        shutdown: async () => undefined as never,
        reportError: (e) => { throw e; },
        makeRunAgentTurn: vi.fn(),
      });
      await program.parseAsync(['jobs', 'run-due'], { from: 'user' });
    } finally {
      log.mockRestore();
      cwdSpy.mockRestore();
    }
    const line = order.findIndex((l) => l.startsWith('provider vault · api_key_cmd in ~/.mnemosine/config.json'));
    expect(line).toBeGreaterThanOrEqual(0);
    expect(line).toBeLessThan(order.indexOf('runDueJobs'));
    expect(order.join('\n')).not.toContain(SECRET_CMD_PART);
    expect(fs.existsSync(marker())).toBe(false);
  });
});
