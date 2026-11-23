import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

import { query } from '../../../src/database/connection.js';
import { createLlmSession } from '../../../src/ai/providers/index.js';
import { resolveProfile } from '../../../src/ai/providers/config.js';
import { createOpenAiClient, isOpenAiHost } from '../../../src/ai/providers/openai-client.js';
import { defaultProbe } from '../../../src/cli/init/s3-ai.js';
import type { ResolvedProfile } from '../../../src/ai/providers/types.js';
import type { AgentContext } from '../../../src/ai/context.js';

// ============================================================
// MNE-001-445 (P5 of #644): headers taken from the environment go only to
// OpenAI's own hosts.
//
// The `openai` SDK reads OPENAI_ORG_ID, OPENAI_PROJECT_ID and
// OPENAI_CUSTOM_HEADERS on its own and sends them with every request, to
// whatever host the client points at; a custom `Authorization` line even
// replaces the profile's key. These tests use the REAL SDK, with only `fetch`
// replaced, so a later SDK that moves where it keeps those headers turns them
// red instead of silently sending them again. Every value is invented.
// ============================================================

const ENV_AUTH = 'Bearer inventado-del-entorno';

interface Seen {
  url: string;
  headers: Record<string, string>;
}

let seen: Seen[];
let tmp: string;

const COMPLETION = {
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'm',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'listo' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

beforeEach(() => {
  seen = [];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-headers-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tmp);
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  vi.stubEnv('MNEMOSINE_PROVIDER', '');
  vi.stubEnv('OPENAI_BASE_URL', '');
  vi.stubEnv('OPENAI_ORG_ID', 'org-inventada');
  vi.stubEnv('OPENAI_PROJECT_ID', 'proj_inventado');
  vi.stubEnv('OPENAI_CUSTOM_HEADERS', `X-Inventada: uno\nAuthorization: ${ENV_AUTH}`);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return new Response(JSON.stringify(COMPLETION), { status: 200, headers: { 'content-type': 'application/json' } });
    })
  );
  (query as unknown as Mock).mockResolvedValue({ rows: [], rowCount: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const profile = (over: Partial<ResolvedProfile>): ResolvedProfile => ({
  name: 'p',
  type: 'openai-compatible',
  model: 'm',
  ...over,
});

async function oneRequest(p: ResolvedProfile): Promise<Seen> {
  await createOpenAiClient(p).chat.completions.create({ model: p.model, messages: [{ role: 'user', content: 'hola' }] });
  expect(seen).toHaveLength(1);
  return seen[0];
}

function expectNoEnvHeaders(s: Seen, ownKey: string): void {
  expect(s.headers['openai-organization']).toBeUndefined();
  expect(s.headers['openai-project']).toBeUndefined();
  expect(s.headers['x-inventada']).toBeUndefined();
  expect(s.headers.authorization).toBe(`Bearer ${ownKey}`);
}

function expectEnvHeaders(s: Seen): void {
  expect(s.headers['openai-organization']).toBe('org-inventada');
  expect(s.headers['openai-project']).toBe('proj_inventado');
  expect(s.headers['x-inventada']).toBe('uno');
}

describe('another host gets none of the environment\'s OpenAI headers, and the profile\'s own key', () => {
  it.each([
    ['grok', 'XAI_API_KEY', 'xai-inventada-1', 'https://api.x.ai/'],
    ['gemini', 'GEMINI_API_KEY', 'AIza-inventada-2', 'https://generativelanguage.googleapis.com/'],
  ])('the %s built-in', async (name, variable, key, host) => {
    vi.stubEnv(variable, key);
    const s = await oneRequest(resolveProfile(name, undefined, tmp));
    expect(s.url.startsWith(host)).toBe(true);
    expectNoEnvHeaders(s, key);
  });

  it('the ollama built-in, which sends only its placeholder', async () => {
    const s = await oneRequest(resolveProfile('ollama', undefined, tmp));
    expect(s.url.startsWith('http://localhost:11434/')).toBe(true);
    expectNoEnvHeaders(s, 'not-needed');
  });

  it('an NVIDIA profile', async () => {
    const s = await oneRequest(profile({ base_url: 'https://integrate.api.nvidia.com/v1', apiKey: 'nvapi-inventada-3' }));
    expectNoEnvHeaders(s, 'nvapi-inventada-3');
  });

  it('a profile with no base_url while OPENAI_BASE_URL points elsewhere', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://otro.example.test/v1');
    const s = await oneRequest(profile({ apiKey: 'llave-propia-4' }));
    expect(s.url.startsWith('https://otro.example.test/v1/')).toBe(true);
    expectNoEnvHeaders(s, 'llave-propia-4');
  });

  it('the profile\'s own headers still go', async () => {
    const s = await oneRequest(profile({ base_url: 'https://api.x.ai/v1', apiKey: 'k', headers: { 'X-Propio': 'si' } }));
    expect(s.headers['x-propio']).toBe('si');
    expectNoEnvHeaders(s, 'k');
  });
});

describe('OpenAI\'s own hosts keep them', () => {
  it('the openai built-in (api.openai.com, set)', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-inventada-5');
    const s = await oneRequest(resolveProfile('openai', undefined, tmp));
    expect(s.url.startsWith('https://api.openai.com/v1/')).toBe(true);
    expectEnvHeaders(s);
    // The SDK lets a custom Authorization line replace the key; toward
    // OpenAI that stays the person's own choice, as before.
    expect(s.headers.authorization).toBe(ENV_AUTH);
  });

  it('api.openai.com by default: no base_url and no OPENAI_BASE_URL', async () => {
    const s = await oneRequest(profile({ apiKey: 'k' }));
    expect(s.url.startsWith('https://api.openai.com/v1/')).toBe(true);
    expectEnvHeaders(s);
  });

  it('a regional host such as eu.api.openai.com', async () => {
    expectEnvHeaders(await oneRequest(profile({ base_url: 'https://eu.api.openai.com/v1', apiKey: 'k' })));
  });
});

