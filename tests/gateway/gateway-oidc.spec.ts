import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOGIN_COOKIE, SESSION_COOKIE } from '../../src/gateway/cookies.js';
import { seal } from '../../src/gateway/sealed-cookie.js';
import { SESSIONS_PER_PRINCIPAL } from '../../src/gateway/session-store.js';
import { AUDIENCE } from './helpers/fake-idp.js';
import {
  cookieFrom,
  PUBLIC_ORIGIN,
  setCookieLine,
  startHarness,
  WEB_CLIENT_SECRET,
  type Harness,
  type RawResponse,
} from './helpers/harness.js';

// ============================================================
// W0 · the gateway as an OIDC client, against an RS256 IdP in memory.
//
// The property under test: a session exists only for an access token the
// gateway obtained itself and verified (asymmetric, issuer, audience, Bearer,
// not the ID token) before storing it, at the callback and after every
// refresh. Every rejection leaves no session and at most one token request.
// ============================================================

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

async function beginLogin(query = '', cookie = ''): Promise<{ res: RawResponse; location: URL; loginPair: string; state: string }> {
  const res = await h.request('GET', `/auth/login${query}`, cookie ? { cookie } : {});
  const location = new URL(res.headers.location ?? 'about:blank');
  return { res, location, loginPair: cookieFrom(res.headers, LOGIN_COOKIE) ?? '', state: location.searchParams.get('state') ?? '' };
}

function callback(query: string, cookie: string): Promise<RawResponse> {
  return h.request('GET', `/auth/callback?${query}`, cookie ? { cookie } : {});
}

/** From now on the token endpoint issues tokens for `subject`, whatever code it gets. */
function issueFor(subject: string): void {
  h.idp.onToken = async () => {
    const access = await h.idp.signAccess({ sub: subject });
    const refresh = `refresh-${subject}-${h.idp.issued.refresh.length}`;
    h.idp.issued.access.push(access);
    h.idp.issued.refresh.push(refresh);
    return { body: { access_token: access, token_type: 'Bearer', refresh_token: refresh } };
  };
}

function revokedTokens(): string[] {
  return h.idp.revocationCalls.map((c) => c.params.get('token') ?? '');
}

function expectRejected(res: RawResponse, maxTokenCalls: number): void {
  expect(res.status).toBe(303);
  expect(res.headers.location).toBe('/#/signin-failed');
  expect(cookieFrom(res.headers, SESSION_COOKIE)).toBeUndefined();
  expect(setCookieLine(res.headers, LOGIN_COOKIE)).toMatch(/Max-Age=0/);
  expect(h.gateway.sessions.size).toBe(0);
  expect(h.idp.tokenCalls.length).toBeLessThanOrEqual(maxTokenCalls);
}

describe('/auth/login', () => {
  it('redirects to the IdP with code + PKCE S256, the exact redirect_uri, a 32-byte state, scope and audience', async () => {
    const { res, location, state } = await beginLogin();
    expect(res.status).toBe(303);
    expect(`${location.origin}${location.pathname}`).toBe(`${h.idp.issuer}/authorize`);
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('client_id')).toBe('web-client');
    expect(location.searchParams.get('redirect_uri')).toBe(`${PUBLIC_ORIGIN}/auth/callback`);
    expect(location.searchParams.get('scope')).toBe('openid email profile offline_access');
    expect(location.searchParams.get('audience')).toBe(AUDIENCE);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sets the sealed login cookie with __Host-, HttpOnly, Secure, SameSite=Lax, Path=/ and ten minutes, and no Domain', async () => {
    const { res } = await beginLogin();
    const line = setCookieLine(res.headers, LOGIN_COOKIE) ?? '';
    expect(line).toMatch(/^__Host-mnemosine_login=[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/);
    expect(line).not.toMatch(/Domain=/i);
  });

  it('ignores every query parameter: no return-to, so no open redirect', async () => {
    const { location, res } = await beginLogin('?returnTo=https%3A%2F%2Fevil.test%2F&redirect_uri=https%3A%2F%2Fevil.test%2F');
    expect(location.searchParams.get('redirect_uri')).toBe(`${PUBLIC_ORIGIN}/auth/callback`);
    expect(JSON.stringify(res.headers)).not.toContain('evil.test');
  });

  it('allocates no server state', async () => {
    for (let i = 0; i < 20; i += 1) await beginLogin();
    expect(h.gateway.sessions.size).toBe(0);
  });
});

