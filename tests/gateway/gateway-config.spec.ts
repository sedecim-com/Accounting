import { afterEach, describe, expect, it } from 'vitest';
import { resetOidcCaches } from '../../src/auth/oidc.js';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  gatewayConfigProblems,
  gatewayConfigWarnings,
  readGatewayConfig,
  type GatewayConfig,
} from '../../src/gateway/config.js';
import { GatewayStartupRefused, startGateway, type RunningGateway } from '../../src/gateway/server.js';
import { createFakeIdp } from './helpers/fake-idp.js';
import { testConfig, WEB_CLIENT_SECRET } from './helpers/harness.js';
import { createStaticRoot } from './helpers/static-root.js';

// ============================================================
// W0 · the gateway's configuration: a closed list of keys, every violation
// named at once, nothing clamped, and the secret never repeated.
// ============================================================

const VALID_ENV = {
  AUTH_OIDC_ISSUER: 'https://idp.example.com',
  AUTH_OIDC_AUDIENCE: 'https://api.example.com',
  AUTH_OIDC_WEB_CLIENT_ID: 'board',
  AUTH_OIDC_WEB_CLIENT_SECRET: WEB_CLIENT_SECRET,
  GATEWAY_PUBLIC_ORIGIN: 'https://board.example.com',
  GATEWAY_API_URL: 'http://api.internal:3000',
};

function problemsFor(env: Record<string, string | undefined>): string[] {
  return gatewayConfigProblems(readGatewayConfig(env));
}

function withOverrides(overrides: Partial<GatewayConfig>): string[] {
  return gatewayConfigProblems({ ...readGatewayConfig(VALID_ENV), ...overrides });
}

describe('readGatewayConfig', () => {
  it('reads the gateway keys, defaults host, port and session limits, and is valid', () => {
    const config = readGatewayConfig(VALID_ENV);
    expect(config).toMatchObject({
      issuer: 'https://idp.example.com',
      webClientId: 'board',
      publicOrigin: 'https://board.example.com',
      apiUrl: 'http://api.internal:3000',
      host: '127.0.0.1',
      port: 8080,
      sessionIdleMinutes: 30,
      sessionAbsoluteHours: 8,
      sessionMax: 1000,
      production: false,
    });
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(DEFAULT_PORT).toBe(8080);
    expect(gatewayConfigProblems(config)).toEqual([]);
  });

  it('ignores the engine credentials and the CLI client id even when they are set', () => {
    const withEngine = readGatewayConfig({
      ...VALID_ENV,
      DATABASE_URL: 'postgresql://owner:pw@db/prod',
      JWT_SECRET: 'x'.repeat(64),
      ENCRYPTION_KEY: 'f'.repeat(64),
      AUTH_OIDC_CLIENT_ID: 'cli-public-client',
    });
    expect(withEngine).toEqual(readGatewayConfig(VALID_ENV));
    expect(JSON.stringify(withEngine)).not.toMatch(/postgresql|cli-public-client|x{64}|f{64}/);
  });
});

