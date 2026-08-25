import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLlmSessionWithFailover } from '../../../src/ai/providers/index.js';
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
