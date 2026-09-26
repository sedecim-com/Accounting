import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// ============================================================
// An OIDC provider in memory: RS256 keys, discovery, JWKS, a token endpoint
// and a revocation endpoint, all served through a fetch function. Every call
// is recorded, so a spec can count token requests and read what was sent.
//
// Each IdP gets its own issuer URL: src/auth/oidc.ts caches discovery and
// JWKS by URL, and two specs sharing an issuer would share keys they did not
// generate.
// ============================================================

export const AUDIENCE = 'https://api.mnemosine.test';

export interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
  params: URLSearchParams;
}

export interface TokenReply {
  status?: number;
  body: unknown;
}

export type TokenHandler = (params: URLSearchParams) => Promise<TokenReply> | TokenReply;

export interface FakeIdp {
  issuer: string;
  fetch: typeof fetch;
  tokenCalls: RecordedCall[];
  revocationCalls: RecordedCall[];
  /** Replaces the token endpoint's behaviour; undefined restores the default. */
  onToken: TokenHandler | undefined;
  /** The default token endpoint, for an onToken that only adds to it. */
  defaultToken: TokenHandler;
  /** Discovery fields to add or override (e.g. a different issuer, no end_session_endpoint). */
  discoveryOverrides: Record<string, unknown>;
  signAccess(opts?: { aud?: string; iss?: string; expiresIn?: string; sub?: string }): Promise<string>;
  signHs256(secret: string): Promise<string>;
  /** Codes the default token endpoint accepts: issue one per sign-in. */
  issueCode(): string;
  /** Every access and refresh token the default endpoint handed out. */
  issued: { access: string[]; refresh: string[] };
}

export async function createFakeIdp(name: string = randomUUID()): Promise<FakeIdp> {
  const issuer = `https://idp-${name}.test`;
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'gateway-test-key';
  jwk.alg = 'RS256';

  const codes = new Set<string>();
  const idp: FakeIdp = {
    issuer,
    tokenCalls: [],
    revocationCalls: [],
    onToken: undefined,
    discoveryOverrides: {},
    issued: { access: [], refresh: [] },
    fetch: undefined as unknown as typeof fetch,
    defaultToken: undefined as unknown as TokenHandler,

    signAccess(opts = {}) {
      return new SignJWT({ scope: 'openid' })
        .setProtectedHeader({ alg: 'RS256', kid: 'gateway-test-key' })
        .setIssuer(opts.iss ?? issuer)
        .setAudience(opts.aud ?? AUDIENCE)
        .setSubject(opts.sub ?? 'user-1')
        .setIssuedAt()
        .setJti(randomUUID())
        .setExpirationTime(opts.expiresIn ?? '10m')
        .sign(privateKey);
    },

    signHs256(secret) {
      return new SignJWT({ tenant_id: 'forged', permissions: ['*'] })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(issuer)
        .setAudience(AUDIENCE)
        .setSubject('user-1')
        .setExpirationTime('10m')
        .sign(new TextEncoder().encode(secret));
    },

    issueCode() {
      const code = `code-${randomUUID()}`;
      codes.add(code);
      return code;
    },
  };

  const defaultToken: TokenHandler = async (params) => {
    const grant = params.get('grant_type');
    if (grant === 'authorization_code' && codes.delete(params.get('code') ?? '')) {
      const access = await idp.signAccess();
      const refresh = `refresh-${randomUUID()}`;
      idp.issued.access.push(access);
      idp.issued.refresh.push(refresh);
      return { body: { access_token: access, token_type: 'Bearer', refresh_token: refresh, id_token: await idp.signAccess({ aud: 'web-client' }), expires_in: 600 } };
    }
    if (grant === 'refresh_token' && idp.issued.refresh.includes(params.get('refresh_token') ?? '')) {
      const access = await idp.signAccess();
      const refresh = `refresh-${randomUUID()}`;
      idp.issued.access.push(access);
      idp.issued.refresh.push(refresh);
      return { body: { access_token: access, token_type: 'Bearer', refresh_token: refresh, expires_in: 600 } };
    }
    return { status: 400, body: { error: 'invalid_grant' } };
  };
  idp.defaultToken = defaultToken;

  const record = async (input: string | URL | Request, init?: RequestInit): Promise<RecordedCall> => {
    const headers = new Headers(init?.headers);
    return {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      params: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    };
  };

  idp.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = await record(input, init);
    const path = new URL(call.url).pathname;
    if (path === '/.well-known/openid-configuration') {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
        end_session_endpoint: `${issuer}/logout`,
        ...idp.discoveryOverrides,
      });
    }
    if (path === '/jwks') return Response.json({ keys: [jwk] });
    if (path === '/token') {
      idp.tokenCalls.push(call);
      const reply = await (idp.onToken ?? defaultToken)(call.params);
      return Response.json(reply.body, { status: reply.status ?? 200 });
    }
    if (path === '/revoke') {
      idp.revocationCalls.push(call);
      return new Response(null, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  return idp;
}
