import { v4 as uuidv4 } from 'uuid';
import { query } from '../../database/connection.js';
import { assertUrlDeWebhook, assertDestinoPublico } from './url-guard.js';
import { hashWebhookSignature } from '../../utils/encryption.js';
import { politicaDe, veredicto, razonDeMuerte, retryConfigInicial } from './politica-reintento.js';
import type { WebhookSubscription, WebhookDelivery } from '../../types/index.js';

export const WEBHOOK_EVENTS = [
  'journal_entry.created', 'journal_entry.updated', 'journal_entry.posted', 'journal_entry.void',
  'invoice.created', 'invoice.updated', 'invoice.sent', 'invoice.paid',
  'invoice.partially_paid', 'invoice.overdue', 'invoice.void',
  'cfdi.stamped', 'cfdi.cancelled',
  'bill.created', 'bill.approved', 'bill.paid',
  'payment.received', 'payment.made',
  'bank_transaction.imported', 'bank_transaction.matched',
  'reconciliation.completed',
  'period.soft_closed', 'period.hard_closed',
  'account.created', 'account.updated',
  'payroll.run.calculated', 'payroll.run.approved', 'payroll.run.paid',
  'paycheck.issued', 'cfdi_nomina.stamped', 'tax_form.filed',
] as const;

export async function createWebhook(
  tenantId: string,
  url: string,
  events: string[],
): Promise<WebhookSubscription> {
  // R2: la URL se valida ANTES de guardarla — un webhook que apunte a la red
  // privada o al metadata endpoint es SSRF con credenciales del servidor.
  assertUrlDeWebhook(url);
  // El secreto COMPLETO sale una sola vez: en esta respuesta (201). Los
  // listados lo omiten (listWebhooks) — quien lo pierde, rota el webhook.
  const secret = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  const id = uuidv4();

  // LA POLÍTICA DE REINTENTO SE ESCRIBE, no se deja al DEFAULT.
  // `retry_config` es NOT NULL con DEFAULT `{"max_retries": 5, ...}` desde
  // la 003, y `politicaDe` le da precedencia a la suscripción sobre el
  // entorno: omitir la columna aquí significaba que TODA suscripción nacía
  // con el 5 de la migración y que WEBHOOK_MAX_RETRIES no gobernaba nada.
  const result = await query<WebhookSubscription>(
    `INSERT INTO webhook_subscriptions (id, tenant_id, url, events, secret, is_active, retry_config)
     VALUES ($1, $2, $3, $4, $5, true, $6::jsonb) RETURNING *`,
    [id, tenantId, url, events, secret, JSON.stringify(retryConfigInicial())]
  );

  return result.rows[0];
}

