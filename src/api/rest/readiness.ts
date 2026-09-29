import type { Request, Response } from 'express';
import { query } from '../../database/connection.js';
import { asyncHandler } from './middleware/async-handler.js';
import { logger } from '../../utils/logger.js';

/**
 * GET /ready — the readiness probe (k8s readinessProbe, load-balancer gate).
 *
 * CONTRACT: 200 `{status: 'ready', db: 'ok', timestamp}` or 503
 * `{status: 'not_ready', db: 'error', timestamp}`, and nothing else.
 *
 * SECURITY: mounted before authentication, so whoever can reach the port reads
 * it. That is why a failure answers only the stable `db: 'error'` and never the
 * driver's message: a Postgres error names the host, the port, the role or
 * the database, and that is infrastructure nobody unauthenticated should be
 * served (#315). The detail goes to the log under `ready_db_error`, with the
 * request's correlation id and the driver's `code` (a SQLSTATE such as 28P01,
 * or an errno such as ECONNREFUSED, which is what an alert rule branches on),
 * which is where an operator looks for it.
 */
export const readyHandler = asyncHandler(async (req: Request, res: Response) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ready', db: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    logger.error('ready_db_error', {
      request_id: req.headers['x-request-id'],
      error: err instanceof Error ? err.message : String(err),
      code: (err as { code?: unknown } | null)?.code,
    });
    res.status(503).json({ status: 'not_ready', db: 'error', timestamp: new Date().toISOString() });
  }
});
