import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeProvider, probeAll, PROBE_TIMEOUT_MS } from '../../../src/ai/providers/probe.js';
import type { ResolvedProfile } from '../../../src/ai/providers/types.js';

const openaiProfile = (over: Partial<ResolvedProfile> = {}): ResolvedProfile => ({
  name: 'hermes',
  type: 'openai-compatible',
  model: 'Hermes-4-405B',
  base_url: 'https://inference-api.nousresearch.com/v1',
  api_key_env: 'NOUS_API_KEY',
  apiKey: 'sk-fake-nous-key-123',
  ...over,
});

const anthropicProfile = (over: Partial<ResolvedProfile> = {}): ResolvedProfile => ({
  name: 'anthropic',
  type: 'anthropic',
  model: 'claude-opus-5',
  api_key_env: 'ANTHROPIC_API_KEY',
  apiKey: 'sk-ant-fake-456',
  ...over,
});

const asFetch = (fn: unknown): typeof fetch => fn as typeof fetch;

const response = (status: number, body = ''): unknown => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
});

describe('probeProvider — openai-compatible', () => {
  it('hits the token-free model-list endpoint with the bearer credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, '{"data":[]}'));
    const r = await probeProvider(openaiProfile(), { fetchImpl: asFetch(fetchMock) });
    expect(r.ok).toBe(true);
    expect(r.category).toBeUndefined();
    expect(r.detail).toBe('HTTP 200');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://inference-api.nousresearch.com/v1/models');
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe('Bearer sk-fake-nous-key-123');
  });

  it('classifies a 401 as auth with the shared taxonomy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(401, '{"error":{"message":"Incorrect API key"}}'));
    const r = await probeProvider(openaiProfile(), { fetchImpl: asFetch(fetchMock) });
    expect(r.ok).toBe(false);
    expect(r.category).toBe('auth');
    expect(r.detail).toContain('HTTP 401');
  });

  it('classifies an exhausted-quota 429 as billing, not rate_limit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(429, '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}'));
    const r = await probeProvider(openaiProfile(), { fetchImpl: asFetch(fetchMock) });
    expect(r.category).toBe('billing');
  });

  it('classifies a connection refusal (local server down) as server', async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    );
    const r = await probeProvider(openaiProfile({ base_url: 'http://localhost:11434/v1', apiKey: undefined }), {
      fetchImpl: asFetch(fetchMock),
    });
    expect(r.ok).toBe(false);
    expect(r.category).toBe('server');
  });

  it('fails without a base_url instead of probing nowhere', async () => {
    const fetchMock = vi.fn();
    const r = await probeProvider(openaiProfile({ base_url: undefined }), { fetchImpl: asFetch(fetchMock) });
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// MNE-001-447 (#644 P7): status probes an anthropic profile through the
// SDK client the session builds, so the probe sends what the session sends,
// to the host the session uses. The SDK reads the environment on its own, so
// each test pins every variable it reads to an invented value or to unset,
// and points its config root at an empty folder.
describe('probeProvider — anthropic, through the session\'s client', () => {
  const ANTHROPIC_VARIABLES = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_PROFILE',
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID',
    'ANTHROPIC_IDENTITY_TOKEN',
    'ANTHROPIC_IDENTITY_TOKEN_FILE',
  ];
  let configDir: string;
  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-probe-anthropic-'));
    for (const variable of ANTHROPIC_VARIABLES) vi.stubEnv(variable, '');
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', configDir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  const okMessage = () =>
    new Response(JSON.stringify({ id: 'msg_probe', type: 'message', role: 'assistant', content: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const header = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name);

  // @anthropic-ai/sdk 1.8.0 sends an API key as a bearer token too
  // (client.js:450-455), so the probe now does what the session does.
  it("makes the minimal 1-token messages call with the profile's key, as the session's client sends it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okMessage());
    const r = await probeProvider(anthropicProfile(), { fetchImpl: asFetch(fetchMock) });
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init?.method).toBe('POST');
    expect(header(init, 'authorization')).toBe('Bearer sk-ant-fake-456');
    const body = JSON.parse(init?.body as string) as { max_tokens: number; model: string };
    expect(body.max_tokens).toBe(1); // hard floor: the probe never burns more
    expect(body.model).toBe('claude-opus-5');
  });

  it("with ANTHROPIC_AUTH_TOKEN, sends Authorization: Bearer and ignores the profile's base_url and headers, as the session does", async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'tok-inventado-de-prueba');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okMessage());
    const r = await probeProvider(
      anthropicProfile({ apiKey: undefined, base_url: 'https://proxy.example.test', headers: { 'x-extra-header': 'from-the-profile' } }),
      { fetchImpl: asFetch(fetchMock) }
    );
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(header(init, 'authorization')).toBe('Bearer tok-inventado-de-prueba');
    expect(header(init, 'x-api-key')).toBeNull();
    expect(header(init, 'x-extra-header')).toBeNull();
  });

  it('follows ANTHROPIC_BASE_URL from the person\'s environment, as the SDK does for the session', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gateway.example.test');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okMessage());
    await probeProvider(anthropicProfile(), { fetchImpl: asFetch(fetchMock) });
    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example.test/v1/messages');
  });

  it('with no credential anywhere, sends nothing and reads as unconfigured', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okMessage());
    const r = await probeProvider(anthropicProfile({ apiKey: undefined }), { fetchImpl: asFetch(fetchMock) });
    expect(r.ok).toBe(false);
    expect(r.category).toBe('unconfigured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies a 401 as auth in one attempt, and never echoes the key', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-fake-456' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    );
    const r = await probeProvider(anthropicProfile(), { fetchImpl: asFetch(fetchMock) });
    expect(r.ok).toBe(false);
    expect(r.category).toBe('auth');
    expect(r.detail).toContain('HTTP 401');
    expect(JSON.stringify(r)).not.toContain('sk-ant-fake-456');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 529 is server, and the probe does not retry it', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), {
        status: 529,
        headers: { 'content-type': 'application/json' },
      })
    );
    const r = await probeProvider(anthropicProfile(), { fetchImpl: asFetch(fetchMock) });
    expect(r.category).toBe('server');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('probeProvider — timeout and redaction', () => {
  it('has a 10s default hard timeout and classifies our own abort as timeout', async () => {
    expect(PROBE_TIMEOUT_MS).toBe(10_000);
    const fetchMock = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
          );
        })
    );
    const r = await probeProvider(openaiProfile(), { fetchImpl: asFetch(fetchMock), timeoutMs: 20 });
    expect(r.ok).toBe(false);
    expect(r.category).toBe('timeout');
    expect(r.detail).toContain('no response within 20ms');
  });

  it('scrubs the credential even when the endpoint echoes it back', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(401, '{"error":{"message":"key sk-fake-nous-key-123 is invalid"}}'));
    const r = await probeProvider(openaiProfile(), { fetchImpl: asFetch(fetchMock) });
    expect(JSON.stringify(r)).not.toContain('sk-fake-nous-key-123');
    expect(r.detail).toContain('[redacted]');
  });

  it('strips URL userinfo: a network error echoing https://user:secret@host never leaks the credential', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new Error('request to https://gateway-user:hunter2-secret@proxy.internal.example/v1/models failed')
      );
    const r = await probeProvider(
      openaiProfile({ base_url: 'https://gateway-user:hunter2-secret@proxy.internal.example/v1' }),
      { fetchImpl: asFetch(fetchMock) }
    );
    expect(r.ok).toBe(false);
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain('hunter2-secret');
    expect(serialized).not.toContain('gateway-user');
    expect(r.detail).toContain('//[redacted]@');
  });

  it('truncates long bodies so the detail stays a status line, not a dump', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(500, 'x'.repeat(5000)));
    const r = await probeProvider(openaiProfile(), { fetchImpl: asFetch(fetchMock) });
    expect(r.detail.length).toBeLessThanOrEqual(200);
  });
});

describe('probeAll', () => {
  it('probes sequentially with per-probe isolation: one crash never aborts the rest', async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      order.push(url);
      if (url.includes('bad.example')) throw new Error('total meltdown');
      return response(200) as Response;
    });
    const results = await probeAll(
      [
        openaiProfile({ name: 'good1', base_url: 'https://good1.example/v1' }),
        openaiProfile({ name: 'bad', base_url: 'https://bad.example/v1' }),
        openaiProfile({ name: 'good2', base_url: 'https://good2.example/v1' }),
      ],
      { fetchImpl: asFetch(fetchMock) }
    );
    expect(order).toEqual([
      'https://good1.example/v1/models',
      'https://bad.example/v1/models',
      'https://good2.example/v1/models',
    ]);
    expect(results.map((r) => `${r.name}:${r.ok}`)).toEqual(['good1:true', 'bad:false', 'good2:true']);
    expect(results[1].category).toBeDefined();
  });
});
