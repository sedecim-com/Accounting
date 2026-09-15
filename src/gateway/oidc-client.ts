import type { ReadableStreamReadResult } from 'node:stream/web';
import { discover, isAsymmetric, verifyIdpToken } from '../auth/oidc.js';
import type { OidcDiscovery } from '../auth/oidc.js';
import type { GatewayConfig } from './config.js';
import { sessionPrincipal, type SessionTokens } from './session-store.js';

// ============================================================
// THE GATEWAY AS A CONFIDENTIAL OIDC CLIENT
//
// The gateway mints nothing. It forwards only access tokens it obtained from
// the IdP itself and verified BEFORE storing them, at the callback and after
// every refresh. The reason is what the API does with a token: on the
// asymmetric path it verifies signature, issuer and audience against the IdP;
// on the HS256 path it takes tenant, permissions and entities from the claims
// verbatim. A gateway that stored whatever a token endpoint returned, or that
// signed its own, would be the authorization engine.
//
// acceptTokenResponse is that gate:
//   · token_type must be Bearer;
//   · the access token must not be the ID token (an ID token is issued to the
//     client, not to the API: accepting it is the classic OIDC mistake);
//   · it must be asymmetrically signed;
//   · and it must verify against the IdP's keys, issuer and audience.
//
// Client authentication is client_secret_basic with a web client distinct
// from the CLI's public client and from the API audience.
// ============================================================

export const TOKEN_TIMEOUT_MS = 10_000;
export const REVOCATION_TIMEOUT_MS = 5_000;
export const TOKEN_BODY_LIMIT_BYTES = 64 * 1024;
export const LOGIN_SCOPE = 'openid email profile offline_access';

export interface OidcClientDeps {
  config: Pick<GatewayConfig, 'issuer' | 'audience' | 'webClientId' | 'webClientSecret' | 'publicOrigin'>;
  fetchImpl: typeof fetch;
}

export class TokenRejected extends Error {
  constructor(readonly reason: string) {
    super(`token response rejected: ${reason}`);
    this.name = 'TokenRejected';
  }
}

/**
 * The IdP answered, and its discovery document names another issuer. Retrying
 * does not fix that: AUTH_OIDC_ISSUER or the IdP's configuration does, so
 * startGateway reports it as a refusal and not as an IdP it could not read.
 */
export class IssuerMismatch extends Error {
  constructor() {
    super('the discovered issuer is not the configured AUTH_OIDC_ISSUER');
    this.name = 'IssuerMismatch';
  }
}

/** Reads a JSON body without trusting its size. */
async function readJsonCapped(res: Response, limit: number): Promise<unknown> {
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new TokenRejected('the token endpoint answered with an oversized body');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new TokenRejected('the token endpoint did not answer with JSON');
  }
}

function field(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export interface TokenResponseFields {
  access_token: string;
  token_type: string;
  id_token?: string;
  refresh_token?: string;
}

function tokenResponseFields(body: unknown): TokenResponseFields {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TokenRejected('the token response is not an object');
  }
  const record = body as Record<string, unknown>;
  const accessToken = field(record, 'access_token');
  if (!accessToken) throw new TokenRejected('the token response has no access_token');
  return {
    access_token: accessToken,
    token_type: field(record, 'token_type') ?? '',
    id_token: field(record, 'id_token'),
    refresh_token: field(record, 'refresh_token'),
  };
}

/**
 * The only way a token becomes session material. Throws TokenRejected, or
 * whatever verification throws, for anything that is not a verified,
 * asymmetric, Bearer access token for this API.
 */
export async function acceptTokenResponse(
  body: unknown,
  opts: { issuer: string; audience: string; fetchImpl: typeof fetch }
): Promise<SessionTokens> {
  const tokens = tokenResponseFields(body);
  if (tokens.token_type.toLowerCase() !== 'bearer') {
    throw new TokenRejected('token_type is not Bearer');
  }
  if (tokens.id_token !== undefined && tokens.id_token === tokens.access_token) {
    throw new TokenRejected('the access token is the ID token');
  }
  if (!isAsymmetric(tokens.access_token)) {
    throw new TokenRejected('the access token is not asymmetrically signed');
  }
  const identity = await verifyIdpToken(tokens.access_token, {
    issuer: opts.issuer,
    audience: opts.audience,
    fetchImpl: opts.fetchImpl,
  });
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessExpiresAt: identity.expiresAt,
    principal: sessionPrincipal(identity.issuer, identity.subject),
  };
}

