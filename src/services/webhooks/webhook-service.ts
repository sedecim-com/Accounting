import { v4 as uuidv4 } from 'uuid';
import { query } from '../../database/connection.js';
import { hashWebhookSignature } from '../../utils/encryption.js';
import { config } from '../../config/index.js';
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
  const secret = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  const id = uuidv4();

  const result = await query<WebhookSubscription>(
    `INSERT INTO webhook_subscriptions (id, tenant_id, url, events, secret, is_active)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
    [id, tenantId, url, events, secret]
  );

  return result.rows[0];
}

export async function deleteWebhook(webhookId: string): Promise<void> {
  await query('DELETE FROM webhook_subscriptions WHERE id = $1', [webhookId]);
}

export async function listWebhooks(tenantId: string): Promise<WebhookSubscription[]> {
  const result = await query<WebhookSubscription>(
    'SELECT * FROM webhook_subscriptions WHERE tenant_id = $1 ORDER BY created_at DESC',
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

async function deliverWebhook(
  deliveryId: string,
  subscription: WebhookSubscription,
  payload: Record<string, unknown>
): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = hashWebhookSignature(body, subscription.secret);
  const timestamp = Math.floor(Date.now() / 1000).toString();

  try {
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
  const maxRetries = config.webhooks.maxRetries;
  const retryInterval = config.webhooks.retryInterval;

  const delivery = await query<WebhookDelivery>(
    'SELECT * FROM webhook_deliveries WHERE id = $1',
    [deliveryId]
  );

  const attemptCount = (delivery.rows[0]?.attempt_count || 0) + 1;
  const status = attemptCount >= maxRetries ? 'failed' : 'pending';
  const nextRetry = attemptCount < maxRetries
    ? new Date(Date.now() + retryInterval * 1000 * Math.pow(2, attemptCount - 1))
    : null;

  await query(
    `UPDATE webhook_deliveries SET
      status = $1, http_status_code = $2, error_message = $3,
      attempt_count = $4, next_retry_at = $5
     WHERE id = $6`,
    [status, statusCode, errorMessage, attemptCount, nextRetry, deliveryId]
  );
}

export async function retryDelivery(deliveryId: string): Promise<void> {
  const delivery = await query<WebhookDelivery>(
    'SELECT * FROM webhook_deliveries WHERE id = $1',
    [deliveryId]
  );

  if (delivery.rows.length === 0) return;

  const webhook = await query<WebhookSubscription>(
    'SELECT * FROM webhook_subscriptions WHERE id = $1',
    [delivery.rows[0].webhook_id]
  );

  if (webhook.rows.length === 0) return;

  await deliverWebhook(deliveryId, webhook.rows[0], delivery.rows[0].payload);
}

export async function getDeliveries(
  webhookId: string,
  filters?: { status?: string; limit?: number }
): Promise<WebhookDelivery[]> {
  let whereClause = 'WHERE webhook_id = $1';
  const params: unknown[] = [webhookId];

  if (filters?.status) {
    whereClause += ' AND status = $2';
    params.push(filters.status);
  }

  const result = await query<WebhookDelivery>(
    `SELECT * FROM webhook_deliveries ${whereClause}
     ORDER BY created_at DESC LIMIT $${params.length + 1}`,
    [...params, filters?.limit || 50]
  );

  return result.rows;
}
