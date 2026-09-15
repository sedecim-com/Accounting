import type { NextFunction, Request, RequestHandler, Response } from 'express';

// ============================================================
// GATEWAY ERRORS
//
// The same envelope as the API ({errors: [{code, message}]}), so the browser
// client reads one shape. Codes are English machine codes; the browser maps
// each to a translated message by key. Messages never carry configuration,
// upstream detail or a token: a refusal says what was refused, not what the
// gateway knows.
// ============================================================

export type GatewayErrorCode =
  | 'HOST_REJECTED'
  | 'PATH_REJECTED'
  | 'CSRF_REJECTED'
  | 'METHOD_NOT_PROXIED'
  | 'METHOD_NOT_ALLOWED'
  | 'SESSION_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'SESSION_CAPACITY'
  | 'UPSTREAM_REDIRECT_REFUSED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'IDP_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

const MESSAGES: Record<GatewayErrorCode, string> = {
  HOST_REJECTED: 'The Host header does not name this gateway.',
  PATH_REJECTED: 'The request path is not accepted.',
  CSRF_REJECTED: 'The request did not come from this application.',
  METHOD_NOT_PROXIED: 'Only reads are relayed to the API.',
  METHOD_NOT_ALLOWED: 'The method is not allowed here.',
  SESSION_REQUIRED: 'Sign in first.',
  SESSION_EXPIRED: 'The session ended. Sign in again.',
  SESSION_CAPACITY: 'The gateway cannot open more sessions right now.',
  UPSTREAM_REDIRECT_REFUSED: 'The API answered with a redirect, which is not relayed.',
  UPSTREAM_UNAVAILABLE: 'The API is not reachable.',
  IDP_UNAVAILABLE: 'The identity provider is not reachable. The session is kept; try again shortly.',
  NOT_FOUND: 'Not found.',
  INTERNAL_ERROR: 'The gateway failed to handle the request.',
};

export function sendError(res: Response, status: number, code: GatewayErrorCode): void {
  res.status(status).json({ errors: [{ code, message: MESSAGES[code] }] });
}

/**
 * Wraps an async handler so a rejection reaches the error handler instead of
 * becoming an unhandled rejection. The wrapper keeps the handler's name, so a
 * walk of the router stack still reads which guard sits where.
 */
export function handleAsync(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  const wrapped: RequestHandler = (req, res, next) => {
    fn(req, res, next).catch(next);
  };
  Object.defineProperty(wrapped, 'name', { value: fn.name });
  return wrapped;
}
