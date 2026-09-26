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
  regexp: RegExp;
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ name: string }> };
}

const root = createStaticRoot();
afterAll(() => root.remove());

function stackOf(): Layer[] {
  const gateway = createGatewayApp({ config: testConfig(), staticRoot: root.dir, logger: { event: () => undefined } });
  gateway.close();
  return (gateway.app as unknown as { _router: { stack: Layer[] } })._router.stack;
}

describe('the gateway router stack', () => {
  it('is exactly: Express built-ins, host guard, headers, four routes, static files, the /v1 pipeline, not found, errors', () => {
    const described = stackOf().map((layer) =>
      layer.route
        ? `route ${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path} [${layer.route.stack.map((s) => s.name).join(', ')}]`
        : layer.name
    );
    expect(described).toEqual([
      // Express 4 always puts these two first (application.js lazyrouter).
      'query',
      'expressInit',
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
      expect(layer.regexp.test('/v1/portfolio')).toBe(true);
      expect(layer.regexp.test('/v1')).toBe(true);
      expect(layer.regexp.test('/metrics')).toBe(false);
      expect(layer.regexp.test('/public/v1/x')).toBe(false);
      expect(layer.regexp.test('/v10/x')).toBe(false);
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
