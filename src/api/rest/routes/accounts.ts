import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError } from '../../../utils/errors.js';
import {
  listAccounts,
  getAccountById,
  createAccount,
  updateAccount,
  deactivateAccount,
  ACCOUNT_TYPES,
  NORMAL_BALANCES,
  UPDATABLE_FIELDS,
} from '../../../services/accounting/account-service.js';
import type { PaginationMeta } from '../../../types/index.js';
import { declararRiesgoRuta } from '../risk.js';

// ============================================================
// /v1/accounts — HTTP surface over the chart-of-accounts service.
// The rules live in services/accounting/account-service.ts so the
// CLI and the agent reach the same behaviour; this file is only
// request parsing, permissions and response shape.
// ============================================================

const router = Router();

const accountTypeEnum = z.enum(ACCOUNT_TYPES);
const normalBalanceEnum = z.enum(NORMAL_BALANCES);

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

const updateAccountSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().optional(),
    is_active: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    fs_category: z.string().optional(),
    account_subtype: z.string().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'At least one field must be provided' });

const meta = (req: Request) => ({
  request_id: req.headers['x-request-id'],
  timestamp: new Date().toISOString(),
  version: 'v1',
});

// GET /v1/accounts
router.get(
  '/',
  requirePermission('accounts:read'),
  requireEntityAccess,
  asyncHandler(async (req: Request, res: Response) => {
    const { entity_id, account_type, is_active, parent_id, search, page = '1', per_page = '50' } = req.query;

    const entityId = (entity_id as string) || req.entityId!;
    const pageNum = Math.max(1, parseInt(page as string, 10));
    const perPage = Math.min(100, Math.max(1, parseInt(per_page as string, 10)));

    const { rows, total } = await listAccounts(entityId, {
      accountType: account_type as string | undefined,
      isActive: is_active === undefined ? undefined : is_active === 'true',
      parentId: parent_id as string | undefined,
      search: search as string | undefined,
      limit: perPage,
      offset: (pageNum - 1) * perPage,
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
  })
);

// GET /v1/accounts/:id
router.get(
  '/:id',
  requirePermission('accounts:read'),
  asyncHandler(async (req: Request, res: Response) => {
    const account = await getAccountById(req.params.id, {
      includeBalance: req.query.include_balance === 'true',
      includeHierarchy: req.query.include_hierarchy === 'true',
    });
    if (!account) throw new NotFoundError('Account', req.params.id);
    res.json({ data: account, meta: meta(req) });
  })
);

// POST /v1/accounts
router.post(
  '/',
  declararRiesgoRuta({ riesgo: 'escritura', escribe: 'accounts (alta del catalogo)' }),
  requirePermission('accounts:create'),
  requireEntityAccess,
  validateBody(createAccountSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const account = await createAccount({ ...req.body, created_by: req.user!.user_id });
    res.status(201).json({ data: account, meta: meta(req) });
  })
);

// PATCH /v1/accounts/:id
router.patch(
  '/:id',
  declararRiesgoRuta({ riesgo: 'escritura', escribe: 'accounts (campos editables)' }),
  requirePermission('accounts:update'),
  validateBody(updateAccountSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const patch = Object.fromEntries(
      UPDATABLE_FIELDS.filter((f) => req.body[f] !== undefined).map((f) => [f, req.body[f]])
    );
    const account = await updateAccount(req.params.id, patch, req.user!.user_id);
    res.json({ data: account, meta: meta(req) });
  })
);

// DELETE /v1/accounts/:id — soft delete; refuses when the account has history.
// Baja LOGICA, no borrado: por eso es escritura y no irreversible. Mismo
// criterio que `mnemosine customer archive`, que tambien mueve is_active.
router.delete(
  '/:id',
  declararRiesgoRuta({ riesgo: 'escritura', escribe: 'accounts.is_active — baja logica reversible; se niega si la cuenta tiene historia' }),
  requirePermission('accounts:delete'),
  asyncHandler(async (req: Request, res: Response) => {
    await deactivateAccount(req.params.id, req.user!.user_id);
    res.status(204).send();
  })
);

export default router;
