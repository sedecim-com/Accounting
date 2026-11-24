import { describe, it, expect, afterEach } from 'vitest';
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
