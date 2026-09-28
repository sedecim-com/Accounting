import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import {
  accessTokenCheck,
  discover,
  isAsymmetric,
  isTokenRejection,
  verifyIdpToken,
  resetOidcCaches,
} from '../../src/auth/oidc.js';

const ISSUER = 'https://idp.ejemplo.mx';
const AUDIENCE = 'https://api.midespacho.mx';
const CLI_CLIENT = 'cli-app-client';
const PLATFORM_CLIENT = 'platform-app-client';

// A real IdP in miniature: key pair, JWKS and discovery served by a fake
// fetch. This tests real signature verification, not a mock of jose.
async function fakeIdp() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'key-1';
  jwk.alg = 'RS256';

  const doc = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    device_authorization_endpoint: `${ISSUER}/device`,
  };

  const fetchImpl = vi.fn(async (url: string | URL) => {
    const u = url.toString();
    if (u.endsWith('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify(doc), { status: 200 });
    }
    if (u.endsWith('/jwks')) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('no', { status: 404 });
  }) as unknown as typeof fetch;

  const sign = (claims: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer((over.iss as string) ?? ISSUER)
      .setAudience((over.aud as string) ?? AUDIENCE)
      .setExpirationTime((over.exp as string) ?? '10m')
      .sign(privateKey);

  // Cognito's shape: no `aud`, the app client in `client_id`, the kind of token in `token_use`.
  const signCognito = (claims: Record<string, unknown>, iss = ISSUER) =>
    new SignJWT({ sub: 'cognito-sub', token_use: 'access', client_id: CLI_CLIENT, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(iss)
      .setExpirationTime('10m')
      .sign(privateKey);

  return { fetchImpl, sign, signCognito, doc };
}

beforeEach(() => resetOidcCaches());

describe('discover', () => {
  it('reads the issuer configuration and caches it', async () => {
    const { fetchImpl } = await fakeIdp();
    const a = await discover(ISSUER, fetchImpl);
    const b = await discover(ISSUER, fetchImpl);
    expect(a.jwks_uri).toBe(`${ISSUER}/jwks`);
    expect(b).toEqual(a);
    // A single request: discovery is not queried for every token.
    expect((fetchImpl as unknown as Mock).mock.calls).toHaveLength(1);
  });

  it('fails clearly if the configuration is incomplete', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ issuer: ISSUER }), { status: 200 })
    ) as unknown as typeof fetch;
    await expect(discover(ISSUER, fetchImpl)).rejects.toThrow(/incomplete/);
  });

  it('fails clearly if the issuer does not respond', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(discover(ISSUER, fetchImpl)).rejects.toThrow(/HTTP 500/);
  });
});

describe('isAsymmetric', () => {
  it('distinguishes our own token (HS256) from the external one (RS256)', async () => {
    const { sign } = await fakeIdp();
    const external = await sign({ sub: 'u1' });
    expect(isAsymmetric(external)).toBe(true);
    // Any HS256 token
    const own = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.firma';
    expect(isAsymmetric(own)).toBe(false);
  });

  it('does not blow up on garbage', () => {
    expect(isAsymmetric('not-a-token')).toBe(false);
  });
});