describe('/auth/callback refuses before it asks for a token', () => {
  it('a state that does not match', async () => {
    const { loginPair } = await beginLogin();
    expectRejected(await callback(`code=${h.idp.issueCode()}&state=${'A'.repeat(43)}`, loginPair), 0);
  });

  it('a missing login cookie', async () => {
    const { state } = await beginLogin();
    expectRejected(await callback(`code=${h.idp.issueCode()}&state=${state}`, ''), 0);
  });

  it('an expired login transaction', async () => {
    const { loginPair, state } = await beginLogin();
    h.now.value += 601_000;
    expectRejected(await callback(`code=${h.idp.issueCode()}&state=${state}`, loginPair), 0);
  });

  it('a tampered login cookie (one flipped character)', async () => {
    const { loginPair, state } = await beginLogin();
    const value = loginPair.slice(LOGIN_COOKIE.length + 1);
    const flipped = value.slice(0, 20) + (value[20] === 'A' ? 'B' : 'A') + value.slice(21);
    expectRejected(await callback(`code=${h.idp.issueCode()}&state=${state}`, `${LOGIN_COOKIE}=${flipped}`), 0);
  });

  it('a login cookie sealed by another process, under another key', async () => {
    const { state } = await beginLogin();
    const forged = seal(Buffer.alloc(32, 7), LOGIN_COOKIE, { v: 1, state, verifier: 'v'.repeat(43), exp: h.now.value + 60_000 }, Buffer.alloc(12, 1));
    expectRejected(await callback(`code=${h.idp.issueCode()}&state=${state}`, `${LOGIN_COOKIE}=${forged}`), 0);
  });

  it('an iss parameter that is not the discovered issuer (RFC 9207)', async () => {
    const { loginPair, state } = await beginLogin();
    expectRejected(await callback(`code=${h.idp.issueCode()}&state=${state}&iss=https%3A%2F%2Fevil.test`, loginPair), 0);
  });

  it('an error from the IdP, which is not reflected anywhere', async () => {
    const { loginPair, state } = await beginLogin();
    const res = await callback(`error=access_denied&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E&state=${state}`, loginPair);
    expectRejected(res, 0);
    expect(res.body).not.toContain('alert(1)');
    expect(JSON.stringify(res.headers)).not.toContain('alert(1)');
    expect(JSON.stringify(res.headers)).not.toContain('access_denied');
  });
});

describe('/auth/callback refuses a token it cannot verify', () => {
  async function withTokenReply(body: Record<string, unknown>): Promise<RawResponse> {
    h.idp.onToken = () => ({ body });
    const { loginPair, state } = await beginLogin();
    return callback(`code=anything&state=${state}`, loginPair);
  }

  it('an access token for another audience', async () => {
    const access = await h.idp.signAccess({ aud: 'https://other-api.test' });
    expectRejected(await withTokenReply({ access_token: access, token_type: 'Bearer' }), 1);
  });

  it('the ID token handed back as the access token', async () => {
    const token = await h.idp.signAccess();
    expectRejected(await withTokenReply({ access_token: token, id_token: token, token_type: 'Bearer' }), 1);
  });

  it('an HS256 token, even one signed with the published development secret', async () => {
    const forged = await h.idp.signHs256('dev-secret-change-me');
    expectRejected(await withTokenReply({ access_token: forged, token_type: 'Bearer' }), 1);
  });

  it('a token_type other than Bearer', async () => {
    const access = await h.idp.signAccess();
    expectRejected(await withTokenReply({ access_token: access, token_type: 'DPoP' }), 1);
  });

  it('a token from another issuer', async () => {
    const access = await h.idp.signAccess({ iss: 'https://evil.test' });
    expectRejected(await withTokenReply({ access_token: access, token_type: 'Bearer' }), 1);
  });

  it('an oversized token response, before parsing it', async () => {
    const access = await h.idp.signAccess();
    expectRejected(await withTokenReply({ access_token: access, token_type: 'Bearer', padding: 'x'.repeat(70 * 1024) }), 1);
  });

  it('a token response without an access token', async () => {
    expectRejected(await withTokenReply({ token_type: 'Bearer', id_token: await h.idp.signAccess() }), 1);
  });

  it('a token endpoint error', async () => {
    const { loginPair, state } = await beginLogin();
    expectRejected(await callback(`code=never-issued&state=${state}`, loginPair), 1);
  });
});