export async function deleteWebhook(webhookId: string, tenantId: string): Promise<boolean> {
  // R2: la frontera dentro del SQL — conocer el UUID no basta para borrar el
  // webhook de otro inquilino. Devuelve si borró, para que la ruta pueda 404.
  const r = await query('DELETE FROM webhook_subscriptions WHERE id = $1 AND tenant_id = $2', [
    webhookId,
    tenantId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

export async function listWebhooks(tenantId: string): Promise<Array<Omit<WebhookSubscription, 'secret'>>> {
  // R2: el secreto NO viaja en los listados — salía entero en cada GET. Las
  // columnas se enumeran para que un campo nuevo decida su exposición a
  // propósito, no por el asterisco.
  const result = await query<Omit<WebhookSubscription, 'secret'>>(
    `SELECT id, tenant_id, url, events, is_active, created_at, updated_at
       FROM webhook_subscriptions WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId]
  );
  return result.rows;
}

export async function dispatchEvent(
  tenantId: string,
  event: string,
  data: Record<string, unknown>,
  entityId?: string
): Promise<void> {
  const subscriptions = await query<WebhookSubscription>(
    `SELECT * FROM webhook_subscriptions
     WHERE tenant_id = $1 AND is_active = true AND $2 = ANY(events)`,
    [tenantId, event]
  );

  for (const sub of subscriptions.rows) {
    const deliveryId = uuidv4();
    const payload = {
      id: `whd_${deliveryId.substring(0, 8)}`,
      event,
      timestamp: new Date().toISOString(),
      data,
      tenant_id: tenantId,
      entity_id: entityId,
    };

    await query(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [deliveryId, sub.id, event, JSON.stringify(payload)]
    );

    // Fire and forget - in production use BullMQ
    deliverWebhook(deliveryId, sub, payload).catch((err) => {
      console.error(`Webhook delivery failed for ${deliveryId}:`, err);
    });
  }
}

/**
 * UN intento de entrega, con su firma y su registro del resultado.
 *
 * Deja de ser privada porque el barrido (`barrido-entregas.ts`) tiene que
 * reintentar exactamente esto —el mismo cuerpo, la misma cabecera de
 * identidad— y una segunda copia del envío sería una segunda política de
 * firma esperando a divergir.
 */
export async function deliverWebhook(
  deliveryId: string,
  subscription: WebhookSubscription,
  payload: Record<string, unknown>
): Promise<void> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  // R2: la firma cubre `timestamp.body` (formato t=...,v1=... estilo Stripe).
  // Con la firma sólo sobre el cuerpo, el receptor no podía rechazar un
  // REPLAY por firma: la cabecera de tiempo viajaba sin firmar.
  const signature = `t=${timestamp},v1=${hashWebhookSignature(`${timestamp}.${body}`, subscription.secret)}`;

  try {
    // R2 (SSRF): el nombre se resuelve y se verifica ANTES de conectar — un
    // dominio público que apunte a la red privada no se entrega. Queda la
    // ventana de re-binding entre resolver y conectar; se anota, no se finge.
    await assertDestinoPublico(subscription.url);
    const response = await fetch(subscription.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-ID': deliveryId,
        'X-Webhook-Event': payload.event as string,
        'X-Webhook-Signature': signature,
        'X-Webhook-Timestamp': timestamp,
      },
      body,
      signal: AbortSignal.timeout(30000),
    });

    if (response.ok) {
      await query(
        `UPDATE webhook_deliveries SET
          status = 'success', http_status_code = $1, delivered_at = NOW(), attempt_count = attempt_count + 1
         WHERE id = $2`,
        [response.status, deliveryId]
      );
    } else {
      const responseBody = await response.text().catch(() => '');
      await markFailed(deliveryId, response.status, responseBody);
    }
  } catch (err) {
    await markFailed(deliveryId, null, (err as Error).message);
  }
}

async function markFailed(
  deliveryId: string,
  statusCode: number | null,
  errorMessage: string
): Promise<void> {
  // La política sale de la SUSCRIPCIÓN, no de una constante global:
  // `webhook_subscriptions.retry_config` existe desde la 003 con su DEFAULT
  // puesto y hasta ahora no lo leía nadie. Un receptor frágil y uno robusto
  // no merecen el mismo castigo, y la columna ya estaba ahí para decirlo.
  const delivery = await query<WebhookDelivery & { retry_config: WebhookSubscription['retry_config'] }>(
    `SELECT d.attempt_count, s.retry_config
       FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON s.id = d.webhook_id
      WHERE d.id = $1`,
    [deliveryId]
  );

  const attemptCount = (delivery.rows[0]?.attempt_count || 0) + 1;
  const fallo = veredicto(attemptCount, politicaDe(delivery.rows[0]));

  // MUERTA SE DICE, no se calla. Antes la entrega agotada quedaba en
  // 'failed' con el error del último intento, indistinguible de la que aún
  // tenía turnos: nadie podía saber, mirando la fila, si el sistema seguía
  // trabajando en ella o se había rendido. El motivo se escribe EN LA FILA
  // porque es donde va a leerlo quien investigue meses después, cuando la
  // salida del barrido que lo anunció ya no exista.
  const mensaje = fallo.muerta ? razonDeMuerte(attemptCount, errorMessage) : errorMessage;

  await query(
    `UPDATE webhook_deliveries SET
      status = $1, http_status_code = $2, error_message = $3,
      attempt_count = $4, next_retry_at = $5
     WHERE id = $6`,
    [fallo.muerta ? 'failed' : 'pending', statusCode, mensaje, attemptCount, fallo.proximoIntento, deliveryId]
  );
}

export async function retryDelivery(deliveryId: string, tenantId: string): Promise<boolean> {
  // R2: la entrega se localiza YA acotada por el inquilino de su suscripción
  // — conocer el UUID de una entrega ajena no re-dispara su webhook.
  const delivery = await query<WebhookDelivery & { sub: WebhookSubscription }>(
    `SELECT d.*, row_to_json(s.*) AS sub
       FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON s.id = d.webhook_id
      WHERE d.id = $1 AND s.tenant_id = $2`,
    [deliveryId, tenantId]
  );
  if (delivery.rows.length === 0) return false;
  const fila = delivery.rows[0];
  await deliverWebhook(deliveryId, fila.sub, fila.payload);
  return true;
}

export async function getDeliveries(
  webhookId: string,
  tenantId: string,
  filters?: { status?: string; limit?: number }
): Promise<WebhookDelivery[]> {
  // R2: acotado por el inquilino de la suscripción — el historial de
  // entregas de un webhook ajeno no se lee por UUID.
  let whereClause = 'WHERE d.webhook_id = $1 AND s.tenant_id = $2';
  const params: unknown[] = [webhookId, tenantId];

  if (filters?.status) {
    whereClause += ' AND d.status = $3';
    params.push(filters.status);
  }

  const result = await query<WebhookDelivery>(
    `SELECT d.* FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON s.id = d.webhook_id
     ${whereClause}
     ORDER BY d.created_at DESC LIMIT $${params.length + 1}`,
    [...params, filters?.limit || 50]
  );

  return result.rows;
}
