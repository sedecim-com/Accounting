import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { ValidationError, NotFoundError } from '../../../utils/errors.js';
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  dispatchEvent,
  retryDelivery,
  getDeliveries,
  WEBHOOK_EVENTS,
} from '../../../services/webhooks/webhook-service.js';
import { declararRiesgoRuta } from '../risk.js';

const router = Router();

const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
});

// POST /v1/webhooks
router.post('/', declararRiesgoRuta({ riesgo: 'escritura', escribe: 'webhook_subscriptions (la suscripcion; la entrega la hace el despachador)' }), requirePermission('settings:manage'), validateBody(createWebhookSchema), asyncHandler(async (req: Request, res: Response) => {
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
router.delete('/:id', declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'DELETE de webhook_subscriptions: borrado duro, sin copia' }), requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  // R2: acotado por inquilino; cero filas = no existe o no es tuyo → 404.
  const borrado = await deleteWebhook(req.params.id, req.user!.tenant_id);
  if (!borrado) throw new NotFoundError('Webhook', req.params.id);
  res.status(204).send();
}));

// POST /v1/webhooks/:id/test
router.post('/:id/test', declararRiesgoRuta({ riesgo: 'externo', escribe: 'nada en la base; ENTREGA a la URL del suscriptor' }), requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
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
    req.user!.tenant_id,
    { status: status as string, limit: limit ? parseInt(limit as string, 10) : undefined }
  );

  res.json({
    data: deliveries,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/webhook-deliveries/:id/retry
router.post('/deliveries/:id/retry', declararRiesgoRuta({ riesgo: 'externo', escribe: 'webhook_deliveries + reenvia a la URL del suscriptor' }), requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  const retried = await retryDelivery(req.params.id, req.user!.tenant_id);
  if (!retried) throw new NotFoundError('Webhook delivery', req.params.id);

  res.json({
    data: { retried: true },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
