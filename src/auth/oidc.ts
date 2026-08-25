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

/**
 * Verifies an IdP access token: signature against the JWKS, plus issuer,
 * audience and expiration.
 *
 * CAREFUL — we verify the ACCESS token with our API's audience, not the
 * ID token. Accepting an ID token as an API credential is the most common
 * mistake when integrating OIDC: that token was issued for the client, not
 * for the resource.
 */
export async function verifyIdpToken(
  token: string,
  opts: { issuer: string; audience: string; fetchImpl?: typeof fetch }
): Promise<VerifiedIdentity> {
  const conf = await discover(opts.issuer, opts.fetchImpl ?? fetch);
  const { payload } = await jwtVerify(token, jwksFor(conf.jwks_uri, opts.fetchImpl), {
    issuer: conf.issuer,
    audience: opts.audience,
  });

  const sub = payload.sub;
  if (!sub) throw new Error('The token has no "sub": it identifies nobody');

  return {
    issuer: conf.issuer,
    subject: sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    emailVerified: payload.email_verified === true,
    groups: extractGroups(payload),
    expiresAt: (payload.exp ?? 0) * 1000,
  };
}

/** Providers name groups differently; the usual ones are accepted. */
function extractGroups(payload: JWTPayload): string[] {
  for (const key of ['groups', 'roles', 'realm_access']) {
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
