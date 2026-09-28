import { createRemoteJWKSet, customFetch, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';

// ============================================================
// OIDC VERIFICATION
//
// A single implementation covers all the serious providers
// (Google Workspace, Entra ID, Okta, Auth0, Keycloak, Zitadel,
// Cognito) because configuration happens via DISCOVERY: only
// issuer, client_id and audience are declared, and the rest is read
// from /.well-known/openid-configuration.
//
// Cognito is the one provider whose access tokens carry no `aud`: they name
// their app client in `client_id`. AUTH_OIDC_PROVIDER=cognito trades that one
// check (accessTokenCheck, #369); every other provider keeps `aud`.
//
// SAML is deliberately not implemented here: it goes behind an IdP
// that translates it to OIDC (Keycloak, Okta, WorkOS, dex). Rolling
// our own SAML is weeks of work and attack surface.
// ============================================================

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  device_authorization_endpoint?: string;
  code_challenge_methods_supported?: string[];
  /** RFC 7009. The web gateway revokes a session's tokens here at logout, when present. */
  revocation_endpoint?: string;
  /** OIDC RP-Initiated Logout. The web gateway sends the browser here after logout, when present. */
  end_session_endpoint?: string;
}

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  /** Groups/roles declared by the IdP, if it sends them. Informational only. */
  groups: string[];
  expiresAt: number;
}

