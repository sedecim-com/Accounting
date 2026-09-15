import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { createPkcePair } from '../auth/login-flows.js';
import {
  clearLoginCookie,
  clearSessionCookie,
  LOGIN_COOKIE,
  LOGIN_TRANSACTION_SECONDS,
  loginCookie,
  parseCookies,
  SESSION_COOKIE,
  sessionCookie,
} from './cookies.js';
import { handleAsync, sendError } from './errors.js';
import type { GatewayLogger } from './logger.js';
import type { OidcClient } from './oidc-client.js';
import { open, seal } from './sealed-cookie.js';
import { sessionKey, sessionTag, type SessionRecord, type SessionStore, type SessionTokens } from './session-store.js';

// ============================================================
// THE THREE SESSION ROUTES
//
// /auth/login   → 303 to the IdP with PKCE S256 and a fresh state, the
//                 transaction sealed in the login cookie. It reads no query
//                 parameter at all: there is no return-to, so there is no open
//                 redirect, and it allocates no server state. The session this
//                 browser already holds is named inside the sealed
//                 transaction: the SPA reaches /auth/login by a same-origin
//                 navigation, which carries the Strict session cookie, while
//                 the IdP's redirect back to the callback is cross-site and
//                 carries only the Lax login cookie.
// /auth/callback → the checks run BEFORE any token request, cheapest and most
//                 attacker-controlled first: IdP error, RFC 9207 iss, the
//                 sealed transaction and its expiry, state in constant time.
//                 Only then the code is exchanged and the token verified. A
//                 fresh session id replaces the browser's, so a planted id
//                 (fixation) buys nothing, and the session the browser held
//                 ends. Every failure lands on '/#/signin-failed' with nothing
//                 reflected.
//
// Tokens a sign-in retires (the browser's previous session, the principal's
// own oldest one past its bound, or the fresh ones a full store refused) are
// forgotten at once, and revoked at the IdP only when their principal holds no
// other live session here. Revocation may be grant-wide (RFC 7009 lets an IdP
// invalidate every token of the grant), so revoking a same-person session
// could sign that person out of the session being created.
// /auth/logout  → behind the CSRF guard. Destroys the session, revokes its
//                 tokens at the IdP when it offers revocation, clears the
//                 cookie and tells the browser where to go next.
// ============================================================

export const SIGNIN_FAILED_LOCATION = '/#/signin-failed';

export interface AuthRouteDeps {
  oidc: OidcClient;
  sessions: SessionStore;
  clock: () => number;
  randomBytes: (size: number) => Buffer;
  logger: GatewayLogger;
  /** Per-process key for the login cookie; never configured. */
  loginKey: Buffer;
  sessionAbsoluteSeconds: number;
}

interface LoginTransaction {
  v: 1;
  state: string;
  verifier: string;
  exp: number;
  /** The session key (a SHA-256 hex) of the session this browser held at /auth/login. */
  previous?: string;
}

function isLoginTransaction(value: unknown): value is LoginTransaction {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return (
    t.v === 1 &&
    typeof t.state === 'string' &&
    typeof t.verifier === 'string' &&
    typeof t.exp === 'number' &&
    (t.previous === undefined || (typeof t.previous === 'string' && /^[0-9a-f]{64}$/.test(t.previous)))
  );
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === 'string' ? value : undefined;
}

/** Revokes what a sign-in retired, for each principal that holds no live session any more. */
async function revokeUnheld(deps: AuthRouteDeps, retired: ReadonlyArray<SessionRecord | SessionTokens>): Promise<void> {
  for (const tokens of retired) {
    if (deps.sessions.hasLive(tokens.principal)) continue;
    try {
      await deps.oidc.revoke(tokens);
    } catch {
      deps.logger.event('session.revocation_failed');
    }
  }
}

