import { isIP, isIPv4 } from 'node:net';
import { resolverTrustProxy, type ValorTrustProxy } from '../api/rest/trust-proxy.js';

// ============================================================
// GATEWAY CONFIGURATION
//
// The gateway is a separate process on purpose: its deployment entry loads no
// dotenv, no src/config and no src/database, so a compromised gateway holds
// browser sessions and never the database credential or the HS256 signing
// secret. This
// module is therefore the ONLY place the gateway reads its environment, and it
// reads a closed list of keys: GATEWAY_*, the four AUTH_OIDC_* keys the web
// client needs, and NODE_ENV. Criterion web-gateway-never-reaches-the-engine
// holds that list, and tests/config/env-example.spec.ts counts every key read
// here through the `env` alias of the default parameter.
//
// Nothing is clamped. A value out of range is a refusal that names the key,
// because a session lifetime silently rounded to a legal value is a lifetime
// nobody chose.
// ============================================================

export interface GatewayConfig {
  issuer: string;
  audience: string;
  webClientId: string;
  /** Never logged, never echoed in a problem. */
  webClientSecret: string;
  /** Scheme, host and port only. Defines redirect_uri, the Origin check and the Host check. */
  publicOrigin: string;
  /** Scheme, host and port of the API; paths come from the request. */
  apiUrl: string;
  host: string;
  port: number;
  /** Raw TRUST_PROXY grammar, resolved by resolverTrustProxy. */
  trustProxy: string | undefined;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  sessionMax: number;
  production: boolean;
}

export const SESSION_IDLE_MINUTES = { fallback: 30, min: 5, max: 120 } as const;
export const SESSION_ABSOLUTE_HOURS = { fallback: 8, min: 1, max: 12 } as const;
export const SESSION_MAX = { fallback: 1000, min: 1, max: 100_000 } as const;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8080;

