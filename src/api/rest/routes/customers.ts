import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError } from '../../../utils/errors.js';
import { entityScope } from '../../../database/scope.js';
import {
  listCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  CUSTOMER_UPDATABLE_FIELDS,
} from '../../../services/ar/customer-service.js';
import { declararRiesgoRuta } from '../risk.js';

// ============================================================
// /v1/customers — HTTP surface over the AR customer service.
// The rules live in services/ar/customer-service.ts so the CLI and
// the agent reach the same behaviour; this file is only request
// parsing, permissions and response shape.
// ============================================================

const router = Router();

// ─── Schemas ───
const addressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().optional(),
}).passthrough();

const createCustomerSchema = z.object({
  entity_id: z.string().uuid(),
  company_name: z.string().min(1).max(255).optional(),
  first_name: z.string().min(1).max(255).optional(),
  last_name: z.string().max(255).optional(),
  tax_id: z.string().max(50).optional(),
  tax_id_type: z.string().max(20).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  billing_address: addressSchema.optional(),
  shipping_address: addressSchema.optional(),
  payment_terms: z.string().max(50).optional(),
  credit_limit: z.union([z.string(), z.number()]).optional(),
  currency_code: z.string().length(3).optional(),
  default_revenue_account_id: z.string().uuid().optional(),
  default_ar_account_id: z.string().uuid().optional(),
}).refine((o) => !!(o.company_name || o.first_name), { message: 'company_name or first_name is required' });

const updateCustomerSchema = z.object({
  company_name: z.string().min(1).max(255).optional(),
  first_name: z.string().min(1).max(255).optional(),
  last_name: z.string().max(255).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  payment_terms: z.string().max(50).optional(),
  credit_limit: z.union([z.string(), z.number()]).optional(),
  credit_status: z.string().max(20).optional(),
  is_active: z.boolean().optional(),
  notes: z.string().optional(),
}).refine((o) => Object.keys(o).length > 0, { message: 'At least one field must be provided' });

const meta = (req: Request) => ({
  request_id: req.headers['x-request-id'],
  timestamp: new Date().toISOString(),
  version: 'v1',
});

// GET /v1/customers
router.get('/', requirePermission('invoices:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, is_active, search, page = '1', per_page = '50' } = req.query;
  const entityId = (entity_id as string) || req.entityId!;
  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(100, parseInt(per_page as string, 10));

  const { rows, total } = await listCustomers(entityId, {
    isActive: is_active === undefined ? undefined : is_active === 'true',
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

// POST /v1/customers
router.post('/', declararRiesgoRuta({ riesgo: 'escritura', escribe: 'customers' }), requirePermission('invoices:create'), requireEntityAccess, validateBody(createCustomerSchema), asyncHandler(async (req: Request, res: Response) => {
  const customer = await createCustomer({ ...req.body, created_by: req.user!.user_id });
  res.status(201).json({ data: customer, meta: meta(req) });
}));

// GET /v1/customers/:id
router.get('/:id', requirePermission('invoices:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const customer = await getCustomerById(req.params.id, entityScope(req.tenantId!, req.entityId!));
  if (!customer) throw new NotFoundError('Customer', req.params.id);
  res.json({ data: customer, meta: meta(req) });
}));

// PATCH /v1/customers/:id
router.patch('/:id', declararRiesgoRuta({ riesgo: 'escritura', escribe: 'customers' }), requirePermission('invoices:create'), requireEntityAccess, validateBody(updateCustomerSchema), asyncHandler(async (req: Request, res: Response) => {
  const patch = Object.fromEntries(
    CUSTOMER_UPDATABLE_FIELDS.filter((f) => req.body[f] !== undefined).map((f) => [f, req.body[f]])
  );
  // No audit context: the HTTP surface keeps writing its one middleware row
  // (middleware/audit.ts), exactly as it did before the service existed.
  const customer = await updateCustomer(req.params.id, entityScope(req.tenantId!, req.entityId!), patch);
  res.json({ data: customer, meta: meta(req) });
}));

export default router;
