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

// ============================================================
// EL ESQUEMA VIAJA EN EL MANEJADOR.
//
// `validateBody(esquema)` era una caja cerrada: el esquema quedaba dentro
// del cierre y desde fuera no había forma de preguntarle a una ruta qué
// cuerpo admite. Por eso la API tenía 50 esquemas de Zod validando cada
// petición y CERO especificación: lo único publicable era una lista
// escrita a mano al lado del código, que es justo la clase de artefacto
// que este proyecto lleva un mes cazando.
//
// La marca es la MISMA técnica que `declararRiesgoRuta` usa para la clase
// de riesgo (../risk.ts), y por el mismo motivo: un mapa aparte indexado
// por ruta es otra lista paralela, y una ruta renombrada lo deja mintiendo
// en silencio. Colgado del manejador, el esquema no puede separarse de lo
// que valida — el censo recorre la pila real de Express y lo encuentra ahí
// o no existe.
//
// La marca no CAMBIA nada: `validateBody` valida exactamente igual que
// antes. Sólo deja de ser opaca.
// ============================================================
const MARCA_CUERPO = Symbol('esquema-de-cuerpo');

type ManejadorConEsquema = RequestHandler & { [MARCA_CUERPO]?: ZodTypeAny };

/** El esquema de cuerpo que lleva un manejador, si lo lleva. */
export function esquemaDeCuerpo(h: unknown): ZodTypeAny | undefined {
  return typeof h === 'function' ? (h as ManejadorConEsquema)[MARCA_CUERPO] : undefined;
}

/**
 * Validate `req.body` against a Zod schema. On success the parsed value
 * replaces `req.body` (so handlers see the typed shape). On failure throws a
 * ValidationError that errorHandler converts to a 422 with field details.
 * (Decía 400; `ValidationError` construye con 422 desde utils/errors.ts, y el
 * contrato publicado sale de ahí, así que el comentario tenía que dejar de
 * decir otra cosa.)
 *
 * El manejador que devuelve lleva colgado el esquema (`esquemaDeCuerpo`),
 * para que el contrato de la API pueda derivarse de lo que la API valida
 * de verdad y no de una copia.
 */
export function validateBody<S extends ZodTypeAny>(schema: S): RequestHandler {
  const validador: ManejadorConEsquema = (req, _res, next) => {
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
  validador[MARCA_CUERPO] = schema;
  return validador;
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