export function createLoginRoute(deps: AuthRouteDeps): RequestHandler {
  return handleAsync(async function login(req, res) {
    noStore(res);
    const current = deps.sessions.find(parseCookies(req.headers.cookie).get(SESSION_COOKIE));
    const { verifier, challenge } = createPkcePair();
    const state = deps.randomBytes(32).toString('base64url');
    let location: string;
    try {
      location = await deps.oidc.authorizationUrl(state, challenge);
    } catch {
      deps.logger.event('login.discovery_failed');
      res.redirect(303, SIGNIN_FAILED_LOCATION);
      return;
    }
    const transaction: LoginTransaction = {
      v: 1,
      state,
      verifier,
      exp: deps.clock() + LOGIN_TRANSACTION_SECONDS * 1000,
      ...(current ? { previous: current.key } : {}),
    };
    res.setHeader('Set-Cookie', loginCookie(seal(deps.loginKey, LOGIN_COOKIE, transaction, deps.randomBytes(12))));
    res.redirect(303, location);
  });
}

export function createCallbackRoute(deps: AuthRouteDeps): RequestHandler {
  return handleAsync(async function callback(req, res) {
    noStore(res);
    res.append('Set-Cookie', clearLoginCookie());
    const fail = (reason: string) => {
      deps.logger.event('login.rejected', { reason });
      res.redirect(303, SIGNIN_FAILED_LOCATION);
    };

    if (req.query.error !== undefined) return fail('idp_error');

    const cookies = parseCookies(req.headers.cookie);
    let issuer: string;
    try {
      issuer = (await deps.oidc.discovery()).issuer;
    } catch {
      return fail('discovery');
    }
    if (req.query.iss !== undefined && queryString(req, 'iss') !== issuer) return fail('issuer');

    const sealed = cookies.get(LOGIN_COOKIE);
    const transaction = sealed ? open(deps.loginKey, LOGIN_COOKIE, sealed) : undefined;
    if (!isLoginTransaction(transaction)) return fail('transaction');
    if (transaction.exp <= deps.clock()) return fail('transaction_expired');
    const state = queryString(req, 'state');
    if (state === undefined || !sameString(state, transaction.state)) return fail('state');
    const code = queryString(req, 'code');
    if (code === undefined || code === '') return fail('code');

    let tokens: SessionTokens;
    try {
      tokens = await deps.oidc.exchangeCode(code, transaction.verifier);
    } catch {
      return fail('token');
    }

    // The session the browser held ends: the one named at /auth/login, and
    // the one the callback carries when the IdP is same-site.
    const carried = cookies.get(SESSION_COOKIE);
    const retired: SessionRecord[] = [];
    for (const key of new Set([transaction.previous, carried === undefined ? undefined : sessionKey(carried)])) {
      if (key === undefined) continue;
      const record = deps.sessions.destroy(key);
      if (!record) continue;
      deps.logger.event('session.destroyed', { session: sessionTag(key) });
      retired.push(record);
    }
    const created = deps.sessions.create(tokens);
    for (const record of created?.displaced ?? []) {
      deps.logger.event('session.displaced');
      retired.push(record);
    }
    await revokeUnheld(deps, created ? retired : [...retired, tokens]);
    if (!created) {
      deps.logger.event('session.capacity');
      return sendError(res, 503, 'SESSION_CAPACITY');
    }
    deps.logger.event('session.created', { session: sessionTag(created.key) });
    res.append('Set-Cookie', sessionCookie(created.cookieValue, deps.sessionAbsoluteSeconds));
    res.redirect(303, '/');
  });
}

export function createLogoutRoute(deps: AuthRouteDeps): RequestHandler {
  return handleAsync(async function logout(req, res) {
    noStore(res);
    const found = deps.sessions.find(parseCookies(req.headers.cookie).get(SESSION_COOKIE));
    if (found) {
      deps.sessions.destroy(found.key);
      deps.logger.event('session.destroyed', { session: sessionTag(found.key) });
      try {
        await deps.oidc.revoke(found.record);
      } catch {
        // Best effort: the gateway already forgot the tokens; an IdP that
        // cannot be reached must not keep the user signed in here.
        deps.logger.event('session.revocation_failed', { session: sessionTag(found.key) });
      }
    }
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.status(200).json({ redirect: await deps.oidc.logoutRedirect() });
  });
}
