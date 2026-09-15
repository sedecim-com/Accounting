import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resetOidcCaches } from '../../../src/auth/oidc.js';
import type { GatewayConfig } from '../../../src/gateway/config.js';
import { SESSION_COOKIE, LOGIN_COOKIE } from '../../../src/gateway/cookies.js';
import type { GatewayLogger, LogField } from '../../../src/gateway/logger.js';
import { createGatewayApp, type GatewayApp } from '../../../src/gateway/server.js';
import { AUDIENCE, createFakeIdp, type FakeIdp } from './fake-idp.js';
import { createStaticRoot, type StaticRoot } from './static-root.js';
import { startStubApi, type StubApi } from './stub-api.js';

// ============================================================
// A gateway on a real socket, between the in-memory IdP and the stub API.
//
// Requests go through node:http rather than fetch on purpose: fetch
// normalises `/v1/../metrics` before it leaves the process and will not send
// an arbitrary Host, and both are exactly what these specs need to send.
// ============================================================

export const PUBLIC_ORIGIN = 'http://localhost:8080';
export const PUBLIC_HOST = 'localhost:8080';
export const WEB_CLIENT_SECRET = 'web-client-secret-that-must-never-leak';

/** A header given as an array is sent as that many header lines. */
export type RequestHeaders = Record<string, string | string[]>;

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface Harness {
  gateway: GatewayApp;
  idp: FakeIdp;
  api: StubApi;
  config: GatewayConfig;
  now: { value: number };
  logs: Array<{ name: string; fields: Record<string, LogField> }>;
  request(method: string, path: string, headers?: RequestHeaders): Promise<RawResponse>;
  /** A GET through the proxy with the headers a same-origin SPA fetch carries. */
  read(path: string, cookie: string, headers?: RequestHeaders): Promise<RawResponse>;
  /**
   * Runs /auth/login and /auth/callback against the fake IdP, the way a browser
   * does: a cookie the browser already holds goes to /auth/login (a same-origin
   * navigation from the SPA), while the callback, reached by a cross-site
   * redirect from the IdP, carries only the Lax login cookie and never the
   * Strict session cookie. Returns the new session cookie pair.
   */
  signIn(existingCookie?: string): Promise<string>;
  close(): Promise<void>;
}

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    issuer: 'https://idp.invalid',
    audience: AUDIENCE,
    webClientId: 'web-client',
    webClientSecret: WEB_CLIENT_SECRET,
    publicOrigin: PUBLIC_ORIGIN,
    apiUrl: 'http://127.0.0.1:9',
    host: '127.0.0.1',
    port: 0,
    trustProxy: undefined,
    sessionIdleMinutes: 30,
    sessionAbsoluteHours: 8,
    sessionMax: 1000,
    production: false,
    ...overrides,
  };
}

/** The `name=value` part of a Set-Cookie header for `name`, or undefined. */
export function cookieFrom(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  for (const line of headers['set-cookie'] ?? []) {
    const pair = line.split(';')[0];
    if (pair.startsWith(`${name}=`) && pair.length > name.length + 1) return pair;
  }
  return undefined;
}

export function setCookieLine(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  return (headers['set-cookie'] ?? []).find((line) => line.startsWith(`${name}=`));
}

export async function startHarness(
  opts: { config?: Partial<GatewayConfig>; logger?: GatewayLogger; staticRoot?: StaticRoot } = {}
): Promise<Harness> {
  resetOidcCaches();
  const idp = await createFakeIdp();
  const api = await startStubApi();
  const root = opts.staticRoot ?? createStaticRoot();
  const now = { value: Date.now() };
  const logs: Harness['logs'] = [];
  const logger: GatewayLogger = opts.logger ?? {
    event: (name, fields = {}) => {
      logs.push({ name, fields });
    },
  };
  const config = testConfig({ issuer: idp.issuer, apiUrl: api.url, ...opts.config });

  // One fetch for both hops, as in production: IdP URLs go to the fake IdP,
  // everything else to the network (the stub API).
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    return url.startsWith(idp.issuer) ? idp.fetch(input, init) : fetch(input, init);
  }) as typeof fetch;

  const gateway = createGatewayApp({
    config,
    fetchImpl,
    clock: () => now.value,
    logger,
    staticRoot: root.dir,
  });
  const server = await new Promise<http.Server>((resolve) => {
    const s = gateway.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;

  const request: Harness['request'] = (method, path, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method, path, headers: { host: PUBLIC_HOST, ...headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
          );
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.end();
    });

  const harness: Harness = {
    gateway,
    idp,
    api,
    config,
    now,
    logs,
    request,
    read: (path, cookie, headers = {}) =>
      request('GET', path, { cookie, 'x-mnemosine-request': '1', 'sec-fetch-site': 'same-origin', ...headers }),

    async signIn(existingCookie) {
      const login = await request('GET', '/auth/login', existingCookie ? { cookie: existingCookie } : {});
      const location = new URL(login.headers.location ?? '');
      const loginPair = cookieFrom(login.headers, LOGIN_COOKIE) ?? '';
      const state = location.searchParams.get('state') ?? '';
      const code = idp.issueCode();
      const callback = await request('GET', `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
        cookie: loginPair,
      });
      const session = cookieFrom(callback.headers, SESSION_COOKIE);
      if (!session) throw new Error(`sign-in did not create a session (HTTP ${callback.status}, ${callback.headers.location ?? ''})`);
      return session;
    },

    async close() {
      gateway.close();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await api.close();
      if (!opts.staticRoot) root.remove();
    },
  };
  return harness;
}
