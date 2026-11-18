import { afterAll, describe, expect, it } from 'vitest';
import { createGatewayApp } from '../../src/gateway/server.js';
import { GATEWAY_ROUTES, PROXIED_METHODS, PROXY_PREFIX } from '../../src/gateway/routes.js';
import { testConfig } from './helpers/harness.js';
import { createStaticRoot } from './helpers/static-root.js';

// ============================================================
// W0 · the gateway's router stack, walked at runtime.
//
// Criterion web-gateway-own-routes-are-plumbing reads the source; this spec
// reads what Express actually registered. The two disagree only when someone
// registers a route the syntax check cannot see (an alias of `app`, a helper
// that receives it), and then this spec is the one that fails.
// ============================================================

interface Layer {
  name: string;
  /** Express 5 (router 2): whether this layer serves the path. */
  match(path: string): unknown;
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ name: string }> };
}

const root = createStaticRoot();
afterAll(() => root.remove());

function stackOf(): Layer[] {
  const gateway = createGatewayApp({ config: testConfig(), staticRoot: root.dir, logger: { event: () => undefined } });
  gateway.close();
  return (gateway.app as unknown as { router: { stack: Layer[] } }).router.stack;
}

describe('the gateway router stack', () => {
  it('is exactly: host guard, headers, four routes, static files, the /v1 pipeline, not found, errors', () => {
    const described = stackOf().map((layer) =>
      layer.route
        ? `route ${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path} [${layer.route.stack.map((s) => s.name).join(', ')}]`
        : layer.name
    );
    expect(described).toEqual([
      'hostGuard',
      'securityHeaders',
      'route GET /healthz [health]',
      'route GET /auth/login [login]',
      'route GET /auth/callback [callback]',
      'route POST /auth/logout [csrfGuard, logout]',
      'staticAssets',
      'pathGuard',
      'csrfGuard',
      'methodGate',
      'sessionGuard',
      'proxyToApi',
      'notFound',
      'errorHandler',
    ]);
  });

  it('mounts the whole pipeline on exactly /v1, and nothing else on a prefix', () => {
    const pipeline = stackOf().filter((layer) =>
      ['pathGuard', 'csrfGuard', 'methodGate', 'sessionGuard', 'proxyToApi'].includes(layer.name)
    );
    expect(pipeline).toHaveLength(5);
    for (const layer of pipeline) {
      expect(Boolean(layer.match('/v1/portfolio'))).toBe(true);
      expect(Boolean(layer.match('/v1'))).toBe(true);
      expect(Boolean(layer.match('/metrics'))).toBe(false);
      expect(Boolean(layer.match('/public/v1/x'))).toBe(false);
      expect(Boolean(layer.match('/v10/x'))).toBe(false);
    }
  });

  it('the literals it registers from are the declared ones', () => {
    expect(GATEWAY_ROUTES.map(([m, p]) => `${m} ${p}`)).toEqual([
      'GET /healthz',
      'GET /auth/login',
      'GET /auth/callback',
      'POST /auth/logout',
    ]);
    expect(PROXY_PREFIX).toBe('/v1');
    expect([...PROXIED_METHODS]).toEqual(['GET', 'HEAD']);
  });
});
