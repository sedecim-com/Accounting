import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_CONTENT_SECURITY_POLICY } from '../../src/gateway/security-headers.js';
import { startHarness, type Harness } from './helpers/harness.js';

// ============================================================
// W0 · the relay to /v1, judged by what the API receives on the wire.
//
// The session is seeded through the real /auth/login and /auth/callback, so
// the Bearer upstream is a token the fake IdP issued and the gateway
// verified, never one a test placed in the store.
// ============================================================

let h: Harness;
let cookie: string;

function codeOf(body: string): string {
  return (JSON.parse(body) as { errors: Array<{ code: string }> }).errors[0].code;
}

beforeEach(async () => {
  h = await startHarness();
  cookie = await h.signIn();
});

afterEach(async () => {
  await h.close();
});

describe('what reaches the API', () => {
  it('the session becomes an Authorization Bearer upstream, with the issued access token', async () => {
    const res = await h.read('/v1/portfolio', cookie);
    expect(res.status).toBe(200);
    expect(h.api.requests).toHaveLength(1);
    expect(h.api.requests[0].method).toBe('GET');
    expect(h.api.requests[0].url).toBe('/v1/portfolio');
    expect(h.api.requests[0].headers.authorization).toBe(`Bearer ${h.idp.issued.access[0]}`);
  });

  it('never forwards a client Authorization (a forged HS256 token included), cookies, x-request-id, forwarded or the CSRF header', async () => {
    const forged = await h.idp.signHs256('dev-secret-change-me');
    await h.read('/v1/portfolio', cookie, {
      authorization: `Bearer ${forged}`,
      'x-request-id': 'client-chosen',
      forwarded: 'for=6.6.6.6',
      'x-real-ip': '6.6.6.6',
      'x-forwarded-host': 'evil.test',
    });
    const upstream = h.api.requests[0].headers;
    expect(upstream.authorization).toBe(`Bearer ${h.idp.issued.access[0]}`);
    expect(JSON.stringify(upstream)).not.toContain(forged);
    expect(upstream.cookie).toBeUndefined();
    expect(upstream['x-request-id']).toBeUndefined();
    expect(upstream.forwarded).toBeUndefined();
    expect(upstream['x-real-ip']).toBeUndefined();
    expect(upstream['x-forwarded-host']).toBeUndefined();
    expect(upstream['x-mnemosine-request']).toBeUndefined();
    expect(upstream['sec-fetch-site']).toBeUndefined();
  });

  it('replaces a client x-forwarded-for with the address Express resolved', async () => {
    await h.read('/v1/portfolio', cookie, { 'x-forwarded-for': '6.6.6.6' });
    expect(h.api.requests[0].headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(h.api.requests[0].headers['x-forwarded-proto']).toBe('http');
  });

  it('forwards x-entity-id byte for byte, and a duplicate arrives joined for the API to refuse', async () => {
    const entity = '0b5f0c7e-3c1a-4c55-9d7e-2f1f7d6f2a10';
    await h.read('/v1/ai/drafts?status=pending_review', cookie, { 'x-entity-id': entity, accept: 'application/json' });
    expect(h.api.requests[0].url).toBe('/v1/ai/drafts?status=pending_review');
    expect(h.api.requests[0].headers['x-entity-id']).toBe(entity);
    expect(h.api.requests[0].headers.accept).toBe('application/json');

    // Two header lines: Node joins them before the gateway sees them, and the
    // gateway forwards the joined value verbatim, which the API refuses (403).
    const other = '5d8a1b2c-0f3e-4a6b-8c9d-7e6f5a4b3c2d';
    await h.read('/v1/ai/drafts', cookie, { 'x-entity-id': [entity, other] });
    expect(h.api.requests[1].headers['x-entity-id']).toBe(`${entity}, ${other}`);
  });

  it('drops upstream set-cookie, location, access-control-* and www-authenticate', async () => {
    h.api.respond = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'api=1; Path=/',
        location: 'https://evil.test/',
        'access-control-allow-origin': '*',
        'www-authenticate': 'Bearer',
        etag: '"v1"',
        'x-ratelimit-remaining': '41',
      });
      res.end('{"data":[]}');
    };
    const res = await h.read('/v1/portfolio', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.headers.etag).toBe('"v1"');
    expect(res.headers['x-ratelimit-remaining']).toBe('41');
    expect(res.body).toBe('{"data":[]}');
  });

  it('carries no-store, Vary Cookie and the sandbox CSP on relayed responses', async () => {
    const res = await h.read('/v1/portfolio', cookie);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.vary).toBe('Cookie');
    expect(res.headers['content-security-policy']).toBe(API_CONTENT_SECURITY_POLICY);
  });

  it('a HEAD is relayed as a HEAD, with no body', async () => {
    const res = await h.request('HEAD', '/v1/portfolio', { cookie, 'x-mnemosine-request': '1' });
    expect(res.status).toBe(200);
    expect(h.api.requests[0].method).toBe('HEAD');
    expect(res.body).toBe('');
  });
});

