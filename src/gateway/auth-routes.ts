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
import { sessionKey, sessionTag, type SessionStore } from './session-store.js';

// ============================================================
// THE THREE SESSION ROUTES
//
// /auth/login   → 303 to the IdP with PKCE S256 and a fresh state, the
//                 transaction sealed in the login cookie. It reads no query
//                 parameter at all: there is no return-to, so there is no open
//                 redirect, and it allocates no server state.
// /auth/callback → the checks run BEFORE any token request, cheapest and most
//                 attacker-controlled first: IdP error, RFC 9207 iss, the
//                 sealed transaction and its expiry, state in constant time.
//                 Only then the code is exchanged and the token verified. A
//                 fresh session id replaces any the browser already carried,
//                 so a planted id (fixation) buys nothing. Every failure lands
//                 on '/#/signin-failed' with nothing reflected.
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
}

function isLoginTransaction(value: unknown): value is LoginTransaction {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return t.v === 1 && typeof t.state === 'string' && typeof t.verifier === 'string' && typeof t.exp === 'number';
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

export function createLoginRoute(deps: AuthRouteDeps): RequestHandler {
  return handleAsync(async function login(_req, res) {
    noStore(res);
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

    let tokens;
    try {
      tokens = await deps.oidc.exchangeCode(code, transaction.verifier);
    } catch {
      return fail('token');
    }

    const previous = cookies.get(SESSION_COOKIE);
    if (previous) deps.sessions.destroy(sessionKey(previous));
    const created = deps.sessions.create(tokens);
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
