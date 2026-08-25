import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError, ValidationError, AccountingError } from '../../../utils/errors.js';
import {
  postInvoiceEntry,
  postCustomerPaymentEntry,
  voidJournalEntryInTx,
  attestEntryAsync,
} from '../../../services/accounting/index.js';
import { nextEntityNumber } from '../../../utils/sequence.js';
import type { Invoice, InvoiceLine, PaginationMeta } from '../../../types/index.js';

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

// GET /v1/invoices
router.get('/', requirePermission('invoices:read'), requireEntityAccess, async (req: Request, res: Response) => {
  const {
    entity_id, customer_id, status,
    start_date, end_date, search,
    page = '1', per_page = '50',
  } = req.query;

  const entityId = entity_id as string || req.entityId;
  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(100, Math.max(1, parseInt(per_page as string, 10)));
  const offset = (pageNum - 1) * perPage;

  let whereClause = 'WHERE i.entity_id = $1';
  const params: unknown[] = [entityId];
  let paramIndex = 2;

  if (customer_id) { whereClause += ` AND i.customer_id = $${paramIndex++}`; params.push(customer_id); }
  if (status) { whereClause += ` AND i.status = $${paramIndex++}`; params.push(status); }
  if (start_date) { whereClause += ` AND i.invoice_date >= $${paramIndex++}`; params.push(start_date); }
  if (end_date) { whereClause += ` AND i.invoice_date <= $${paramIndex++}`; params.push(end_date); }
  if (search) {
    whereClause += ` AND (i.invoice_number ILIKE $${paramIndex} OR c.company_name ILIKE $${paramIndex})`;
    params.push(`%${search}%`);
    paramIndex++;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id ${whereClause}`,
    params
  );
  const totalCount = parseInt(countResult.rows[0].count, 10);

  const result = await query<Invoice & { customer_name: string }>(
    `SELECT i.*, c.company_name as customer_name
     FROM invoices i
     LEFT JOIN customers c ON c.id = i.customer_id
     ${whereClause}
     ORDER BY i.invoice_date DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, perPage, offset]
  );

  res.json({
    data: result.rows,
    pagination: {
      page: pageNum, per_page: perPage,
      total_pages: Math.ceil(totalCount / perPage),
      total_count: totalCount, next_cursor: null, prev_cursor: null,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// GET /v1/invoices/:id
router.get('/:id', requirePermission('invoices:read'), async (req: Request, res: Response) => {
  const invoiceResult = await query<Invoice>(
    `SELECT i.*, c.company_name as customer_name, c.email as customer_email
     FROM invoices i
     LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.id = $1`,
    [req.params.id]
  );

  if (invoiceResult.rows.length === 0) {
    throw new NotFoundError('Invoice', req.params.id);
  }

  const invoice = invoiceResult.rows[0] as Invoice & { lines?: InvoiceLine[] };

  const linesResult = await query<InvoiceLine>(
    'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_number',
    [req.params.id]
  );
  invoice.lines = linesResult.rows;

  res.json({
    data: invoice,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// POST /v1/invoices
router.post('/', requirePermission('invoices:create'), requireEntityAccess, validateBody(createInvoiceSchema), asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, customer_id, invoice_date, due_date, currency_code, lines, terms, memo, po_number } = req.body;

  const invoice = await withTransaction(async (client) => {
    const invoiceNumber = await nextEntityNumber(client, entity_id, 'invoice', 'INV');

    let subtotal = new Decimal(0);
    let taxAmount = new Decimal(0);

    const processedLines = lines.map((line: Record<string, unknown>, i: number) => {
      const qty = new Decimal(line.quantity as number || 1);
      const price = new Decimal(line.unit_price as number);
      const lineAmount = qty.times(price);
      const lineTax = line.tax_rate
        ? lineAmount.times(new Decimal(line.tax_rate as number).dividedBy(100))
        : new Decimal(0);
      const totalAmt = lineAmount.plus(lineTax);

      subtotal = subtotal.plus(lineAmount);
      taxAmount = taxAmount.plus(lineTax);

      return {
        line_number: i + 1,
        item_id: line.item_id || null,
        description: line.description || '',
        quantity: qty.toFixed(4),
        unit_price: price.toFixed(4),
        revenue_account_id: line.revenue_account_id,
        tax_code: line.tax_code || null,
        tax_rate: line.tax_rate || null,
        tax_amount: lineTax.toFixed(4),
        line_amount: lineAmount.toFixed(4),
        total_amount: totalAmt.toFixed(4),
        cost_center_id: line.cost_center_id || null,
        project_id: line.project_id || null,
        cfdi_product_code: line.cfdi_product_code || null,
        cfdi_unit_code: line.cfdi_unit_code || null,
      };
    });

    const totalAmount = subtotal.plus(taxAmount);
    const invoiceId = uuidv4();

    await client.query(
      `INSERT INTO invoices (
        id, entity_id, invoice_number, customer_id,
        subtotal, tax_amount, total_amount, amount_due,
        currency_code, invoice_date, due_date,
        status, terms, memo, po_number, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft', $12, $13, $14, $15)`,
      [
        invoiceId, entity_id, invoiceNumber, customer_id,
        subtotal.toFixed(4), taxAmount.toFixed(4), totalAmount.toFixed(4), totalAmount.toFixed(4),
        currency_code || 'USD', invoice_date, due_date,
        terms || null, memo || null, po_number || null, req.user!.user_id,
      ]
    );

    for (const line of processedLines) {
      await client.query(
        `INSERT INTO invoice_lines (
          id, invoice_id, line_number, item_id, description,
          quantity, unit_price, revenue_account_id,
          tax_code, tax_rate, tax_amount, line_amount, total_amount,
          cost_center_id, project_id, cfdi_product_code, cfdi_unit_code
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          uuidv4(), invoiceId, line.line_number, line.item_id, line.description,
          line.quantity, line.unit_price, line.revenue_account_id,
          line.tax_code, line.tax_rate, line.tax_amount, line.line_amount, line.total_amount,
          line.cost_center_id, line.project_id, line.cfdi_product_code, line.cfdi_unit_code,
        ]
      );
    }

    const result = await client.query<Invoice>('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
    return result.rows[0];
  });

  res.status(201).json({
    data: invoice,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/invoices/:id/send
router.post('/:id/send', requirePermission('invoices:send'), validateBody(sendInvoiceSchema), asyncHandler(async (req: Request, res: Response) => {
  const { to, cc, subject, message } = req.body;

  // Sending is the invoice's issuance: the AR/revenue entry posts here,
  // atomically with the status change (idempotent behind journal_entry_id).
  const jeInfo = await withTransaction(async (client) => {
    const invoiceResult = await client.query<Invoice>(
      'SELECT * FROM invoices WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (invoiceResult.rows.length === 0) throw new NotFoundError('Invoice', req.params.id);
    const invoice = invoiceResult.rows[0];

    await client.query(
      `UPDATE invoices SET status = 'sent', sent_at = NOW(), sent_to = $1 WHERE id = $2`,
      [to || '', req.params.id]
    );

    const linesResult = await client.query<InvoiceLine>(
      'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_number',
      [req.params.id]
    );
    const entry = await postInvoiceEntry(client, invoice, linesResult.rows, req.user!.user_id);
    return entry ? { entityId: invoice.entity_id, entryId: entry.id } : null;
  });
  if (jeInfo && req.tenantId) attestEntryAsync(req.tenantId, jeInfo.entityId, jeInfo.entryId);

  // TODO: Integrate with email service

  res.json({
    data: { sent: true, sent_to: to },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
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
router.post('/:id/void', requirePermission('invoices:void'), asyncHandler(async (req: Request, res: Response) => {
  const { invoice, attest } = await withTransaction(async (client) => {
    const result = await client.query<Invoice>(
      `UPDATE invoices SET status = 'void' WHERE id = $1 AND status NOT IN ('paid', 'void') RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      throw new NotFoundError('Invoice', req.params.id);
    }
    const voided = result.rows[0];

    // NIF B-1: the invoice's GL entry is annulled by a linked reversal, in
    // the same transaction as the status change.
    let attestInfo: { entityId: string; entryId: string } | null = null;
    if (voided.journal_entry_id) {
      const { reversal } = await voidJournalEntryInTx(
        client, voided.journal_entry_id, req.user!.user_id, `Invoice ${voided.invoice_number} voided`
      );
      if (reversal) attestInfo = { entityId: voided.entity_id, entryId: reversal.id };
    }
    return { invoice: voided, attest: attestInfo };
  });
  if (attest && req.tenantId) attestEntryAsync(req.tenantId, attest.entityId, attest.entryId);
  const result = { rows: [invoice] };

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
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

  await query(
    `UPDATE invoices SET
      cfdi_uuid = $1, cfdi_status = 'stamped',
      pac_provider = $2, stamped_at = NOW()
     WHERE id = $3`,
    [result.uuid, result.provider_used, req.params.id]
  );

  res.json({
    data: {
      cfdi_uuid: result.uuid,
      cfdi_status: 'stamped',
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

  // TODO: Send cancellation request to PAC provider
  await query(
    `UPDATE invoices SET
      cfdi_status = 'cancelled',
      memo = COALESCE(memo, '') || $1
     WHERE id = $2`,
    [`\nCFDI Cancelled: reason=${cancellation_reason}, replacement=${replacement_uuid || 'N/A'}`, req.params.id]
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
