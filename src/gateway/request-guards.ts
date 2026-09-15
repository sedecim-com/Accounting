import type { RequestHandler } from 'express';
import type { GatewayConfig } from './config.js';
import { parseCookies, SESSION_COOKIE } from './cookies.js';
import { sendError, handleAsync } from './errors.js';
import type { GatewayLogger } from './logger.js';
import type { OidcClient } from './oidc-client.js';
import { isProxiedMethod } from './routes.js';
import { sessionTag, type SessionRecord, type SessionStore } from './session-store.js';

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
//     token has less than a minute left.
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

/**
 * Refreshes the session's access token once, however many requests arrive
 * while it runs. A refreshed token passes acceptTokenResponse before it
 * replaces the old one; a failure destroys the session.
 */
async function refreshOnce(deps: SessionGuardDeps, key: string, record: SessionRecord): Promise<boolean> {
  if (!record.refreshing) {
    const refreshToken = record.refreshToken;
    record.refreshing = (async () => {
      if (!refreshToken) return false;
      try {
        const tokens = await deps.oidc.refresh(refreshToken);
        return deps.sessions.replaceTokens(key, tokens);
      } catch {
        deps.logger.event('session.refresh_failed', { session: sessionTag(key) });
        return false;
      }
    })().finally(() => {
      record.refreshing = undefined;
    });
  }
  const refreshed = await record.refreshing;
  if (!refreshed) deps.sessions.destroy(key);
  return refreshed;
}

export function createSessionGuard(deps: SessionGuardDeps): RequestHandler {
  return handleAsync(async function sessionGuard(req, res, next) {
    const found = deps.sessions.find(parseCookies(req.headers.cookie).get(SESSION_COOKIE));
    if (!found) return sendError(res, 401, 'SESSION_REQUIRED');
    const { key, record } = found;
    if (record.accessExpiresAt - deps.clock() < REFRESH_MARGIN_MS) {
      const refreshed = await refreshOnce(deps, key, record);
      if (!refreshed) return sendError(res, 401, 'SESSION_EXPIRED');
    }
    deps.sessions.touch(key);
    const locals: SessionLocals = { key, record };
    res.locals.session = locals;
    next();
  });
}