describe('verifyIdpToken', () => {
  it('accepts a well-signed token and extracts the identity', async () => {
    const { fetchImpl, sign } = await fakeIdp();
    const token = await sign({ sub: 'sub-123', email: 'ana@despacho.mx', email_verified: true });
    const id = await verifyIdpToken(token, { issuer: ISSUER, audience: AUDIENCE, fetchImpl });
    expect(id.subject).toBe('sub-123');
    expect(id.email).toBe('ana@despacho.mx');
    expect(id.emailVerified).toBe(true);
    expect(id.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects a different audience: a token for another API is no good here', async () => {
    const { fetchImpl, sign } = await fakeIdp();
    const token = await sign({ sub: 'u1' }, { aud: 'https://otra-api.mx' });
    await expect(
      verifyIdpToken(token, { issuer: ISSUER, audience: AUDIENCE, fetchImpl })
    ).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const { fetchImpl, sign } = await fakeIdp();
    const token = await sign({ sub: 'u1' }, { exp: '-1m' });
    await expect(
      verifyIdpToken(token, { issuer: ISSUER, audience: AUDIENCE, fetchImpl })
    ).rejects.toThrow();
  });

  it('rejects a signature from another key', async () => {
    const goodIdp = await fakeIdp();
    const badIdp = await fakeIdp();
    const token = await badIdp.sign({ sub: 'intruder' });
    await expect(
      verifyIdpToken(token, { issuer: ISSUER, audience: AUDIENCE, fetchImpl: goodIdp.fetchImpl })
    ).rejects.toThrow();
  });

  it('requires "sub": a token without a subject identifies nobody', async () => {
    const { fetchImpl, sign } = await fakeIdp();
    const token = await sign({ email: 'sin-sub@x.mx' });
    await expect(
      verifyIdpToken(token, { issuer: ISSUER, audience: AUDIENCE, fetchImpl })
    ).rejects.toThrow(/sub/);
  });

  it('accepts groups under each provider\'s claim name', async () => {
    const { fetchImpl, sign } = await fakeIdp();
    const flat = await sign({ sub: 'a', groups: ['contadores'] });
    expect((await verifyIdpToken(flat, { issuer: ISSUER, audience: AUDIENCE, fetchImpl })).groups)
      .toEqual(['contadores']);

    resetOidcCaches();
    const keycloak = await sign({ sub: 'b', realm_access: { roles: ['revisor'] } });
    expect((await verifyIdpToken(keycloak, { issuer: ISSUER, audience: AUDIENCE, fetchImpl })).groups)
      .toEqual(['revisor']);
  });
});

// MNE-001-104 (#369): with AUTH_OIDC_PROVIDER=cognito, client_id and token_use stand where aud stands.
describe('verifyIdpToken with Cognito access tokens', () => {
  const COGNITO = { issuer: ISSUER, cognitoClientIds: [CLI_CLIENT, PLATFORM_CLIENT] };

  /** The rejection, which must be a verdict on the token (401), never an IdP outage (502). */
  async function refusal(token: string, fetchImpl: typeof fetch): Promise<Error> {
    const err = await verifyIdpToken(token, { ...COGNITO, fetchImpl }).then(
      () => new Error('the token was accepted'),
      (e: unknown) => e as Error
    );
    expect(isTokenRejection(err), err.message).toBe(true);
    return err;
  }

  it('accepts an access token by client_id and token_use, with no aud, and reads cognito:groups', async () => {
    const { fetchImpl, signCognito } = await fakeIdp();
    const token = await signCognito({ client_id: PLATFORM_CLIENT, 'cognito:groups': ['contadores'] });
    const id = await verifyIdpToken(token, { ...COGNITO, fetchImpl });
    expect(id.subject).toBe('cognito-sub');
    expect(id.groups).toEqual(['contadores']);
  });

  it('refuses a Cognito ID token where an access token is required, even though its aud names the client', async () => {
    const { fetchImpl, signCognito } = await fakeIdp();
    const idToken = await signCognito({ token_use: 'id', aud: CLI_CLIENT, email: 'ana@despacho.mx' });
    expect((await refusal(idToken, fetchImpl)).message).toMatch(/token_use/);
  });

  it('refuses an access token issued to an app client that is not listed', async () => {
    const { fetchImpl, signCognito } = await fakeIdp();
    const token = await signCognito({ client_id: 'another-app-client' });
    expect((await refusal(token, fetchImpl)).message).toMatch(/client_id/);
  });

  it('refuses a token that does not say what it is or whom it was issued to', async () => {
    const { fetchImpl, signCognito } = await fakeIdp();
    await refusal(await signCognito({ token_use: undefined }), fetchImpl);
    await refusal(await signCognito({ client_id: undefined }), fetchImpl);
  });

  it('refuses a token for another issuer, even one signed with the same key', async () => {
    const { fetchImpl, signCognito } = await fakeIdp();
    const token = await signCognito({}, 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OTHER');
    expect((await refusal(token, fetchImpl)).message).toMatch(/iss/);
  });

  it('outside Cognito mode the same access token is refused: aud is still required', async () => {
    const { fetchImpl, signCognito } = await fakeIdp();
    const token = await signCognito({});
    await expect(verifyIdpToken(token, { issuer: ISSUER, audience: AUDIENCE, fetchImpl })).rejects.toThrow(/aud/);
  });
});

describe('accessTokenCheck', () => {
  it('only AUTH_OIDC_PROVIDER=cognito trades aud for the app clients listed in AUTH_OIDC_CLIENT_ID', () => {
    expect(accessTokenCheck({ provider: 'cognito', audience: AUDIENCE, clientId: ` ${CLI_CLIENT} ,${PLATFORM_CLIENT},` }))
      .toEqual({ cognitoClientIds: [CLI_CLIENT, PLATFORM_CLIENT] });
    for (const provider of ['oidc', 'generic', '', 'Cognito']) {
      expect(accessTokenCheck({ provider, audience: AUDIENCE, clientId: CLI_CLIENT }), provider).toEqual({ audience: AUDIENCE });
    }
  });
});