describe('gatewayConfigProblems', () => {
  it('names every missing key at once', () => {
    const problems = problemsFor({});
    for (const key of [
      'AUTH_OIDC_ISSUER',
      'AUTH_OIDC_AUDIENCE',
      'AUTH_OIDC_WEB_CLIENT_ID',
      'AUTH_OIDC_WEB_CLIENT_SECRET',
      'GATEWAY_PUBLIC_ORIGIN',
      'GATEWAY_API_URL',
    ]) {
      expect(problems.some((p) => p.startsWith(`${key} is required`)), key).toBe(true);
    }
  });

  const matrix: Array<[string, Partial<GatewayConfig>, RegExp]> = [
    ['a web client id equal to the audience', { webClientId: 'https://api.example.com' }, /AUTH_OIDC_WEB_CLIENT_ID must differ/],
    ['an http public origin in production', { publicOrigin: 'http://localhost:8080', production: true }, /GATEWAY_PUBLIC_ORIGIN must use https/],
    ['an http public origin that is not loopback', { publicOrigin: 'http://board.example.com' }, /GATEWAY_PUBLIC_ORIGIN must use https/],
    ['a public origin with a path', { publicOrigin: 'https://board.example.com/app' }, /GATEWAY_PUBLIC_ORIGIN must be an origin only/],
    ['a public origin with a trailing slash', { publicOrigin: 'https://board.example.com/' }, /GATEWAY_PUBLIC_ORIGIN must be an origin only/],
    ['a non-loopback http issuer', { issuer: 'http://idp.example.com' }, /AUTH_OIDC_ISSUER must use https/],
    ['a loopback http issuer in production', { issuer: 'http://127.0.0.1:9000', production: true }, /AUTH_OIDC_ISSUER must use https/],
    ['an API URL with credentials', { apiUrl: 'http://user:pw@api.internal:3000' }, /GATEWAY_API_URL must be an http\(s\) origin only/],
    ['an API URL with a path', { apiUrl: 'http://api.internal:3000/v1' }, /GATEWAY_API_URL must be an http\(s\) origin only/],
    ['TRUST_PROXY true in production', { trustProxy: 'true', production: true, publicOrigin: 'https://board.example.com' }, /GATEWAY_TRUST_PROXY=true is refused/],
    ['an idle limit under the range', { sessionIdleMinutes: 4 }, /GATEWAY_SESSION_IDLE_MINUTES must be a whole number between 5 and 120/],
    ['an idle limit over the range', { sessionIdleMinutes: 121 }, /GATEWAY_SESSION_IDLE_MINUTES/],
    ['an absolute lifetime over 12 hours', { sessionAbsoluteHours: 13 }, /GATEWAY_SESSION_ABSOLUTE_HOURS must be a whole number between 1 and 12/],
    ['a zero session cap', { sessionMax: 0 }, /GATEWAY_SESSION_MAX/],
    ['a port out of range', { port: 70_000 }, /GATEWAY_PORT/],
  ];

  for (const [name, overrides, expected] of matrix) {
    it(`refuses ${name}`, () => {
      const problems = withOverrides(overrides);
      expect(problems.some((p) => expected.test(p)), problems.join(' | ')).toBe(true);
    });
  }

  it('a value that is not a whole number is refused, not clamped or defaulted', () => {
    const problems = problemsFor({ ...VALID_ENV, GATEWAY_SESSION_IDLE_MINUTES: '30.5', GATEWAY_SESSION_MAX: 'lots', GATEWAY_PORT: '-1' });
    expect(problems.filter((p) => /GATEWAY_SESSION_IDLE_MINUTES|GATEWAY_SESSION_MAX|GATEWAY_PORT/.test(p))).toHaveLength(3);
  });

  it('accepts loopback http outside production', () => {
    expect(withOverrides({ issuer: 'http://127.0.0.1:9000', publicOrigin: 'http://localhost:8080' })).toEqual([]);
    expect(withOverrides({ trustProxy: 'true' })).toEqual([]);
  });

  it('never repeats the client secret, whatever else is wrong', () => {
    const problems = problemsFor({ AUTH_OIDC_WEB_CLIENT_SECRET: WEB_CLIENT_SECRET, AUTH_OIDC_WEB_CLIENT_ID: WEB_CLIENT_SECRET });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).not.toContain(WEB_CLIENT_SECRET);
  });

  it('warns, without refusing, about plain http to a non-loopback API in production', () => {
    const config = { ...readGatewayConfig(VALID_ENV), production: true };
    expect(gatewayConfigProblems(config)).toEqual([]);
    expect(gatewayConfigWarnings(config).join()).toMatch(/GATEWAY_API_URL is plain http/);
    expect(gatewayConfigWarnings({ ...config, apiUrl: 'http://127.0.0.1:3000' })).toEqual([]);
  });
});

describe('startGateway', () => {
  let running: RunningGateway | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('refuses an invalid configuration without echoing the secret', async () => {
    const attempt = startGateway({ ...testConfig(), webClientId: 'same', audience: 'same' });
    await expect(attempt).rejects.toBeInstanceOf(GatewayStartupRefused);
    await expect(attempt).rejects.not.toThrow(new RegExp(WEB_CLIENT_SECRET));
  });

  it('refuses when the discovered issuer is not the configured one', async () => {
    resetOidcCaches();
    const idp = await createFakeIdp();
    idp.discoveryOverrides.issuer = 'https://impostor.test';
    const root = createStaticRoot();
    const attempt = startGateway(testConfig({ issuer: idp.issuer }), {
      fetchImpl: idp.fetch,
      staticRoot: root.dir,
      logger: { event: () => undefined },
    });
    await expect(attempt).rejects.toThrow(/discovered issuer is not the configured AUTH_OIDC_ISSUER/);
    root.remove();
  });

  it('listens on the configured loopback host once everything checks out', async () => {
    resetOidcCaches();
    const idp = await createFakeIdp();
    const root = createStaticRoot();
    running = await startGateway(testConfig({ issuer: idp.issuer }), {
      fetchImpl: idp.fetch,
      staticRoot: root.dir,
      logger: { event: () => undefined },
    });
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await fetch(`${running.url}/healthz`);
    expect(await health.json()).toEqual({ status: 'ok' });
    root.remove();
  });
});
