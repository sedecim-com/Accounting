import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

import type { AgentContext } from '../../../src/ai/context.js';

// ============================================================
// NVIDIA's hosted catalog is a trial that records what it receives
// (MNE-001-448, #644 P8). However a session's profile was chosen, a
// base URL on integrate.api.nvidia.com opens a session only for chat
// and ask after the terms and a yes, or for the eval's synthetic
// golden set. Invented keys and a temporary HOME only.
// ============================================================

const CTX: AgentContext = {
  entityId: 'entity-1', entityName: 'Demo', tenantId: 'tenant-a',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'XAXX010101000',
};
const SET = ['MNEMOSINE_PROVIDER', 'NVIDIA_API_KEY'] as const;
const BEFORE = Object.fromEntries(SET.map((k) => [k, process.env[k]]));
let home: string;
let cwd: string;
let homedir: { mockRestore: () => void };

/** A fresh module graph: the acceptance lives for one process, as a chat session does. */
async function fresh() {
  vi.resetModules();
  const trial = await import('../../../src/ai/providers/trial-endpoint.js');
  const config = await import('../../../src/ai/providers/config.js');
  const index = await import('../../../src/ai/providers/index.js');
  return { ...trial, ...config, ...index };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-cwd-'));
  // os.homedir() is what the config readers call; the real home is never read.
  homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
  delete process.env.MNEMOSINE_PROVIDER;
  process.env.NVIDIA_API_KEY = 'clave-falsa-de-prueba';
});
afterEach(() => {
  homedir.mockRestore();
  for (const k of SET) {
    if (BEFORE[k] === undefined) delete process.env[k];
    else process.env[k] = BEFORE[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('the hosted endpoint is recognised by its host, not by a substring', () => {
  it('integrate.api.nvidia.com in any case or with a final dot; nothing else', async () => {
    const { isTrialEndpoint } = await fresh();
    expect(isTrialEndpoint('https://integrate.api.nvidia.com/v1')).toBe(true);
    expect(isTrialEndpoint('https://INTEGRATE.api.nvidia.com./v1')).toBe(true);
    expect(isTrialEndpoint('http://nim.despacho.test:8000/v1')).toBe(false);
    expect(isTrialEndpoint('https://integrate.api.nvidia.com.otro.test/v1')).toBe(false);
    expect(isTrialEndpoint('https://otro.test/integrate.api.nvidia.com/v1')).toBe(false);
    expect(isTrialEndpoint('no es una url')).toBe(false);
    expect(isTrialEndpoint(undefined)).toBe(false);
  });
});

describe('an unattended session never opens on it, however its profile was chosen', () => {
  const chosen: Array<[string, () => void]> = [
    ['--provider nvidia', () => {}],
    ['MNEMOSINE_PROVIDER', () => { process.env.MNEMOSINE_PROVIDER = 'nvidia'; }],
    ['a default_provider in the user file', () => {
      fs.mkdirSync(path.join(home, '.mnemosine'));
      fs.writeFileSync(path.join(home, '.mnemosine', 'config.json'), JSON.stringify({ default_provider: 'nvidia' }));
    }],
    ['a profile of a project file on that host', () => {
      fs.writeFileSync(path.join(cwd, 'mnemosine.config.json'), JSON.stringify({
        default_provider: 'mio',
        providers: { mio: { type: 'openai-compatible', model: 'm', base_url: 'https://integrate.api.nvidia.com/v1', api_key_env: 'NVIDIA_API_KEY' } },
      }));
    }],
  ];
  for (const [how, arrange] of chosen) {
    it(`ingest, jobs and init's import refuse it (${how})`, async () => {
      arrange();
      const { resolveProfile, createLlmSession, assertDefaultNotOnTrial } = await fresh();
      const profile = resolveProfile(how === '--provider nvidia' ? 'nvidia' : undefined, undefined, cwd);
      const refusal = { code: 'AI_TRIAL_ENDPOINT_REFUSED', statusCode: 403 };
      await expect(createLlmSession(profile, CTX, {}, { grounding: { enabled: false }, cwd })).rejects.toMatchObject(refusal);
      expect(() => assertDefaultNotOnTrial(how === '--provider nvidia' ? 'nvidia' : undefined, cwd)).toThrow(
        expect.objectContaining(refusal)
      );
    });
  }

  it('a profile on another host is not stopped by the tick check', async () => {
    const { assertDefaultNotOnTrial } = await fresh();
    expect(() => assertDefaultNotOnTrial(undefined, cwd)).not.toThrow();
  });

  it('jobs run-due checks before it claims any job', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/cli/jobs-command.ts'), 'utf-8');
    const check = src.indexOf('assertDefaultNotOnTrial(');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(src.indexOf('await runDueJobs(ctx'));
  });

  it('the eval passes its explicit allowance, which opens it for the synthetic golden set only', async () => {
    const { resolveProfile, assertTrialEndpointAllowed } = await fresh();
    const profile = resolveProfile('nvidia', undefined, cwd);
    expect(() => assertTrialEndpointAllowed(profile, { unattended: true, allowance: 'synthetic-golden-set' })).not.toThrow();
    const harness = fs.readFileSync(path.join(__dirname, '../../../scripts/eval-clasificador.ts'), 'utf-8');
    expect(harness).toMatch(/createLlmSession\([\s\S]{0,1500}trialEndpoint: 'synthetic-golden-set'/);
  });
});

describe('chat and ask: the terms and a yes at the keyboard, once per session', () => {
  const io = (confirm: ((q: string) => Promise<boolean>) | null, lines: string[]) =>
    ({ confirm, print: (l: string) => lines.push(l), cwd });

  it('without a terminal it refuses and asks nothing', async () => {
    const { acceptTrialTermsFor } = await fresh();
    const lines: string[] = [];
    await expect(acceptTrialTermsFor('nvidia', io(null, lines))).rejects.toMatchObject({ code: 'AI_TRIAL_ENDPOINT_REFUSED' });
  });

  it('it prints the terms and asks; No opens nothing', async () => {
    const { acceptTrialTermsFor, resolveProfile, createLlmSession } = await fresh();
    const lines: string[] = [];
    const confirm = vi.fn(async () => false);
    await expect(acceptTrialTermsFor('nvidia', io(confirm, lines))).rejects.toMatchObject({ code: 'AI_TRIAL_ENDPOINT_REFUSED' });
    expect(confirm).toHaveBeenCalledTimes(1);
    const terms = lines.join('\n');
    expect(terms).toContain('integrate.api.nvidia.com');
    expect(terms).toMatch(/record what you send/);
    expect(terms).toMatch(/personal data/);
    // An attended session without the yes is refused at the chokepoint too.
    await expect(createLlmSession(resolveProfile('nvidia', undefined, cwd), CTX, {}, { cwd }))
      .rejects.toMatchObject({ code: 'AI_TRIAL_ENDPOINT_REFUSED' });
  });

  it('a yes lets the attended session through, and the session is not asked again', async () => {
    const { acceptTrialTermsFor, assertTrialEndpointAllowed, resolveProfile } = await fresh();
    const confirm = vi.fn(async () => true);
    await acceptTrialTermsFor('nvidia', io(confirm, []));
    await acceptTrialTermsFor('nvidia', io(confirm, []));
    expect(confirm).toHaveBeenCalledTimes(1);
    const profile = resolveProfile('nvidia', undefined, cwd);
    expect(() => assertTrialEndpointAllowed(profile, { unattended: false })).not.toThrow();
    // The yes was given at a keyboard: it never covers an unattended run.
    expect(() => assertTrialEndpointAllowed(profile, { unattended: true })).toThrow(
      expect.objectContaining({ code: 'AI_TRIAL_ENDPOINT_REFUSED' })
    );
  });

  it('another profile is not asked anything', async () => {
    const { acceptTrialTermsFor } = await fresh();
    const confirm = vi.fn(async () => true);
    await acceptTrialTermsFor('ollama', io(confirm, []));
    expect(confirm).not.toHaveBeenCalled();
  });
});