describe('what the API cannot make the gateway do', () => {
  it('an upstream redirect becomes 502 and is not followed', async () => {
    h.api.respond = (_req, res) => {
      res.writeHead(302, { location: `${h.api.url}/v1/elsewhere` });
      res.end();
    };
    const res = await h.read('/v1/portfolio', cookie);
    expect(res.status).toBe(502);
    expect(codeOf(res.body)).toBe('UPSTREAM_REDIRECT_REFUSED');
    expect(h.api.requests).toHaveLength(1);
  });

  it('an unreachable API is 502 with no internal detail', async () => {
    await h.api.close();
    const res = await h.read('/v1/portfolio', cookie);
    expect(res.status).toBe(502);
    const body = JSON.parse(res.body) as { errors: Array<{ code: string; message: string }> };
    expect(body.errors[0].code).toBe('UPSTREAM_UNAVAILABLE');
    expect(res.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|fetch failed/);
  });

  it('an upstream 401 destroys the session', async () => {
    h.api.respond = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"errors":[{"code":"UNAUTHORIZED"}]}');
    };
    const first = await h.read('/v1/portfolio', cookie);
    expect(first.status).toBe(401);
    expect(codeOf(first.body)).toBe('SESSION_EXPIRED');
    expect(h.gateway.sessions.size).toBe(0);

    h.api.respond = (_req, res) => res.end('{}');
    const second = await h.read('/v1/portfolio', cookie);
    expect(second.status).toBe(401);
    expect(codeOf(second.body)).toBe('SESSION_REQUIRED');
    expect(h.api.requests).toHaveLength(1);
  });

  it('403 and 422 from the API pass through unchanged', async () => {
    for (const status of [403, 422]) {
      h.api.respond = (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(`{"errors":[{"code":"FROM_API_${status}"}]}`);
      };
      const res = await h.read('/v1/portfolio', cookie);
      expect(res.status).toBe(status);
      expect(res.body).toBe(`{"errors":[{"code":"FROM_API_${status}"}]}`);
    }
    expect(h.gateway.sessions.size).toBe(1);
  });
});

describe('paths that would leave /v1 once a URL parser resolves them', () => {
  const ambiguous = ['/v1/../metrics', '/v1/%2e%2e/ready', '/v1/%2E%2E/live', '/v1/a%2fb', '/v1//x', '/v1/a\\b', '/v1/./portfolio', '/v1/%5c', 'http://evil.test/v1/portfolio'];

  for (const path of ambiguous) {
    it(`${path} is 400 with no upstream call`, async () => {
      const res = await h.read(path, cookie);
      expect(res.status).toBe(400);
      expect(codeOf(res.body)).toBe('PATH_REJECTED');
      expect(h.api.requests).toHaveLength(0);
    });
  }

  it('nothing outside /v1 is relayed: /metrics, /ready and /public/v1 are the gateway 404', async () => {
    for (const path of ['/metrics', '/ready', '/live', '/health', '/public/v1/verify']) {
      const res = await h.read(path, cookie);
      expect(res.status, path).toBe(404);
    }
    expect(h.api.requests).toHaveLength(0);
  });

  it('a request with no session is 401 with no upstream call', async () => {
    const res = await h.read('/v1/portfolio', '');
    expect(res.status).toBe(401);
    expect(codeOf(res.body)).toBe('SESSION_REQUIRED');
    expect(h.api.requests).toHaveLength(0);
  });
});
