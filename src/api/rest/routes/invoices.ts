import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError, ValidationError, NotImplementedError } from '../../../utils/errors.js';
import { postCustomerPaymentEntry, attestEntryAsync } from '../../../services/accounting/index.js';
import {
  listInvoices,
  getInvoiceById,
  createInvoice,
  issueInvoice,
  voidInvoice,
} from '../../../services/ar/invoice-service.js';
import { nextEntityNumber } from '../../../utils/sequence.js';
import { estadoParaPersistir } from '../../../services/integrations/mexico/pac/simulacion.js';
import type { Invoice } from '../../../types/index.js';

// ============================================================
// /v1/invoices — HTTP surface over the AR invoice service.
// Listing, reading, creating, issuing and voiding live in
// services/ar/invoice-service.ts so the CLI and the agent reach the
// same behaviour. What stays here is request parsing, permissions,
// response shape — plus the payment and CFDI endpoints, which belong
// to the cash-application and fiscal families and are untouched.
// ============================================================

const router = Router();

// ─── Schemas ───
const numericLike = z.union([z.string(), z.number()]);
const invoiceLineSchema = z.object({
  item_id: z.string().uuid().nullable().optional(),
  description: z.string().optional(),
  quantity: numericLike.optional(),
  unit_price: numericLike,
  revenue_account_id: z.string().uuid(),
  tax_code: z.string().nullable().optional(),
  tax_rate: numericLike.nullable().optional(),
  cost_center_id: z.string().uuid().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  cfdi_product_code: z.string().nullable().optional(),
  cfdi_unit_code: z.string().nullable().optional(),
}).passthrough();

const createInvoiceSchema = z.object({
  entity_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  currency_code: z.string().length(3).optional(),
  lines: z.array(invoiceLineSchema).min(1, 'At least 1 line required'),
  terms: z.string().optional(),
  memo: z.string().optional(),
  po_number: z.string().optional(),
});

const sendInvoiceSchema = z.object({
  to: z.string().email().optional(),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  subject: z.string().optional(),
  message: z.string().optional(),
});

const recordPaymentSchema = z.object({
  amount: numericLike,
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  payment_method: z.string().optional(),
  bank_account_id: z.string().uuid().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
}).passthrough();

const voidInvoiceSchema = z.object({
  reason: z.string().min(1),
});

const meta = (req: Request) => ({
  request_id: req.headers['x-request-id'],
  timestamp: new Date().toISOString(),
  version: 'v1',
});

// GET /v1/invoices
router.get('/', requirePermission('invoices:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const {
    entity_id, customer_id, status,
    start_date, end_date, search,
    page = '1', per_page = '50',
  } = req.query;

  const entityId = (entity_id as string) || req.entityId!;
  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(100, Math.max(1, parseInt(per_page as string, 10)));

  const { rows, total } = await listInvoices(entityId, {
    customerId: customer_id as string | undefined,
    statuses: status ? [status as string] : undefined,
    since: start_date as string | undefined,
    until: end_date as string | undefined,
    search: search as string | undefined,
    limit: perPage,
    offset: (pageNum - 1) * perPage,
  });

  res.json({
    data: rows,
    pagination: {
      page: pageNum, per_page: perPage,
      total_pages: Math.ceil(total / perPage),
      total_count: total, next_cursor: null, prev_cursor: null,
    },
    meta: meta(req),
  });
}));

// GET /v1/invoices/:id
router.get('/:id', requirePermission('invoices:read'), asyncHandler(async (req: Request, res: Response) => {
  const invoice = await getInvoiceById(req.params.id, { includeLines: true });
  if (!invoice) throw new NotFoundError('Invoice', req.params.id);
  res.json({ data: invoice, meta: meta(req) });
}));

// POST /v1/invoices
router.post('/', requirePermission('invoices:create'), requireEntityAccess, validateBody(createInvoiceSchema), asyncHandler(async (req: Request, res: Response) => {
  const invoice = await createInvoice({ ...req.body, created_by: req.user!.user_id });
  res.status(201).json({ data: invoice, meta: meta(req) });
}));

