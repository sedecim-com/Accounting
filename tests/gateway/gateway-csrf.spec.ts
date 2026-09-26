import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_ORIGIN, startHarness, type Harness, type RequestHeaders } from './helpers/harness.js';

// ============================================================
// W0 · the browser session cannot act cross-site.
//
// The named case is the API's CFDI stamp: POST /v1/invoices/<uuid>/cfdi/stamp
// takes no body, so a cross-site form or a no-cors fetch could fire it if a
// cookie were enough. With a valid session in the jar, every cross-site shape
// is 403; the same-origin one gets past CSRF and is still 405, because the
// proxy relays reads only. The API receives nothing in every case.
// ============================================================

const STAMP = '/v1/invoices/3f0a4a3e-8c55-4a53-9b2f-6c7c1b2c9d11/cfdi/stamp';

let h: Harness;
let cookie: string;

beforeEach(async () => {
  h = await startHarness();
  cookie = await h.signIn();
});

afterEach(async () => {
  await h.close();
});

function codeOf(body: string): string {
  return (JSON.parse(body) as { errors: Array<{ code: string }> }).errors[0].code;
}

describe('a body-less POST to the stamp route with a live session', () => {
  const crossSite: Array<[string, RequestHeaders]> = [
    ['a foreign Origin', { 'x-mnemosine-request': '1', origin: 'https://evil.test' }],
    ['a same-site sibling Origin', { 'x-mnemosine-request': '1', origin: 'http://sibling.localhost:8080' }],
    ['Sec-Fetch-Site cross-site', { 'x-mnemosine-request': '1', origin: PUBLIC_ORIGIN, 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site same-site', { 'x-mnemosine-request': '1', origin: PUBLIC_ORIGIN, 'sec-fetch-site': 'same-site' }],
    ['no CSRF header (a plain form post)', { origin: PUBLIC_ORIGIN }],
    ['no Origin at all', { 'x-mnemosine-request': '1' }],
    ['an Origin that only starts like ours', { 'x-mnemosine-request': '1', origin: `${PUBLIC_ORIGIN}.evil.test` }],
  ];

  for (const [name, headers] of crossSite) {
    it(`with ${name} is 403 and the API receives nothing`, async () => {
      const res = await h.request('POST', STAMP, { cookie, ...headers });
      expect(res.status).toBe(403);
      expect(codeOf(res.body)).toBe('CSRF_REJECTED');
      expect(h.api.requests).toHaveLength(0);
    });
  }

  it('same-origin with the header gets past CSRF and is 405: the proxy relays reads only', async () => {
    const res = await h.request('POST', STAMP, {
      cookie,
      'x-mnemosine-request': '1',
      origin: PUBLIC_ORIGIN,
      'sec-fetch-site': 'same-origin',
    });
    expect(res.status).toBe(405);
    expect(codeOf(res.body)).toBe('METHOD_NOT_PROXIED');
    expect(h.api.requests).toHaveLength(0);
  });

  it('PUT, PATCH and DELETE are refused the same way', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await h.request(method, STAMP, { cookie, 'x-mnemosine-request': '1', origin: PUBLIC_ORIGIN });
      expect(res.status, method).toBe(405);
    }
    expect(h.api.requests).toHaveLength(0);
  });
});

describe('reads and preflights', () => {
  it('a GET without the CSRF header is 403, so an <img> or a link cannot read through the session', async () => {
    const res = await h.request('GET', '/v1/portfolio', { cookie });
    expect(res.status).toBe(403);
    expect(h.api.requests).toHaveLength(0);
  });

  it('a CORS preflight never gets a CORS answer', async () => {
    const preflight = await h.request('OPTIONS', '/v1/portfolio', {
      origin: 'https://evil.test',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-mnemosine-request',
    });
    expect([403, 405]).toContain(preflight.status);
    expect(Object.keys(preflight.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);

    const sameOrigin = await h.request('OPTIONS', '/v1/portfolio', { cookie, 'x-mnemosine-request': '1', origin: PUBLIC_ORIGIN });
    expect(sameOrigin.status).toBe(405);

    const outside = await h.request('OPTIONS', '/', { origin: 'https://evil.test', 'access-control-request-method': 'GET' });
    expect(outside.status).toBe(405);
    expect(Object.keys(outside.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
    expect(h.api.requests).toHaveLength(0);
  });
});

describe('logout', () => {
  it('with a foreign Origin is 403 and the session survives', async () => {
    const res = await h.request('POST', '/auth/logout', { cookie, 'x-mnemosine-request': '1', origin: 'https://evil.test' });
    expect(res.status).toBe(403);
    expect(h.gateway.sessions.size).toBe(1);
    const still = await h.read('/v1/portfolio', cookie);
    expect(still.status).toBe(200);
  });

  it('without the CSRF header is 403 and the session survives', async () => {
    const res = await h.request('POST', '/auth/logout', { cookie, origin: PUBLIC_ORIGIN });
    expect(res.status).toBe(403);
    expect(h.gateway.sessions.size).toBe(1);
  });
});

describe('the Host guard', () => {
  it('a wrong Host is 421 on every path, before anything else runs', async () => {
    for (const [method, path] of [
      ['GET', '/'],
      ['GET', '/auth/login'],
      ['GET', '/auth/callback?code=x&state=y'],
      ['POST', '/auth/logout'],
      ['GET', '/v1/portfolio'],
      ['GET', '/nothing-here'],
      ['HEAD', '/healthz'],
      ['POST', '/healthz'],
    ] as const) {
      const res = await h.request(method, path, {
        host: 'rebound.evil.test:8080',
        cookie,
        'x-mnemosine-request': '1',
        origin: PUBLIC_ORIGIN,
      });
      expect(res.status, `${method} ${path}`).toBe(421);
    }
    expect(h.api.requests).toHaveLength(0);
    expect(h.idp.tokenCalls).toHaveLength(1);
  });

  it('GET /healthz answers any Host, because probes address the pod IP', async () => {
    const res = await h.request('GET', '/healthz', { host: '10.0.3.7:8080' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });
});
