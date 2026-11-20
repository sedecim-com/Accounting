import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// MNE-001-442: the probe init runs before saving a provider. No model is
// called: both SDKs are replaced, and the test reads what would be sent.
const { openaiCreate, anthropicCreate } = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  anthropicCreate: vi.fn(),
}));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
  },
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));

import { defaultProbe } from '../../../src/cli/init/s3-ai.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tmp);
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  delete process.env.MNEMOSINE_PROVIDER;
  openaiCreate.mockReset().mockResolvedValue({
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ type: 'function' }] } }],
  });
  anthropicCreate.mockReset().mockResolvedValue({ content: [{ type: 'tool_use' }], stop_reason: 'tool_use' });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the init probe', () => {
  it('asks for 1024 tokens on both wire formats, so a model that reasons first can still call the tool', async () => {
    process.env.ANTHROPIC_API_KEY = 'clave-falsa-de-prueba';
    expect((await defaultProbe('ollama')).tools).toBe(true);
    expect((await defaultProbe('anthropic')).tools).toBe(true);
    expect(openaiCreate.mock.calls[0][0]).toMatchObject({ max_tokens: 1024 });
    expect(anthropicCreate.mock.calls[0][0]).toMatchObject({ max_tokens: 1024 });
  });

  it('sends reasoning_effort only when the profile declares it', async () => {
    await defaultProbe('ollama');
    expect('reasoning_effort' in openaiCreate.mock.calls[0][0]).toBe(false);

    fs.writeFileSync(path.join(tmp, 'mnemosine.config.json'), JSON.stringify({
      providers: {
        razona: { type: 'openai-compatible', model: 'm', base_url: 'http://localhost:9/v1', reasoning_effort: 'none' },
      },
    }));
    await defaultProbe('razona', 'otro-modelo');
    expect(openaiCreate.mock.calls[1][0]).toMatchObject({ model: 'otro-modelo', reasoning_effort: 'none' });
  });
});