const discoveryCache = new Map<string, { at: number; value: OidcDiscovery }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** Reads the provider configuration. Cached: not fetched on every request. */
export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.value;

  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Could not read the OIDC configuration of ${issuer} (HTTP ${res.status})`);
  }
  const value = (await res.json()) as OidcDiscovery;
  if (!value.jwks_uri || !value.token_endpoint) {
    throw new Error(`The OIDC configuration of ${issuer} is incomplete (missing jwks_uri or token_endpoint)`);
  }
  discoveryCache.set(issuer, { at: Date.now(), value });
  return value;
}

const JWKS_TIMEOUT_MS = 5000;

function jwksFor(jwksUri: string, fetchImpl?: typeof fetch) {
  let set = jwksCache.get(jwksUri);
  if (!set) {
    // createRemoteJWKSet caches the keys and rotates them only when an unknown
    // kid appears: it is not one request per token. The fetch is injected so we
    // can test without network access and to bound the time — a JWKS that does
    // not respond must not hang the request.
    set = createRemoteJWKSet(new URL(jwksUri), {
      timeoutDuration: JWKS_TIMEOUT_MS,
      ...(fetchImpl ? { [customFetch]: fetchImpl } : {}),
    });
    jwksCache.set(jwksUri, set);
  }
  return set;
}

/** Is the token signed asymmetrically (IdP) or with our secret (HS256)? */
export function isAsymmetric(token: string): boolean {
  try {
    const alg = decodeProtectedHeader(token).alg ?? '';
    return alg.startsWith('RS') || alg.startsWith('ES') || alg.startsWith('PS');
  } catch {
    return false;
  }
}

/** The AUTH_OIDC_PROVIDER value whose access tokens are checked by client_id and token_use instead of aud. */
export const COGNITO_PROVIDER = 'cognito';

/**
 * What an access token must carry, besides signature, issuer and expiry, to
 * be a credential for this API: the API named in `aud` (the OIDC norm), or,
 * for Cognito, one of the listed app clients in `client_id`. Exactly one: a
 * check with neither would verify no audience at all.
 */
export type AccessTokenCheck =
  | { audience: string; cognitoClientIds?: undefined }
  | { cognitoClientIds: readonly string[]; audience?: undefined };

/**
 * The check a deployment's AUTH_OIDC_* settings ask for. Only the exact value
 * `cognito` trades `aud` for the app clients listed, comma-separated, in
 * AUTH_OIDC_CLIENT_ID; any other value, unset included, keeps `aud`. The
 * settings come in as an argument because the web gateway loads this module
 * too, and it reads no engine configuration.
 */
export function accessTokenCheck(settings: { provider: string; audience: string; clientId: string }): AccessTokenCheck {
  if (settings.provider !== COGNITO_PROVIDER) return { audience: settings.audience };
  return { cognitoClientIds: settings.clientId.split(',').map((id) => id.trim()).filter((id) => id !== '') };
}

/**
 * Verifies an IdP access token: signature against the JWKS, plus issuer,
 * audience and expiration.
 *
 * CAREFUL — we verify the ACCESS token with our API's audience, not the
 * ID token. Accepting an ID token as an API credential is the most common
 * mistake when integrating OIDC: that token was issued for the client, not
 * for the resource.
 *
 * SECURITY: a Cognito access token has no `aud`, and a Cognito ID token has
 * the same issuer and keys. With `cognitoClientIds`, `token_use` must be
 * "access" and `client_id` one of the listed app clients: together they
 * stand where `aud` stands, and they are read only after the signature,
 * issuer and expiry verified.
 */
export async function verifyIdpToken(
  token: string,
  opts: { issuer: string; fetchImpl?: typeof fetch } & AccessTokenCheck
): Promise<VerifiedIdentity> {
  const conf = await discover(opts.issuer, opts.fetchImpl ?? fetch);
  const { payload } = await jwtVerify(token, jwksFor(conf.jwks_uri, opts.fetchImpl), {
    issuer: conf.issuer,
    // NOTE: jose skips the aud check only when `audience` is undefined, which
    // the type above allows in Cognito mode alone.
    audience: opts.audience,
  });
  if (opts.cognitoClientIds !== undefined) assertCognitoAccessToken(payload, opts.cognitoClientIds);

  const sub = payload.sub;
  if (!sub) throw new TokenWithoutSubjectError();

  return {
    issuer: conf.issuer,
    subject: sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    emailVerified: payload.email_verified === true,
    groups: extractGroups(payload),
    expiresAt: (payload.exp ?? 0) * 1000,
  };
}

/**
 * A verified token that names no subject. A rejection of the token itself, as
 * a bad signature or an expired token is, and not a failure to reach the IdP:
 * callers that tell the two apart (the API's authenticate) need a type, not a
 * message to match.
 */
export class TokenWithoutSubjectError extends Error {
  constructor() {
    super('The token has no "sub": it identifies nobody');
    this.name = 'TokenWithoutSubjectError';
  }
}

/**
 * A verified Cognito token that is not an access token issued to one of the
 * accepted app clients. A verdict on the token (401), like a bad signature.
 */
export class CognitoTokenRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CognitoTokenRejectedError';
  }
}

// CONTRACT: Cognito's access token as AWS documents it: `token_use` says which
// of its two tokens this is, `client_id` names the app client, no `aud`.
function assertCognitoAccessToken(payload: JWTPayload, clientIds: readonly string[]): void {
  if (payload.token_use !== 'access') {
    throw new CognitoTokenRejectedError('The token\'s token_use is not "access": an ID token is not an API credential');
  }
  if (typeof payload.client_id !== 'string' || !clientIds.includes(payload.client_id)) {
    throw new CognitoTokenRejectedError('The token\'s client_id is not an app client this API accepts');
  }
}

/** jose error codes that are a verdict on the token itself. Every other failure while verifying is the IdP. */
const TOKEN_REJECTION_CODES: ReadonlySet<string> = new Set([
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);

/**
 * True when verifyIdpToken failed because it judged the token and refused it,
 * false when it could not judge it: discovery or the JWKS unreachable, timed
 * out, an HTTP error, a body that is not what it promised. Two callers act on
 * the difference and must not drift apart: the API's authenticate (401 or
 * 502) and the web gateway's refresh (end the session or keep it).
 *
 * jose's errors are read by their code, which every one of them carries, and
 * not by class: the gateway loads this module, and what it may bind from jose
 * is the verification half only.
 */
export function isTokenRejection(err: unknown): err is Error {
  if (err instanceof TokenWithoutSubjectError || err instanceof CognitoTokenRejectedError) return true;
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && TOKEN_REJECTION_CODES.has(code);
}

/** Providers name groups differently; the usual ones are accepted. */
function extractGroups(payload: JWTPayload): string[] {
  for (const key of ['groups', 'roles', 'realm_access', 'cognito:groups']) {
    const raw = payload[key];
    if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string');
    // Keycloak: realm_access.roles
    if (raw && typeof raw === 'object' && Array.isArray((raw as { roles?: unknown }).roles)) {
      return ((raw as { roles: unknown[] }).roles).filter((g): g is string => typeof g === 'string');
    }
  }
  return [];
}

/** Tests only: clears the discovery and JWKS caches. */
export function resetOidcCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}
