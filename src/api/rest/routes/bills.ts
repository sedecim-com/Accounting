import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { withTransaction } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError, NotImplementedError } from '../../../utils/errors.js';
import { recordVendorPayment } from '../../../services/payments/payment-service.js';
import {
  postVendorPaymentEntry,
  attestEntryAsync,
} from '../../../services/accounting/index.js';
import {
  listBills,
  getBillById,
  createBill,
  approveBill,
} from '../../../services/ap/bill-service.js';
import type { PaginationMeta } from '../../../types/index.js';

// ============================================================
// /v1/bills — HTTP surface over the vendor-bill service.
// Capture, retrieval and approval live in services/ap/
// bill-service.ts so the CLI and the agent reach the same
// behaviour; this file is request parsing, permissions and
// response shape.
//
// Payments (POST /payments) now go through services/payments/
// payment-service.ts too, shared with `mnemosine bill pay`. The state
// question the catalog flagged — every payment written as 'completed',
// leaving four of the CHECK's states unreachable — is answered there and
// on purpose: recording a payment means the money already left the bank,
// and the other four belong to a scheduler that does not exist.
// ============================================================

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

const meta = (req: Request) => ({
  request_id: req.headers['x-request-id'],
  timestamp: new Date().toISOString(),
  version: 'v1',
});

// GET /v1/bills
router.get('/', requirePermission('bills:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const {
    entity_id, vendor_id, status,
    start_date, end_date,
    page = '1', per_page = '50',
  } = req.query;

  const entityId = (entity_id as string) || req.entityId!;
  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(100, Math.max(1, parseInt(per_page as string, 10)));

  const { rows, total } = await listBills(entityId, {
    vendorId: vendor_id as string | undefined,
    status: status as string | undefined,
    startDate: start_date as string | undefined,
    endDate: end_date as string | undefined,
    limit: perPage,
    offset: (pageNum - 1) * perPage,
  });

  const pagination: PaginationMeta = {
    page: pageNum, per_page: perPage,
    total_pages: Math.ceil(total / perPage),
    total_count: total,
    next_cursor: null, prev_cursor: null,
  };

  res.json({ data: rows, pagination, meta: meta(req) });
}));

// GET /v1/bills/:id
router.get('/:id', requirePermission('bills:read'), asyncHandler(async (req: Request, res: Response) => {
  const bill = await getBillById(req.params.id, { includeLines: true });
  if (!bill) throw new NotFoundError('Bill', req.params.id);

  res.json({ data: bill, meta: meta(req) });
}));

// POST /v1/bills
router.post('/', requirePermission('bills:create'), requireEntityAccess, validateBody(createBillSchema), asyncHandler(async (req: Request, res: Response) => {
  const bill = await createBill({ ...req.body, created_by: req.user!.user_id });

  res.status(201).json({ data: bill, meta: meta(req) });
}));

// POST /v1/bills/:id/approve
router.post('/:id/approve', requirePermission('bills:approve'), asyncHandler(async (req: Request, res: Response) => {
  // Approval recognizes the liability: CR AP / DR expense + creditable IVA,
  // atomically with the status change (idempotent behind journal_entry_id).
  const { bill, attestation } = await approveBill(req.params.id, req.user!.user_id);
  if (attestation && req.tenantId) {
    attestEntryAsync(req.tenantId, attestation.entityId, attestation.entryId);
  }

  res.json({ data: bill, meta: meta(req) });
}));

// POST /v1/bills/:id/schedule-payment — WITHDRAWN
//
// This answered 200 with {scheduled_date, payment_method, payment_amount,
// bank_account_id} and appended a line to bills.memo. That was the entire
// act. No row in scheduled_payments (that table has never been written to),
// no queued job, no instruction to any bank — and the bill's amount_due was
// untouched, so a vendor "scheduled" for the 15th was simply unpaid on the
// 15th, with a sentence in a memo field to show for it.
//
// There is no payment scheduler in mnemosine to route this to. Until one
// exists that actually holds and releases a payment, the endpoint says so.
router.post('/:id/schedule-payment', requirePermission('bills:create'), asyncHandler(async () => {
  throw new NotImplementedError(
    'mnemosine does not schedule payments: it has no payment scheduler and no connection to your ' +
      'bank, so nothing would be released on the date you give. Pay the bill in your bank, then ' +
      'record it with POST /v1/bills/payments (passing discount_amount if you took an early-payment ' +
      'discount) — that is the call that moves amount_due and posts to the ledger.'
  );
}));

// POST /v1/payments/vendors
// requireEntityAccess: el entity_id viene del CUERPO y nadie comprobaba
// que fuera una entidad del usuario. Con el UUID de una entidad hermana
// se fabricaba un pago a proveedor en sus libros.
router.post('/payments', requirePermission('bills:create'), requireEntityAccess, validateBody(vendorPaymentSchema), asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, vendor_id, payment_amount, payment_method, payment_date, bank_account_id, applications, memo } = req.body;

  // Una sola implementación, compartida con `mnemosine bill pay` y con el
  // agente. Antes vivía aquí dentro y la terminal no podía alcanzarla, lo
  // que importaba porque el pago es lo que LIBERA el IVA aparcado de un
  // CFDI a crédito: quien operaba por terminal nunca lo acreditaba.
  const result = await recordVendorPayment(
    {
      entityId: entity_id,
      counterpartyId: vendor_id,
      paymentAmount: String(payment_amount),
      paymentDate: payment_date,
      paymentMethod: payment_method,
      bankAccountId: bank_account_id || null,
      memo: memo || null,
      applications: (applications ?? []).map((a: { bill_id: string; amount_applied: string | number; discount_amount?: string | number }) => ({
        documentId: a.bill_id,
        amountApplied: String(a.amount_applied),
        discountAmount: a.discount_amount !== undefined ? String(a.discount_amount) : undefined,
      })),
    },
    req.user!.user_id
  );

  if (result.attestation && req.tenantId) {
    attestEntryAsync(req.tenantId, result.attestation.entityId, result.attestation.entryId);
  }

  res.status(201).json({
    data: {
      recorded: true,
      payment_number: result.paymentNumber,
      journal_entry_id: result.journalEntry?.id ?? null,
      applied: result.documentos,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
