import { describe, it, expect, vi } from 'vitest';
import { createPkcePair, loginWithDeviceCode, loginWithPkce } from '../../src/auth/login-flows.js';
import { resetOidcCaches } from '../../src/auth/oidc.js';
import crypto from 'node:crypto';

const ISSUER = 'https://idp.ejemplo.mx';
const CFG = { issuer: ISSUER, clientId: 'cli-1', audience: 'https://api.mx' };

const DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  device_authorization_endpoint: `${ISSUER}/device`,
};

function idp(handlers: {
  device?: () => Response;
  token?: (body: URLSearchParams, call: number) => Response;
  doc?: Record<string, unknown>;
}) {
  let tokenCalls = 0;
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    if (u.endsWith('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify(handlers.doc ?? DOC), { status: 200 });
    }
    if (u.endsWith('/device')) return handlers.device?.() ?? new Response('{}', { status: 200 });
    if (u.endsWith('/token')) {
      const body = new URLSearchParams((init?.body as string) ?? '');
      return handlers.token?.(body, tokenCalls++) ?? new Response('{}', { status: 200 });
    }
    return new Response('no', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('PKCE', () => {
  it('the challenge is the SHA-256 of the verifier in base64url', () => {
    const { verifier, challenge } = createPkcePair();
    const expected = crypto.createHash('sha256').update(verifier).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
    // No padding and no characters that need URL escaping.
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it('each attempt uses a distinct verifier', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});

describe('loginWithPkce', () => {
  it('sends the S256 challenge and exchanges the code for the token', async () => {
    resetOidcCaches();
    let authUrl = '';
    const fetchImpl = idp({
      token: () =>
        new Response(JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_in: 900 }), { status: 200 }),
    });

    const presenter = {
      // The presenter receives the URL with the listener already listening:
      // the browser returning the code to that port is simulated.
      showUrl: async (url: string) => {
        authUrl = url;
        const u = new URL(url);
        const redirect = new URL(u.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('code', 'code-abc');
        redirect.searchParams.set('state', u.searchParams.get('state')!);
        await fetch(redirect.toString()).catch(() => undefined);
      },
    };

    const token = await loginWithPkce(CFG, presenter, { fetchImpl, timeoutMs: 5000 });

    expect(token.accessToken).toBe('tok');
    expect(token.refreshToken).toBe('ref');
    expect(token.expiresAt).toBeGreaterThan(Date.now());
    const u = new URL(authUrl);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('discards the response if the state does not match (injected code)', async () => {
    resetOidcCaches();
    const fetchImpl = idp({});
    const presenter = {
      showUrl: async (url: string) => {
        const u = new URL(url);
        const redirect = new URL(u.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('code', 'third-party-code');
        redirect.searchParams.set('state', 'wrong-state');
        await fetch(redirect.toString()).catch(() => undefined);
      },
    };
    await expect(loginWithPkce(CFG, presenter, { fetchImpl, timeoutMs: 4000 }))
      .rejects.toThrow(/state/);
  });

  it('propagates the error the provider returns', async () => {
    resetOidcCaches();
    const fetchImpl = idp({});
    const presenter = {
      showUrl: async (url: string) => {
        const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!);
        redirect.searchParams.set('error', 'access_denied');
        await fetch(redirect.toString()).catch(() => undefined);
      },
    };
    await expect(loginWithPkce(CFG, presenter, { fetchImpl, timeoutMs: 4000 }))
      .rejects.toThrow(/access_denied/);
  });
});

describe('loginWithDeviceCode', () => {
  const startOk = () =>
    new Response(JSON.stringify({
      device_code: 'dev-1', user_code: 'ABCD-EFGH',
      verification_uri: `${ISSUER}/activate`, interval: 1, expires_in: 60,
    }), { status: 200 });

  it('waits while pending and delivers the token upon authorization', async () => {
    resetOidcCaches();
    const fetchImpl = idp({
      device: startOk,
      token: (_b, call) =>
        call < 2
          ? new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 })
          : new Response(JSON.stringify({ access_token: 'tok-dev', expires_in: 600 }), { status: 200 }),
    });
    const codes: string[] = [];
    const token = await loginWithDeviceCode(
      CFG,
      { showUrl: () => undefined, showCode: (c) => codes.push(c) },
      { fetchImpl, sleep: async () => undefined }
    );
    expect(token.accessToken).toBe('tok-dev');
    expect(codes).toEqual(['ABCD-EFGH']);
  });

  it('honors slow_down by increasing the wait', async () => {
    resetOidcCaches();
    const waits: number[] = [];
    const fetchImpl = idp({
      device: startOk,
      token: (_b, call) =>
        call === 0
          ? new Response(JSON.stringify({ error: 'slow_down' }), { status: 400 })
          : new Response(JSON.stringify({ access_token: 'tok', expires_in: 60 }), { status: 200 }),
    });
    await loginWithDeviceCode(
      CFG,
      { showUrl: () => undefined },
      { fetchImpl, sleep: async (ms) => { waits.push(ms); } }
    );
    // The provider asked to go slower: the second wait is longer.
    expect(waits[1]).toBeGreaterThan(waits[0]);
  });

  it('fails clearly if the provider does not support the device flow', async () => {
    resetOidcCaches();
    const noDevice = { ...DOC };
    delete (noDevice as Record<string, unknown>).device_authorization_endpoint;
    const fetchImpl = idp({ doc: noDevice });
    await expect(
      loginWithDeviceCode(CFG, { showUrl: () => undefined }, { fetchImpl, sleep: async () => undefined })
    ).rejects.toThrow(/does not support/);
  });

  it('propagates the provider rejection', async () => {
    resetOidcCaches();
    const fetchImpl = idp({
      device: startOk,
      token: () => new Response(JSON.stringify({ error: 'expired_token', error_description: 'it expired' }), { status: 400 }),
    });
    await expect(
      loginWithDeviceCode(CFG, { showUrl: () => undefined }, { fetchImpl, sleep: async () => undefined })
    ).rejects.toThrow(/it expired/);
  });
});