// POST /v1/invoices/:id/send
// Sending is this endpoint's idea of issuance: the AR/revenue entry posts
// here, atomically with the delivery fields. `issueInvoice` owns both halves
// now — `markSent` is what separates delivering from merely issuing, and the
// CLI's `invoice issue` passes it as false.
router.post('/:id/send', requirePermission('invoices:send'), validateBody(sendInvoiceSchema), asyncHandler(async (req: Request, res: Response) => {
  const { to } = req.body;

  const { attest } = await issueInvoice(req.params.id, req.user!.user_id, {
    markSent: true,
    sentTo: to,
  });
  if (attest && req.tenantId) attestEntryAsync(req.tenantId, attest.entityId, attest.entryId);

  // TODO: Integrate with email service

  res.json({ data: { sent: true, sent_to: to }, meta: meta(req) });
}));

// POST /v1/invoices/:id/payments
router.post('/:id/payments', requirePermission('invoices:create'), validateBody(recordPaymentSchema.extend({
  payment_amount: numericLike,
  payment_method: z.string(),
  reference_number: z.string().optional(),
}).partial({ amount: true, reference: true })), asyncHandler(async (req: Request, res: Response) => {
  const { payment_date, payment_amount, payment_method, reference_number, bank_account_id } = req.body;

  const invoiceResult = await query<Invoice>(
    'SELECT * FROM invoices WHERE id = $1',
    [req.params.id]
  );

  if (invoiceResult.rows.length === 0) {
    throw new NotFoundError('Invoice', req.params.id);
  }

  const invoice = invoiceResult.rows[0];
  const paymentAmt = new Decimal(payment_amount);
  const amountDue = new Decimal(invoice.amount_due);

  if (paymentAmt.greaterThan(amountDue)) {
    throw new ValidationError('Payment amount exceeds amount due');
  }

  const jeInfo = await withTransaction(async (client) => {
    const paymentNumber = await nextEntityNumber(client, invoice.entity_id, 'customer_payment', 'PMT');
    const paymentId = uuidv4();

    await client.query(
      `INSERT INTO customer_payments (
        id, entity_id, payment_number, customer_id,
        payment_amount, currency_code, payment_method,
        reference_number, bank_account_id, payment_date,
        status, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'completed', $11)`,
      [
        paymentId, invoice.entity_id, paymentNumber, invoice.customer_id,
        paymentAmt.toFixed(4), invoice.currency_code, payment_method,
        reference_number || null, bank_account_id || null, payment_date,
        req.user!.user_id,
      ]
    );

    await client.query(
      `INSERT INTO payment_allocations (id, payment_id, invoice_id, amount_applied)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), paymentId, req.params.id, paymentAmt.toFixed(4)]
    );

    const newAmountPaid = new Decimal(invoice.amount_paid).plus(paymentAmt);
    const newAmountDue = amountDue.minus(paymentAmt);
    const newStatus = newAmountDue.lessThanOrEqualTo(0) ? 'paid' : 'partially_paid';

    await client.query(
      `UPDATE invoices SET
        amount_paid = $1, amount_due = $2, status = $3,
        last_payment_date = $4
       WHERE id = $5`,
      [newAmountPaid.toFixed(4), newAmountDue.toFixed(4), newStatus, payment_date, req.params.id]
    );

    const entry = await postCustomerPaymentEntry(
      client,
      {
        id: paymentId,
        entity_id: invoice.entity_id,
        payment_number: paymentNumber,
        payment_amount: paymentAmt.toFixed(4),
        payment_date,
        bank_account_id: bank_account_id || null,
        journal_entry_id: null,
      },
      req.user!.user_id
    );
    return entry ? { entityId: invoice.entity_id, entryId: entry.id } : null;
  });
  if (jeInfo && req.tenantId) attestEntryAsync(req.tenantId, jeInfo.entityId, jeInfo.entryId);

  res.status(201).json({
    data: { recorded: true },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/invoices/:id/void
// NIF B-1: the invoice's GL entry is annulled by a linked reversal, in the
// same transaction as the status change. The stamped-CFDI and applied-cash
// guards the service states are opted out of here on purpose: this endpoint
// has never enforced them and its contract is unchanged.
router.post('/:id/void', requirePermission('invoices:void'), asyncHandler(async (req: Request, res: Response) => {
  const { invoice, attest } = await voidInvoice(req.params.id, req.user!.user_id, {
    allowStamped: true,
    allowApplied: true,
  });
  if (attest && req.tenantId) attestEntryAsync(req.tenantId, attest.entityId, attest.entryId);

  res.json({ data: invoice, meta: meta(req) });
}));

// POST /v1/invoices/:id/cfdi/stamp (Mexico)
router.post('/:id/cfdi/stamp', requirePermission('invoices:create'), asyncHandler(async (req: Request, res: Response) => {
  const { pacRouter } = await import('../../../services/integrations/mexico/pac/pac-router.js');

  const invoice = await query<Invoice>('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
  if (invoice.rows.length === 0) throw new NotFoundError('Invoice', req.params.id);

  // Build minimal CFDI XML for stamping (real implementation would use cfdi.ts generateCfdiXml)
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0"
  Folio="${invoice.rows[0].invoice_number}" Total="${invoice.rows[0].total_amount}"
  SubTotal="${invoice.rows[0].subtotal}" Moneda="${invoice.rows[0].currency_code}">
</cfdi:Comprobante>`;

  // Stamp via multi-PAC router with automatic failover
  const result = await pacRouter.stamp(xml, {
    tenantId: req.user!.tenant_id,
    userId: req.user!.user_id,
  });

  // Un folio fabricado por un adaptador simulado NUNCA se guarda como
  // 'stamped': quedaría indistinguible de uno emitido por el SAT.
  const { cfdi_status, nota } = estadoParaPersistir(result);

  await query(
    `UPDATE invoices SET
      cfdi_uuid = $1, cfdi_status = $2,
      pac_provider = $3, stamped_at = NOW(),
      memo = CASE WHEN $4::text IS NULL THEN memo
                  ELSE COALESCE(memo, '') || E'\n' || $4::text END
     WHERE id = $5`,
    [result.uuid, cfdi_status, result.provider_used, nota, req.params.id]
  );

  res.json({
    data: {
      cfdi_uuid: result.uuid,
      cfdi_status,
      simulado: result.simulado,
      aviso: nota,
      provider_used: result.provider_used,
      fecha_timbrado: result.fecha_timbrado,
      no_certificado_sat: result.no_certificado_sat,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/invoices/:id/cfdi/cancel (Mexico)
router.post('/:id/cfdi/cancel', requirePermission('invoices:void'), asyncHandler(async (req: Request, res: Response) => {
  const { cancellation_reason, replacement_uuid } = req.body;

  if (!cancellation_reason) {
    throw new ValidationError('cancellation_reason is required');
  }

  const invoiceResult = await query<Invoice>(
    'SELECT * FROM invoices WHERE id = $1 AND cfdi_status = \'stamped\'',
    [req.params.id]
  );

  if (invoiceResult.rows.length === 0) {
    throw new NotFoundError('Stamped Invoice', req.params.id);
  }

  // SAT cancellation reason codes:
  // 01 - Invoice issued with errors, with a related replacement
  // 02 - Invoice issued with errors, no related replacement
  // 03 - The transaction did not take place
  // 04 - Nominative transaction related in the global invoice
  const validReasons = ['01', '02', '03', '04'];
  if (!validReasons.includes(cancellation_reason)) {
    throw new ValidationError(`Invalid cancellation reason. Must be one of: ${validReasons.join(', ')}`);
  }

  if (cancellation_reason === '01' && !replacement_uuid) {
    throw new ValidationError('replacement_uuid is required for reason 01');
  }

  // Cancelar ante el SAT es irreversible y este endpoint NUNCA lo hizo: marcaba
  // la factura como cancelada en la base y devolvía 200. El resultado es la
  // peor forma del defecto que el cerrojo antisimulación existe para impedir —
  // el mayor cree cancelado un CFDI que el SAT sigue considerando vigente, y
  // nadie se entera hasta que llega el requerimiento.
  //
  // Se retira en vez de completarse porque cancelar de verdad son cuatro cosas
  // que no existen todavía: llamar al PAC por pac-router (que ya tiene la
  // guarda), esperar el acuse, archivarlo por bytes, y encadenar la reversa del
  // asiento contable. Media cancelación es peor que ninguna.
  throw new NotImplementedError(
    'mnemosine todavía no cancela CFDI ante el SAT. Cancela en el portal de tu PAC ' +
      'o en el del SAT, y después reversa el asiento con `mnemosine entry reverse ' +
      '<numero> --reason "CFDI cancelado, acuse <folio>"`. Cuando exista, la ' +
      'cancelación irá por pac-router con acuse archivado y reversa encadenada.',
    { invoice_id: req.params.id, cancellation_reason, replacement_uuid: replacement_uuid ?? null }
  );

  res.json({
    data: {
      cfdi_uuid: invoiceResult.rows[0].cfdi_uuid,
      cfdi_status: 'cancelled',
      cancellation_reason,
      replacement_uuid: replacement_uuid || null,
      cancelled_at: new Date().toISOString(),
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
