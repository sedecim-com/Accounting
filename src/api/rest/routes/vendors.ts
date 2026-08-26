import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError } from '../../../utils/errors.js';
import {
  listVendors,
  getVendorById,
  createVendor,
  updateVendor,
  VENDOR_UPDATABLE_FIELDS,
} from '../../../services/ap/vendor-service.js';
import type { PaginationMeta } from '../../../types/index.js';

// ============================================================
// /v1/vendors — HTTP surface over the vendor master service.
// The rules live in services/ap/vendor-service.ts so the CLI and
// the agent reach the same behaviour; this file is only request
// parsing, permissions and response shape.
//
// `includeBankSecrets: true` on every call is not a preference:
// this surface has always returned the encrypted bank blobs in
// `SELECT *`, and the extraction is not the place to change what
// an existing client receives. The CLI never asks for them.
// ============================================================

const router = Router();

// ─── Schemas ───
const createVendorSchema = z.object({
  entity_id: z.string().uuid(),
  company_name: z.string().min(1).max(255),
  contact_name: z.string().max(255).optional(),
  tax_id: z.string().max(50).optional(),
  tax_id_type: z.string().max(20).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  payment_terms: z.string().max(50).optional(),
  default_expense_account_id: z.string().uuid().optional(),
  currency_code: z.string().length(3).optional(),
  bank_account_number: z.string().optional(),
  bank_routing_number: z.string().optional(),
  clabe: z.string().length(18).optional(),
  bank_name: z.string().max(255).optional(),
  is_1099_vendor: z.boolean().optional(),
});

const updateVendorSchema = z.object({
  company_name: z.string().min(1).max(255).optional(),
  contact_name: z.string().max(255).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  payment_terms: z.string().max(50).optional(),
  is_active: z.boolean().optional(),
  notes: z.string().optional(),
}).refine((o) => Object.keys(o).length > 0, { message: 'At least one field must be provided' });

const meta = (req: Request) => ({
  request_id: req.headers['x-request-id'],
  timestamp: new Date().toISOString(),
  version: 'v1',
});

// GET /v1/vendors
router.get('/', requirePermission('bills:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, is_active, search, page = '1', per_page = '50' } = req.query;
  const entityId = (entity_id as string) || req.entityId!;
  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(100, parseInt(per_page as string, 10));

  const { rows, total } = await listVendors(entityId, {
    isActive: is_active === undefined ? undefined : is_active === 'true',
    search: search as string | undefined,
    limit: perPage,
    offset: (pageNum - 1) * perPage,
    includeBankSecrets: true,
  });

  const pagination: PaginationMeta = {
    page: pageNum,
    per_page: perPage,
    total_pages: Math.ceil(total / perPage),
    total_count: total,
    next_cursor: null,
    prev_cursor: null,
  };

  res.json({ data: rows, pagination, meta: meta(req) });
}));

// POST /v1/vendors
router.post('/', requirePermission('bills:create'), requireEntityAccess, validateBody(createVendorSchema), asyncHandler(async (req: Request, res: Response) => {
  const vendor = await createVendor(
    { ...req.body, created_by: req.user!.user_id },
    { includeBankSecrets: true }
  );
  res.status(201).json({ data: vendor, meta: meta(req) });
}));

// GET /v1/vendors/:id
router.get('/:id', requirePermission('bills:read'), asyncHandler(async (req: Request, res: Response) => {
  const vendor = await getVendorById(req.params.id, { includeBankSecrets: true });
  if (!vendor) throw new NotFoundError('Vendor', req.params.id);
  res.json({ data: vendor, meta: meta(req) });
}));

// PATCH /v1/vendors/:id
router.patch('/:id', requirePermission('bills:create'), validateBody(updateVendorSchema), asyncHandler(async (req: Request, res: Response) => {
  const patch = Object.fromEntries(
    VENDOR_UPDATABLE_FIELDS.filter((f) => req.body[f] !== undefined).map((f) => [f, req.body[f]])
  );
  const vendor = await updateVendor(
    req.params.id,
    patch,
    { userId: req.user!.user_id, tenantId: req.tenantId },
    { includeBankSecrets: true }
  );
  res.json({ data: vendor, meta: meta(req) });
}));

export default router;
