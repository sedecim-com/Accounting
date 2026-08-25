import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { encrypt } from '../../../utils/encryption.js';
import { generateEntryNumber } from '../../../utils/sequence.js';
import type { Vendor } from '../../../types/index.js';

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

// GET /v1/vendors
router.get('/', requirePermission('bills:read'), requireEntityAccess, async (req: Request, res: Response) => {
  const { entity_id, is_active, search, page = '1', per_page = '50' } = req.query;
  const entityId = entity_id as string || req.entityId;
  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(100, parseInt(per_page as string, 10));

  let where = 'WHERE entity_id = $1';
  const params: unknown[] = [entityId];
  let idx = 2;

  if (is_active !== undefined) { where += ` AND is_active = $${idx++}`; params.push(is_active === 'true'); }
  if (search) { where += ` AND (company_name ILIKE $${idx} OR vendor_number ILIKE $${idx})`; params.push(`%${search}%`); idx++; }

  const countResult = await query<{ count: string }>(`SELECT COUNT(*) as count FROM vendors ${where}`, params);
  const result = await query<Vendor>(
    `SELECT * FROM vendors ${where} ORDER BY company_name LIMIT $${idx++} OFFSET $${idx}`,
    [...params, perPage, (pageNum - 1) * perPage]
  );

  res.json({
    data: result.rows,
    pagination: { page: pageNum, per_page: perPage, total_pages: Math.ceil(parseInt(countResult.rows[0].count, 10) / perPage), total_count: parseInt(countResult.rows[0].count, 10), next_cursor: null, prev_cursor: null },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// POST /v1/vendors
router.post('/', requirePermission('bills:create'), requireEntityAccess, validateBody(createVendorSchema), asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, company_name, contact_name, tax_id, tax_id_type, email, phone, payment_terms, default_expense_account_id, currency_code, bank_account_number, bank_routing_number, clabe, bank_name, is_1099_vendor } = req.body;

  const countResult = await query<{ count: string }>('SELECT COUNT(*) as count FROM vendors WHERE entity_id = $1', [entity_id]);
  const vendorNumber = generateEntryNumber('V', parseInt(countResult.rows[0].count, 10));

  const result = await query<Vendor>(
    `INSERT INTO vendors (
      id, entity_id, vendor_number, company_name, contact_name, tax_id, tax_id_type,
      is_1099_vendor, email, phone, payment_terms, default_expense_account_id,
      currency_code, bank_account_number_encrypted, bank_routing_number_encrypted,
      clabe_encrypted, bank_name, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [
      uuidv4(), entity_id, vendorNumber, company_name, contact_name || null,
      tax_id || null, tax_id_type || null, is_1099_vendor || false,
      email || null, phone || null, payment_terms || 'Net 30',
      default_expense_account_id || null, currency_code || 'USD',
      bank_account_number ? encrypt(bank_account_number) : null,
      bank_routing_number ? encrypt(bank_routing_number) : null,
      clabe ? encrypt(clabe) : null, bank_name || null,
      req.user!.user_id,
    ]
  );

  res.status(201).json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /v1/vendors/:id
router.get('/:id', requirePermission('bills:read'), async (req: Request, res: Response) => {
  const result = await query<Vendor>('SELECT * FROM vendors WHERE id = $1', [req.params.id]);
  if (result.rows.length === 0) throw new NotFoundError('Vendor', req.params.id);

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// PATCH /v1/vendors/:id
router.patch('/:id', requirePermission('bills:create'), validateBody(updateVendorSchema), asyncHandler(async (req: Request, res: Response) => {
  const fields = ['company_name', 'contact_name', 'email', 'phone', 'payment_terms', 'is_active', 'notes'];
  const updates: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = $${idx++}`); params.push(req.body[f]); }
  }

  if (updates.length === 0) throw new ValidationError('No valid fields to update');

  updates.push(`updated_at = NOW()`);
  params.push(req.params.id);

  const result = await query<Vendor>(
    `UPDATE vendors SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  if (result.rows.length === 0) throw new NotFoundError('Vendor', req.params.id);

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
