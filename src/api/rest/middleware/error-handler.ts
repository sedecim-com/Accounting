import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../../utils/errors.js';
import { responseLanguage, responseLocale } from './locale.js';

/**
 * CONTRACT: body-parser refuses a request before any route runs, and its
 * errors are plain `Error`s with a `type` and a 4xx `status`, not AppErrors.
 * Left alone they fell through to the 500 below, so a malformed JSON body sent
 * to /v1/ai (or any JSON route) told the client the server had failed (#315).
 * They are mapped here to the same codes the AI webhook route answers for the
 * same faults, so one malformed body reads the same on every route.
 */
function bodyParserError(err: Error): AppError | undefined {
  const { type, status } = err as Error & { type?: unknown; status?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number') return undefined;
  if (type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Body must be valid JSON');
  if (type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Body exceeds the size limit');
  if (status === 415) return new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', err.message);
  if (status >= 400 && status < 500) return new AppError(400, 'MALFORMED_BODY', 'Malformed request body');
  return undefined;
}

export function errorHandler(
  rawErr: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.headers['x-request-id'] as string;
  const err = bodyParserError(rawErr) ?? rawErr;

  if (err instanceof AppError) {
    // The `code` is wire contract and goes out the same in every language; the
    // `message` is for a human (I9 · issue #151).
    //
    // THE RESPONSE DECLARES A LANGUAGE ONLY WHEN IT REALLY RENDERED ONE. An
    // error written by catalog key is rendered in the negotiated language, and
    // then — and only then — the response carries `Content-Language`,
    // `meta.language` and `Vary: Accept-Language`. An error still written as
    // prose goes out with the text it was written with, in whatever language
    // that was, and says nothing about the language: measured on this very
    // commit, announcing one would have labelled an English 401 as `es-MX` and
    // a Spanish idempotency conflict as `en-US`.
    const keyed = err.messageKey !== undefined;
    const language = responseLanguage(res);
    if (keyed) {
      res.setHeader('Content-Language', responseLocale(res));
      res.vary('Accept-Language');
    }
    res.status(err.statusCode).json({
      errors: [
        {
          code: err.code,
          message: err.localized(language),
          field: err.field,
          details: err.details,
        },
      ],
      meta: {
        request_id: requestId,
        timestamp: new Date().toISOString(),
        version: 'v1',
        ...(keyed ? { language } : {}),
      },
    });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    errors: [
      {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
      },
    ],
    meta: {
      request_id: requestId,
      timestamp: new Date().toISOString(),
      version: 'v1',
    },
  });
}
