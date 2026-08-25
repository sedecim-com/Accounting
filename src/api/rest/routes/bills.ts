import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { nextEntityNumber } from '../../../utils/sequence.js';
import {
  postBillEntry,
  postVendorPaymentEntry,
  attestEntryAsync,
} from '../../../services/accounting/index.js';
import type { Bill, BillLine, PaginationMeta } from '../../../types/index.js';

const router = Router();

// ─── Schemas ───
const numericLike = z.union([z.string(), z.number()]);
const billLineSchema = z.object({
  account_id: z.string().uuid(),
  item_id: z.string().uuid().nullable().optional(),
  description: z.string().nullable().optional(),
  quantity: numericLike.optional(),
  unit_price: numericLike,
  tax_amount: numericLike.optional(),
  cost_center_id: z.string().uuid().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
}).passthrough();

const createBillSchema = z.object({
  entity_id: z.string().uuid(),
  vendor_id: z.string().uuid(),
  vendor_invoice_number: z.string().optional(),
  bill_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  currency_code: z.string().length(3).optional(),
  lines: z.array(billLineSchema).min(1),
  terms: z.string().optional(),
  description: z.string().optional(),
  attachments: z.array(z.unknown()).optional(),
});

const schedulePaymentSchema = z.object({
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  payment_method: z.string().min(1),
  bank_account_id: z.string().uuid().optional(),
  apply_early_discount: z.boolean().optional(),
});

const vendorPaymentSchema = z.object({
  entity_id: z.string().uuid(),
  vendor_id: z.string().uuid(),
  payment_amount: numericLike,
  payment_method: z.string().min(1),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  bank_account_id: z.string().uuid().optional(),
  applications: z.array(z.object({
    bill_id: z.string().uuid(),
    amount_applied: numericLike,
    discount_amount: numericLike.optional(),
  })).optional(),
  memo: z.string().optional(),
});

