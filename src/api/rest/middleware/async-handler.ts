import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ZodTypeAny, infer as ZInfer } from 'zod';
import { ValidationError } from '../../../utils/errors.js';

/**
 * Wrap an async route handler so unhandled rejections are forwarded to the
 * Express error pipeline (errorHandler) instead of crashing the process.
 *
 *   router.post('/x', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler<
  Req extends Request = Request,
  Res extends Response = Response,
>(
  fn: (req: Req, res: Res, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as Req, res as Res, next)).catch(next);
  };
}

/**
 * Validate `req.body` against a Zod schema. On success the parsed value
 * replaces `req.body` (so handlers see the typed shape). On failure throws a
 * ValidationError that errorHandler converts to a 400 with field details.
 */
export function validateBody<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const details = parsed.error.errors.map(
        (e) => `${e.path.join('.') || '<root>'}: ${e.message}`
      );
      return next(new ValidationError(`Invalid request body: ${details.join('; ')}`));
    }
    req.body = parsed.data as ZInfer<S>;
    next();
  };
}

/**
 * Validate `req.query` against a Zod schema (after express's parsing of query
 * strings, so values are still strings — coerce in the schema with z.coerce.*).
 */
export function validateQuery<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      const details = parsed.error.errors.map(
        (e) => `${e.path.join('.') || '<root>'}: ${e.message}`
      );
      return next(new ValidationError(`Invalid query params: ${details.join('; ')}`));
    }
    // req.query is typed as ParsedQs; cast through unknown.
    (req as unknown as { query: unknown }).query = parsed.data;
    next();
  };
}
