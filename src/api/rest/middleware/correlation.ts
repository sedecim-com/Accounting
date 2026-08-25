import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logContext, logger } from '../../../utils/logger.js';

/**
 * Correlation ID middleware.
 *
 * Honors an inbound `x-request-id` header if present (so gateways / callers
 * can propagate their own ID through the system); otherwise generates a UUID.
 *
 * The ID is:
 *   1. Set on `req.headers['x-request-id']` so downstream handlers see it.
 *   2. Echoed in the `X-Request-Id` response header for client-side correlation.
 *   3. Stored in the AsyncLocalStorage `logContext` so every log line within
 *      this request — including from deeply nested services — carries it.
 *
 * We enter the ALS scope with `logContext.run(...)` and call `next()` inside,
 * which makes the context flow through Express's async pipeline.
 */
export const correlationIdMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const existing = req.headers['x-request-id'];
  const requestId = typeof existing === 'string' && existing.length > 0 ? existing : uuidv4();
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-Id', requestId);

  // Tenant/user/entity are populated later by authenticate(); seed them lazily
  // so logs emitted before auth still carry the request_id.
  const ctx = { request_id: requestId };
  logContext.run(ctx, () => {
    // Once auth runs, enrich the store so subsequent logs pick up identity.
    res.on('finish', () => {
      logger.info('http_request', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        user_id: req.user?.user_id,
        tenant_id: req.user?.tenant_id,
      });
    });
    next();
  });
};

/**
 * After authenticate() populates req.user, this middleware copies the identity
 * into the log context so downstream logs pick it up. Mount AFTER authenticate.
 */
export const enrichLogContextMiddleware: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const ctx = logContext.getStore();
  if (ctx && req.user) {
    ctx.tenant_id = req.user.tenant_id;
    ctx.user_id = req.user.user_id;
    ctx.entity_id = req.entityId;
  }
  next();
};
