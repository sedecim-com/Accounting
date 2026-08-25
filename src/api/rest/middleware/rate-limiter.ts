import { Request, Response, NextFunction } from 'express';
import { checkRateLimit } from '../../../services/cache/redis.js';
import { config } from '../../../config/index.js';

export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const key = req.user?.tenant_id || req.ip || 'anonymous';
  const { windowMs, maxRequests } = config.rateLimit;

  checkRateLimit(key, windowMs, maxRequests).then(({ allowed, remaining, resetAt }) => {
    res.set('X-RateLimit-Limit', String(maxRequests));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

    if (!allowed) {
      res.status(429).json({
        errors: [{
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please try again later.',
        }],
        meta: {
          request_id: req.headers['x-request-id'],
          timestamp: new Date().toISOString(),
          version: 'v1',
        },
      });
      return;
    }

    next();
  }).catch(() => next());
}