// GET /v1/bills
router.get('/', requirePermission('bills:read'), requireEntityAccess, async (req: Request, res: Response) => {
  const {
    entity_id, vendor_id, status,
    start_date, end_date,
    page = '1', per_page = '50',
  } = req.query;

  const entityId = entity_id as string || req.entityId;
  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(100, Math.max(1, parseInt(per_page as string, 10)));
  const offset = (pageNum - 1) * perPage;

  let whereClause = 'WHERE b.entity_id = $1';
  const params: unknown[] = [entityId];
  let paramIndex = 2;

  if (vendor_id) { whereClause += ` AND b.vendor_id = $${paramIndex++}`; params.push(vendor_id); }
  if (status) { whereClause += ` AND b.status = $${paramIndex++}`; params.push(status); }
  if (start_date) { whereClause += ` AND b.bill_date >= $${paramIndex++}`; params.push(start_date); }
  if (end_date) { whereClause += ` AND b.bill_date <= $${paramIndex++}`; params.push(end_date); }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM bills b ${whereClause}`,
    params
  );

  const result = await query<Bill & { vendor_name: string }>(
    `SELECT b.*, v.company_name as vendor_name
     FROM bills b LEFT JOIN vendors v ON v.id = b.vendor_id
     ${whereClause} ORDER BY b.bill_date DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, perPage, offset]
  );

  res.json({
    data: result.rows,
    pagination: {
      page: pageNum, per_page: perPage,
      total_pages: Math.ceil(parseInt(countResult.rows[0].count, 10) / perPage),
      total_count: parseInt(countResult.rows[0].count, 10),
      next_cursor: null, prev_cursor: null,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// GET /v1/bills/:id
router.get('/:id', requirePermission('bills:read'), async (req: Request, res: Response) => {
  const billResult = await query<Bill>(
    `SELECT b.*, v.company_name as vendor_name
     FROM bills b LEFT JOIN vendors v ON v.id = b.vendor_id WHERE b.id = $1`,
    [req.params.id]
  );

  if (billResult.rows.length === 0) throw new NotFoundError('Bill', req.params.id);

  const bill = billResult.rows[0] as Bill & { lines?: BillLine[] };
  const linesResult = await query<BillLine>(
    'SELECT * FROM bill_lines WHERE bill_id = $1 ORDER BY line_number',
    [req.params.id]
  );
  bill.lines = linesResult.rows;

  res.json({
    data: bill,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// POST /v1/bills
router.post('/', requirePermission('bills:create'), requireEntityAccess, validateBody(createBillSchema), asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, vendor_id, vendor_invoice_number, bill_date, due_date, currency_code, lines, terms, description, attachments } = req.body;

  const bill = await withTransaction(async (client) => {
    const billNumber = await nextEntityNumber(client, entity_id, 'bill', 'BILL');

    let subtotal = new Decimal(0);
    let taxAmount = new Decimal(0);

    const processedLines = lines.map((line: Record<string, unknown>, i: number) => {
      const qty = new Decimal(line.quantity as number || 1);
      const price = new Decimal(line.unit_price as number);
      const lineAmount = qty.times(price);
      const lineTax = new Decimal(line.tax_amount as number || 0);
      const totalAmt = lineAmount.plus(lineTax);

      subtotal = subtotal.plus(lineAmount);
      taxAmount = taxAmount.plus(lineTax);

      return { ...line, line_number: i + 1, quantity: qty.toFixed(4), unit_price: price.toFixed(4), line_amount: lineAmount.toFixed(4), tax_amount: lineTax.toFixed(4), total_amount: totalAmt.toFixed(4) };
    });

    const totalAmount = subtotal.plus(taxAmount);
    const billId = uuidv4();

    await client.query(
      `INSERT INTO bills (
        id, entity_id, bill_number, vendor_id, vendor_invoice_number,
        subtotal, tax_amount, total_amount, amount_due,
        currency_code, bill_date, due_date, status, description, terms,
        attachments, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13,$14,$15,$16)`,
      [
        billId, entity_id, billNumber, vendor_id, vendor_invoice_number || null,
        subtotal.toFixed(4), taxAmount.toFixed(4), totalAmount.toFixed(4), totalAmount.toFixed(4),
        currency_code || 'USD', bill_date, due_date, description || null, terms || null,
        JSON.stringify(attachments || []), req.user!.user_id,
      ]
    );

    for (const line of processedLines) {
      await client.query(
        `INSERT INTO bill_lines (id, bill_id, line_number, account_id, item_id, description, quantity, unit_price, line_amount, tax_amount, total_amount, cost_center_id, project_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [uuidv4(), billId, line.line_number, line.account_id, line.item_id || null, line.description || null, line.quantity, line.unit_price, line.line_amount, line.tax_amount, line.total_amount, line.cost_center_id || null, line.project_id || null]
      );
    }

    const result = await client.query<Bill>('SELECT * FROM bills WHERE id = $1', [billId]);
    return result.rows[0];
  });

  res.status(201).json({
    data: bill,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/bills/:id/approve
router.post('/:id/approve', requirePermission('bills:approve'), asyncHandler(async (req: Request, res: Response) => {
  // Approval recognizes the liability: CR AP / DR expense + creditable IVA,
  // atomically with the status change (idempotent behind journal_entry_id).
  const { bill, attest } = await withTransaction(async (client) => {
    const result = await client.query<Bill>(
      `UPDATE bills SET status = 'approved', approved_by = $1, approved_at = NOW()
       WHERE id = $2 AND status IN ('draft', 'pending_approval') RETURNING *`,
      [req.user!.user_id, req.params.id]
    );
    if (result.rows.length === 0) throw new NotFoundError('Bill', req.params.id);
    const approved = result.rows[0];

    const linesResult = await client.query<BillLine>(
      'SELECT * FROM bill_lines WHERE bill_id = $1 ORDER BY line_number',
      [req.params.id]
    );
    const entry = await postBillEntry(client, approved, linesResult.rows, req.user!.user_id);
    return { bill: approved, attest: entry ? { entityId: approved.entity_id, entryId: entry.id } : null };
  });
  if (attest && req.tenantId) attestEntryAsync(req.tenantId, attest.entityId, attest.entryId);
  const result = { rows: [bill] };

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/bills/:id/schedule-payment
router.post('/:id/schedule-payment', requirePermission('bills:create'), validateBody(schedulePaymentSchema), asyncHandler(async (req: Request, res: Response) => {
  const { payment_date, payment_method, bank_account_id, apply_early_discount } = req.body;

  const billResult = await query<Bill>(
    'SELECT * FROM bills WHERE id = $1 AND status IN (\'approved\', \'posted\')',
    [req.params.id]
  );
  if (billResult.rows.length === 0) throw new NotFoundError('Bill', req.params.id);

  const bill = billResult.rows[0];
  let paymentAmount = new Decimal(bill.amount_due);

  // Apply early payment discount if applicable
  let discountAmount = new Decimal(0);
  if (apply_early_discount && bill.terms) {
    const termsMatch = bill.terms.match(/(\d+)\/(\d+)/);
    if (termsMatch) {
      const discountPct = parseInt(termsMatch[1], 10);
      const discountDays = parseInt(termsMatch[2], 10);
      const daysUntilPayment = Math.floor(
        (new Date(payment_date).getTime() - new Date(bill.bill_date).getTime()) / (86400000)
      );
      if (daysUntilPayment <= discountDays) {
        discountAmount = paymentAmount.times(discountPct).dividedBy(100);
        paymentAmount = paymentAmount.minus(discountAmount);
      }
    }
  }

  // Schedule the payment (in production, would use BullMQ delayed job)
  await query(
    `UPDATE bills SET memo = COALESCE(memo, '') || $1 WHERE id = $2`,
    [`\nScheduled payment: ${paymentAmount.toFixed(2)} via ${payment_method} on ${payment_date}`, req.params.id]
  );

  res.json({
    data: {
      bill_id: req.params.id,
      scheduled_date: payment_date,
      payment_method,
      payment_amount: paymentAmount.toFixed(4),
      discount_amount: discountAmount.toFixed(4),
      bank_account_id,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/payments/vendors
router.post('/payments', requirePermission('bills:create'), validateBody(vendorPaymentSchema), asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, vendor_id, payment_amount, payment_method, payment_date, bank_account_id, applications, memo } = req.body;

  const jeInfo = await withTransaction(async (client) => {
    const paymentNumber = await nextEntityNumber(client, entity_id, 'vendor_payment', 'VPMT');
    const paymentId = uuidv4();

    await client.query(
      `INSERT INTO vendor_payments (
        id, entity_id, payment_number, vendor_id, payment_amount,
        payment_method, bank_account_id, payment_date, status, memo, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9,$10)`,
      [paymentId, entity_id, paymentNumber, vendor_id, payment_amount, payment_method, bank_account_id || null, payment_date, memo || null, req.user!.user_id]
    );

    if (applications) {
      for (const app of applications) {
        await client.query(
          `INSERT INTO payment_applications (id, payment_id, bill_id, amount_applied, discount_amount)
           VALUES ($1, $2, $3, $4, $5)`,
          [uuidv4(), paymentId, app.bill_id, app.amount_applied, app.discount_amount || 0]
        );

        // Update bill
        await client.query(
          `UPDATE bills SET
            amount_paid = amount_paid + $1,
            amount_due = amount_due - $1,
            status = CASE WHEN amount_due - $1 <= 0 THEN 'paid' ELSE 'partially_paid' END,
            last_payment_date = $2
           WHERE id = $3`,
          [app.amount_applied, payment_date, app.bill_id]
        );
      }
    }

    const entry = await postVendorPaymentEntry(
      client,
      {
        id: paymentId,
        entity_id,
        payment_number: paymentNumber,
        payment_amount: String(payment_amount),
        payment_date,
        bank_account_id: bank_account_id || null,
        journal_entry_id: null,
      },
      req.user!.user_id
    );
    return entry ? { entityId: entity_id as string, entryId: entry.id } : null;
  });
  if (jeInfo && req.tenantId) attestEntryAsync(req.tenantId, jeInfo.entityId, jeInfo.entryId);

  res.status(201).json({
    data: { recorded: true },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