describe('a successful sign-in', () => {
  it('sets a Strict __Host- session cookie, redirects to /, and puts no token in any body or header', async () => {
    const { loginPair, state, location } = await beginLogin();
    const code = h.idp.issueCode();
    const res = await callback(`code=${code}&state=${state}`, loginPair);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/');
    const line = setCookieLine(res.headers, SESSION_COOKIE) ?? '';
    expect(line).toMatch(/^__Host-mnemosine_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=28800$/);
    expect(line).not.toMatch(/Domain=/i);
    expect(h.gateway.sessions.size).toBe(1);

    const everything = JSON.stringify(res.headers) + res.body;
    expect(everything).not.toContain(h.idp.issued.access[0]);
    expect(everything).not.toContain(h.idp.issued.refresh[0]);

    // The exchange used client_secret_basic, the same redirect_uri, and the
    // verifier whose S256 is the challenge the browser carried.
    const call = h.idp.tokenCalls[0];
    expect(call.authorization).toBe(`Basic ${Buffer.from(`web-client:${WEB_CLIENT_SECRET}`).toString('base64')}`);
    expect(call.params.get('redirect_uri')).toBe(`${PUBLIC_ORIGIN}/auth/callback`);
    expect(call.params.get('code')).toBe(code);
    expect(call.params.has('client_secret')).toBe(false);
    const verifier = call.params.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(location.searchParams.get('code_challenge'));
  });

  it('replaces any session id the browser already carried (fixation)', async () => {
    const first = await h.signIn();
    const planted = `${SESSION_COOKIE}=${'P'.repeat(43)}`;
    const second = await h.signIn(first);
    const third = await h.signIn(planted);
    expect(second).not.toBe(first);
    expect(third).not.toBe(planted);
    expect((await h.read('/v1/portfolio', first)).status).toBe(401);
    expect((await h.read('/v1/portfolio', second)).status).toBe(200);
    expect(h.gateway.sessions.size).toBe(2);
  });

  it('a re-login ends the earlier session although the callback, a cross-site hop, carries no Strict session cookie', async () => {
    const first = await h.signIn();
    // The SPA's same-origin navigation to /auth/login carries the session
    // cookie; the IdP's redirect back to /auth/callback carries only the login
    // cookie, as a browser sends it.
    const { loginPair, state } = await beginLogin('', first);
    const res = await callback(`code=${h.idp.issueCode()}&state=${state}`, loginPair);
    expect(res.status).toBe(303);
    expect(cookieFrom(res.headers, SESSION_COOKIE)).toBeDefined();
    expect(h.gateway.sessions.size).toBe(1);
    expect((await h.read('/v1/portfolio', first)).status).toBe(401);
    // Same subject: the gateway forgets the old tokens but does not revoke
    // them, because an IdP may revoke the whole grant and take the new session
    // with it.
    expect(revokedTokens()).toEqual([]);
  });

  it('a re-login as someone else ends the earlier session and revokes its tokens, since its subject holds nothing else', async () => {
    const first = await h.signIn();
    issueFor('user-2');
    const second = await h.signIn(first);
    expect((await h.read('/v1/portfolio', first)).status).toBe(401);
    expect((await h.read('/v1/portfolio', second)).status).toBe(200);
    expect(revokedTokens()).toEqual([h.idp.issued.refresh[0], h.idp.issued.access[0]]);
  });

  it('one IdP subject cannot exhaust the store: its own oldest session gives way, and another subject still signs in', async () => {
    await h.close();
    h = await startHarness({ config: { sessionMax: SESSIONS_PER_PRINCIPAL + 1 } });
    const held: string[] = [];
    for (let i = 0; i < SESSIONS_PER_PRINCIPAL + 2; i += 1) {
      h.now.value += 1_000;
      held.push(await h.signIn());
    }
    expect(h.gateway.sessions.size).toBe(SESSIONS_PER_PRINCIPAL);
    const statuses = [];
    for (const cookie of held) statuses.push((await h.read('/v1/portfolio', cookie)).status);
    expect(statuses).toEqual([401, 401, ...Array.from({ length: SESSIONS_PER_PRINCIPAL }, () => 200)]);

    issueFor('someone-else');
    const other = await h.signIn();
    expect((await h.read('/v1/portfolio', other)).status).toBe(200);
  });

  it('a sign-in refused at capacity revokes the tokens it just obtained, and signs nobody out', async () => {
    await h.close();
    h = await startHarness({ config: { sessionMax: 1 } });
    const first = await h.signIn();
    issueFor('user-2');
    const { loginPair, state } = await beginLogin();
    const res = await callback(`code=anything&state=${state}`, loginPair);
    expect(res.status).toBe(503);
    expect(cookieFrom(res.headers, SESSION_COOKIE)).toBeUndefined();
    expect(revokedTokens()).toEqual([h.idp.issued.refresh[1], h.idp.issued.access[1]]);
    expect((await h.read('/v1/portfolio', first)).status).toBe(200);
  });

  it('a login transaction cannot be replayed once used', async () => {
    const { loginPair, state } = await beginLogin();
    const code = h.idp.issueCode();
    expect((await callback(`code=${code}&state=${state}`, loginPair)).status).toBe(303);
    const replay = await callback(`code=${code}&state=${state}`, loginPair);
    expect(cookieFrom(replay.headers, SESSION_COOKIE)).toBeUndefined();
    expect(h.gateway.sessions.size).toBe(1);
  });
});

