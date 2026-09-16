import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../../utils/errors.js';
import { responseLanguage, responseLocale } from './locale.js';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.headers['x-request-id'] as string;

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
