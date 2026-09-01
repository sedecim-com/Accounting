import { Request, Response, NextFunction } from 'express';
import { checkRateLimit } from '../../../services/cache/redis.js';
import { config } from '../../../config/index.js';

/**
 * Limita por INQUILINO cuando ya se sabe quién llama, y por IP si no.
 *
 * Corre DESPUÉS de authenticate, así que reparte cuota entre inquilinos: dos
 * clientes distintos no se estorban aunque salgan por la misma IP.
 */
export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  return limitar(req, res, next, req.user?.tenant_id || req.ip || 'anonymous');
}

/**
 * Limita por IP ANTES de autenticar, con un bucket propio (prefijo `ip:`) para
 * no consumir el del inquilino.
 *
 * Sin esto, verificar una firma JWT —trabajo de CPU— era gratis para quien no
 * tiene credenciales: bastaba con inundar el endpoint con tokens basura, y el
 * limitador de más abajo nunca llegaba a correr. Es lo que CodeQL señala como
 * `js/missing-rate-limiting`: un manejador que autoriza sin nada que lo frene.
 *
 * También cubre lo que NO autentica: /public/v1 sirve sin credenciales, así
 * que la IP es la única identidad disponible.
 *
 * AVISO OPERATIVO: sin Redis configurado, checkRateLimit deja pasar todo por
 * decisión explícita (ver services/cache/redis.ts). Esto acota el código, no
 * el despliegue: en producción, configurar Redis es lo que le da efecto.
 */
export function preAuthRateLimiter(req: Request, res: Response, next: NextFunction): void {
  return limitar(req, res, next, `ip:${req.ip || 'anonymous'}`);
}

function limitar(req: Request, res: Response, next: NextFunction, key: string): void {
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
