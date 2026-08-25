import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { generateEntryNumber } from '../../../utils/sequence.js';
import type { Customer } from '../../../types/index.js';

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

// GET /v1/customers
router.get('/', requirePermission('invoices:read'), requireEntityAccess, async (req: Request, res: Response) => {
  const { entity_id, is_active, search, page = '1', per_page = '50' } = req.query;
  const entityId = entity_id as string || req.entityId;
  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(100, parseInt(per_page as string, 10));

  let where = 'WHERE entity_id = $1';
  const params: unknown[] = [entityId];
  let idx = 2;

  if (is_active !== undefined) { where += ` AND is_active = $${idx++}`; params.push(is_active === 'true'); }
  if (search) { where += ` AND (company_name ILIKE $${idx} OR customer_number ILIKE $${idx} OR first_name ILIKE $${idx} OR last_name ILIKE $${idx})`; params.push(`%${search}%`); idx++; }

  const countResult = await query<{ count: string }>(`SELECT COUNT(*) as count FROM customers ${where}`, params);
  const result = await query<Customer>(
    `SELECT * FROM customers ${where} ORDER BY COALESCE(company_name, first_name) LIMIT $${idx++} OFFSET $${idx}`,
    [...params, perPage, (pageNum - 1) * perPage]
  );

  res.json({
    data: result.rows,
    pagination: { page: pageNum, per_page: perPage, total_pages: Math.ceil(parseInt(countResult.rows[0].count, 10) / perPage), total_count: parseInt(countResult.rows[0].count, 10), next_cursor: null, prev_cursor: null },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// POST /v1/customers
router.post('/', requirePermission('invoices:create'), requireEntityAccess, validateBody(createCustomerSchema), asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, company_name, first_name, last_name, tax_id, tax_id_type, email, phone, billing_address, shipping_address, payment_terms, credit_limit, currency_code, default_revenue_account_id, default_ar_account_id } = req.body;

  const countResult = await query<{ count: string }>('SELECT COUNT(*) as count FROM customers WHERE entity_id = $1', [entity_id]);
  const customerNumber = generateEntryNumber('C', parseInt(countResult.rows[0].count, 10));

  const result = await query<Customer>(
    `INSERT INTO customers (
      id, entity_id, customer_number, company_name, first_name, last_name,
      tax_id, tax_id_type, email, phone,
      billing_address, shipping_address, payment_terms,
      credit_limit, currency_code, default_revenue_account_id,
      default_ar_account_id, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [
      uuidv4(), entity_id, customerNumber,
      company_name || null, first_name || null, last_name || null,
      tax_id || null, tax_id_type || null, email || null, phone || null,
      billing_address ? JSON.stringify(billing_address) : null,
      shipping_address ? JSON.stringify(shipping_address) : null,
      payment_terms || 'Net 30', credit_limit || null,
      currency_code || 'USD', default_revenue_account_id || null,
      default_ar_account_id || null, req.user!.user_id,
    ]
  );

  res.status(201).json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /v1/customers/:id
router.get('/:id', requirePermission('invoices:read'), async (req: Request, res: Response) => {
  const result = await query<Customer>('SELECT * FROM customers WHERE id = $1', [req.params.id]);
  if (result.rows.length === 0) throw new NotFoundError('Customer', req.params.id);

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// PATCH /v1/customers/:id
router.patch('/:id', requirePermission('invoices:create'), validateBody(updateCustomerSchema), asyncHandler(async (req: Request, res: Response) => {
  const fields = ['company_name', 'first_name', 'last_name', 'email', 'phone', 'payment_terms', 'credit_limit', 'credit_status', 'is_active', 'notes'];
  const updates: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = $${idx++}`); params.push(req.body[f]); }
  }

  if (updates.length === 0) throw new ValidationError('No valid fields to update');

  updates.push(`updated_at = NOW()`);
  params.push(req.params.id);

  const result = await query<Customer>(
    `UPDATE customers SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  if (result.rows.length === 0) throw new NotFoundError('Customer', req.params.id);

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
