import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError } from '../../../utils/errors.js';
import {
  getPeriodCloseStatus,
  softClosePeriod,
  hardClosePeriod,
  listFiscalPeriods,
} from '../../../services/accounting/index.js';
import { declararRiesgoRuta } from '../risk.js';

const router = Router();

const closePeriodSchema = z.object({
  entity_id: z.string().uuid().optional(),
});

// GET /v1/fiscal-periods
router.get('/', requirePermission('accounts:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, fiscal_year_id, status } = req.query;
  const entityId = entity_id as string || req.entityId;

  // The filtering moved into the fiscal-calendar service; the response is
  // still the table's own columns, in start_date order.
  const rows = await listFiscalPeriods(entityId as string, {
    fiscalYearId: fiscal_year_id as string | undefined,
    status: status as string | undefined,
  });

  res.json({
    data: rows,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /v1/fiscal-periods/:id/close-status
router.get('/:id/close-status', requirePermission('periods:close'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const entityId = req.query.entity_id as string || req.entityId;
  if (!entityId) throw new NotFoundError('Entity');

  const status = await getPeriodCloseStatus(req.params.id, entityId);

  res.json({
    data: status,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/fiscal-periods/:id/soft-close
// El cierre blando se deshace reabriendo, pero reabrir es a su vez
// irreversible (`mnemosine period reopen` lo declara asi): la vuelta no es
// gratis, y una clase que dijera `escritura` prometeria que si lo es.
router.post('/:id/soft-close', declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'fiscal_periods.status' }), requirePermission('periods:close'), requireEntityAccess, validateBody(closePeriodSchema), asyncHandler(async (req: Request, res: Response) => {
  const entityId = req.body.entity_id || req.entityId;
  const period = await softClosePeriod(req.params.id, entityId, req.user!.user_id);

  res.json({
    data: period,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/fiscal-periods/:id/hard-close
router.post('/:id/hard-close', declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'fiscal_periods.status (cierre duro) y el arrastre de saldos' }), requirePermission('periods:close'), requireEntityAccess, validateBody(closePeriodSchema), asyncHandler(async (req: Request, res: Response) => {
  const entityId = req.body.entity_id || req.entityId;
  const period = await hardClosePeriod(req.params.id, entityId, req.user!.user_id);

  res.json({
    data: period,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