describe('refresh', () => {
  const nearExpiry = () => {
    // The issued access token lives ten minutes; 9.5 minutes later less than
    // the 60 s margin is left and the next request refreshes.
    h.now.value += 9.5 * 60_000;
  };

  it('five concurrent requests trigger one refresh, and the rotated tokens are used and stored', async () => {
    const cookie = await h.signIn();
    nearExpiry();
    const slow = h.idp.onToken;
    let refreshes = 0;
    h.idp.onToken = async (params) => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      h.idp.onToken = slow;
      const access = await h.idp.signAccess();
      h.idp.issued.access.push(access);
      h.idp.issued.refresh.push('refresh-rotated');
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe(h.idp.issued.refresh[0]);
      return { body: { access_token: access, token_type: 'Bearer', refresh_token: 'refresh-rotated' } };
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => h.read('/v1/portfolio', cookie)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(refreshes).toBe(1);
    expect(h.api.requests.map((r) => r.headers.authorization)).toEqual(
      Array.from({ length: 5 }, () => `Bearer ${h.idp.issued.access[1]}`)
    );

    nearExpiry();
    await h.read('/v1/portfolio', cookie);
    const last = h.idp.tokenCalls[h.idp.tokenCalls.length - 1];
    expect(last.params.get('refresh_token')).toBe('refresh-rotated');
  });

  it('a refreshed HS256 token ends the session with 401', async () => {
    const cookie = await h.signIn();
    nearExpiry();
    const forged = await h.idp.signHs256('dev-secret-change-me');
    h.idp.onToken = () => ({ body: { access_token: forged, token_type: 'Bearer' } });
    const res = await h.read('/v1/portfolio', cookie);
    expect(res.status).toBe(401);
    expect(h.gateway.sessions.size).toBe(0);
    expect(h.api.requests).toHaveLength(0);
  });

  it('a refreshed token for another audience ends the session with 401', async () => {
    const cookie = await h.signIn();
    nearExpiry();
    const other = await h.idp.signAccess({ aud: 'https://other-api.test' });
    h.idp.onToken = () => ({ body: { access_token: other, token_type: 'Bearer' } });
    expect((await h.read('/v1/portfolio', cookie)).status).toBe(401);
    expect(h.gateway.sessions.size).toBe(0);
  });
});

describe('idle and absolute lifetimes', () => {
  it('an idle session expires after the idle limit', async () => {
    const cookie = await h.signIn();
    h.now.value += 31 * 60_000;
    const res = await h.read('/v1/portfolio', cookie);
    expect(res.status).toBe(401);
    expect(h.gateway.sessions.size).toBe(0);
  });

  it('activity keeps a session alive, but never past its absolute lifetime', async () => {
    await h.close();
    h = await startHarness({ config: { sessionAbsoluteHours: 1 } });
    const cookie = await h.signIn();
    for (let minutes = 20; minutes < 60; minutes += 20) {
      h.now.value += 20 * 60_000;
      expect((await h.read('/v1/portfolio', cookie)).status, `${minutes} min`).toBe(200);
    }
    h.now.value += 21 * 60_000;
    expect((await h.read('/v1/portfolio', cookie)).status).toBe(401);
    expect(h.gateway.sessions.size).toBe(0);
  });
});

describe('/auth/logout', () => {
  it('destroys the session, revokes both tokens, clears the cookie and returns the end-session redirect', async () => {
    const cookie = await h.signIn();
    const res = await h.request('POST', '/auth/logout', { cookie, 'x-mnemosine-request': '1', origin: PUBLIC_ORIGIN });
    expect(res.status).toBe(200);
    const redirect = new URL((JSON.parse(res.body) as { redirect: string }).redirect);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(`${h.idp.issuer}/logout`);
    expect(redirect.searchParams.get('client_id')).toBe('web-client');
    expect(redirect.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC_ORIGIN}/`);
    expect(setCookieLine(res.headers, SESSION_COOKIE)).toBe(
      '__Host-mnemosine_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'
    );
    expect(h.gateway.sessions.size).toBe(0);
    expect(h.idp.revocationCalls.map((c) => c.params.get('token'))).toEqual([
      h.idp.issued.refresh[0],
      h.idp.issued.access[0],
    ]);
    expect((await h.read('/v1/portfolio', cookie)).status).toBe(401);
  });

  it('without an end-session endpoint the redirect is /', async () => {
    h.idp.discoveryOverrides.end_session_endpoint = undefined;
    const cookie = await h.signIn();
    const res = await h.request('POST', '/auth/logout', { cookie, 'x-mnemosine-request': '1', origin: PUBLIC_ORIGIN });
    expect(JSON.parse(res.body)).toEqual({ redirect: '/' });
  });
});
