import crypto from 'node:crypto';
import http from 'node:http';
import { discover, type OidcDiscovery } from './oidc.js';
import type { StoredToken } from './token-store.js';

// ============================================================
// LOGIN FLOWS FOR A CLI
//
// A CLI cannot do the classic browser redirect, and the two
// standards that solve it address different situations:
//
//   · PKCE with loopback redirect (RFC 8252) — opens the browser and
//     listens on 127.0.0.1. Best experience when there is a browser
//     on the same machine. It is what gcloud and aws sso do.
//   · Device Authorization Grant (RFC 8628) — "open this URL and type
//     this code". Indispensable over SSH or on a server, which is
//     exactly where the ingest cron lives.
// ============================================================

export interface LoginConfig {
  issuer: string;
  clientId: string;
  audience: string;
  scope?: string;
}

export interface LoginPresenter {
  /** Opens or displays the authorization URL. */
  showUrl(url: string, note?: string): void | Promise<void>;
  /** Displays the device code to the user. */
  showCode?(code: string, url: string): void;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE verifier and challenge (S256): the challenge travels, the verifier never does. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function toStored(res: TokenResponse, issuer: string): StoredToken {
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    // Without expires_in we deliberately assume a short lifetime: it is safer
    // to refresh too often than to use an expired token.
    expiresAt: Date.now() + (res.expires_in ?? 300) * 1000,
    issuer,
  };
}

async function postForm(
  url: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<TokenResponse> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return (await res.json()) as TokenResponse;
}

// ── Flow 1: Authorization Code + PKCE with loopback ──

export async function loginWithPkce(
  cfg: LoginConfig,
  presenter: LoginPresenter,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<StoredToken> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const conf = await discover(cfg.issuer, fetchImpl);
  const { verifier, challenge } = createPkcePair();
  const state = base64url(crypto.randomBytes(16));

  const { code, redirectUri } = await awaitLoopbackCode(conf, cfg, challenge, state, presenter, opts.timeoutMs);

  const token = await postForm(conf.token_endpoint, {
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }, fetchImpl);

  if (!token.access_token) {
    throw new Error(`The provider did not deliver a token: ${token.error_description ?? token.error ?? 'no detail'}`);
  }
  return toStored(token, conf.issuer);
}

/** Starts an ephemeral loopback server and waits for the code. */
function awaitLoopbackCode(
  conf: OidcDiscovery,
  cfg: LoginConfig,
  challenge: string,
  state: string,
  presenter: LoginPresenter,
  timeoutMs = 5 * 60 * 1000
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error('Timed out waiting for authorization'))),
      timeoutMs
    );
    timer.unref();

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        error || !code
          ? '<p>Authorization failed. You can close this window.</p>'
          : '<p>Done. Return to the terminal.</p>'
      );

      if (error) return finish(() => reject(new Error(`The provider returned: ${error}`)));
      if (!code) return;
      // The state ties the response to this request: without checking it, a
      // third party could inject their own code into our listener.
      if (gotState !== state) {
        return finish(() => reject(new Error('The "state" does not match: response discarded')));
      }
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      finish(() => resolve({ code, redirectUri: `http://127.0.0.1:${port}/callback` }));
    });

    server.on('error', (err) => finish(() => reject(err)));

    // Ephemeral port: nothing gets stepped on and no fixed port has to be registered.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const auth = new URL(conf.authorization_endpoint);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('client_id', cfg.clientId);
      auth.searchParams.set('redirect_uri', redirectUri);
      auth.searchParams.set('scope', cfg.scope ?? 'openid email profile offline_access');
      auth.searchParams.set('code_challenge', challenge);
      auth.searchParams.set('code_challenge_method', 'S256');
      auth.searchParams.set('state', state);
      if (cfg.audience) auth.searchParams.set('audience', cfg.audience);
      void presenter.showUrl(auth.toString(), 'Authorize in the browser; this terminal is waiting.');
    });
  });
}

// ── Flow 2: Device Authorization Grant ──

export async function loginWithDeviceCode(
  cfg: LoginConfig,
  presenter: LoginPresenter,
  opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}
): Promise<StoredToken> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
  const conf = await discover(cfg.issuer, fetchImpl);
  if (!conf.device_authorization_endpoint) {
    throw new Error(`${conf.issuer} does not support the device flow; use the browser one`);
  }

  const startRes = await fetchImpl(conf.device_authorization_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      scope: cfg.scope ?? 'openid email profile offline_access',
      ...(cfg.audience ? { audience: cfg.audience } : {}),
    }).toString(),
  });
  const start = (await startRes.json()) as {
    device_code: string; user_code: string; verification_uri: string;
    verification_uri_complete?: string; interval?: number; expires_in?: number;
  };
  if (!start.device_code) throw new Error('The provider did not deliver a device_code');

  presenter.showCode?.(start.user_code, start.verification_uri_complete ?? start.verification_uri);

  // The interval is dictated by the provider; if it asks to go slower (slow_down) we comply.
  let intervalMs = (start.interval ?? 5) * 1000;
  const deadline = Date.now() + (start.expires_in ?? 900) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const token = await postForm(conf.token_endpoint, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: start.device_code,
      client_id: cfg.clientId,
    }, fetchImpl);

    if (token.access_token) return toStored(token, conf.issuer);
    if (token.error === 'authorization_pending') continue;
    if (token.error === 'slow_down') { intervalMs += 5000; continue; }
    throw new Error(`The provider rejected the login: ${token.error_description ?? token.error}`);
  }
  throw new Error('The device code expired before being authorized');
}
