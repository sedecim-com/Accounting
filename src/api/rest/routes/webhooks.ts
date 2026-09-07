import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError } from '../../../utils/errors.js';
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

// LA LISTA DE EVENTOS VIVE EN EL ESQUEMA, NO EN EL MANEJADOR.
//
// Era `z.array(z.string())` con la comprobación contra WEBHOOK_EVENTS
// escrita DENTRO del manejador. Las dos rechazan lo mismo, pero sólo una
// se puede publicar: el contrato de la API (src/api/rest/openapi.ts) sale
// del esquema que viaja colgado de `validateBody`, y lo que el manejador
// comprueba por su cuenta es invisible para el censo. Así que el
// documento anunciaba «events: array de string» y la ruta contestaba 422
// a cualquier evento fuera de la lista — un cuerpo que la especificación
// declaraba válido y la API rechazaba, que es exactamente el defecto que
// el conversor existe para no cometer.
//
// Con el enum aquí, la lista de eventos admitidos viaja en el contrato y
// quien integra la lee sin abrir el código.
const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});

// POST /v1/webhooks
router.post('/', declararRiesgoRuta({ riesgo: 'escritura', escribe: 'webhook_subscriptions (la suscripcion; la entrega la hace el despachador)' }), requirePermission('settings:manage'), validateBody(createWebhookSchema), asyncHandler(async (req: Request, res: Response) => {
  const { url, events } = req.body;

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
