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
import { exitCodeFor, ExitCode } from '../../src/cli/kernel/index.js';
import {
  createGatewayApp,
  GatewayDiscoveryFailed,
  GatewayListenFailed,
  GatewayStartupRefused,
  startGateway,
  startupExitCode,
  type RunningGateway,
} from '../../src/gateway/server.js';
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
    ['a TRUST_PROXY address Express cannot read', { trustProxy: '10.0.0.300' }, /GATEWAY_TRUST_PROXY must be false, true, a number of hops/],
    ['a TRUST_PROXY list with a malformed CIDR', { trustProxy: 'loopback, 10.0.0.0/99' }, /GATEWAY_TRUST_PROXY must be/],
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

  it('refuses a TRUST_PROXY Express cannot compile by naming the key, never the value, and accepts every form of the grammar', () => {
    const problems = withOverrides({ trustProxy: 'not-an-address-7f3a' });
    expect(problems.filter((p) => p.startsWith('GATEWAY_TRUST_PROXY must be'))).toHaveLength(1);
    expect(problems.join('\n')).not.toContain('not-an-address-7f3a');
    for (const trustProxy of ['', 'false', 'off', '1', '2', 'loopback', '10.0.0.0/8', '10.0.0.1, uniquelocal', '::1', 'fe80::/10', '::ffff:10.0.0.1', '10.0.0.0/255.255.255.128']) {
      expect(withOverrides({ trustProxy }), trustProxy).toEqual([]);
    }
  });

  it('never accepts a TRUST_PROXY that Express would throw on, and refuses what Express refuses', () => {
    // Express is asked for real, through createGatewayApp, which resolves the
    // value and sets it on the one app. The config check may not call
    // express() itself (one app, in server.ts), so this is what holds its
    // grammar to Express's.
    const root = createStaticRoot();
    const expressAccepts = (trustProxy: string): boolean => {
      try {
        createGatewayApp({ config: { ...testConfig(), trustProxy }, staticRoot: root.dir, logger: { event: () => undefined } }).close();
        return true;
      } catch {
        return false;
      }
    };
    const corpus = [
      'loopback', 'Loopback', 'linklocal', 'uniquelocal', '__proto__', 'constructor', 'localhost', '[::1]',
      '1.2.3.4', '0.0.0.0', '255.255.255.255', '256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '0x1.2.3.4', '1.2.3.04',
      '1.2.3.4/0', '1.2.3.4/1', '1.2.3.4/32', '1.2.3.4/33', '1.2.3.4/024', '1.2.3.4/', '1.2.3.4//24', '1.2.3.4/24/24', '1.2.3.4/+24',
      '1.2.3.4/255.255.255.0', '1.2.3.4/255.255.255.128', '1.2.3.4/128.0.0.0', '1.2.3.4/255.255.255.255', '1.2.3.4/255.0.255.0', '1.2.3.4/0.0.0.0', '1.2.3.4/255.255.256.0',
      '::', '::/0', '::/1', '::1', '::1/128', '::1/129', '1::', '1::2::3', ':::', 'fe80::/10', 'fe80::1%eth0', 'fe80::1%en-0', 'fe80::1%eth0.1', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:9',
      '::1/255.255.255.0', '::ffff:1.2.3.4', '::FFFF:1.2.3.4', '::ffff:1.2.3.4/33', '::ffff:1.2.3.4/129', '::1.2.3.4', '64:ff9b::1.2.3.4', '0::ffff:1.2.3.4',
      '1:2:3:4:5:6:1.2.3.4', '::ffff:0:1.2.3.4', '10.0.0.1, 10.0.0.300', 'loopback, ::1/0',
    ];
    const accepted: string[] = [];
    for (const trustProxy of corpus) {
      const refused = withOverrides({ trustProxy }).some((p) => p.startsWith('GATEWAY_TRUST_PROXY'));
      const compiles = expressAccepts(trustProxy);
      if (!refused) {
        accepted.push(trustProxy);
        expect(compiles, `accepted ${trustProxy}, which Express refuses`).toBe(true);
      }
      if (!compiles) expect(refused, `Express refuses ${trustProxy}`).toBe(true);
    }
    root.remove();
    // The cross-check must judge accepted values too, not only refusals.
    expect(accepted.length).toBeGreaterThan(15);
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

  it('refuses a TRUST_PROXY Express cannot compile before building the app, as a named refusal', async () => {
    const attempt = startGateway({ ...testConfig(), trustProxy: '10.0.0.300' });
    await expect(attempt).rejects.toBeInstanceOf(GatewayStartupRefused);
    await expect(attempt).rejects.toThrow(/GATEWAY_TRUST_PROXY must be/);
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
    // A setting to fix, not an outage: the refusal, which both entries exit with 2.
    await expect(attempt).rejects.toBeInstanceOf(GatewayStartupRefused);
    root.remove();
  });

  it('reports an IdP it cannot read as an external failure, not as a refusal', async () => {
    resetOidcCaches();
    const root = createStaticRoot();
    const unreachable = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const attempt = startGateway(testConfig({ issuer: 'https://idp-down.example.test' }), {
      fetchImpl: unreachable,
      staticRoot: root.dir,
      logger: { event: () => undefined },
    });
    await expect(attempt).rejects.toBeInstanceOf(GatewayDiscoveryFailed);
    await expect(attempt).rejects.toThrow(/OIDC discovery for AUTH_OIDC_ISSUER failed: fetch failed/);
    await expect(attempt).rejects.not.toThrow(new RegExp(WEB_CLIENT_SECRET));
    const err = await attempt.catch((e: unknown) => e);
    expect(startupExitCode(err)).toBe(ExitCode.EXTERNAL_FAILED);
    expect(exitCodeFor(err)).toBe(ExitCode.EXTERNAL_FAILED);
    root.remove();
  });

  it('names the address and the system code when the port is taken, and exits 1 from both doors', async () => {
    resetOidcCaches();
    const idp = await createFakeIdp();
    const root = createStaticRoot();
    const deps = { fetchImpl: idp.fetch, staticRoot: root.dir, logger: { event: () => undefined } };
    running = await startGateway(testConfig({ issuer: idp.issuer }), deps);
    const port = Number(new URL(running.url).port);
    const attempt = startGateway(testConfig({ issuer: idp.issuer, port }), deps);
    await expect(attempt).rejects.toBeInstanceOf(GatewayListenFailed);
    await expect(attempt).rejects.toThrow(`cannot listen on 127.0.0.1:${port}: EADDRINUSE`);
    const err = await attempt.catch((e: unknown) => e);
    expect(startupExitCode(err)).toBe(ExitCode.FAILURE);
    expect(exitCodeFor(err)).toBe(ExitCode.FAILURE);
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
