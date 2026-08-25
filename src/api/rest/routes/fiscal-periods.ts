import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError } from '../../../utils/errors.js';
import {
  getPeriodCloseStatus,
  softClosePeriod,
  hardClosePeriod,
} from '../../../services/accounting/index.js';
import type { FiscalPeriod } from '../../../types/index.js';

const router = Router();

const closePeriodSchema = z.object({
  entity_id: z.string().uuid().optional(),
});

// GET /v1/fiscal-periods
router.get('/', requirePermission('accounts:read'), requireEntityAccess, async (req: Request, res: Response) => {
  const { entity_id, fiscal_year_id, status } = req.query;
  const entityId = entity_id as string || req.entityId;

  let where = 'WHERE entity_id = $1';
  const params: unknown[] = [entityId];
  let idx = 2;

  if (fiscal_year_id) { where += ` AND fiscal_year_id = $${idx++}`; params.push(fiscal_year_id); }
  if (status) { where += ` AND status = $${idx++}`; params.push(status); }

  const result = await query<FiscalPeriod>(
    `SELECT * FROM fiscal_periods ${where} ORDER BY start_date`,
    params
  );

  res.json({
    data: result.rows,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// GET /v1/fiscal-periods/:id/close-status
router.get('/:id/close-status', requirePermission('periods:close'), async (req: Request, res: Response) => {
  const entityId = req.query.entity_id as string || req.entityId;
  if (!entityId) throw new NotFoundError('Entity');

  const status = await getPeriodCloseStatus(req.params.id, entityId);

  res.json({
    data: status,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// POST /v1/fiscal-periods/:id/soft-close
router.post('/:id/soft-close', requirePermission('periods:close'), validateBody(closePeriodSchema), asyncHandler(async (req: Request, res: Response) => {
  const entityId = req.body.entity_id || req.entityId;
  const period = await softClosePeriod(req.params.id, entityId, req.user!.user_id);

  res.json({
    data: period,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/fiscal-periods/:id/hard-close
router.post('/:id/hard-close', requirePermission('periods:close'), validateBody(closePeriodSchema), asyncHandler(async (req: Request, res: Response) => {
  const entityId = req.body.entity_id || req.entityId;
  const period = await hardClosePeriod(req.params.id, entityId, req.user!.user_id);

  res.json({
    data: period,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
