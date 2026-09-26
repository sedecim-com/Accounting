import { randomBytes as nodeRandomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { resolverTrustProxy } from '../api/rest/trust-proxy.js';
import { createCallbackRoute, createLoginRoute, createLogoutRoute, type AuthRouteDeps } from './auth-routes.js';
import { gatewayConfigProblems, gatewayConfigWarnings, type GatewayConfig } from './config.js';
import { sendError } from './errors.js';
import { createStderrLogger, type GatewayLogger } from './logger.js';
import { createOidcClient, IssuerMismatch } from './oidc-client.js';
import { createProxy } from './proxy.js';
import { createCsrfGuard, createHostGuard, createSessionGuard, methodGate, pathGuard } from './request-guards.js';
import { GATEWAY_ROUTES, PROXY_PREFIX, type GatewayRouteName } from './routes.js';
import { createSecurityHeaders } from './security-headers.js';
import { SESSIONS_PER_PRINCIPAL, SessionStore } from './session-store.js';
import { createStaticAssets, DEFAULT_STATIC_ROOT, loadStaticAssets, MissingStaticAssets } from './static-assets.js';

// ============================================================
// THE WEB GATEWAY
//
// A separate process (see main.ts) with two jobs: hold the browser session,
// and relay reads to the API's /v1. It builds no answer of its own beyond
// four plumbing routes and a closed table of static files.
//
// The middleware order IS the security argument, so it is written once, here,
// and pinned by criteria web-gateway-own-routes-are-plumbing and
// browser-session-is-not-ambient-authority:
//   1. hostGuard       every response is for this origin, or 421
//   2. securityHeaders CSP and hardening on everything, refusals included
//   3. the four own routes, from GATEWAY_ROUTES, in one loop
//   4. staticAssets    the closed table, GET and HEAD
//   5. /v1             path, CSRF, method, session, then the relay
//   6. notFound
//   7. errorHandler
// ============================================================

export interface GatewayDeps {
  config: GatewayConfig;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  randomBytes?: (size: number) => Buffer;
  logger?: GatewayLogger;
  /** Where the published files are read from. Defaults to `<repo>/dist/gateway/public`. */
  staticRoot?: string;
}

export interface GatewayApp {
  app: Express;
  sessions: SessionStore;
  /** Stops the session sweeper. */
  close(): void;
}

const health: RequestHandler = (_req, res) => {
  res.status(200).json({ status: 'ok' });
};

const notFound: RequestHandler = (req, res) => {
  if (req.method === 'GET' || req.method === 'HEAD') return sendError(res, 404, 'NOT_FOUND');
  sendError(res, 405, 'METHOD_NOT_ALLOWED');
};

function createErrorHandler(logger: GatewayLogger): ErrorRequestHandler {
  return function errorHandler(_err, _req, res, _next) {
    // The error itself is not logged: it may carry an upstream body or a URL.
    logger.event('request.failed');
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(res, 500, 'INTERNAL_ERROR');
  };
}

export function createGatewayApp(deps: GatewayDeps): GatewayApp {
  const { config } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const clock = deps.clock ?? Date.now;
  const randomBytes = deps.randomBytes ?? ((size: number) => nodeRandomBytes(size));
  const logger = deps.logger ?? createStderrLogger();
  const assets = loadStaticAssets(deps.staticRoot ?? DEFAULT_STATIC_ROOT);

  const sessions = new SessionStore(
    {
      idleMs: config.sessionIdleMinutes * 60_000,
      absoluteMs: config.sessionAbsoluteHours * 3_600_000,
      max: config.sessionMax,
      perPrincipal: SESSIONS_PER_PRINCIPAL,
    },
    clock,
    () => randomBytes(32).toString('base64url')
  );
  sessions.startSweeper();

  const oidc = createOidcClient({ config, fetchImpl });
  const authDeps: AuthRouteDeps = {
    oidc,
    sessions,
    clock,
    randomBytes,
    logger,
    loginKey: randomBytes(32),
    sessionAbsoluteSeconds: config.sessionAbsoluteHours * 3600,
  };

  const hostGuard = createHostGuard(config);
  const securityHeaders = createSecurityHeaders(config);
  const csrfGuard = createCsrfGuard(config);
  const sessionGuard = createSessionGuard({ sessions, oidc, clock, logger });
  const proxyToApi = createProxy({ config, fetchImpl, sessions, logger });
  const staticAssets = createStaticAssets(assets);
  const errorHandler = createErrorHandler(logger);

  const handlers: Record<GatewayRouteName, RequestHandler[]> = {
    health: [health],
    login: [createLoginRoute(authDeps)],
    callback: [createCallbackRoute(authDeps)],
    logout: [csrfGuard, createLogoutRoute(authDeps)],
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', resolverTrustProxy(config.trustProxy, config.production ? 'production' : 'development').valor);

  app.use(hostGuard);
  app.use(securityHeaders);
  for (const [method, routePath, name] of GATEWAY_ROUTES) {
    app[method === 'GET' ? 'get' : 'post'](routePath, handlers[name]);
  }
  app.use(staticAssets);
  app.use(PROXY_PREFIX, pathGuard, csrfGuard, methodGate, sessionGuard, proxyToApi);
  app.use(notFound);
  app.use(errorHandler);

  return {
    app,
    sessions,
    close: () => sessions.stopSweeper(),
  };
}

// HOW A FAILED START EXITS. Two entries start the gateway, and they must exit
// alike: `node dist/gateway/main.js` and `mnemosine web start`. The CLI maps an
// error's statusCode through exitCodeFor (src/cli/kernel/index.ts), which the
// gateway may not import, so each startup error carries the status that maps
// to its code in that contract, and startupExitCode spells the same table for
// main.ts. tests/gateway/gateway-main.spec.ts holds the two together.

/** A configuration or a build that cannot serve. Nothing listened; fixing it takes a person. */
export class GatewayStartupRefused extends Error {
  /** 400 is the contract's USAGE (2): the same code the CLI gives a broken flag or setting. */
  readonly statusCode = 400;
  constructor(readonly problems: string[]) {
    super(`the web gateway refuses to start:\n  - ${problems.join('\n  - ')}`);
    this.name = 'GatewayStartupRefused';
  }
}

/** The IdP could not be read at start: unreachable, an HTTP error or an incomplete answer. Retryable. */
export class GatewayDiscoveryFailed extends Error {
  /** 502 is the contract's EXTERNAL_FAILED (8): an external service failed, try again. */
  readonly statusCode = 502;
  constructor(readonly reason: string) {
    super(`the web gateway cannot start: OIDC discovery for AUTH_OIDC_ISSUER failed: ${reason}`);
    this.name = 'GatewayDiscoveryFailed';
  }
}

/**
 * The socket could not be opened: a port already in use (EADDRINUSE), a
 * privileged port (EACCES), an address this host does not have
 * (EADDRNOTAVAIL, ENOTFOUND). Host and port are configuration, not secrets, so
 * the message names them with the system code, and both entries print it.
 * There is no statusCode: it exits 1 from both, since whether it is worth
 * retrying depends on what holds the port.
 */
export class GatewayListenFailed extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly code: string
  ) {
    super(`the web gateway cannot start: cannot listen on ${host.includes(':') ? `[${host}]` : host}:${port}: ${code}`);
    this.name = 'GatewayListenFailed';
  }
}