/** client_secret_basic (RFC 6749 §2.3.1): each part form-encoded, then base64. */
function basicAuthorization(clientId: string, clientSecret: string): string {
  const encode = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
  return `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`, 'utf8').toString('base64')}`;
}

export interface OidcClient {
  /** Discovery, refused when the discovered issuer is not the configured one. */
  discovery(): Promise<OidcDiscovery>;
  redirectUri(): string;
  authorizationUrl(state: string, codeChallenge: string): Promise<string>;
  exchangeCode(code: string, verifier: string): Promise<SessionTokens>;
  refresh(refreshToken: string): Promise<SessionTokens>;
  revoke(tokens: { accessToken: string; refreshToken?: string }): Promise<void>;
  /** Where the browser goes after logout: the IdP's end-session endpoint, or '/'. */
  logoutRedirect(): Promise<string>;
}

export function createOidcClient(deps: OidcClientDeps): OidcClient {
  const { config, fetchImpl } = deps;

  const discovery = async (): Promise<OidcDiscovery> => {
    const conf = await discover(config.issuer, fetchImpl);
    if (conf.issuer !== config.issuer) {
      throw new IssuerMismatch();
    }
    return conf;
  };

  const redirectUri = () => `${config.publicOrigin}/auth/callback`;

  const tokenRequest = async (params: Record<string, string>): Promise<SessionTokens> => {
    const conf = await discovery();
    const res = await fetchImpl(conf.token_endpoint, {
      method: 'POST',
      headers: {
        authorization: basicAuthorization(config.webClientId, config.webClientSecret),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    const body = await readJsonCapped(res, TOKEN_BODY_LIMIT_BYTES);
    if (!res.ok) throw new TokenRejected(`the token endpoint answered HTTP ${res.status}`);
    return acceptTokenResponse(body, { issuer: config.issuer, audience: config.audience, fetchImpl });
  };

  return {
    discovery,
    redirectUri,

    async authorizationUrl(state, codeChallenge) {
      const conf = await discovery();
      const url = new URL(conf.authorization_endpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.webClientId);
      url.searchParams.set('redirect_uri', redirectUri());
      url.searchParams.set('scope', LOGIN_SCOPE);
      url.searchParams.set('audience', config.audience);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', state);
      return url.toString();
    },

    exchangeCode(code, verifier) {
      return tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        code_verifier: verifier,
      });
    },

    refresh(refreshToken) {
      return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    },

    async revoke(tokens) {
      const conf = await discovery();
      const endpoint = conf.revocation_endpoint;
      if (!endpoint) return;
      const pairs: Array<[string, string]> = [['access_token', tokens.accessToken]];
      if (tokens.refreshToken) pairs.unshift(['refresh_token', tokens.refreshToken]);
      for (const [hint, token] of pairs) {
        try {
          const res = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              authorization: basicAuthorization(config.webClientId, config.webClientSecret),
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ token, token_type_hint: hint }).toString(),
            redirect: 'error',
            signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS),
          });
          await res.body?.cancel();
        } catch {
          // Best effort: the session is already gone from the gateway, and a
          // revocation endpoint that fails must not keep the user signed in.
        }
      }
    },

    async logoutRedirect() {
      let conf: OidcDiscovery;
      try {
        conf = await discovery();
      } catch {
        return '/';
      }
      if (!conf.end_session_endpoint) return '/';
      const url = new URL(conf.end_session_endpoint);
      url.searchParams.set('client_id', config.webClientId);
      url.searchParams.set('post_logout_redirect_uri', `${config.publicOrigin}/`);
      return url.toString();
    },
  };
}
