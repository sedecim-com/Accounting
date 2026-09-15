// ============================================================
// THE BROWSER'S CONTRACT WITH THE API (W1 · issue #117)
//
// Every read the board makes is one entry of API_OPERATIONS, and this is the
// only file of the browser program allowed to spell '/v1'. Criterion
// web-client-reads-only-contracted-paths reads this table on its syntax tree
// and requires each entry to be a GET that exists in the COMMITTED
// docs/openapi.json, so a renamed or retired route, or a call the contract
// never declared, fails the plan instead of the demo. It also requires fetch
// to appear only in api.ts.
//
// There is no generated client: the contract publishes no success schemas yet,
// so a generated module would carry method and path only, which the subset
// check above already proves against the same file.
//
// DOM-free: the unit specs import it.
// ============================================================

export const API_OPERATIONS = {
  portfolio: { method: 'GET', path: '/v1/portfolio' },
  drafts: { method: 'GET', path: '/v1/ai/drafts' },
  questions: { method: 'GET', path: '/v1/ai/questions' },
  periods: { method: 'GET', path: '/v1/fiscal-periods' },
} as const;

export type ApiOperation = keyof typeof API_OPERATIONS;

/** The header the gateway's CSRF guard demands on every /v1 request. */
export const REQUEST_MARKER_HEADER = 'X-Mnemosine-Request';

/** The gateway's own session routes, which are not part of the API contract. */
export const SIGN_IN_PATH = '/auth/login';
export const SIGN_OUT_PATH = '/auth/logout';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A lowercase, hyphenated UUID: the only form an entity id takes in a URL or a header here. */
export function isCanonicalUuid(value: string): boolean {
  return CANONICAL_UUID.test(value);
}

/** The fields of a fetch init this client sets, typed without the DOM. */
export interface GetRequestInit {
  method: 'GET';
  credentials: 'same-origin';
  redirect: 'error';
  cache: 'no-store';
  headers: Record<string, string>;
}

export interface GetRequest {
  url: string;
  init: GetRequestInit;
}

export interface GetRequestOptions {
  /** The entity the read is about, sent as x-entity-id. Must be a canonical UUID. */
  entityId?: string;
  /** A status filter, for the list operations that take one. */
  status?: string;
}

/** Operations that read one entity, and so need x-entity-id. */
const ENTITY_OPERATIONS: ReadonlySet<ApiOperation> = new Set<ApiOperation>(['drafts', 'questions', 'periods']);

/**
 * The URL and init of one contracted read.
 *
 * Same-origin credentials (the session cookie, never a token), no redirect
 * followed, nothing cached, and the marker header. An entity id that is not a
 * canonical UUID throws before it can reach a header, and the portfolio takes
 * no parameter at all, because the API refuses any query key there.
 */
export function buildGetRequest(operation: ApiOperation, options: GetRequestOptions = {}): GetRequest {
  const { path } = API_OPERATIONS[operation];
  const headers: Record<string, string> = { [REQUEST_MARKER_HEADER]: '1', accept: 'application/json' };

  if (ENTITY_OPERATIONS.has(operation)) {
    if (options.entityId === undefined || !isCanonicalUuid(options.entityId)) {
      throw new Error(`${operation} needs a canonical entity id`);
    }
    headers['x-entity-id'] = options.entityId;
  } else if (options.entityId !== undefined || options.status !== undefined) {
    throw new Error(`${operation} takes no entity and no filter`);
  }

  const query = options.status === undefined ? '' : `?status=${encodeURIComponent(options.status)}`;
  return {
    url: `${path}${query}`,
    init: { method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers },
  };
}

/**
 * A read's outcome, reduced to what the screen does with it. Declared here,
 * not in api.ts, so the DOM-free board and its specs name it without loading
 * the network client.
 */
export type ApiResult =
  | { kind: 'ok'; body: unknown }
  | { kind: 'signed-out' }
  | { kind: 'session-expired' }
  // missingPermissions: the refusal lists permissions the account lacks.
  | { kind: 'forbidden'; missingPermissions: boolean }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

/** The first error of the {errors:[{code, details}]} envelope the API and the gateway share. */
function firstErrorOf(body: unknown): object | undefined {
  if (typeof body !== 'object' || body === null || !('errors' in body) || !Array.isArray(body.errors)) return undefined;
  const first: unknown = body.errors[0];
  return typeof first === 'object' && first !== null ? first : undefined;
}

/** The code of the first error in an error response body, when it has one. */
export function errorCodeOf(body: unknown): string | undefined {
  const error = firstErrorOf(body);
  return error !== undefined && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Whether a 403 body names permissions the account lacks.
 *
 * The API answers 403 FORBIDDEN in two places with the same code:
 * authenticate, when x-entity-id names an entity the token does not grant,
 * with no details, and before any permission is checked; and
 * requirePermission, which lists what is missing in details.missing. Only the
 * second is about the account, and the board says different things for each.
 */
export function namesMissingPermissions(body: unknown): boolean {
  const error = firstErrorOf(body);
  const details: unknown = error !== undefined && 'details' in error ? error.details : undefined;
  if (typeof details !== 'object' || details === null || !('missing' in details)) return false;
  return Array.isArray(details.missing) && details.missing.length > 0;
}
