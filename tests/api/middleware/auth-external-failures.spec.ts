import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

// ============================================================
// W0 · authenticate answers 401 only when the TOKEN is refused.
//
// The web gateway destroys a browser session on an upstream 401
// (src/gateway/proxy.ts), so a 401 the API gives for an outage signs every
// browser out. This spec runs the real authenticate and the real error
// handler over an RS256 IdP served through a stubbed global fetch (the path
// verifyExternal takes in the server, with no fetch injected) and a mocked
// database, and holds the three answers apart: a refused token is 401, an IdP
// whose discovery or keys cannot be read is 502, a database error is 500.
// ============================================================

const db = vi.hoisted(() => ({
  query: undefined as undefined | ((text: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>),
}));

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn((text: string, params: unknown[] = []) => {
    if (!db.query) throw new Error('no query expected');
    return db.query(text, params);
  }),
  withTransaction: vi.fn(() => {
    throw new Error('no transaction expected');
  }),
}));

import { authenticate } from '../../../src/api/rest/middleware/auth.js';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';
import { resetOidcCaches } from '../../../src/auth/oidc.js';
import { config } from '../../../src/config/index.js';

const ISSUER = 'https://idp.auth-failures.test';
const AUDIENCE = 'https://api.auth-failures.test';
const ENTITY = '11111111-1111-4111-8111-111111111111';

const saved = { issuer: config.auth.issuer, audience: config.auth.audience, tenantId: config.auth.tenantId };
let privateKey: PrivateKey;
let otherKey: PrivateKey;
let jwk: JWK;

type Route = (url: string) => Promise<globalThis.Response>;
let discoveryRoute: Route;
let jwksRoute: Route;

const ok = (body: unknown): Promise<globalThis.Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  // config is declared readonly; the object itself is plain, and afterAll puts it back.
  Object.assign(config.auth, { issuer: ISSUER, audience: AUDIENCE, tenantId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' });
});

afterAll(() => {
  Object.assign(config.auth, saved);
});

beforeEach(() => {
  resetOidcCaches();
  discoveryRoute = () =>
    ok({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
    });
  jwksRoute = () => ok({ keys: [jwk] });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | globalThis.Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/.well-known/openid-configuration')) return discoveryRoute(url);
      if (url.endsWith('/jwks')) return jwksRoute(url);
      return Promise.resolve(new Response('no', { status: 404 }));
    })
  );
  db.query = activeUser();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.query = undefined;
});

function sign(claims: Record<string, unknown> = { sub: 'user-1', email: 'ana@example.test' }, opts: { key?: PrivateKey; exp?: string; aud?: string } = {}): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setExpirationTime(opts.exp ?? '10m')
    .sign(opts.key ?? privateKey);
}

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: 'u-1',
    tenant_id: config.auth.tenantId,
    email: 'ana@example.test',
    roles: ['viewer'],
    permissions: ['accounts:read'],
    accessible_entities: [ENTITY],
    is_active: true,
    identity_id: 'i-1',
    ...over,
  };
}

/** The identity lookup finds `row`; the login update and the session insert succeed. */
function activeUser(row: Record<string, unknown> = userRow()) {
  return (text: string) =>
    Promise.resolve(/FROM identities/.test(text) ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 1 });
}

/** Runs authenticate and, when it fails, the API's error handler: the status and code a client would get. */
async function answer(token: string): Promise<{ status: number; code?: string }> {
  const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
  const err = await new Promise<unknown>((resolve) => {
    authenticate(req, {} as Response, (e?: unknown) => resolve(e));
  });
  if (err === undefined) return { status: 200 };
  let status = 0;
  let body: { errors: Array<{ code: string }> } | undefined;
  const res = {
    status(s: number) {
      status = s;
      return res;
    },
    json(b: typeof body) {
      body = b;
      return res;
    },
  } as unknown as Response;
  errorHandler(err as Error, req, res, () => undefined);
  return { status, code: body?.errors[0]?.code };
}

describe('authenticate with an IdP token', () => {
  it('accepts a valid token for an active user with entities', async () => {
    expect(await answer(await sign())).toEqual({ status: 200 });
  });
});

describe('a refused token is 401', () => {
  it('expired', async () => {
    expect(await answer(await sign(undefined, { exp: '-1m' }))).toEqual({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('signed by another key', async () => {
    expect(await answer(await sign(undefined, { key: otherKey }))).toEqual({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('for another audience', async () => {
    expect(await answer(await sign(undefined, { aud: 'https://other.test' }))).toEqual({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('without sub', async () => {
    expect(await answer(await sign({ email: 'ana@example.test' }))).toEqual({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('for a deactivated account', async () => {
    db.query = activeUser(userRow({ is_active: false }));
    expect(await answer(await sign())).toEqual({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('on a first login whose token carries no email', async () => {
    db.query = () => Promise.resolve({ rows: [], rowCount: 0 });
    expect(await answer(await sign({ sub: 'new-user' }))).toEqual({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('while a user with no granted entity stays 403', async () => {
    db.query = activeUser(userRow({ accessible_entities: [] }));
    expect(await answer(await sign())).toEqual({ status: 403, code: 'FORBIDDEN' });
  });
});

describe('an IdP that cannot be read is 502, never 401', () => {
  it('discovery answers an HTTP error', async () => {
    discoveryRoute = () => Promise.resolve(new Response('down', { status: 503 }));
    expect(await answer(await sign())).toEqual({ status: 502, code: 'EXTERNAL_SERVICE_FAILED' });
  });

  it('discovery is unreachable', async () => {
    discoveryRoute = () => Promise.reject(new TypeError('fetch failed'));
    expect(await answer(await sign())).toEqual({ status: 502, code: 'EXTERNAL_SERVICE_FAILED' });
  });

  it('the JWKS answers an HTTP error', async () => {
    jwksRoute = () => Promise.resolve(new Response('down', { status: 500 }));
    expect(await answer(await sign())).toEqual({ status: 502, code: 'EXTERNAL_SERVICE_FAILED' });
  });

  it('the JWKS times out', async () => {
    jwksRoute = () => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    expect(await answer(await sign())).toEqual({ status: 502, code: 'EXTERNAL_SERVICE_FAILED' });
  });
});

describe('a database error is 500, never 401', () => {
  it('the identity lookup throws', async () => {
    db.query = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    expect(await answer(await sign())).toEqual({ status: 500, code: 'INTERNAL_SERVER_ERROR' });
  });

  it('the session insert throws after the user was found', async () => {
    db.query = (text: string) =>
      /INSERT INTO sessions/.test(text) ? Promise.reject(new Error('terminating connection')) : activeUser()(text);
    expect(await answer(await sign())).toEqual({ status: 500, code: 'INTERNAL_SERVER_ERROR' });
  });
});
