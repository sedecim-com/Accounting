import { Readable } from 'node:stream';
import type { RequestHandler } from 'express';
import type { GatewayConfig } from './config.js';
import { sendError, handleAsync } from './errors.js';
import type { GatewayLogger } from './logger.js';
import type { SessionLocals } from './request-guards.js';
import { API_CONTENT_SECURITY_POLICY } from './security-headers.js';
import type { SessionStore } from './session-store.js';
import { sessionTag } from './session-store.js';

// ============================================================
// THE RELAY TO /v1
//
// Everything here is an allow-list, because the proxy sits between a browser
// that anyone can script and an API that believes its Authorization header.
//
//   · Request headers: only the four a read needs. The gateway writes
//     `authorization` itself from the session; a client's own Authorization
//     (a forged HS256 token, say) never travels. Nor do cookies, forwarding
//     headers or the CSRF header. x-forwarded-for is the address Express
//     resolved under GATEWAY_TRUST_PROXY, overwriting whatever the client
//     wrote, so the API's per-IP limiter keeps working when its TRUST_PROXY
//     names the gateway.
//   · No request body, no redirects followed: a 3xx from upstream is a 502,
//     so the API can never send the session somewhere else.
//   · Response headers: only what a reader needs. Set-Cookie, Location,
//     Access-Control-* and WWW-Authenticate stay behind.
//   · An upstream 401 ends the session: the token it holds no longer works.
//     The API keeps 401 for a verdict on the token (middleware/auth.ts); a
//     database or IdP outage answers 5xx, which is relayed and keeps the
//     session, so an outage does not sign every browser out.
// ============================================================

export const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'if-none-match', 'x-entity-id'] as const;

export const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'etag',
  'retry-after',
  'x-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
] as const;

export const UPSTREAM_TIMEOUT_MS = 30_000;

export interface ProxyDeps {
  config: Pick<GatewayConfig, 'apiUrl' | 'publicOrigin'>;
  fetchImpl: typeof fetch;
  sessions: SessionStore;
  logger: GatewayLogger;
}

/** The upstream URL for a proxied request, or undefined when it would leave the API's /v1. */
export function upstreamUrlFor(originalUrl: string, apiUrl: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(originalUrl, apiUrl);
  } catch {
    return undefined;
  }
  if (url.origin !== new URL(apiUrl).origin) return undefined;
  if (url.pathname !== '/v1' && !url.pathname.startsWith('/v1/')) return undefined;
  return url;
}

export function createProxy(deps: ProxyDeps): RequestHandler {
  const forwardedProto = new URL(deps.config.publicOrigin).protocol.replace(/:$/, '');

  return handleAsync(async function proxyToApi(req, res) {
    const session = res.locals.session as SessionLocals | undefined;
    if (!session) return sendError(res, 401, 'SESSION_REQUIRED');

    const target = upstreamUrlFor(req.originalUrl, deps.config.apiUrl);
    if (!target) return sendError(res, 400, 'PATH_REJECTED');

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    headers.set('authorization', `Bearer ${session.record.accessToken}`);
    headers.set('x-forwarded-for', req.ip ?? '');
    headers.set('x-forwarded-proto', forwardedProto);

    let upstream: Response;
    try {
      upstream = await deps.fetchImpl(target, {
        method: req.method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      deps.logger.event('proxy.upstream_unavailable', { session: sessionTag(session.key) });
      return sendError(res, 502, 'UPSTREAM_UNAVAILABLE');
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Cookie');
    res.setHeader('Content-Security-Policy', API_CONTENT_SECURITY_POLICY);

    if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
      await upstream.body?.cancel();
      return sendError(res, 502, 'UPSTREAM_REDIRECT_REFUSED');
    }
    if (upstream.status === 401) {
      await upstream.body?.cancel();
      deps.sessions.destroy(session.key);
      deps.logger.event('session.upstream_rejected', { session: sessionTag(session.key) });
      return sendError(res, 401, 'SESSION_EXPIRED');
    }

    res.status(upstream.status);
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) res.setHeader(name, value);
    }

    if (!upstream.body || req.method === 'HEAD') {
      await upstream.body?.cancel();
      res.end();
      return;
    }
    const body = Readable.fromWeb(upstream.body);
    body.on('error', () => {
      res.destroy();
    });
    body.pipe(res);
  });
}