/** An unset or empty value takes the default; anything that is not a whole number becomes NaN and is refused. */
function wholeNumber(raw: string | undefined, fallback: number): number {
  const text = raw?.trim() ?? '';
  if (text === '') return fallback;
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

export function readGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const issuer = env.AUTH_OIDC_ISSUER ?? '';
  const audience = env.AUTH_OIDC_AUDIENCE ?? '';
  const webClientId = env.AUTH_OIDC_WEB_CLIENT_ID ?? '';
  const webClientSecret = env.AUTH_OIDC_WEB_CLIENT_SECRET ?? '';
  const publicOrigin = env.GATEWAY_PUBLIC_ORIGIN ?? '';
  const apiUrl = env.GATEWAY_API_URL ?? '';
  const host = env.GATEWAY_HOST?.trim() || DEFAULT_HOST;
  const port = wholeNumber(env.GATEWAY_PORT, DEFAULT_PORT);
  const trustProxy = env.GATEWAY_TRUST_PROXY;
  const sessionIdleMinutes = wholeNumber(env.GATEWAY_SESSION_IDLE_MINUTES, SESSION_IDLE_MINUTES.fallback);
  const sessionAbsoluteHours = wholeNumber(env.GATEWAY_SESSION_ABSOLUTE_HOURS, SESSION_ABSOLUTE_HOURS.fallback);
  const sessionMax = wholeNumber(env.GATEWAY_SESSION_MAX, SESSION_MAX.fallback);
  const production = env.NODE_ENV === 'production';
  return {
    issuer: issuer.trim(),
    audience: audience.trim(),
    webClientId: webClientId.trim(),
    webClientSecret,
    publicOrigin: publicOrigin.trim(),
    apiUrl: apiUrl.trim(),
    host,
    port,
    trustProxy,
    sessionIdleMinutes,
    sessionAbsoluteHours,
    sessionMax,
    production,
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Scheme, host and port, with nothing else written: no path, query, fragment or credentials. */
function isBareOrigin(value: string, url: URL): boolean {
  return url.origin !== 'null' && url.origin === value && url.username === '' && url.password === '';
}

// ============================================================
// A TRUST_PROXY LIST EXPRESS CAN READ.
//
// Express compiles a `trust proxy` list when createGatewayApp sets it
// (proxy-addr) and throws on an entry it cannot read. Unchecked here, such a
// value passed validation and crashed createGatewayApp, and the node entry
// exited 1 printing only that the gateway failed to start, without the key.
//
// Express cannot be asked directly: an express() outside server.ts is an app
// the gateway's route table does not declare (criterion
// web-gateway-own-routes-are-plumbing). So the grammar is checked here, and on
// the strict side of proxy-addr's: every entry this accepts, Express accepts,
// which tests/gateway/gateway-config.spec.ts cross-checks against Express
// itself. What it refuses that Express would take is unusual spelling (octal
// or hex octets, zone ids, an IPv4 tail on any IPv6 prefix but ::ffff:), and
// the refusal names the key.
// ============================================================

const TRUST_PROXY_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** The prefix length a dotted netmask spells, or 0 when its ones are not contiguous. */
function netmaskBits(mask: string): number {
  const bits = mask
    .split('.')
    .map((octet) => Number(octet).toString(2).padStart(8, '0'))
    .join('');
  if (!/^1*0*$/.test(bits)) return 0;
  const firstZero = bits.indexOf('0');
  return firstZero === -1 ? 32 : firstZero;
}

function trustProxyEntryIsValid(entry: string): boolean {
  if (TRUST_PROXY_NAMES.has(entry)) return true;
  const slash = entry.lastIndexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(address);
  if (family === 0 || address.includes('%')) return false;
  if (family === 6 && address.includes('.') && !/^::ffff:(?:\d{1,3}\.){3}\d{1,3}$/i.test(address)) return false;
  if (slash === -1) return true;
  const range = entry.slice(slash + 1);
  const max = family === 6 ? 128 : 32;
  if (/^[0-9]+$/.test(range)) {
    const bits = Number(range);
    return bits >= 1 && bits <= max;
  }
  return family === 4 && isIPv4(range) && netmaskBits(range) >= 1;
}

function trustProxyIsValid(value: ValorTrustProxy): boolean {
  return !Array.isArray(value) || value.every(trustProxyEntryIsValid);
}

function checkRange(problems: string[], key: string, value: number, range: { min: number; max: number }): void {
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    problems.push(`${key} must be a whole number between ${range.min} and ${range.max}`);
  }
}

/**
 * Every violation at once, so an operator fixes the configuration in one pass.
 * A problem names the key and the rule; it never repeats a value, so the
 * client secret cannot leak through a refusal.
 */
export function gatewayConfigProblems(config: GatewayConfig): string[] {
  const problems: string[] = [];
  const production = config.production;

  if (config.issuer === '') {
    problems.push('AUTH_OIDC_ISSUER is required');
  } else {
    const issuer = parseUrl(config.issuer);
    if (!issuer) problems.push('AUTH_OIDC_ISSUER must be a URL');
    else if (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && isLoopbackUrl(issuer) && !production)) {
      problems.push('AUTH_OIDC_ISSUER must use https (http is accepted only for a loopback issuer outside production)');
    }
  }

  if (config.audience === '') problems.push('AUTH_OIDC_AUDIENCE is required');
  if (config.webClientId === '') problems.push('AUTH_OIDC_WEB_CLIENT_ID is required');
  if (config.webClientId !== '' && config.webClientId === config.audience) {
    problems.push(
      'AUTH_OIDC_WEB_CLIENT_ID must differ from AUTH_OIDC_AUDIENCE: a token issued to the web client must not be accepted as an API token'
    );
  }
  if (config.webClientSecret === '') problems.push('AUTH_OIDC_WEB_CLIENT_SECRET is required');

  if (config.publicOrigin === '') {
    problems.push('GATEWAY_PUBLIC_ORIGIN is required');
  } else {
    const origin = parseUrl(config.publicOrigin);
    if (!origin || !isBareOrigin(config.publicOrigin, origin)) {
      problems.push('GATEWAY_PUBLIC_ORIGIN must be an origin only (scheme, host and port, no path or trailing slash)');
    } else if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && isLoopbackUrl(origin) && !production)) {
      problems.push('GATEWAY_PUBLIC_ORIGIN must use https (http is accepted only for localhost or 127.0.0.1 outside production)');
    }
  }

  if (config.apiUrl === '') {
    problems.push('GATEWAY_API_URL is required');
  } else {
    const api = parseUrl(config.apiUrl);
    if (!api || !isBareOrigin(config.apiUrl, api) || (api.protocol !== 'http:' && api.protocol !== 'https:')) {
      problems.push('GATEWAY_API_URL must be an http(s) origin only (no credentials, path or trailing slash)');
    }
  }

  if (config.host === '') problems.push('GATEWAY_HOST must not be empty');
  checkRange(problems, 'GATEWAY_PORT', config.port, { min: 0, max: 65_535 });

  const trust = resolverTrustProxy(config.trustProxy, production ? 'production' : 'development');
  if (trust.valor === true && production) {
    problems.push('GATEWAY_TRUST_PROXY=true is refused in production: it believes every X-Forwarded-For a client writes');
  } else if (!trustProxyIsValid(trust.valor)) {
    // The value is not repeated: the key and the grammar are enough to fix it.
    problems.push(
      'GATEWAY_TRUST_PROXY must be false, true, a number of hops, or a comma-separated list of addresses, CIDR ranges, loopback, linklocal or uniquelocal'
    );
  }

  checkRange(problems, 'GATEWAY_SESSION_IDLE_MINUTES', config.sessionIdleMinutes, SESSION_IDLE_MINUTES);
  checkRange(problems, 'GATEWAY_SESSION_ABSOLUTE_HOURS', config.sessionAbsoluteHours, SESSION_ABSOLUTE_HOURS);
  checkRange(problems, 'GATEWAY_SESSION_MAX', config.sessionMax, SESSION_MAX);

  return problems;
}

/** Accepted but worth saying at startup. */
export function gatewayConfigWarnings(config: GatewayConfig): string[] {
  const warnings: string[] = [];
  const api = parseUrl(config.apiUrl);
  if (config.production && api?.protocol === 'http:' && !isLoopbackUrl(api)) {
    warnings.push(
      'GATEWAY_API_URL is plain http to a non-loopback host: session access tokens cross that hop unencrypted'
    );
  }
  return warnings;
}
