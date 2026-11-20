import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { z } from 'zod';
import { RequestValidationError } from '../../../utils/errors.js';
import { parseForClientKeyed } from '../../../utils/zod-client-errors.js';
import { answerUnrequestedIn } from './locale.js';

/**
 * The request a route handler receives. @types/express 5 widens `req.params`
 * values to `string | string[]` for wildcard segments (`*name`); every route of
 * this API uses named segments (`:id`) only, which are always one string.
 */
export type RouteRequest = Request<Record<string, string>>;

/**
 * Wrap an async route handler so unhandled rejections are forwarded to the
 * Express error pipeline (errorHandler) instead of crashing the process.
 *
 *   router.post('/x', asyncHandler(async (req, res) => { ... }))
 *
 * NOTE: Express 5 forwards a rejected promise from a handler by itself, so a
 * bare `async` handler no longer hangs the request. The wrapper stays: it is
 * what the routes are written with, and it behaves the same under both. The
 * comments in the routes that say "Express 4 does not forward a rejection"
 * describe the defect each one fixed at the time, not today's Express.
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

type ManejadorConEsquema = RequestHandler & { [MARCA_CUERPO]?: z.ZodType };

/** El esquema de cuerpo que lleva un manejador, si lo lleva. */
export function esquemaDeCuerpo(h: unknown): z.ZodType | undefined {
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
 *
 * CONTRACT: an invalid body answers HTTP 422 with code `VALIDATION_ERROR`
 * in the standard error envelope of errorHandler (`errors[0]` with `code`
 * and `message` only, `meta` with request_id, timestamp, version and
 * language). The message is written by catalog key (MNE-001-152, #151): in
 * English it is `Invalid request body: <path>: <message>` for each issue,
 * joined with '; ', where `<path>` is the dotted field path or `<root>`,
 * worded and ordered as zod 3.25.76 did by src/utils/zod-client-errors.ts
 * (#367). That English is `err.message` and the logs, byte for byte, and it
 * is what the client reads unless the request named a supported language
 * (no header, `*` and only unsupported languages all read English: the one
 * exception to DEFAULT_LOCALE, `answerUnrequestedIn`). A request that names
 * `es` reads the frame and every keyed issue in Spanish. Either way the
 * response declares `Content-Language`, `Vary: Accept-Language` and
 * `meta.language`, and code, field, paths and issue order do not change.
 * tests/api/golden/rest-body.golden.json and
 * tests/api/rest/body-contract.spec.ts pin it.
 */
export function validateBody<S extends z.ZodType>(schema: S): RequestHandler {
  const validador: ManejadorConEsquema = (req, res, next) => {
    const parsed = parseForClientKeyed<unknown>(schema, req.body);
    if (!parsed.success) {
      answerUnrequestedIn(res, 'en');
      return next(new RequestValidationError({ kind: 'body' }, parsed.issues));
    }
    req.body = parsed.data;
    next();
  };
  validador[MARCA_CUERPO] = schema;
  return validador;
}

/**
 * Give a request that carried no parsed body the empty object it had under
 * Express 4. body-parser 2 (Express 5) leaves `req.body` undefined when there
 * is no body or the content type is not the parser's; body-parser 1 left `{}`.
 * Mounted after the body parser, it keeps what a bodyless request answers: the
 * same validation message from `validateBody`, and no TypeError (a 500) in a
 * handler that reads a field straight out of `req.body`.
 */
export const emptyBodyAsObject: RequestHandler = (req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
};

// The query-string twin of the body mark above: the schema of one query
// parameter hangs from the middleware that validates it, so the OpenAPI census
// (src/api/rest/openapi.ts) publishes the parameters a route really checks.
const QUERY_MARK = Symbol('query-parameter-schema');

/** One validated query parameter: its name and the schema it must satisfy. */
export interface QueryParameter {
  readonly name: string;
  readonly schema: z.ZodType;
}

type HandlerWithQuery = RequestHandler & { [QUERY_MARK]?: QueryParameter };

/** The query parameter a handler validates, if it validates one. */
export function queryParameterOf(h: unknown): QueryParameter | undefined {
  return typeof h === 'function' ? (h as HandlerWithQuery)[QUERY_MARK] : undefined;
}

/**
 * Validate one query-string parameter, `req.query[name]`, against a Zod
 * schema. On success the parsed value replaces the raw one.
 *
 * CONTRACT: an invalid parameter answers what `validateBody` answers for a bad
 * body (#315): HTTP 422 `VALIDATION_ERROR` in the error envelope, with
 * `field` set to the parameter's name and the message, in English,
 * `Invalid query parameter: <name>: <message>` (issues joined with '; ',
 * worded by src/utils/zod-client-errors.ts). It is keyed and answers in the
 * same language as `validateBody` (MNE-001-152): English unless the request
 * names a supported language. A bare `.parse()` inside the handler threw a
 * ZodError, which is not an AppError, and errorHandler answered 500 to a
 * client typo.
 */
export function validateQuery(name: string, schema: z.ZodType): RequestHandler {
  const validator: HandlerWithQuery = (req, res, next) => {
    const parsed = parseForClientKeyed<unknown>(schema, req.query[name]);
    if (!parsed.success) {
      answerUnrequestedIn(res, 'en');
      return next(new RequestValidationError({ kind: 'query', name }, parsed.issues));
    }
    if (parsed.data !== undefined) {
      // NOTE: Express 5 makes `req.query` a getter that parses the URL again on
      // every read, so a write into the object it returns is lost. An own
      // property keeps the parsed value for the handlers that follow.
      Object.defineProperty(req, 'query', {
        value: { ...req.query, [name]: parsed.data },
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    next();
  };
  validator[QUERY_MARK] = { name, schema };
  return validator;
}
