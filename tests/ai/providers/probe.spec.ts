import { describe, it, expect, vi } from 'vitest';
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

describe('probeProvider — anthropic', () => {
  it('makes the minimal 1-token messages call with x-api-key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200));
    const r = await probeProvider(anthropicProfile(), { fetchImpl: asFetch(fetchMock) });
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('sk-ant-fake-456');
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(1); // hard floor: the probe never burns more
    expect(body.model).toBe('claude-opus-5');
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
