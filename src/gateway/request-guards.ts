import type { RequestHandler } from 'express';
import { isTokenRejection } from '../auth/oidc.js';
import type { GatewayConfig } from './config.js';
import { parseCookies, SESSION_COOKIE } from './cookies.js';
import { sendError, handleAsync } from './errors.js';
import type { GatewayLogger } from './logger.js';
import { TokenRejected, type OidcClient } from './oidc-client.js';
import { isProxiedMethod } from './routes.js';
import { sessionTag, type RefreshOutcome, type SessionRecord, type SessionStore } from './session-store.js';

// ============================================================
// THE GUARDS IN FRONT OF THE PROXY
//
// Order matters and is pinned in server.ts (criterion
// browser-session-is-not-ambient-authority): path, CSRF, method, session. A
// request any of them refuses never reaches the API, and the session guard
// runs last so a refused request does not even refresh a token.
//
//   · hostGuard (every path): 421 unless Host is the public origin's host.
//     A loopback gateway is otherwise reachable through DNS rebinding: an
//     attacker's name resolving to 127.0.0.1 would be same-origin to itself
//     and carry nothing the CSRF guard could tell apart. GET /healthz is the
//     one exemption, because probes address the pod IP.
//   · pathGuard: the upstream URL is built with WHATWG URL, which resolves
//     `..` and `%2e%2e` segments. `/v1/%2e%2e/metrics` would leave the /v1
//     prefix upstream while matching it here, so any encoded dot, slash or
//     backslash, dot segment or empty segment is refused on the raw URL.
//   · csrfGuard: a custom header (a cross-site form or img cannot send one,
//     and a cross-site fetch that does triggers a preflight nobody answers),
//     Sec-Fetch-Site same-origin when the browser sends it, and for unsafe
//     methods an Origin byte-equal to the public origin. POST /auth/logout
//     gets the same guard.
//   · methodGate: GET and HEAD only; see PROXIED_METHODS.
//   · sessionGuard: a live session, refreshed single-flight when its access
//     token has less than a minute left. Only a verdict of the IdP ends the
//     session; an IdP that cannot answer leaves it as it was, a refresh never
//     outlives the session, and a session with no refresh token lives out its
//     access token (below).
// ============================================================

export const CSRF_HEADER = 'x-mnemosine-request';
export const REFRESH_MARGIN_MS = 60_000;

export interface SessionLocals {
  key: string;
  record: SessionRecord;
}

export function createHostGuard(config: Pick<GatewayConfig, 'publicOrigin'>): RequestHandler {
  const expectedHost = new URL(config.publicOrigin).host.toLowerCase();
  return function hostGuard(req, res, next) {
    if (req.method === 'GET' && req.path === '/healthz') return next();
    const host = req.headers.host?.toLowerCase();
    if (host !== expectedHost) return sendError(res, 421, 'HOST_REJECTED');
    next();
  };
}

/** True when the raw path could mean something else once a URL parser resolves it. */
export function isAmbiguousPath(originalUrl: string): boolean {
  const query = originalUrl.indexOf('?');
  const rawPath = query === -1 ? originalUrl : originalUrl.slice(0, query);
  if (/%2e|%2f|%5c/i.test(rawPath)) return true;
  if (rawPath.includes('\\') || rawPath.includes('//')) return true;
  return rawPath.split('/').some((segment) => segment === '.' || segment === '..');
}

export const pathGuard: RequestHandler = (req, res, next) => {
  if (isAmbiguousPath(req.originalUrl)) return sendError(res, 400, 'PATH_REJECTED');
  next();
};

export function createCsrfGuard(config: Pick<GatewayConfig, 'publicOrigin'>): RequestHandler {
  return function csrfGuard(req, res, next) {
    if (req.headers[CSRF_HEADER] !== '1') return sendError(res, 403, 'CSRF_REJECTED');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return sendError(res, 403, 'CSRF_REJECTED');
    if (!isProxiedMethod(req.method) && req.headers.origin !== config.publicOrigin) {
      return sendError(res, 403, 'CSRF_REJECTED');
    }
    next();
  };
}

export const methodGate: RequestHandler = (req, res, next) => {
  if (!isProxiedMethod(req.method)) return sendError(res, 405, 'METHOD_NOT_PROXIED');
  next();
};

export interface SessionGuardDeps {
  sessions: SessionStore;
  oidc: OidcClient;
  clock: () => number;
  logger: GatewayLogger;
}