describe('isOpenAiHost', () => {
  it('only https and the SDK\'s residency hosts', () => {
    for (const r of ['', 'us.', 'eu.', 'ae.', 'au.', 'in.', 'jp.']) {
      expect(isOpenAiHost(`https://${r}api.openai.com/v1`)).toBe(true);
    }
    expect(isOpenAiHost('http://api.openai.com/v1')).toBe(false);
    expect(isOpenAiHost('https://api.openai.com.example.test/v1')).toBe(false);
    expect(isOpenAiHost('https://evil.test/api.openai.com')).toBe(false);
    expect(isOpenAiHost(undefined)).toBe(false);
    expect(isOpenAiHost('no es una url')).toBe(false);
  });
});

describe('both places that build a client use the rule', () => {
  const CTX: AgentContext = {
    entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    entityName: 'Demo MX',
    tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
    currency: 'MXN',
    country: 'MX',
    accountingStandard: 'mx_nif',
    taxId: 'XAXX010101000',
  };

  // On xAI and not on NVIDIA's hosted catalog: a session there needs its trial
  // terms accepted first (MNE-001-448), which trial-endpoint.spec.ts covers.
  it('a session turn (createLlmSession)', async () => {
    const session = await createLlmSession(
      profile({ name: 'xai', base_url: 'https://api.x.ai/v1', apiKey: 'xai-inventada-6', stream: false }),
      CTX
    );
    await session.runTurn('hola');
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expectNoEnvHeaders(s, 'xai-inventada-6');
  });

  it('the init probe (defaultProbe)', async () => {
    vi.stubEnv('XAI_API_KEY', 'xai-inventada-7');
    expect((await defaultProbe('grok')).chat).toBe(true);
    expect(seen).toHaveLength(1);
    expectNoEnvHeaders(seen[0], 'xai-inventada-7');
  });
});
