import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { ValidationError } from '../../../utils/errors.js';
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  dispatchEvent,
  retryDelivery,
  getDeliveries,
  WEBHOOK_EVENTS,
} from '../../../services/webhooks/webhook-service.js';

const router = Router();

const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
});

// POST /v1/webhooks
router.post('/', requirePermission('settings:manage'), validateBody(createWebhookSchema), asyncHandler(async (req: Request, res: Response) => {
  const { url, events } = req.body;

  const invalidEvents = events.filter((e: string) => !WEBHOOK_EVENTS.includes(e as typeof WEBHOOK_EVENTS[number]));
  if (invalidEvents.length > 0) {
    throw new ValidationError(`Invalid events: ${invalidEvents.join(', ')}`);
  }

  const webhook = await createWebhook(req.user!.tenant_id, url, events);

  res.status(201).json({
    data: webhook,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /v1/webhooks
router.get('/', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  const webhooks = await listWebhooks(req.user!.tenant_id);

  res.json({
    data: webhooks,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// DELETE /v1/webhooks/:id
router.delete('/:id', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  await deleteWebhook(req.params.id);
  res.status(204).send();
}));

// POST /v1/webhooks/:id/test
router.post('/:id/test', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  await dispatchEvent(req.user!.tenant_id, 'test.ping', { message: 'Test webhook delivery' });

  res.json({
    data: { sent: true },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /v1/webhooks/:id/deliveries
router.get('/:id/deliveries', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  const { status, limit } = req.query;
  const deliveries = await getDeliveries(
    req.params.id,
    { status: status as string, limit: limit ? parseInt(limit as string, 10) : undefined }
  );

  res.json({
    data: deliveries,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/webhook-deliveries/:id/retry
router.post('/deliveries/:id/retry', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  await retryDelivery(req.params.id);

  res.json({
    data: { retried: true },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
