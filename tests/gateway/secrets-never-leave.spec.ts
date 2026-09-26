import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_COOKIE, SESSION_COOKIE } from '../../src/gateway/cookies.js';
import type { LogField } from '../../src/gateway/logger.js';
import { cookieFrom, PUBLIC_ORIGIN, startHarness, WEB_CLIENT_SECRET, type Harness, type RawResponse } from './helpers/harness.js';

// ============================================================
// W0 · the gateway's secrets never leave it.
//
// The whole flow runs with a capturing logger and spies on stdout and stderr:
// sign in, read, fail a read upstream, refresh, log out, and a few refusals.
// Then every captured byte (log lines, console output, response bodies and
// headers) is searched for the access token, the refresh tokens, the code,
// the PKCE verifier, the client secret and the raw session id. The session id
// may appear in exactly one place: the Set-Cookie that hands it to the browser.
// ============================================================

let h: Harness | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await h?.close();
  h = undefined;
});

describe('secrets never leave the gateway', () => {
  it('not in logs, console output, bodies or headers', async () => {
    const logLines: string[] = [];
    const console: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      console.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      console.push(String(chunk));
      return true;
    });
    h = await startHarness({
      logger: {
        event: (name: string, fields: Record<string, LogField> = {}) => {
          logLines.push(JSON.stringify({ name, ...fields }));
        },
      },
    });
    const responses: RawResponse[] = [];
    const keep = async (p: Promise<RawResponse>) => {
      const r = await p;
      responses.push(r);
      return r;
    };

    // Sign in by hand, keeping every response.
    const login = await keep(h.request('GET', '/auth/login'));
    const state = new URL(login.headers.location ?? '').searchParams.get('state') ?? '';
    const code = h.idp.issueCode();
    const callback = await keep(
      h.request('GET', `/auth/callback?code=${code}&state=${state}`, { cookie: cookieFrom(login.headers, LOGIN_COOKIE) ?? '' })
    );
    const sessionPair = cookieFrom(callback.headers, SESSION_COOKIE) ?? '';
    const sessionId = sessionPair.slice(SESSION_COOKIE.length + 1);
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await keep(h.read('/v1/portfolio', sessionPair));
    h.api.respond = (_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"errors":[{"code":"INTERNAL"}]}');
    };
    await keep(h.read('/v1/portfolio', sessionPair));
    h.now.value += 9.5 * 60_000;
    h.api.respond = (_req, res) => res.end('{}');
    await keep(h.read('/v1/portfolio', sessionPair));
    await keep(h.request('GET', `/auth/callback?code=${code}&state=wrong`, { cookie: sessionPair }));
    await keep(h.request('POST', '/v1/portfolio', { cookie: sessionPair, 'x-mnemosine-request': '1', origin: PUBLIC_ORIGIN }));
    await keep(h.request('POST', '/auth/logout', { cookie: sessionPair, 'x-mnemosine-request': '1', origin: PUBLIC_ORIGIN }));
    await keep(h.read('/v1/portfolio', sessionPair));

    const verifier = h.idp.tokenCalls[0].params.get('code_verifier') ?? '';
    expect(h.idp.issued.access.length).toBeGreaterThanOrEqual(2);
    expect(h.idp.issued.refresh.length).toBeGreaterThanOrEqual(2);
    const secrets: Record<string, string> = {
      'client secret': WEB_CLIENT_SECRET,
      'authorization code': code,
      'PKCE verifier': verifier,
      ...Object.fromEntries(h.idp.issued.access.map((t, i) => [`access token ${i}`, t])),
      ...Object.fromEntries(h.idp.issued.refresh.map((t, i) => [`refresh token ${i}`, t])),
    };

    const logged = logLines.join('\n') + console.join('');
    const served = responses.map((r) => JSON.stringify(r.headers) + r.body).join('\n');
    for (const [name, secret] of Object.entries(secrets)) {
      expect(secret.length, name).toBeGreaterThan(8);
      expect(logged.includes(secret), `${name} in logs`).toBe(false);
      expect(served.includes(secret), `${name} in a response`).toBe(false);
    }

    expect(logged.includes(sessionId), 'session id in logs').toBe(false);
    const carriers = responses.flatMap((r) =>
      [...(r.headers['set-cookie'] ?? []), JSON.stringify({ ...r.headers, 'set-cookie': undefined }), r.body].filter((s) => s.includes(sessionId))
    );
    expect(carriers).toEqual([`${sessionPair}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`]);
    expect(logLines.length).toBeGreaterThan(0);
  });
});
