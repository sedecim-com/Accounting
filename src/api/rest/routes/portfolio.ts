import { Router, Request, Response } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { listPortfolio, portfolioCallerOf } from '../../../services/portfolio/portfolio-service.js';

const router = Router();

// GET /v1/portfolio
//
// The firm portfolio: one row per entity the token grants, inside the token's
// tenant. The scope comes from portfolioCallerOf(req), which reads only the
// verified token; see src/services/portfolio/portfolio-service.ts.
//
// The permission is exactly what the per-entity routes it summarises demand:
// accounts:read for the period state (GET /v1/fiscal-periods) and
// journal_entries:read for the draft and question counts (GET /v1/ai/drafts,
// /v1/ai/questions). It is a conjunction, so the summary never shows a count
// the caller could not read entity by entity. There is no requireEntityAccess:
// the route acts on the token's entity set, not on one entity the request names.
router.get('/', requirePermission('accounts:read', 'journal_entries:read'), asyncHandler(async (req: Request, res: Response) => {
  const result = await listPortfolio(portfolioCallerOf(req));

  res.json({
    data: result.rows,
    meta: {
      request_id: req.headers['x-request-id'],
      timestamp: new Date().toISOString(),
      version: 'v1',
      as_of_date: result.asOfDate,
      omitted: { unresolved: result.unresolved },
      not_evaluated: ['close_readiness'],
    },
  });
}));

export default router;
