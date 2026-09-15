import {
  buildGetRequest,
  errorCodeOf,
  namesMissingPermissions,
  REQUEST_MARKER_HEADER,
  SIGN_OUT_PATH,
  type ApiOperation,
  type ApiResult,
  type GetRequestOptions,
} from './contract.js';

// ============================================================
// THE ONE NETWORK CLIENT OF THE BROWSER PROGRAM (W1 · issue #117)
//
// The only two calls to fetch in src/gateway/app live here, and criterion
// web-client-reads-only-contracted-paths counts them: a read goes through
// buildGetRequest (so through API_OPERATIONS), and signing out is a POST to
// the gateway's own route, never to /v1. The page holds no token: the session
// cookie is HttpOnly and travels with same-origin credentials.
//
// Outcomes are reduced to ApiResult (contract.ts), what the screen does with
// them. A status code is not shown to the user; board.ts maps an outcome to a
// failure and the view maps that to a message key.
// ============================================================

/** The parsed body of an error response, or undefined when it is not JSON. */
async function errorBodyOf(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

export async function apiGet(operation: ApiOperation, options: GetRequestOptions = {}): Promise<ApiResult> {
  const request = buildGetRequest(operation, options);
  let response: Response;
  try {
    response = await fetch(request.url, request.init);
  } catch {
    // A network failure, or a redirect the init refuses to follow.
    return { kind: 'unavailable' };
  }
  if (response.status === 401) {
    return errorCodeOf(await errorBodyOf(response)) === 'SESSION_EXPIRED' ? { kind: 'session-expired' } : { kind: 'signed-out' };
  }
  if (response.status === 403) return { kind: 'forbidden', missingPermissions: namesMissingPermissions(await errorBodyOf(response)) };
  if (response.status === 502 || response.status === 503 || response.status === 504) return { kind: 'unavailable' };
  if (!response.ok) return { kind: 'failed' };
  try {
    const body: unknown = await response.json();
    return { kind: 'ok', body };
  } catch {
    return { kind: 'failed' };
  }
}

/**
 * Ends the session at the gateway and returns where the browser goes next:
 * the IdP's end-session URL, or '/'. The gateway answers every sign-out it
 * performed with one, so undefined means it was not confirmed and the session
 * may still be open.
 */
export async function signOut(): Promise<string | undefined> {
  try {
    const response = await fetch(SIGN_OUT_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { [REQUEST_MARKER_HEADER]: '1' },
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('redirect' in body)) return undefined;
    return typeof body.redirect === 'string' ? body.redirect : undefined;
  } catch {
    return undefined;
  }
}