// ============================================================
// A REFRESH ENDS THE SESSION ONLY ON A VERDICT.
//
// It used to end it on any failure, so every browser whose access token
// entered the refresh margin while the IdP was down was signed out, with a
// token that still worked and a refresh token that would have worked a minute
// later. Now a failure is one of two things:
//   · refused: the token endpoint answered 4xx (TokenRejected), or the token
//     it returned failed acceptTokenResponse (TokenRejected, or a jose verdict
//     read by isTokenRejection). The session is destroyed: 401.
//   · unavailable: anything else. The endpoint unreachable or timed out, a
//     5xx/408/429 (IdpUnavailable), discovery or the keys unreadable while the
//     new token was checked. The session keeps its tokens, the request goes on
//     with the access token while it is still valid, and after that it answers
//     502 IDP_UNAVAILABLE until a refresh gets through. The idle and absolute
//     lifetimes still bound how long it can wait.
// One case is lost even so: an IdP that rotated the refresh token, and whose
// answer then timed out or whose keys could not be read, has spent the one the
// session holds. The next refresh is refused, a verdict, and that ends it.
//
// Two more rules, from Witness (#249):
//   · WIT-01. A refresh that SUCCEEDS is an await too, and the session can
//     cross its idle or absolute limit while it waits. The store refuses to
//     replace the tokens of an ended session, and the guard asks the store
//     again after every refresh, whatever its outcome: only a session that is
//     still alive is touched and relayed. Touching first would restart the
//     idle clock of a session that had already ended.
//   · WIT-02. A session without a refresh token is not a refused one. An IdP
//     may admit a login without refresh_token (offline_access is a request,
//     not a guarantee). There is nothing to renew, so the access token serves
//     until it expires, bounded like any other by the idle and absolute
//     lifetimes; then the session ends with 401 and a new sign-in.
// ============================================================

function isRefusal(err: unknown): boolean {
  return err instanceof TokenRejected || isTokenRejection(err);
}

/**
 * Refreshes the session's access token once, however many requests arrive
 * while it runs. A refreshed token passes acceptTokenResponse before it
 * replaces the old one; a refusal destroys the session.
 */
async function refreshOnce(deps: SessionGuardDeps, key: string, record: SessionRecord): Promise<RefreshOutcome> {
  if (!record.refreshing) {
    const refreshToken = record.refreshToken;
    record.refreshing = (async (): Promise<RefreshOutcome> => {
      // The guard never gets here without one (WIT-02); if it did, there is
      // nothing to renew and nothing to wait for.
      if (!refreshToken) return 'refused';
      try {
        const tokens = await deps.oidc.refresh(refreshToken);
        return deps.sessions.replaceTokens(key, tokens) ? 'refreshed' : 'refused';
      } catch (err) {
        if (isRefusal(err)) {
          deps.logger.event('session.refresh_failed', { session: sessionTag(key) });
          return 'refused';
        }
        deps.logger.event('session.refresh_unavailable', { session: sessionTag(key) });
        return 'unavailable';
      }
    })().finally(() => {
      record.refreshing = undefined;
    });
  }
  const outcome = await record.refreshing;
  if (outcome === 'refused') deps.sessions.destroy(key);
  return outcome;
}

export function createSessionGuard(deps: SessionGuardDeps): RequestHandler {
  return handleAsync(async function sessionGuard(req, res, next) {
    const cookie = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    const found = deps.sessions.find(cookie);
    if (!found) return sendError(res, 401, 'SESSION_REQUIRED');
    const { key, record } = found;
    if (record.accessExpiresAt - deps.clock() < REFRESH_MARGIN_MS) {
      if (!record.refreshToken) {
        // Nothing to renew (WIT-02): use the access token until it expires.
        if (record.accessExpiresAt <= deps.clock()) {
          deps.sessions.destroy(key);
          return sendError(res, 401, 'SESSION_EXPIRED');
        }
      } else {
        const outcome = await refreshOnce(deps, key, record);
        if (outcome === 'refused') return sendError(res, 401, 'SESSION_EXPIRED');
        // A sign-out or an expiry while the refresh waited is not undone by
        // relaying, neither with the tokens it left behind nor with the ones
        // it brought (WIT-01).
        if (!deps.sessions.find(cookie)) return sendError(res, 401, 'SESSION_EXPIRED');
        if (outcome === 'unavailable' && record.accessExpiresAt <= deps.clock()) {
          return sendError(res, 502, 'IDP_UNAVAILABLE');
        }
      }
    }
    deps.sessions.touch(key);
    const locals: SessionLocals = { key, record };
    res.locals.session = locals;
    next();
  });
}