/** The exit code of a failed start: 2 a refusal, 8 an IdP that could not be read, 1 anything else. */
export function startupExitCode(err: unknown): 1 | 2 | 8 {
  if (err instanceof GatewayStartupRefused) return 2;
  if (err instanceof GatewayDiscoveryFailed) return 8;
  return 1;
}

export interface RunningGateway {
  server: Server;
  /** The address it listens on, as http://host:port. */
  url: string;
  close(): Promise<void>;
}

/**
 * Validates the configuration, preloads the static files, checks the IdP's
 * discovery, and only then listens. Every refusal happens before a socket is
 * opened.
 */
export async function startGateway(
  config: GatewayConfig,
  deps: Omit<GatewayDeps, 'config'> = {}
): Promise<RunningGateway> {
  const problems = gatewayConfigProblems(config);
  if (problems.length > 0) throw new GatewayStartupRefused(problems);
  const logger = deps.logger ?? createStderrLogger();
  for (const warning of gatewayConfigWarnings(config)) logger.event('config.warning', { warning });

  let gateway: GatewayApp;
  try {
    gateway = createGatewayApp({ ...deps, config, logger });
  } catch (err) {
    if (err instanceof MissingStaticAssets) throw new GatewayStartupRefused([err.message]);
    throw err;
  }
  try {
    await createOidcClient({ config, fetchImpl: deps.fetchImpl ?? fetch }).discovery();
  } catch (err) {
    gateway.close();
    // An IdP that answers with another issuer is a setting to fix, not an outage to retry.
    if (err instanceof IssuerMismatch) throw new GatewayStartupRefused([err.message]);
    throw new GatewayDiscoveryFailed(err instanceof Error ? err.message : 'discovery failed');
  }

  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const listening = gateway.app.listen(config.port, config.host, () => resolve(listening));
      listening.once('error', reject);
    });
  } catch (err) {
    gateway.close();
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    throw new GatewayListenFailed(config.host, config.port, typeof code === 'string' ? code : 'unknown error');
  }
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  logger.event('gateway.listening', { host: config.host, port: address.port });

  return {
    server,
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        gateway.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
