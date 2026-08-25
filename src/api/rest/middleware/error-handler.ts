import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../../utils/errors.js';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.headers['x-request-id'] as string;

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      errors: [
        {
          code: err.code,
          message: err.message,
          field: err.field,
          details: err.details,
        },
      ],
      meta: {
        request_id: requestId,
        timestamp: new Date().toISOString(),
        version: 'v1',
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
