import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError, ValidationError, ConflictError } from '../../../utils/errors.js';
import type { Account, PaginationMeta } from '../../../types/index.js';

const router = Router();

// ─── Schemas ───
const accountTypeEnum = z.enum([
  'asset', 'liability', 'equity', 'revenue', 'expense',
  'contra_asset', 'contra_liability', 'contra_equity',
]);
const normalBalanceEnum = z.enum(['debit', 'credit']);

const createAccountSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(255),
  account_type: accountTypeEnum,
  account_subtype: z.string().optional(),
  fs_category: z.string().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  entity_id: z.string().uuid(),
  currency_code: z.string().length(3).optional(),
  normal_balance: normalBalanceEnum,
  allow_manual_entries: z.boolean().optional(),
  is_header: z.boolean().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const updateAccountSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  is_active: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  fs_category: z.string().optional(),
  account_subtype: z.string().optional(),
}).refine((o) => Object.keys(o).length > 0, { message: 'At least one field must be provided' });

// GET /v1/accounts
router.get('/', requirePermission('accounts:read'), requireEntityAccess, async (req: Request, res: Response) => {
  const {
    entity_id,
    account_type,
    is_active,
    parent_id,
    search,
    page = '1',
    per_page = '50',
  } = req.query;

  const entityId = entity_id as string || req.entityId;
  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(100, Math.max(1, parseInt(per_page as string, 10)));
  const offset = (pageNum - 1) * perPage;

  let whereClause = 'WHERE entity_id = $1';
  const params: unknown[] = [entityId];
  let paramIndex = 2;

  if (account_type) {
    whereClause += ` AND account_type = $${paramIndex++}`;
    params.push(account_type);
  }
  if (is_active !== undefined) {
    whereClause += ` AND is_active = $${paramIndex++}`;
    params.push(is_active === 'true');
  }
  if (parent_id) {
    whereClause += ` AND parent_id = $${paramIndex++}`;
    params.push(parent_id);
  }
  if (search) {
    whereClause += ` AND (code ILIKE $${paramIndex} OR name ILIKE $${paramIndex})`;
    params.push(`%${search}%`);
    paramIndex++;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM accounts ${whereClause}`,
    params
  );
  const totalCount = parseInt(countResult.rows[0].count, 10);

  const result = await query<Account>(
    `SELECT a.*,
            (SELECT COUNT(*) FROM accounts c WHERE c.parent_id = a.id) as children_count
     FROM accounts a ${whereClause}
     ORDER BY a.code ASC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, perPage, offset]
  );

  const pagination: PaginationMeta = {
    page: pageNum,
    per_page: perPage,
    total_pages: Math.ceil(totalCount / perPage),
    total_count: totalCount,
    next_cursor: null,
    prev_cursor: null,
  };

  res.json({
    data: result.rows,
    pagination,
    meta: {
      request_id: req.headers['x-request-id'],
      timestamp: new Date().toISOString(),
      version: 'v1',
    },
  });
});

// GET /v1/accounts/:id
router.get('/:id', requirePermission('accounts:read'), async (req: Request, res: Response) => {
  const { include_balance, include_hierarchy } = req.query;

  let selectClause = 'SELECT a.*';
  let joinClause = '';

  if (include_hierarchy === 'true') {
    selectClause += `, p.code as parent_code, p.name as parent_name`;
    joinClause += ' LEFT JOIN accounts p ON p.id = a.parent_id';
  }

  const result = await query<Account>(
    `${selectClause} FROM accounts a ${joinClause} WHERE a.id = $1`,
    [req.params.id]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Account', req.params.id);
  }

  const account = result.rows[0] as unknown as Record<string, unknown>;

  if (include_balance === 'true') {
    // Lifetime activity, NOT SUM(ending_balance): carried-forward periods
    // embed the prior ending in their beginning, so summing endings would
    // double-count. Activity totals are carryforward-invariant.
    const balanceResult = await query<{ balance: string }>(
      `SELECT COALESCE(SUM(debit_total - credit_total), 0) as balance
       FROM account_balances WHERE account_id = $1`,
      [req.params.id]
    );
    account.current_balance = balanceResult.rows[0].balance;
  }

  res.json({
    data: account,
    meta: {
      request_id: req.headers['x-request-id'],
      timestamp: new Date().toISOString(),
      version: 'v1',
    },
  });
});

// POST /v1/accounts
router.post('/', requirePermission('accounts:create'), requireEntityAccess, validateBody(createAccountSchema), asyncHandler(async (req: Request, res: Response) => {
  const {
    code, name, account_type, fs_category, parent_id,
    entity_id, currency_code, normal_balance,
    allow_manual_entries, description, account_subtype,
    is_header, tags,
  } = req.body;

  // Check for duplicate
  const existing = await query<{ id: string }>(
    'SELECT id FROM accounts WHERE code = $1 AND entity_id = $2',
    [code, entity_id]
  );
  if (existing.rows.length > 0) {
    throw new ConflictError(`Account with code "${code}" already exists`);
  }

  const id = uuidv4();
  const result = await query<Account>(
    `INSERT INTO accounts (
      id, code, name, account_type, account_subtype, fs_category,
      parent_id, entity_id, currency_code, normal_balance,
      allow_manual_entries, is_header, description, tags, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING *`,
    [
      id, code, name, account_type, account_subtype || null, fs_category || null,
      parent_id || null, entity_id, currency_code || null, normal_balance,
      allow_manual_entries ?? true, is_header ?? false,
      description || null, tags ? JSON.stringify(tags) : '{}', req.user!.user_id,
    ]
  );

  res.status(201).json({
    data: result.rows[0],
    meta: {
      request_id: req.headers['x-request-id'],
      timestamp: new Date().toISOString(),
      version: 'v1',
    },
  });
}));

// PATCH /v1/accounts/:id
router.patch('/:id', requirePermission('accounts:update'), validateBody(updateAccountSchema), asyncHandler(async (req: Request, res: Response) => {
  const updates: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  const allowedFields = ['name', 'description', 'is_active', 'tags', 'fs_category', 'account_subtype'];
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = $${paramIndex++}`);
      params.push(field === 'tags' ? JSON.stringify(req.body[field]) : req.body[field]);
    }
  }

  if (updates.length === 0) {
    throw new ValidationError('No valid fields to update');
  }

  updates.push(`updated_at = NOW()`);
  updates.push(`updated_by = $${paramIndex++}`);
  params.push(req.user!.user_id);
  params.push(req.params.id);

  const result = await query<Account>(
    `UPDATE accounts SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    params
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Account', req.params.id);
  }

  res.json({
    data: result.rows[0],
    meta: {
      request_id: req.headers['x-request-id'],
      timestamp: new Date().toISOString(),
      version: 'v1',
    },
  });
}));

// DELETE /v1/accounts/:id (soft delete)
router.delete('/:id', requirePermission('accounts:delete'), asyncHandler(async (req: Request, res: Response) => {
  // Check for transactions
  const hasTransactions = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM journal_entry_lines WHERE account_id = $1',
    [req.params.id]
  );

  if (parseInt(hasTransactions.rows[0].count, 10) > 0) {
    throw new ValidationError('Cannot delete account with existing transactions');
  }

  const result = await query(
    `UPDATE accounts SET is_active = false, updated_at = NOW(), updated_by = $1 WHERE id = $2`,
    [req.user!.user_id, req.params.id]
  );

  if (result.rowCount === 0) {
    throw new NotFoundError('Account', req.params.id);
  }

  res.status(204).send();
}));

export default router;
