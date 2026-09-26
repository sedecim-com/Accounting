// ============================================================
// THE GATEWAY'S WHOLE ROUTE SURFACE, AS DATA
//
// The web gateway exists for two jobs: it holds the browser session, and it
// relays reads to /v1. Anything else it answered would be a second API, and
// aggregation in a gateway is where a third engine starts. So the gateway's
// own routes are a literal table of four plumbing routes, registered by one
// loop in server.ts, and the proxied methods are a literal pair.
//
// PROXIED_METHODS is GET and HEAD only, on purpose. The API trusts
// `Authorization: Bearer` and nothing else; a cookie turned into a Bearer is
// ambient authority. Its external acts (CFDI stamp and cancel) take no body,
// and its dry-run, live and idempotency flags are not enforced by the API
// itself yet. With a cookie, one CSRF or XSS bypass on a body-less POST would
// create a document at the SAT. Browser writes wait until the API enforces
// its own safeguards; the gateway cannot enforce them without becoming an
// engine.
//
// Criterion web-gateway-own-routes-are-plumbing reads this file's syntax
// tree; tests/gateway/gateway-routes.spec.ts walks the real router stack.
// ============================================================

export type GatewayRouteName = 'health' | 'login' | 'callback' | 'logout';

export type GatewayRoute = readonly ['GET' | 'POST', string, GatewayRouteName];

export const GATEWAY_ROUTES: readonly GatewayRoute[] = [
  ['GET', '/healthz', 'health'],
  ['GET', '/auth/login', 'login'],
  ['GET', '/auth/callback', 'callback'],
  ['POST', '/auth/logout', 'logout'],
];

/** Exactly the API's versioned prefix: /metrics, /ready, /live and /public/v1 stay unreachable. */
export const PROXY_PREFIX = '/v1';

export const PROXIED_METHODS = ['GET', 'HEAD'] as const;

export type ProxiedMethod = (typeof PROXIED_METHODS)[number];

export function isProxiedMethod(method: string): method is ProxiedMethod {
  return (PROXIED_METHODS as readonly string[]).includes(method);
}
