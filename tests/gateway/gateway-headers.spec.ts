import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetOidcCaches } from '../../src/auth/oidc.js';
import { GatewayStartupRefused, startGateway } from '../../src/gateway/server.js';
import { SPA_CONTENT_SECURITY_POLICY } from '../../src/gateway/security-headers.js';
import { DEFAULT_STATIC_ROOT, STATIC_ASSETS } from '../../src/gateway/static-assets.js';
import { createFakeIdp } from './helpers/fake-idp.js';
import { startHarness, testConfig, type Harness } from './helpers/harness.js';
import { createStaticRoot } from './helpers/static-root.js';

// ============================================================
// W0 · what every gateway response carries, and what it never serves.
// ============================================================

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

const HARDENING = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

describe('the shell and the static table', () => {
  it("'/' carries exactly the SPA policy, the hardening headers, no-store and its content type", async () => {
    const root = createStaticRoot({ 'index.html': '<!doctype html><title>mnemosine</title>' });
    h = await startHarness({ staticRoot: root });
    const res = await h.request('GET', '/');
    root.remove();
    expect(res.status).toBe(200);
    expect(res.body).toBe('<!doctype html><title>mnemosine</title>');
    expect(res.headers['content-security-policy']).toBe(SPA_CONTENT_SECURITY_POLICY);
    expect(res.headers).toMatchObject(HARDENING);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(Object.keys(res.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
  });

  it('refusals past the Host guard carry the same hardening', async () => {
    h = await startHarness();
    for (const res of [await h.request('GET', '/nope'), await h.request('GET', '/v1/x'), await h.request('POST', '/v1/x')]) {
      expect(res.headers).toMatchObject(HARDENING);
      expect(res.headers['content-security-policy']).toBeDefined();
    }
    // The Host guard runs first, before any header is set: a 421 is a JSON
    // refusal for a name that is not this gateway, and carries nothing else.
    const misdirected = await h.request('GET', '/', { host: 'evil.test' });
    expect(misdirected.status).toBe(421);
    const refusal = JSON.parse(misdirected.body) as { errors: Array<{ code: string; message: string }> };
    expect(refusal.errors.map((e) => e.code)).toEqual(['HOST_REJECTED']);
  });

  it('HSTS is sent only when the public origin is https', async () => {
    h = await startHarness({ config: { publicOrigin: 'https://board.example.com' } });
    const res = await h.request('GET', '/', { host: 'board.example.com' });
    expect(res.status).toBe(200);
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('serves nothing outside the table: no source, no source maps, no dotfiles, no JSON mirrors, no directory', async () => {
    const root = createStaticRoot();
    fs.mkdirSync(path.join(root.dir, 'modules'), { recursive: true });
    fs.writeFileSync(path.join(root.dir, 'modules', 'x.js.map'), '{}');
    fs.writeFileSync(path.join(root.dir, '.env'), 'SECRET=1');
    fs.mkdirSync(path.join(root.dir, 'design'), { recursive: true });
    fs.writeFileSync(path.join(root.dir, 'design', 'tokens.json'), '{}');
    h = await startHarness({ staticRoot: root });
    for (const p of ['/modules/x.js.map', '/src/gateway/server.ts', '/.env', '/design/tokens.json', '/index.html', '/modules/', '/../package.json']) {
      const res = await h.request('GET', p);
      expect(res.status, p).toBe(404);
      expect(res.body, p).not.toContain('SECRET');
    }
    root.remove();
  });

  it('HEAD of a static file has the headers and no body; POST to it is 405', async () => {
    h = await startHarness();
    const head = await h.request('HEAD', '/');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(Number(head.headers['content-length'])).toBeGreaterThan(0);
    expect((await h.request('POST', '/')).status).toBe(405);
  });

  it('every published path is the shell or a web asset, and none shadows /v1, /auth or /healthz', () => {
    expect(STATIC_ASSETS.length).toBeGreaterThan(0);
    for (const [publishedPath] of STATIC_ASSETS) {
      expect(publishedPath === '/' || /\.(html|js|css|woff2)$/.test(publishedPath), publishedPath).toBe(true);
      expect(publishedPath).not.toMatch(/^\/(v1|auth|healthz)(\/|$)/);
    }
  });

  it('the default root is dist/gateway/public under the repository', () => {
    expect(DEFAULT_STATIC_ROOT).toBe(path.resolve(__dirname, '..', '..', 'dist', 'gateway', 'public'));
  });
});

describe('startGateway refuses before it listens', () => {
  it('when a listed static file is missing, naming the build step', async () => {
    resetOidcCaches();
    const idp = await createFakeIdp();
    const empty = createStaticRoot();
    fs.rmSync(path.join(empty.dir, STATIC_ASSETS[0][1]));
    const config = testConfig({ issuer: idp.issuer, apiUrl: 'http://127.0.0.1:9' });
    const attempt = startGateway(config, { fetchImpl: idp.fetch, staticRoot: empty.dir, logger: { event: () => undefined } });
    await expect(attempt).rejects.toBeInstanceOf(GatewayStartupRefused);
    await expect(attempt).rejects.toThrow(/npm run build:web/);
    expect(idp.tokenCalls).toHaveLength(0);
    empty.remove();
  });
});
